//! HTTP/1.1 server loop that writes responses the way Node's `http` module does.
//!
//! Why not hyper or axum: the route's bytes include Express's exact header
//! spelling and order (`Etag` from the handler, `ETag` from Express itself, in
//! one response family), and hyper normalises header names. This loop parses
//! requests with `httparse` and writes the status line and headers itself, so
//! the order and casing are whatever the route emulation produced.
//!
//! What Node adds after the application's own headers, reproduced in
//! [`write_response`]:
//!
//! 1. `Date`, always (Node's `sendDate`).
//! 2. `Connection: keep-alive` and `Keep-Alive: timeout=5`, or
//!    `Connection: close`, only when the application did not set `Connection`
//!    itself (the Node route's `writeDefaultHead` normally does).
//! 3. `Transfer-Encoding: chunked` for a body with no `Content-Length`.
//!
//! 204 and 304 responses carry no framing header and no body, and a HEAD
//! response carries the headers only.

use anyhow::{Result, anyhow, bail};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::Instant,
};

/// Largest request head plus body accepted. The route takes a few query
/// parameters; Node's 50 MB body limit is far beyond anything it can use.
const LIMIT: usize = 1024 * 1024;
/// Node's default `server.keepAliveTimeout` (5 s), which it also advertises.
const KEEP_ALIVE: Duration = Duration::from_secs(5);
/// One request, from its first byte through the response write.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);

/// Request headers as Node presents them on `req.headers`: lower-case names,
/// repeated headers joined (or the first kept, for Node's single-value list).
#[derive(Clone, Debug, Default)]
pub struct Headers(Vec<(String, String)>);

/// Headers Node keeps only the first instance of (`matchKnownFields`).
const FIRST_WINS: [&str; 17] = [
    "content-type",
    "content-length",
    "user-agent",
    "referer",
    "host",
    "authorization",
    "proxy-authorization",
    "if-modified-since",
    "if-unmodified-since",
    "from",
    "location",
    "max-forwards",
    "retry-after",
    "etag",
    "last-modified",
    "server",
    "age",
];

impl Headers {
    pub fn from_raw<'a>(raw: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut out: Vec<(String, String)> = Vec::new();
        for (name, value) in raw {
            let name = name.to_ascii_lowercase();
            let value = value.trim_matches([' ', '\t']).to_string();
            match out.iter_mut().find(|(k, _)| *k == name) {
                None => out.push((name, value)),
                Some(_) if FIRST_WINS.contains(&name.as_str()) || name == "expires" => {}
                Some((_, existing)) if name == "cookie" => {
                    existing.push_str("; ");
                    existing.push_str(&value);
                }
                Some((_, existing)) => {
                    existing.push_str(", ");
                    existing.push_str(&value);
                }
            }
        }
        Self(out)
    }

    /// `req.headers[name]` (`name` lower-case).
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

pub struct Request {
    pub method: String,
    /// The request-target exactly as received (`req.url`).
    pub target: String,
    pub headers: Headers,
    pub body: Vec<u8>,
}

impl Request {
    /// `req.path`: the target up to `?`.
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    /// The raw query string after the first `?`, if any.
    pub fn query(&self) -> Option<&str> {
        self.target.split_once('?').map(|(_, q)| q)
    }
}

pub enum Body {
    /// No body bytes (304, 204, or an empty `res.end()` with a length header).
    Empty,
    /// Bytes delimited by a `Content-Length` the application already set.
    Fixed(Vec<u8>),
    /// `Transfer-Encoding: chunked`; one HTTP chunk per entry.
    Chunked(Vec<Vec<u8>>),
}

pub struct Outgoing {
    pub status: u16,
    /// Application headers in the order Node would hold them.
    pub headers: Vec<(String, String)>,
    pub body: Body,
    /// Close the connection after this response (Node destroys the socket on
    /// a few error paths).
    pub close: bool,
}

