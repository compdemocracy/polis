//! Independent, bounded static transport. Unsupported responses stay on Node.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use anyhow::{Context, Result, bail};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
};
#[path = "../../polis-contracts/src/admin_page.rs"]
mod contract;
const MAX_BODY: usize = 16 * 1024;
const MAX_HEAD: usize = 8192;
const MARKER: &str = "<!-- REPLACE_THIS_WITH_FB_META_TAGS -->";
const META: &str =
    "<meta property=\"og:image\" content=\"https://s3.amazonaws.com/pol.is/polis_logo.png\" />\n";

pub struct Client {
    host: String,
    port: u16,
    slots: Semaphore,
    address: Option<SocketAddr>,
}
impl Client {
    pub async fn from_env() -> Result<Option<Self>> {
        Self::from_env_for("POLIS_API_ADMIN_PAGE_READS").await
    }
    pub(crate) async fn from_env_for(switch: &str) -> Result<Option<Self>> {
        if std::env::var(switch).ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let host = std::env::var("STATIC_FILES_HOST").context("STATIC_FILES_HOST required")?;
        let port = std::env::var("STATIC_FILES_ADMIN_PORT")
            .or_else(|_| std::env::var("STATIC_FILES_PORT"))
            .unwrap_or_else(|_| "8080".into())
            .parse()?;
        let mut client = Self::new(host, port)?;
        if client.address.is_none() {
            // Resolve once before listening. A cancelled request must never leave
            // resolver work running in the runtime's shared blocking pool.
            client.address = match tokio::time::timeout(
                Duration::from_millis(75),
                tokio::net::lookup_host((client.host.as_str(), client.port)),
            )
            .await
            {
                Ok(Ok(mut addresses)) => addresses.next(),
                _ => None,
            };
            // Failure disables only this transport; other API routes can serve.
            if client.address.is_none() {
                eprintln!("{{\"event\":\"admin_static_upstream_unavailable\"}}");
            }
        }
        Ok(Some(client))
    }
    pub(crate) fn new(host: String, port: u16) -> Result<Self> {
        if host.is_empty()
            || host.len() > 253
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            || port == 0
        {
            bail!("invalid static upstream");
        }
        let address = host
            .parse::<IpAddr>()
            .ok()
            .map(|ip| SocketAddr::new(ip, port));
        Ok(Self {
            address,
            host,
            port,
            slots: Semaphore::new(4),
        })
    }
    async fn fetch(&self, req: &Request) -> Result<Vec<u8>> {
        let _permit = self.slots.try_acquire().context("static transport busy")?;
        tokio::time::timeout(Duration::from_millis(75), self.fetch_inner(req))
            .await
            .context("static response deadline")?
    }
    async fn fetch_inner(&self, req: &Request) -> Result<Vec<u8>> {
        let mut socket =
            TcpStream::connect(self.address.context("unresolved static upstream")?).await?;
        let mut wire = format!(
            "{} /index_admin.html HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n",
            req.method, self.host, self.port
        );
        for name in ["user-agent", "accept", "accept-language", "accept-encoding"] {
            if let Some(value) = req.headers.get(name) {
                wire.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        wire.push_str("\r\n");
        socket.write_all(wire.as_bytes()).await?;
        let mut bytes = Vec::new();
        let mut buf = [0; MAX_HEAD + MAX_BODY];
        let mut read_ends = Vec::new();
        loop {
            let n = socket.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
            read_ends.push(bytes.len());
            if bytes.len() > MAX_HEAD + MAX_BODY {
                bail!("static response too large");
            }
        }
        let end = bytes
            .windows(4)
            .position(|s| s == b"\r\n\r\n")
            .context("incomplete static head")?
            + 4;
        if end > MAX_HEAD {
            bail!("static head too large");
        }
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut parsed = httparse::Response::new(&mut headers);
        if !parsed.parse(&bytes)?.is_complete() || parsed.code != Some(200) {
            bail!("unsupported static status");
        }
        let values = |name: &str| {
            parsed
                .headers
                .iter()
                .filter(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value)
                .collect::<Vec<_>>()
        };
        if !values("transfer-encoding").is_empty() || !values("content-encoding").is_empty() {
            bail!("unsupported static encoding");
        }
        let length = values("content-length");
        if length.len() != 1 {
            bail!("static length required");
        }
        let length = std::str::from_utf8(length[0])?.parse::<usize>()?;
        if length > MAX_BODY {
            bail!("static body too large");
        }
        let body = &bytes[end..];
        if req.method == "HEAD" {
            if !body.is_empty() {
                bail!("unexpected HEAD body");
            }
            return Ok(Vec::new());
        }
        if read_ends.iter().filter(|&&at| at > end).count() > 1 {
            bail!("segmented static body");
        }
        if body.len() != length || !body.is_ascii() {
            bail!("unsupported static body");
        }
        Ok(body.to_vec())
    }
}
pub fn matches(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/m/") else {
        return false;
    };
    let b = rest.as_bytes();
    b.len() >= 2 && b[0].is_ascii_digit() && b[1].is_ascii_alphanumeric()
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.admin_page.is_none() || !matches(req.path()) || !admitted(req) {
        return None;
    }
    Some(contract::Request {
        path: req.path().into(),
        head_only: req.method == "HEAD",
    })
}
pub(crate) fn admitted(req: &Request) -> bool {
    if !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some_and(|q| !q.is_empty())
        || !req.body.is_empty()
        || req.headers.get("content-length").is_some_and(|v| v != "0")
        || !req.headers.only(&[
            "host",
            "connection",
            "user-agent",
            "accept",
            "accept-language",
            "accept-encoding",
            "content-length",
            "x-forwarded-proto",
        ])
    {
        return false;
    }
    if req.path().len() > 2048
        || !req
            .path()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        || req
            .headers
            .get("accept-encoding")
            .is_some_and(|v| v != "identity")
    {
        return false;
    }
    true
}
pub(crate) async fn html(client: &Client, req: &Request) -> Result<(String, Vec<Vec<u8>>)> {
    let body = client.fetch(req).await?;
    let (response, chunks) = rewrite(&body).context("unsupported static HTML")?;
    Ok((response.html, chunks))
}
// Replacestream retains one marker-length suffix until flush. The admitted
// ASCII document uses the same case-insensitive replacement and two writes.
fn rewrite(body: &[u8]) -> Option<(contract::Response, Vec<Vec<u8>>)> {
    let text = std::str::from_utf8(body).ok()?;
    let mut rest = text;
    let mut prefix = String::new();
    while let Some(at) = rest.to_ascii_lowercase().find(&MARKER.to_ascii_lowercase()) {
        prefix.push_str(&rest[..at]);
        prefix.push_str(META);
        rest = &rest[at + MARKER.len()..];
    }
    let tail = rest.len().min(MARKER.len());
    prefix.push_str(&rest[..rest.len() - tail]);
    let suffix = &rest[rest.len() - tail..];
    let response = contract::Response {
        html: format!("{prefix}{suffix}"),
    };
    Some((
        response,
        vec![prefix.into_bytes(), suffix.as_bytes().to_vec()],
    ))
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(_query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Some(client) = app.admin_page.as_ref() else {
        return route::bad_gateway();
    };
    let Ok(body) = client.fetch(req).await else {
        return route::bad_gateway();
    };
    let Some((_response, chunks)) = rewrite(&body) else {
        return route::bad_gateway();
    };
    route::admin_html(req, res, chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Headers;
    async fn fixture(wire: Vec<u8>, delay: Duration) -> (Client, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut b = [0; 4096];
            let n = s.read(&mut b).await.unwrap();
            assert!(String::from_utf8_lossy(&b[..n]).contains(" /index_admin.html HTTP/1.1\r\n"));
            tokio::time::sleep(delay).await;
            s.write_all(&wire).await.ok();
        });
        (Client::new("127.0.0.1".into(), port).unwrap(), task)
    }
    fn req(method: &str) -> Request {
        Request {
            method: method.into(),
            target: "/m/2test".into(),
            headers: Headers::default(),
            body: vec![],
        }
    }
    #[test]
    fn path_prefix_and_fixed_upstream() {
        for p in ["/m/2x", "/m/2x/suffix", "/m/2xSuffix", "/m/2x-"] {
            assert!(matches(p));
        }
        for p in ["/m/2", "/m/x2", "/m/", "/M/2x", "/prefix/m/2x"] {
            assert!(!matches(p));
        }
        for host in ["", "127.0.0.1/path", "user@host", "host\r\nInjected: x"] {
            assert!(Client::new(host.into(), 8080).is_err());
        }
    }
    #[test]
    fn stream_replacement_matches_suffix_retention() {
        let document = format!("begin{}{}end", MARKER.to_lowercase(), "a".repeat(80));
        let (r, chunks) = rewrite(document.as_bytes()).unwrap();
        assert_eq!(r.html, format!("begin{META}{}end", "a".repeat(80)));
        assert_eq!(chunks.concat(), r.html.as_bytes());
        assert_eq!(chunks[1].len(), MARKER.len());
        assert_eq!(
            rewrite(b"short").unwrap().1,
            vec![vec![], b"short".to_vec()]
        );
    }
    #[tokio::test]
    async fn fixed_body_and_head_are_bounded() {
        for (method, wire, expected) in [
            (
                "GET",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec(),
                b"abc".to_vec(),
            ),
            (
                "HEAD",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n".to_vec(),
                vec![],
            ),
        ] {
            let (c, t) = fixture(wire, Duration::ZERO).await;
            assert_eq!(c.fetch(&req(method)).await.unwrap(), expected);
            t.await.unwrap();
        }
    }
    #[tokio::test]
    async fn uncertain_static_responses_fall_back() {
        for wire in [
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc",
            "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Encoding: gzip\r\n\r\n",
        ] {
            let (c, t) = fixture(wire.as_bytes().to_vec(), Duration::ZERO).await;
            assert!(c.fetch(&req("GET")).await.is_err(), "{wire}");
            t.await.unwrap();
        }
    }
    #[tokio::test]
    async fn slow_and_saturated_static_transport_sheds_itself() {
        let (c, t) = fixture(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
            Duration::from_millis(150),
        )
        .await;
        let permit = c.slots.acquire_many(4).await.unwrap();
        assert!(
            c.fetch(&req("GET"))
                .await
                .unwrap_err()
                .to_string()
                .contains("busy")
        );
        drop(permit);
        assert!(
            c.fetch(&req("GET"))
                .await
                .unwrap_err()
                .to_string()
                .contains("deadline")
        );
        assert_eq!(c.slots.available_permits(), 4);
        t.await.unwrap();
    }
    #[tokio::test]
    async fn fragmented_static_body_is_not_a_single_write_contract() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client =
            Client::new("127.0.0.1".into(), listener.local_addr().unwrap().port()).unwrap();
        let task = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut b = [0; 4096];
            let n = s.read(&mut b).await.unwrap();
            assert!(n > 0);
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(15)).await;
            s.write_all(b"def").await.unwrap();
        });
        assert!(
            client
                .fetch(&req("GET"))
                .await
                .unwrap_err()
                .to_string()
                .contains("segmented")
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn unresolved_static_host_is_a_local_handoff() {
        let client = Client::new("unresolved.invalid".into(), 8080).unwrap();
        assert!(
            client
                .fetch(&req("GET"))
                .await
                .unwrap_err()
                .to_string()
                .contains("unresolved")
        );
        assert_eq!(client.slots.available_permits(), 4);
    }
}
