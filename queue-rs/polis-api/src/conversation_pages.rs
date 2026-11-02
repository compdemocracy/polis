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
#[path = "../../polis-contracts/src/conversation_pages.rs"]
mod contract;
use contract::{Page, Request as PageRequest};
const MAX_BODY: usize = 16 * 1024;
const MAX_HEAD: usize = 8192;
const MAX_RENDER: usize = 65536;
const PRELOAD_MARKER: &str = "\"REPLACE_THIS_WITH_PRELOAD_DATA\"";
const META_MARKER: &str = "<!-- REPLACE_THIS_WITH_FB_META_TAGS -->";
pub struct Client {
    host: String,
    port: u16,
    slots: Semaphore,
    address: Option<SocketAddr>,
}
impl Client {
    pub(crate) async fn from_env_for(switch: &str) -> Result<Option<Self>> {
        if std::env::var(switch).ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let host = std::env::var("STATIC_FILES_HOST").context("STATIC_FILES_HOST required")?;
        let port = std::env::var("STATIC_FILES_PARTICIPATION_PORT")
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
                eprintln!("{{\"event\":\"conversation_static_upstream_unavailable\"}}");
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
            "{} /index.html HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n",
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

pub fn page(path: &str) -> Option<(Page, &str)> {
    let (page, rest) = (Page::Conversation, path.strip_prefix('/')?);
    let n = rest.bytes().take_while(u8::is_ascii_alphanumeric).count();
    (n >= 2 && rest.as_bytes()[0].is_ascii_digit()).then_some((page, &rest[..n]))
}
pub fn matches(path: &str) -> bool {
    page(path).is_some()
}
pub fn parse(app: &App, req: &Request) -> Option<PageRequest> {
    let (page, cid) = page(req.path())?;
    if app.conversation_pages[page.index()].is_none()
        || app.conversation_page_dbs[page.index()].is_none()
        || !crate::admin_page::admitted(req)
        || cid.len() > 100
    {
        return None;
    }
    let ua = req.headers.get("user-agent").unwrap_or_default();
    if ua
        .as_bytes()
        .windows(6)
        .any(|w| w.starts_with(b"MSIE ") && b"234567".contains(&w[5]))
    {
        return None;
    }
    Some(PageRequest {
        page,
        conversation_id: cid.into(),
        path: req.path().into(),
        head_only: req.method == "HEAD",
    })
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(15),
        statement_timeout: Duration::from_millis(50),
        max_lifetime: Duration::from_secs(300),
    }
}
/// ASCII-only admission keeps JS string and stream offsets identical.
fn entity(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}
fn replace(chunks: Vec<Vec<u8>>, marker: &str, replacement: &str) -> Option<Vec<Vec<u8>>> {
    let mut carry = String::new();
    let mut out = Vec::new();
    let mut total = 0;
    for chunk in chunks {
        carry.push_str(std::str::from_utf8(&chunk).ok()?);
        let mut rest = carry.as_str();
        let mut prefix = String::new();
        while let Some(at) = rest.to_ascii_lowercase().find(&marker.to_ascii_lowercase()) {
            if total + prefix.len() + at + replacement.len() > MAX_RENDER {
                return None;
            }
            prefix.push_str(&rest[..at]);
            prefix.push_str(replacement);
            rest = &rest[at + marker.len()..];
        }
        let tail = rest.len().min(marker.len());
        prefix.push_str(&rest[..rest.len() - tail]);
        let suffix = rest[rest.len() - tail..].to_owned();
        total += prefix.len();
        if total > MAX_RENDER {
            return None;
        }
        out.push(prefix.into_bytes());
        carry = suffix;
    }
    if total + carry.len() > MAX_RENDER {
        return None;
    }
    out.push(carry.into_bytes());
    Some(out)
}
fn rewrite(
    body: &[u8],
    preload: &str,
    topic: &str,
    description: &str,
) -> Option<(contract::Response, Vec<Vec<u8>>)> {
    if !preload.is_ascii() || !topic.is_ascii() || !description.is_ascii() {
        return None;
    }
    let meta = format!(
        "<meta property=\"og:image\" content=\"https://s3.amazonaws.com/pol.is/polis_logo.png\" />\n    <meta property=\"og:title\" content=\"{}\" />\n    <meta property=\"og:description\" content=\"{}\" />\n",
        entity(topic),
        entity(description)
    );
    let first = replace(vec![body.to_vec()], PRELOAD_MARKER, preload)?;
    let chunks = replace(first, META_MARKER, &meta)?;
    let html = String::from_utf8(chunks.concat()).ok()?;
    Some((contract::Response { html }, chunks))
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Some(pool) = &app.conversation_page_dbs[query.page.index()] else {
        return route::bad_gateway();
    };
    let cid = query.conversation_id;
    let read = tokio::time::timeout(
        Duration::from_millis(75),
        pool.with(move |c| prepare(c, &cid)),
    )
    .await;
    let Ok(Ok(Some(prepared))) = read else {
        return route::bad_gateway();
    };
    let ua = req.headers.get("user-agent").unwrap_or_default();
    if ua
        .as_bytes()
        .windows(6)
        .any(|w| w.starts_with(b"MSIE ") && b"89".contains(&w[5]))
    {
        let Some(host) = req.headers.get("host").filter(|h| {
            !h.is_empty()
                && h.len() <= 255
                && h.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b))
        }) else {
            return route::bad_gateway();
        };
        return route::redirect(req, res, &format!("https://{host}/#{}", query.path));
    }
    let Some(client) = &app.conversation_pages[query.page.index()] else {
        return route::bad_gateway();
    };
    // The read lease is returned before beginning the independent static request.
    let Ok(body) = client.fetch(req).await else {
        return route::bad_gateway();
    };
    let Some((_response, chunks)) = rewrite(
        &body,
        &prepared.json,
        &prepared.topic,
        &prepared.description,
    ) else {
        return route::bad_gateway();
    };
    route::conversation_html(req, res, chunks, !app.dev_mode)
}

