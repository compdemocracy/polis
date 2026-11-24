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
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering::SeqCst},
    },
    time::Duration,
};
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
/// How long the write of a response that holds something
/// ([`hold_until_written`]) may take; past it the connection is closed and
/// what it held is let go. Other responses' writes are unchanged.
pub const HELD_WRITE_DEADLINE: Duration = Duration::from_secs(5);

/// What a handler asked to keep until its response has been written or its
/// connection dropped: a route's admission place and byte count, so they bound
/// the bytes that are still on their way to the client, not only those being
/// read. One list per connection, emptied after each response.
type Holds = Arc<std::sync::Mutex<Vec<Box<dyn std::any::Any + Send>>>>;

tokio::task_local! {
    static RESPONSE_HOLDS: Holds;
}

/// Keep `value` until the response the current request is building has been
/// written, or its connection has dropped. `false` (and `value` dropped) when
/// no connection is writing this request (a test calling a handler
/// directly).
pub fn hold_until_written(value: impl std::any::Any + Send) -> bool {
    RESPONSE_HOLDS
        .try_with(|holds| holds.lock().map(|mut h| h.push(Box::new(value))).is_ok())
        .unwrap_or(false)
}

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

    pub fn only(&self, names: &[&str]) -> bool {
        self.0
            .iter()
            .all(|(name, _)| names.contains(&name.as_str()))
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
        202 => "Accepted",
        204 => "No Content",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        409 => "Conflict",
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
    hand_back: bool,
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
    let transfer_encoded = raw
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"));
    let write_path = matches!(req.method, Some("POST" | "PUT" | "DELETE"))
        && req.path.is_some_and(|p| {
            p.split('?')
                .next()
                .is_some_and(|path| path == crate::topic_selections::PATH)
        });
    let vote_path = req.method == Some("POST")
        && req
            .path
            .is_some_and(|p| p.split('?').next() == Some(crate::post_votes::PATH));
    let wave_path = req.method == Some("POST")
        && req
            .path
            .is_some_and(|p| p.split('?').next() == Some(crate::post_treevite_waves::PATH));
    let comment_path = req.method == Some("POST")
        && req
            .path
            .is_some_and(|p| p.split('?').next() == Some(crate::post_comments::PATH));
    let mut hand_back = transfer_encoded && (write_path || vote_path || wave_path || comment_path);
    if transfer_encoded && !hand_back {
        bail!("chunked request bodies are not accepted");
    }
    if !hand_back && lengths.len() > 1 && lengths.windows(2).any(|w| w[0].trim() != w[1].trim()) {
        bail!("conflicting Content-Length");
    }
    let mut body_len = match lengths.first().filter(|_| !hand_back) {
        Some(v) => v.trim().parse::<usize>()?,
        None => 0,
    };
    if (write_path && body_len > crate::topic_selection_writes::MAX_BODY_BYTES)
        || (vote_path && body_len > crate::post_votes::MAX_BODY_BYTES)
        || (wave_path && body_len > crate::post_treevite_waves::MAX_BODY_BYTES)
        || (comment_path && body_len > crate::post_comments::MAX_BODY_BYTES)
    {
        hand_back = true;
        body_len = 0;
    }
    if len > LIMIT || body_len > LIMIT.saturating_sub(len) {
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
        hand_back,
    }))
}

/// Which process a listener belongs to. The main listener's behaviour is
/// unchanged by the shadow's existence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listener {
    Main,
    /// The shadow role's listener (`crate::shadow`): it counts the request
    /// heads it cannot parse, and answers a copy whose body the writer would
    /// not read with 204 rather than the vote hand-back marker.
    Shadow,
}

/// A request head this server could not parse: answered 502 and closed on
/// the main listener, dropped on the shadow's (`refuse_head`). Displays as the
/// parse error itself.
#[derive(Debug)]
pub struct HeadRefused(anyhow::Error);

impl std::fmt::Display for HeadRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HeadRefused {}