/// `http.STATUS_CODES` for the statuses this route can produce.
pub fn reason_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// IMF-fixdate, as `new Date().toUTCString()` prints it.
pub fn http_date(unix_seconds: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = unix_seconds / 86_400;
    let secs = unix_seconds % 86_400;
    // Civil-from-days (Howard Hinnant), valid for every date after 1970.
    let z = days as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        DAYS[(days % 7) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn date_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    http_date(secs)
}

/// Serialises one response. `keep_alive` is whether the connection stays open
/// afterwards, which decides what Node writes when the application set no
/// `Connection` header.
pub fn write_response(
    response: &Outgoing,
    head_only: bool,
    keep_alive: bool,
    date: &str,
) -> Result<Vec<u8>> {
    write_response_for(response, head_only, keep_alive, false, date)
}

/// As [`write_response`], for a request of either HTTP version. Node never
/// chunks a response to an HTTP/1.0 request: the body goes out as is and the
/// connection close ends it.
pub fn write_response_for(
    response: &Outgoing,
    head_only: bool,
    keep_alive: bool,
    http10: bool,
    date: &str,
) -> Result<Vec<u8>> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        reason_text(response.status)
    );
    let mut has_connection = false;
    for (name, value) in &response.headers {
        if name.contains([':', '\r', '\n']) || value.contains(['\r', '\n']) {
            bail!("invalid response header {name:?}");
        }
        has_connection |= name.eq_ignore_ascii_case("connection");
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str("Date: ");
    out.push_str(date);
    out.push_str("\r\n");
    if !has_connection {
        if keep_alive {
            out.push_str("Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n");
        } else {
            out.push_str("Connection: close\r\n");
        }
    }
    let bodyless = head_only || response.status == 204 || response.status == 304;
    if matches!(response.body, Body::Chunked(_)) && !bodyless && !http10 {
        out.push_str("Transfer-Encoding: chunked\r\n");
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    if bodyless {
        return Ok(bytes);
    }
    match &response.body {
        Body::Empty => {}
        Body::Fixed(body) => bytes.extend_from_slice(body),
        Body::Chunked(chunks) if http10 => {
            for chunk in chunks {
                bytes.extend_from_slice(chunk);
            }
        }
        Body::Chunked(chunks) => {
            for chunk in chunks.iter().filter(|c| !c.is_empty()) {
                bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                bytes.extend_from_slice(chunk);
                bytes.extend_from_slice(b"\r\n");
            }
            bytes.extend_from_slice(b"0\r\n\r\n");
        }
    }
    Ok(bytes)
}

struct Head {
    len: usize,
    method: String,
    target: String,
    headers: Headers,
    body_len: usize,
    http10: bool,
    close: bool,
}

fn parse_head(buf: &[u8]) -> Result<Option<Head>> {
    let mut fields = [httparse::EMPTY_HEADER; 128];
    let mut req = httparse::Request::new(&mut fields);
    let httparse::Status::Complete(len) = req.parse(buf)? else {
        return Ok(None);
    };
    let raw: Vec<(&str, &str)> = req
        .headers
        .iter()
        .map(|h| Ok((h.name, std::str::from_utf8(h.value)?)))
        .collect::<Result<_, std::str::Utf8Error>>()?;
    let lengths: Vec<&str> = raw
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map(|(_, v)| *v)
        .collect();
    if raw
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
    {
        bail!("chunked request bodies are not accepted");
    }
    if lengths.len() > 1 && lengths.windows(2).any(|w| w[0].trim() != w[1].trim()) {
        bail!("conflicting Content-Length");
    }
    let body_len = match lengths.first() {
        Some(v) => v.trim().parse::<usize>()?,
        None => 0,
    };
    if len + body_len > LIMIT {
        bail!("request over limit");
    }
    let http10 = req.version == Some(0);
    let connection = raw
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("connection"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(",");
    let close = if http10 {
        !connection.contains("keep-alive")
    } else {
        connection.split(',').any(|t| t.trim() == "close")
    };
    Ok(Some(Head {
        len,
        method: req.method.ok_or_else(|| anyhow!("no method"))?.to_string(),
        target: req.path.ok_or_else(|| anyhow!("no target"))?.to_string(),
        headers: Headers::from_raw(raw),
        body_len,
        http10,
        close,
    }))
}

/// Accepts connections forever, answering each request with `handler`.
pub async fn serve<H, F>(listener: TcpListener, handler: Arc<H>) -> Result<()>
where
    H: Fn(Request) -> F + Send + Sync + 'static,
    F: Future<Output = Outgoing> + Send + 'static,
{
    loop {
        let (socket, _) = listener.accept().await?;
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = connection(socket, handler).await {
                eprintln!(
                    "{{\"event\":\"http_connection_error\",\"detail\":{:?}}}",
                    e.to_string()
                );
            }
        });
    }
}