pub struct Prepared {
    pub json: String,
    pub topic: String,
    pub description: String,
}
pub fn prepare(c: &mut postgres::Client, cid: &str) -> Result<Option<Prepared>> {
    let size=c.query("SELECT coalesce(octet_length(topic),0)+coalesce(octet_length(description),0)+coalesce(octet_length(link_url),0)+coalesce(octet_length(parent_url),0)+coalesce(octet_length(bgcolor),0)+coalesce(octet_length(help_color),0)+coalesce(octet_length(help_bgcolor),0)+coalesce(octet_length(style_btn),0) FROM conversations c JOIN zinvites z ON c.zid=z.zid WHERE z.zinvite=$1 LIMIT 2",&[&cid])?;
    if size.len() != 1 || size[0].try_get::<_, i32>(0)? > 8192 {
        return Ok(None);
    }
    let Some(preload) = crate::conversation_preload::read(c, cid)? else {
        return Ok(None);
    };
    #[derive(serde::Serialize)]
    struct Preload<T> {
        conversation: T,
    }
    let topic = preload.topic.clone().unwrap_or_default();
    let description = preload.description.clone().unwrap_or_default();
    let json = serde_json::to_string(&Preload {
        conversation: preload,
    })?;
    if !json.is_ascii() || json.len() > 16384 {
        return Ok(None);
    }
    Ok(Some(Prepared {
        json,
        topic,
        description,
    }))
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
            assert!(String::from_utf8_lossy(&b[..n]).contains(" /index.html HTTP/1.1\r\n"));
            tokio::time::sleep(delay).await;
            s.write_all(&wire).await.ok();
        });
        (Client::new("127.0.0.1".into(), port).unwrap(), task)
    }
    fn req(method: &str) -> Request {
        Request {
            method: method.into(),
            target: "/2test".into(),
            headers: Headers::default(),
            body: vec![],
        }
    }
    #[test]
    fn path_prefix_and_fixed_upstream() {
        for p in ["/2x", "/2x/suffix", "/2xSuffix", "/2x-"] {
            assert!(matches(p));
        }
        for p in ["/2", "/x2", "/", "/X/2x", "/prefix/2x"] {
            assert!(!matches(p));
        }
        for host in ["", "127.0.0.1/path", "user@host", "host\r\nInjected: x"] {
            assert!(Client::new(host.into(), 8080).is_err());
        }
    }
    #[test]
    fn stream_replacement_is_case_insensitive_literal_and_bounded() {
        let document = format!(
            "begin{}{}end",
            PRELOAD_MARKER.to_lowercase(),
            "a".repeat(80)
        );
        let (r, chunks) = rewrite(document.as_bytes(), "{\"x\":1}", "<t>&'\"", "d").unwrap();
        assert_eq!(r.html, format!("begin{{\"x\":1}}{}end", "a".repeat(80)));
        assert_eq!(chunks.concat(), r.html.as_bytes());
        assert_eq!(entity("<t>&'\""), "&lt;t&gt;&amp;&apos;&quot;");
        assert!(
            rewrite(
                PRELOAD_MARKER.repeat(20).as_bytes(),
                &"a".repeat(16384),
                "",
                ""
            )
            .is_none()
        );
        assert!(rewrite(b"short", "\"雪\"", "", "").is_none());
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

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    #[tokio::test]
    async fn page_preserves_preload_and_bounds_and_sheds_locked_reads() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("conversation_page_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.conversations(zid integer,topic text,description text,created bigint,link_url text,parent_url text,vis_type integer,write_type integer,importance_enabled boolean,help_type integer,bgcolor text,help_color text,help_bgcolor text,style_btn text,auth_opt_allow_3rdparty boolean); CREATE TABLE {setup_schema}.zinvites(zid integer,zinvite text); INSERT INTO {setup_schema}.conversations VALUES(1,NULL,NULL,9223372036854775807,NULL,NULL,0,1,false,1,NULL,NULL,NULL,NULL,NULL),(2,'雪','public',NULL,'link','parent',2,0,true,0,'blue','red','white','round',false); INSERT INTO {setup_schema}.zinvites VALUES(1,'first'),(2,'second'),(1,'ambiguous'),(2,'ambiguous');")).unwrap();
        }).await.unwrap();
        let make_pool = || {
            let mut c: postgres::Config = url.parse().unwrap();
            c.options(&format!("-c search_path={schema}"));
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(c)),
                pool_limits(),
            )
        };
        let pool = make_pool();
        let participation = make_pool();
        let first = pool.with(|c| prepare(c, "first")).await.unwrap().unwrap();
        assert!(first.json.contains("9223372036854775807"));
        assert!(first.topic.is_empty() && first.description.is_empty());
        assert!(pool.with(|c| prepare(c, "second")).await.unwrap().is_none());
        for cid in ["missing", "ambiguous"] {
            assert!(pool.with(move |c| prepare(c, cid)).await.unwrap().is_none());
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let locked = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.conversations IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let stalled = pool.clone();
        let task = tokio::spawn(async move { stalled.with(|c| prepare(c, "first")).await });
        assert!(participation.ping().await);
        assert!(task.await.unwrap().is_err());
        release_tx.send(()).unwrap();
        locked.await.unwrap();
        assert!(pool.with(|c| prepare(c, "first")).await.unwrap().is_some());
        let error = pool
            .with(|c| Ok(c.batch_execute("DELETE FROM conversations")?))
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(pool);
            drop(participation);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
}

#[cfg(test)]
mod recorded_html_tests {
    use super::*;
    #[test]
    fn unchanged_node_html_after_both_stream_replacements() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            id: String,
            document: String,
            preload: String,
            topic: Option<String>,
            description: Option<String>,
            html: String,
        }
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "../../polis-contracts/src/fixtures/conversation-pages.json"
        ))
        .unwrap();
        for f in fixtures {
            let (response, chunks) = rewrite(
                f.document.as_bytes(),
                &f.preload,
                f.topic.as_deref().unwrap_or_default(),
                f.description.as_deref().unwrap_or_default(),
            )
            .unwrap();
            assert_eq!(response.html, f.html, "{}", f.id);
            assert_eq!(chunks.concat(), f.html.as_bytes(), "{}", f.id);
        }
    }
}