impl HeadRefused {
    /// A fixed word for the kind of head, never a byte of the request.
    pub fn class(&self) -> &'static str {
        if self.0.downcast_ref::<std::str::Utf8Error>().is_some() {
            "header_utf8"
        } else if let Some(error) = self.0.downcast_ref::<httparse::Error>() {
            if *error == httparse::Error::TooManyHeaders {
                "too_many_headers"
            } else {
                "head_syntax"
            }
        } else {
            "head_other"
        }
    }
}

/// Connections with a request in progress: from accept until the connection
/// waits for another request (keep-alive) or closes, and again from the first
/// byte of that next request. The stop waits for this to reach zero.
static IN_PROGRESS: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn in_progress() -> usize {
    IN_PROGRESS.load(SeqCst)
}

/// One connection's place in [`IN_PROGRESS`]. Raised before its task is
/// spawned, so a stop that begins after the accept always counts it.
struct Busy(bool);

impl Busy {
    fn new() -> Self {
        IN_PROGRESS.fetch_add(1, SeqCst);
        Self(true)
    }

    fn set(&mut self, busy: bool) {
        if busy != self.0 {
            if busy {
                IN_PROGRESS.fetch_add(1, SeqCst);
            } else {
                IN_PROGRESS.fetch_sub(1, SeqCst);
            }
            self.0 = busy;
        }
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.set(false);
    }
}

/// Accepts connections until `stop` completes, answering each request with
/// `handler`. Then it accepts nothing new: the connections the kernel had
/// already completed are accepted and served (closing the listener would
/// reset them, and a request sent on one would get no answer), and the
/// listener is closed. Connections being served keep running; waiting for
/// them is the caller's (`shutdown`).
pub async fn serve_until<H, F>(
    listener: TcpListener,
    handler: Arc<H>,
    role: Listener,
    stop: impl Future<Output = ()>,
) -> Result<()>
where
    H: Fn(Request) -> F + Send + Sync + 'static,
    F: Future<Output = Outgoing> + Send + 'static,
{
    tokio::pin!(stop);
    loop {
        let (socket, _) = tokio::select! {
            biased;
            () = &mut stop => break,
            accepted = listener.accept() => accepted?,
        };
        spawn_connection(socket, handler.clone(), role);
    }
    // Without blocking: the first error (none left to accept, or any other)
    // ends the sweep, never the stop that follows.
    let Ok(listener) = listener.into_std() else {
        return Ok(());
    };
    while let Ok((socket, _)) = listener.accept() {
        if socket.set_nonblocking(true).is_ok()
            && let Ok(socket) = TcpStream::from_std(socket)
        {
            spawn_connection(socket, handler.clone(), role);
        }
    }
    Ok(())
}

fn spawn_connection<H, F>(socket: TcpStream, handler: Arc<H>, role: Listener)
where
    H: Fn(Request) -> F + Send + Sync + 'static,
    F: Future<Output = Outgoing> + Send + 'static,
{
    let busy = Busy::new();
    tokio::spawn(async move {
        if let Err(e) = connection_as(socket, handler, role, busy).await {
            match role {
                Listener::Main => eprintln!(
                    "{{\"event\":\"http_connection_error\",\"detail\":{:?}}}",
                    e.to_string()
                ),
                Listener::Shadow => match e.downcast_ref::<HeadRefused>() {
                    Some(refused) => crate::shadow::head_refused(refused.class()),
                    None => crate::shadow::connection_error(&e.to_string()),
                },
            }
        }
    });
}

#[cfg(test)]
async fn connection<H, F>(socket: TcpStream, handler: Arc<H>) -> Result<()>
where
    H: Fn(Request) -> F + Send + Sync + 'static,
    F: Future<Output = Outgoing> + Send + 'static,
{
    connection_as(socket, handler, Listener::Main, Busy::new()).await
}

/// The method and target of a request line, when the head's first line can
/// be read that far; nothing else of the head is trusted.
fn request_line(input: &[u8]) -> (Option<&str>, Option<&str>) {
    let line = input.split(|b| *b == b'\n').next().unwrap_or_default();
    let mut parts = line.split(|b| *b == b' ');
    let mut part = || parts.next().and_then(|p| std::str::from_utf8(p).ok());
    (part(), part())
}