async fn connection<H, F>(mut socket: TcpStream, handler: Arc<H>) -> Result<()>
where
    H: Fn(Request) -> F + Send + Sync + 'static,
    F: Future<Output = Outgoing> + Send + 'static,
{
    socket.set_nodelay(true)?;
    let mut input: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        // Wait for the next request head within the keep-alive window; once a
        // byte of it has arrived, the whole exchange has one deadline.
        let mut started: Option<Instant> = if input.is_empty() {
            None
        } else {
            Some(Instant::now())
        };
        let head = loop {
            if let Some(head) = parse_head(&input)? {
                break head;
            }
            let read = match started {
                None => match tokio::time::timeout(KEEP_ALIVE, socket.read(&mut buf)).await {
                    Ok(r) => r?,
                    Err(_) => return Ok(()),
                },
                Some(at) => {
                    match tokio::time::timeout_at(at + REQUEST_DEADLINE, socket.read(&mut buf))
                        .await
                    {
                        Ok(r) => r?,
                        Err(_) => bail!("request head deadline"),
                    }
                }
            };
            if read == 0 {
                return Ok(());
            }
            started.get_or_insert_with(Instant::now);
            input.extend_from_slice(&buf[..read]);
            if input.len() > LIMIT {
                bail!("request over limit");
            }
        };
        let deadline = started.unwrap_or_else(Instant::now) + REQUEST_DEADLINE;
        while input.len() < head.len + head.body_len {
            let read = match tokio::time::timeout_at(deadline, socket.read(&mut buf)).await {
                Ok(r) => r?,
                Err(_) => bail!("request body deadline"),
            };
            if read == 0 {
                bail!("truncated request body");
            }
            input.extend_from_slice(&buf[..read]);
        }
        let body = input[head.len..head.len + head.body_len].to_vec();
        input.drain(..head.len + head.body_len);
        let head_only = head.method == "HEAD";
        // Node's http server (requireHostHeader) answers an HTTP/1.1 request
        // with no Host before any application code runs, and closes.
        if !head.http10 && head.headers.get("host").is_none_or(str::is_empty) {
            let refusal = Outgoing {
                status: 400,
                headers: vec![("Connection".into(), "close".into())],
                body: Body::Chunked(Vec::new()),
                close: true,
            };
            socket
                .write_all(&write_response(&refusal, head_only, false, &date_now())?)
                .await?;
            socket.shutdown().await.ok();
            return Ok(());
        }
        let request = Request {
            method: head.method,
            target: head.target,
            headers: head.headers,
            body,
        };
        let response = match tokio::time::timeout_at(deadline, handler(request)).await {
            Ok(r) => r,
            Err(_) => bail!("handler deadline"),
        };
        // An HTTP/1.0 body without a length is delimited by closing.
        let unframed = head.http10 && matches!(response.body, Body::Chunked(_));
        let keep_alive = !head.close && !response.close && !unframed;
        let bytes = write_response_for(&response, head_only, keep_alive, head.http10, &date_now())?;
        socket.write_all(&bytes).await?;
        if !keep_alive {
            socket.shutdown().await.ok();
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_print_like_to_utc_string() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_700_000_000), "Tue, 14 Nov 2023 22:13:20 GMT");
        assert_eq!(http_date(1_789_102_309), "Fri, 11 Sep 2026 04:51:49 GMT");
        assert_eq!(http_date(951_782_400), "Tue, 29 Feb 2000 00:00:00 GMT");
    }

    #[test]
    fn request_headers_join_like_node() {
        let h = Headers::from_raw([
            ("If-None-Match", "\"a\""),
            ("if-none-match", " \"b\" "),
            ("Host", "one"),
            ("host", "two"),
            ("Cookie", "a=1"),
            ("cookie", "b=2"),
        ]);
        assert_eq!(h.get("if-none-match"), Some("\"a\", \"b\""));
        assert_eq!(h.get("host"), Some("one"));
        assert_eq!(h.get("cookie"), Some("a=1; b=2"));
    }

    #[test]
    fn node_adds_date_then_connection_then_chunking() {
        let out = Outgoing {
            status: 302,
            headers: vec![("Location".into(), "https://h/x".into())],
            body: Body::Chunked(vec![]),
            close: false,
        };
        let bytes = write_response(&out, false, true, "D").unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "HTTP/1.1 302 Found\r\nLocation: https://h/x\r\nDate: D\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
        );
    }

    #[test]
    fn not_modified_has_no_framing_and_no_body() {
        let out = Outgoing {
            status: 304,
            headers: vec![("Connection".into(), "keep-alive".into())],
            body: Body::Fixed(b"ignored".to_vec()),
            close: false,
        };
        let bytes = write_response(&out, false, true, "D").unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "HTTP/1.1 304 Not Modified\r\nConnection: keep-alive\r\nDate: D\r\n\r\n"
        );
    }

    #[test]
    fn head_requests_get_headers_only() {
        let out = Outgoing {
            status: 200,
            headers: vec![("Content-Length".into(), "3".into())],
            body: Body::Fixed(b"abc".to_vec()),
            close: false,
        };
        let bytes = write_response(&out, true, false, "D").unwrap();
        assert!(
            String::from_utf8(bytes)
                .unwrap()
                .ends_with("Connection: close\r\n\r\n")
        );
    }

    #[test]
    fn missing_host_refusal_matches_node() {
        let refusal = Outgoing {
            status: 400,
            headers: vec![("Connection".into(), "close".into())],
            body: Body::Chunked(Vec::new()),
            close: true,
        };
        assert_eq!(
            String::from_utf8(write_response(&refusal, false, false, "D").unwrap()).unwrap(),
            "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nDate: D\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
        );
    }

    #[test]
    fn heads_parse_with_framing_rules() {
        let head = parse_head(b"GET /a?b=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap()
            .unwrap();
        assert_eq!((head.body_len, head.close, head.http10), (2, false, false));
        assert!(parse_head(b"GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").is_err());
        let head = parse_head(b"GET / HTTP/1.0\r\n\r\n").unwrap().unwrap();
        assert!(head.close);
        assert!(
            parse_head(b"GET / HTTP/1.1\r\nHost: x\r\n")
                .unwrap()
                .is_none()
        );
    }
}