/// A request head this server cannot read (`error`). The main listener
/// answers it as the hand-back it is: no body is decoded and nothing is
/// dispatched, so a 502, marked on the vote and comment write paths as the
/// parser's other hand-backs are, with `Connection: close`. Through nginx the
/// marked 502 sends the whole request to Node, and any other 502 reaches Node
/// through a read location's fallback, where a dropped connection did too.
/// The shadow listener answers nothing, as before, and counts it. Either way
/// the connection then closes and `error` is reported as before.
async fn refuse_head(
    socket: &mut TcpStream,
    role: Listener,
    input: &[u8],
    started: Option<Instant>,
    error: anyhow::Error,
) -> Result<()> {
    if role == Listener::Main {
        let (method, target) = request_line(input);
        let path = target.and_then(|t| t.split('?').next());
        let mut response = crate::route::bad_gateway();
        if method == Some("POST") && path == Some(crate::post_votes::PATH) {
            crate::post_votes::mark_handback(&mut response);
            crate::post_votes::observe(&response);
        }
        if method == Some("POST") && path == Some(crate::post_comments::PATH) {
            crate::post_comments::mark_handback(&mut response);
            crate::post_comments::observe(&response);
        }
        response.close = true;
        let bytes =
            write_response_for(&response, method == Some("HEAD"), false, false, &date_now())?;
        let deadline = started.unwrap_or_else(Instant::now) + REQUEST_DEADLINE;
        if let Ok(Ok(())) = tokio::time::timeout_at(deadline, socket.write_all(&bytes)).await {
            socket.shutdown().await.ok();
        }
    }
    Err(error)
}

async fn connection_as<H, F>(
    mut socket: TcpStream,
    handler: Arc<H>,
    role: Listener,
    mut busy: Busy,
) -> Result<()>
where
    H: Fn(Request) -> F + Send + Sync + 'static,
    F: Future<Output = Outgoing> + Send + 'static,
{
    socket.set_nodelay(true)?;
    let mut input: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    let mut first = true;
    loop {
        // Wait for the next request head within the keep-alive window; once a
        // byte of it has arrived, the whole exchange has one deadline.
        let mut started: Option<Instant> = if input.is_empty() {
            None
        } else {
            Some(Instant::now())
        };
        // Between requests a kept-alive connection is idle: a stop does not
        // wait for it. A new connection's first request is awaited.
        if started.is_none() && !first {
            busy.set(false);
        }
        first = false;
        let head = loop {
            match parse_head(&input) {
                Ok(Some(head)) => break head,
                Ok(None) => {}
                Err(e) => {
                    let refused = anyhow::Error::new(HeadRefused(e));
                    return refuse_head(&mut socket, role, &input, started, refused).await;
                }
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
            busy.set(true);
            started.get_or_insert_with(Instant::now);
            input.extend_from_slice(&buf[..read]);
            if input.len() > LIMIT {
                let over = anyhow!("request over limit");
                return refuse_head(&mut socket, role, &input, started, over).await;
            }
        };
        let deadline = started.unwrap_or_else(Instant::now) + REQUEST_DEADLINE;
        if head.hand_back && role == Listener::Shadow {
            // The live writer would hand this back unread. The shadow answers
            // the copy 204, never the hand-back marker, and closes.
            crate::shadow::body_unread();
            let response = Outgoing {
                status: 204,
                headers: vec![],
                body: Body::Empty,
                close: true,
            };
            let bytes = write_response_for(&response, false, false, head.http10, &date_now())?;
            tokio::time::timeout_at(deadline, socket.write_all(&bytes)).await??;
            socket.shutdown().await.ok();
            return Ok(());
        }
        if head.hand_back {
            // No body is decoded or dispatched. Close so unread body bytes can
            // never be interpreted as another request on this connection.
            let mut response = crate::route::bad_gateway();
            if head.method == "POST"
                && head.target.split('?').next() == Some(crate::post_votes::PATH)
            {
                crate::post_votes::mark_handback(&mut response);
                crate::post_votes::observe(&response);
            }
            if head.method == "POST"
                && head.target.split('?').next() == Some(crate::post_comments::PATH)
            {
                crate::post_comments::mark_handback(&mut response);
                crate::post_comments::observe(&response);
            }
            response.close = true;
            let bytes = write_response_for(&response, false, false, head.http10, &date_now())?;
            tokio::time::timeout_at(deadline, socket.write_all(&bytes)).await??;
            socket.shutdown().await.ok();
            return Ok(());
        }
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
        let holds: Holds = Arc::default();
        let response = match tokio::time::timeout_at(
            deadline,
            RESPONSE_HOLDS.scope(holds.clone(), handler(request)),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => bail!("handler deadline"),
        };
        // An HTTP/1.0 body without a length is delimited by closing.
        let unframed = head.http10 && matches!(response.body, Body::Chunked(_));
        let keep_alive = !head.close && !response.close && !unframed;
        let bytes = write_response_for(&response, head_only, keep_alive, head.http10, &date_now())?;
        let held = holds.lock().map(|h| !h.is_empty()).unwrap_or(true);
        if held {
            // A response that holds a route's place has a bounded write; an
            // error or the deadline ends the connection and lets go of it.
            drop(response);
            tokio::time::timeout(HELD_WRITE_DEADLINE, socket.write_all(&bytes))
                .await
                .map_err(|_| anyhow!("held response write deadline"))??;
            drop(bytes);
            if let Ok(mut h) = holds.lock() {
                h.clear();
            }
        } else {
            socket.write_all(&bytes).await?;
        }
        if !keep_alive {
            socket.shutdown().await.ok();
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn oversized_fixed_length_votes_hand_back_without_dispatch_or_body() {
        for suffix in ["", "?unsupported=true"] {
            for length in [crate::post_votes::MAX_BODY_BYTES + 1, LIMIT + 1, usize::MAX] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    let (socket, _) = listener.accept().await.unwrap();
                    connection(
                        socket,
                        Arc::new(|_| async { panic!("oversized vote must never be dispatched") }),
                    )
                    .await
                    .unwrap();
                });
                let mut client = TcpStream::connect(address).await.unwrap();
                client.write_all(format!("POST /api/v3/votes{suffix} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {length}\r\n\r\n").as_bytes()).await.unwrap();
                let mut response = Vec::new();
                tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut response))
                    .await
                    .unwrap()
                    .unwrap();
                let response = String::from_utf8(response).unwrap();
                assert!(
                    response.starts_with("HTTP/1.1 502 Bad Gateway\r\n"),
                    "{response}"
                );
                assert!(response.contains("Connection: close\r\n"));
                server.await.unwrap();
            }
        }
        // Other routes retain the general limit, including overflow-safe rejection.
        for length in [LIMIT + 1, usize::MAX] {
            assert!(parse_head(format!("POST /other HTTP/1.1\r\nHost: localhost\r\nContent-Length: {length}\r\n\r\n").as_bytes()).is_err());
        }
        let head = parse_head(
            format!(
                "POST /api/v3/votes HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
                crate::post_votes::MAX_BODY_BYTES
            )
            .as_bytes(),
        )
        .unwrap()
        .unwrap();
        assert!(!head.hand_back);
        assert_eq!(head.body_len, crate::post_votes::MAX_BODY_BYTES);
    }

    #[tokio::test]
    async fn chunked_votes_hand_back_before_dispatch_and_close() {
        for suffix in ["", "?unsupported=true"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                connection(
                    socket,
                    Arc::new(|_| async {
                        panic!("transfer-encoded vote must never reach the handler")
                    }),
                )
                .await
                .unwrap();
            });
            let mut client = TcpStream::connect(address).await.unwrap();
            // Send only the head: hand-back must not wait for unknown framing.
            client.write_all(format!("POST /api/v3/votes{suffix} HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = Vec::new();
            tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut response))
                .await
                .unwrap()
                .unwrap();
            let response = String::from_utf8(response).unwrap();
            assert!(
                response.starts_with("HTTP/1.1 502 Bad Gateway\r\n"),
                "{response}"
            );
            assert!(response.contains("Connection: close\r\n"));
            assert!(response.contains("X-Polis-Vote-Dispatch: not-started\r\n"));
            server.await.unwrap();
        }
    }

    /// A comment whose body this server would not read (chunked, or longer
    /// than the comment handler admits) is handed back unread, marked as a
    /// hand-back before dispatch, and the connection is closed.
    #[tokio::test]
    async fn chunked_and_oversized_comments_hand_back_unread_and_marked() {
        let over = crate::post_comments::MAX_BODY_BYTES + 1;
        for framing in [
            "Transfer-Encoding: chunked".to_owned(),
            format!("Content-Length: {over}"),
            format!("Content-Length: {}", LIMIT + 1),
            format!("Content-Length: {}", usize::MAX),
        ] {
            for suffix in ["", "?unsupported=true"] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    let (socket, _) = listener.accept().await.unwrap();
                    connection(
                        socket,
                        Arc::new(|_| async {
                            panic!("an unread comment must never reach the handler")
                        }),
                    )
                    .await
                    .unwrap();
                });
                let mut client = TcpStream::connect(address).await.unwrap();
                // Only the head is sent: the hand-back does not wait for a body.
                client
                    .write_all(
                        format!(
                            "POST /api/v3/comments{suffix} HTTP/1.1\r\nHost: localhost\r\n{framing}\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                let mut response = Vec::new();
                tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut response))
                    .await
                    .unwrap()
                    .unwrap();
                let response = String::from_utf8(response).unwrap();
                assert!(
                    response.starts_with("HTTP/1.1 502 Bad Gateway\r\n"),
                    "{framing}: {response}"
                );
                assert!(response.contains("Connection: close\r\n"));
                assert!(response.contains("X-Polis-Comment-Dispatch: not-started\r\n"));
                assert!(!response.contains("X-Polis-Vote-Dispatch"));
                server.await.unwrap();
            }
        }
        // The largest admitted body is read; a GET on the same path keeps
        // the listener's general rule.
        let head = parse_head(
            format!(
                "POST /api/v3/comments HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
                crate::post_comments::MAX_BODY_BYTES
            )
            .as_bytes(),
        )
        .unwrap()
        .unwrap();
        assert!(!head.hand_back);
        assert_eq!(head.body_len, crate::post_comments::MAX_BODY_BYTES);
        assert!(
            parse_head(
                b"GET /api/v3/comments HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n"
            )
            .is_err()
        );
    }

    /// What the server writes back, and how the connection ended, for one
    /// raw request on a fresh connection whose handler must never run.
    async fn exchange_refused(raw: Vec<u8>) -> (String, Result<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            connection(
                socket,
                Arc::new(|_| async { panic!("a refused head must never reach the handler") }),
            )
            .await
        });
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(&raw).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let ended = server.await.unwrap();
        (String::from_utf8(response).unwrap(), ended)
    }

    /// The response with its Date line removed.
    fn without_date(response: &str) -> String {
        response
            .split("\r\n")
            .filter(|line| !line.starts_with("Date: "))
            .collect::<Vec<_>>()
            .join("\r\n")
    }

    /// Every way a request head can fail to parse: what follows the request
    /// line (and its `Host`), or the whole head for the last two.
    fn refused_heads(method: &str, path: &str) -> Vec<(&'static str, Vec<u8>)> {
        let head = |extra: &[u8]| {
            let mut raw = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n").into_bytes();
            raw.extend_from_slice(extra);
            raw.extend_from_slice(b"\r\n");
            raw
        };
        let many: String = (0..128).map(|i| format!("X-Extra-{i}: v\r\n")).collect();
        let mut over_limit =
            format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nX-Long: ").into_bytes();
        // No end of head: the server reads all of it and then refuses it.
        over_limit.resize(LIMIT + 1, b'a');
        vec![
            (
                "a header value that is not UTF-8",
                head(b"X-Name: caf\xe9\r\n"),
            ),
            ("more than 128 header lines", head(many.as_bytes())),
            (
                "a control byte in a header value",
                head(b"X-Name: a\x01b\r\n"),
            ),
            ("a header name that is not a token", head(b"X Name: v\r\n")),
            (
                "a Content-Length that is not a number",
                head(b"Content-Length: ten\r\n"),
            ),
            (
                "a Content-Length no size can hold",
                head(b"Content-Length: 99999999999999999999999\r\n"),
            ),
            (
                "two different Content-Lengths",
                head(b"Content-Length: 2\r\nContent-Length: 3\r\n"),
            ),
            (
                "a request line with an unknown version",
                format!("{method} {path} HTTP/7.1\r\nHost: localhost\r\n\r\n").into_bytes(),
            ),
            ("a head longer than the limit", over_limit),
        ]
    }

    /// A vote whose head this server cannot parse is answered, never dropped:
    /// the same marked 502 the parser's own hand-back gives (a chunked vote),
    /// with `Connection: close`, and nothing reaches the handler. Through
    /// nginx the marker hands the whole request to Node, which reads it with
    /// its own parser and records the vote. Dropping the connection instead
    /// gave nginx's own 502, and the vote was never recorded.
    #[tokio::test]
    async fn votes_whose_head_does_not_parse_hand_back_marked_before_dispatch() {
        let (marked, _) = exchange_refused(
            b"POST /api/v3/votes HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n"
                .to_vec(),
        )
        .await;
        let marked = without_date(&marked);
        assert!(
            marked.contains("X-Polis-Vote-Dispatch: not-started\r\n"),
            "{marked}"
        );
        for suffix in ["", "?unsupported=true"] {
            let path = format!("{}{suffix}", crate::post_votes::PATH);
            for (case, raw) in refused_heads("POST", &path) {
                let (response, ended) = exchange_refused(raw).await;
                assert_eq!(without_date(&response), marked, "{case} {suffix}");
                assert!(
                    ended.is_err_and(|e| e.downcast_ref::<HeadRefused>().is_some()
                        || e.to_string() == "request over limit"),
                    "{case}: the refusal is still reported"
                );
            }
        }
    }

    /// The comment write path's refusal carries its own marker; any other
    /// request this server cannot parse is answered 502 with no marker (a read
    /// location's fallback sends every 502 to Node, as it did the drop).
    #[tokio::test]
    async fn other_requests_whose_head_does_not_parse_are_answered_502() {
        for (method, path, marker) in [
            (
                "POST",
                crate::post_comments::PATH,
                Some("X-Polis-Comment-Dispatch: not-started\r\n"),
            ),
            ("GET", crate::post_votes::PATH, None),
            ("GET", "/api/v3/math/pca2?conversation_id=2fixture", None),
            ("POST", "/api/v3/other", None),
        ] {
            for (case, raw) in refused_heads(method, path) {
                let (response, _) = exchange_refused(raw).await;
                assert!(
                    response.starts_with("HTTP/1.1 502 Bad Gateway\r\n"),
                    "{method} {path} {case}: {response:?}"
                );
                assert!(response.contains("Connection: close\r\n"), "{case}");
                assert!(response.ends_with("\r\n\r\nBad Gateway\n"), "{case}");
                assert!(!response.contains("X-Polis-Vote-Dispatch"), "{case}");
                match marker {
                    Some(marker) => assert!(response.contains(marker), "{case}"),
                    None => assert!(!response.contains("-Dispatch:"), "{case}"),
                }
            }
        }
    }

    /// Connections the kernel completed before the stop and that the accept
    /// loop never took (here: all of them, because the stop is already
    /// complete when the loop first polls) are swept: each is answered, and a
    /// connection after the sweep is refused.
    #[tokio::test]
    async fn the_sweep_answers_every_connection_queued_at_the_stop() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut clients = Vec::new();
        for i in 0..64 {
            let mut c = TcpStream::connect(address).await.unwrap();
            let request = if i % 2 == 0 {
                format!("GET /queued/{i} HTTP/1.0\r\nHost: h\r\n\r\n")
            } else {
                // A body that has fully arrived before the stop.
                format!("POST /queued/{i} HTTP/1.0\r\nHost: h\r\nContent-Length: 4\r\n\r\nbody")
            };
            c.write_all(request.as_bytes()).await.unwrap();
            clients.push(c);
        }
        let handler = Arc::new(|req: Request| async move {
            let body = req.target.clone().into_bytes();
            Outgoing {
                status: 200,
                headers: vec![("Content-Length".into(), body.len().to_string())],
                body: Body::Fixed(body),
                close: false,
            }
        });
        serve_until(listener, handler, Listener::Main, std::future::ready(()))
            .await
            .unwrap();
        let refused = TcpStream::connect(address).await;
        for (i, mut c) in clients.into_iter().enumerate() {
            let mut response = Vec::new();
            tokio::time::timeout(Duration::from_secs(5), c.read_to_end(&mut response))
                .await
                .unwrap()
                .unwrap();
            let response = String::from_utf8(response).unwrap();
            assert!(
                response.starts_with("HTTP/1.1 200 OK\r\n"),
                "{i}: {response:?}"
            );
            assert!(
                response.ends_with(&format!("/queued/{i}")),
                "{i}: {response:?}"
            );
        }
        assert!(refused.is_err(), "the listener is closed after the sweep");
    }

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
    fn conflict_status_line_and_head_preserve_the_wire_contract() {
        let out = Outgoing {
            status: 409,
            headers: vec![("Content-Length".into(), "8".into())],
            body: Body::Fixed(b"conflict".to_vec()),
            close: false,
        };
        let full = write_response(&out, false, true, "D").unwrap();
        let head = write_response(&out, true, true, "D").unwrap();
        assert!(full.starts_with(b"HTTP/1.1 409 Conflict\r\n"));
        assert!(full.ends_with(b"\r\n\r\nconflict"));
        assert_eq!(head, &full[..full.len() - 8]);
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
    fn selection_write_framing_hands_back_without_body_dispatch() {
        for method in ["POST", "PUT", "DELETE"] {
            for suffix in ["", "?conversation_id=generated"] {
                let path = format!("{}{suffix}", crate::topic_selections::PATH);
                for size in [65537, LIMIT + 1, usize::MAX] {
                    let head=parse_head(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {size}\r\n\r\n").as_bytes()).unwrap().unwrap();
                    assert!(head.hand_back);
                    assert_eq!(head.body_len, 0);
                }
                let head = parse_head(
                    format!("{method} {path} HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap()
                .unwrap();
                assert!(head.hand_back);
                assert_eq!(head.body_len, 0);
            }
        }
        let head = parse_head(
            format!(
                "POST {} HTTP/1.1\r\nContent-Length: 65536\r\n\r\n",
                crate::topic_selections::PATH
            )
            .as_bytes(),
        )
        .unwrap()
        .unwrap();
        assert!(!head.hand_back);
        assert_eq!(head.body_len, 65536);
    }

    #[test]
    fn wave_write_framing_hands_back_before_dispatch() {
        for suffix in ["", "?conversation_id=fixture"] {
            for framing in [
                "Transfer-Encoding: chunked".to_owned(),
                "Content-Length: 65537".to_owned(),
                format!("Content-Length: {}", usize::MAX),
            ] {
                let head = parse_head(
                    format!(
                        "POST {}{suffix} HTTP/1.1\r\nHost: localhost\r\n{framing}\r\n\r\n",
                        crate::post_treevite_waves::PATH
                    )
                    .as_bytes(),
                )
                .unwrap()
                .unwrap();
                assert!(head.hand_back);
                assert_eq!(head.body_len, 0);
            }
        }
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
