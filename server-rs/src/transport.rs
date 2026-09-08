//! HTTP/1 compatibility transport. Axum dispatches the routes; this writer
//! preserves the contract's header spelling/order (hyper's HeaderMap cannot).
//!
//! Connections are persistent. `/api/v3/math/pca2` is polled every 2.5s by every
//! open client, so a connection setup per poll is a throughput and tail-latency
//! regression against Node that the byte gate cannot see, because `Connection` is
//! on the exclusion list. `Connection: keep-alive` itself is written by
//! `writeDefaultHead` (`domain.ts:14-18`) and so travels with the response headers,
//! not with this writer.
use crate::{Error, OrderedHeaders};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tower::ServiceExt;
const LIMIT: usize = 1024 * 1024;
/// Two separate clocks. `idle` is Node's `server.keepAliveTimeout`, and like
/// Node's it applies only while a socket is waiting for the next request to
/// begin. `request` is the deadline for serving one, and covers routing, SQL,
/// body generation and the response write.
///
/// Conflating the two is a live defect, not a tuning question: wrapping the whole
/// exchange in the idle window cancels a handler that is doing its job, and it
/// does so on the connection's very first request, where nothing has been idle at
/// all.
#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub idle: Duration,
    pub request: Duration,
}
impl Default for Timeouts {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(5),
            request: Duration::from_secs(15),
        }
    }
}
pub async fn serve(listener: TcpListener, router: Router) -> Result<(), Error> {
    serve_with(listener, router, Timeouts::default()).await
}
pub async fn serve_with(
    listener: TcpListener,
    router: Router,
    timeouts: Timeouts,
) -> Result<(), Error> {
    loop {
        let (socket, _) = listener.accept().await?;
        let router = router.clone();
        tokio::spawn(async move {
            if let Err(e) = connection(socket, router, timeouts).await {
                eprintln!("http connection: {e}");
            }
        });
    }
}
/// Serves requests until the peer closes, asks to close, sends nothing for the idle
/// window, or produces a response this writer cannot delimit.
async fn connection(
    mut socket: TcpStream,
    router: Router,
    timeouts: Timeouts,
) -> Result<(), Error> {
    let mut input = Vec::new();
    loop {
        // Waiting is timed by the idle clock; serving is timed by the request clock.
        let Some(head) = read_head(&mut socket, &mut input, timeouts).await? else {
            break;
        };
        match tokio::time::timeout(
            timeouts.request,
            one(&mut socket, &router, &mut input, head),
        )
        .await
        {
            Ok(Ok(true)) => continue,
            Ok(Ok(false)) => break,
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                eprintln!("http request deadline");
                break;
            }
        }
    }
    socket.shutdown().await?;
    Ok(())
}
/// Reads until a complete request head is buffered. `None` means the peer closed
/// or let the keep-alive window lapse before starting a request. Once the first
/// byte of a request has arrived the request clock takes over, so a slow header
/// is a request deadline rather than an idle expiry.
async fn read_head(
    socket: &mut TcpStream,
    input: &mut Vec<u8>,
    timeouts: Timeouts,
) -> Result<Option<Parsed>, Error> {
    let mut buf = [0u8; 8192];
    loop {
        let mut fields = [httparse::EMPTY_HEADER; 128];
        let mut req = httparse::Request::new(&mut fields);
        if let httparse::Status::Complete(offset) = req.parse(input)? {
            return Ok(Some(parse(offset, &req)?));
        }
        let started = !input.is_empty();
        let deadline = if started {
            timeouts.request
        } else {
            timeouts.idle
        };
        let n = match tokio::time::timeout(deadline, socket.read(&mut buf)).await {
            Ok(n) => n?,
            Err(_) if started => return Err("http request header deadline".into()),
            Err(_) => return Ok(None),
        };
        if n == 0 {
            return Ok(None);
        }
        input.extend_from_slice(&buf[..n]);
        if input.len() > LIMIT {
            return Err("request exceeds limit".into());
        }
    }
}
/// Serves one already-parsed request. Returns whether the connection may serve another.
async fn one(
    socket: &mut TcpStream,
    router: &Router,
    input: &mut Vec<u8>,
    head: Parsed,
) -> Result<bool, Error> {
    let mut buf = [0u8; 8192];
    let (header_len, method, path, headers, length) = head;
    while input.len() < header_len + length {
        let n = socket.read(&mut buf).await?;
        if n == 0 {
            return Err("truncated request".into());
        }
        input.extend_from_slice(&buf[..n]);
        if input.len() > LIMIT {
            return Err("request exceeds limit".into());
        }
    }
    let request_headers = headers;
    let mut request = Request::builder().method(method.as_str()).uri(path);
    for (k, v) in &request_headers {
        request = request.header(k, v);
    }
    let request = request.body(Body::from(input[header_len..header_len + length].to_vec()))?;
    // Anything after this request belongs to the next one on the same connection.
    input.drain(..header_len + length);
    let result = router.clone().oneshot(request).await?;
    let status = result.status();
    let headers = result.extensions().get::<OrderedHeaders>().cloned();
    let body = to_bytes(result.into_body(), 64 * 1024 * 1024).await?;
    let headers = headers
        .unwrap_or(OrderedHeaders(vec![(
            "Content-Length".into(),
            body.len().to_string(),
        )]))
        .0;
    let chunked = headers
        .iter()
        .any(|(k, v)| k == "Transfer-Encoding" && v == "chunked");
    let framed = chunked || body.is_empty() || headers.iter().any(|(k, _)| k == "Content-Length");
    // HTTP/1.0 and an explicit close request both end the connection after this
    // response; an undelimitable body has to end it too, since the peer would
    // otherwise read the next response as a continuation of this one.
    let reuse = framed
        && !request_headers
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("connection") && v.eq_ignore_ascii_case("close"));
    let mut output = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for (k, v) in headers {
        if v.contains(['\r', '\n']) {
            return Err("invalid response header".into());
        }
        output.push_str(&format!("{k}: {v}\r\n"));
    }
    output.push_str("\r\n");
    socket.write_all(output.as_bytes()).await?;
    // Express matches HEAD to the app.get route, runs the handler and calls
    // `res.end()` with no chunk, so the headers stand and no body is written.
    if method.eq_ignore_ascii_case("HEAD") {
        return Ok(reuse);
    }
    if chunked {
        socket
            .write_all(format!("{:x}\r\n", body.len()).as_bytes())
            .await?;
        socket.write_all(&body).await?;
        socket.write_all(b"\r\n0\r\n\r\n").await?;
    } else {
        socket.write_all(&body).await?;
    }
    Ok(reuse)
}
/// Splits the request line and headers out of a parsed request.
type Parsed = (usize, String, String, Vec<(String, String)>, usize);
fn parse(offset: usize, req: &httparse::Request<'_, '_>) -> Result<Parsed, Error> {
    let headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|h| {
            Ok((
                h.name.to_string(),
                std::str::from_utf8(h.value)?.to_string(),
            ))
        })
        .collect::<Result<_, std::str::Utf8Error>>()?;
    let lengths: Vec<_> = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .collect();
    if lengths.len() > 1
        || headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
    {
        return Err("ambiguous/unsupported request framing".into());
    }
    let length = lengths
        .first()
        .map(|(_, v)| v.parse::<usize>())
        .transpose()?
        .unwrap_or(0);
    if length > LIMIT {
        return Err("request exceeds limit".into());
    }
    Ok((
        offset,
        req.method.unwrap().to_string(),
        req.path.unwrap().to_string(),
        headers,
        length,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::OrderedHeaders;
    use axum::{Router, response::Response, routing::get};
    async fn hello() -> Response<Body> {
        let mut r = Response::builder().body(Body::from("hello")).unwrap();
        r.extensions_mut().insert(OrderedHeaders(vec![
            ("Content-Type".into(), "text/plain".into()),
            ("Content-Length".into(), "5".into()),
        ]));
        r
    }
    async fn listening() -> std::net::SocketAddr {
        listening_with(Timeouts::default()).await
    }
    async fn listening_with(timeouts: Timeouts) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // A handler that takes longer than the idle window to answer.
        async fn slow() -> Response<Body> {
            tokio::time::sleep(Duration::from_millis(250)).await;
            hello().await
        }
        let router = Router::new()
            .route("/x", get(hello).head(hello))
            .route("/slow", get(slow));
        tokio::spawn(async move { serve_with(listener, router, timeouts).await });
        addr
    }
    /// The idle window is Node's keep-alive timeout: it governs a socket waiting
    /// for its next request, never a request already being served. Before this
    /// change the whole exchange ran under the idle clock, so a handler slower
    /// than the window was cancelled with zero response bytes — on the first
    /// request of a connection, where nothing had been idle at all.
    #[tokio::test]
    async fn a_slow_handler_outlives_the_idle_window() {
        let addr = listening_with(Timeouts {
            idle: Duration::from_millis(100),
            request: Duration::from_secs(10),
        })
        .await;
        let out = exchange(
            addr,
            "GET /slow HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(out.ends_with("hello"), "handler was cancelled: {out:?}");
    }
    #[tokio::test]
    async fn an_actually_idle_socket_still_expires() {
        let addr = listening_with(Timeouts {
            idle: Duration::from_millis(100),
            request: Duration::from_secs(10),
        })
        .await;
        let started = std::time::Instant::now();
        // Connect, send nothing, and expect the keep-alive window to close it.
        let mut socket = TcpStream::connect(addr).await.unwrap();
        let mut rest = Vec::new();
        socket.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "idle window ignored"
        );
    }
    #[tokio::test]
    async fn a_second_request_on_an_idle_connection_is_still_served() {
        let addr = listening_with(Timeouts {
            idle: Duration::from_millis(400),
            request: Duration::from_secs(10),
        })
        .await;
        let mut socket = TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 4096];
        for _ in 0..2 {
            socket
                .write_all(b"GET /slow HTTP/1.1\r\nHost: t\r\n\r\n")
                .await
                .unwrap();
            let mut response = String::new();
            while !response.ends_with("hello") {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0, "connection closed mid-response: {response:?}");
                response.push_str(std::str::from_utf8(&buf[..n]).unwrap());
            }
        }
    }
    async fn exchange(addr: std::net::SocketAddr, request: &str) -> String {
        let mut socket = TcpStream::connect(addr).await.unwrap();
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            out.push_str(std::str::from_utf8(&buf[..n]).unwrap());
        }
        out
    }
    /// M1: two requests, one connection. The writer no longer forces
    /// `Connection: close`, so the handler's own keep-alive header stands.
    #[tokio::test]
    async fn one_connection_serves_successive_requests() {
        let addr = listening().await;
        let mut socket = TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 4096];
        for _ in 0..3 {
            socket
                .write_all(b"GET /x HTTP/1.1\r\nHost: t\r\n\r\n")
                .await
                .unwrap();
            // The response may arrive in more than one segment; read until complete.
            let mut response = String::new();
            while !response.ends_with("hello") {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0, "connection closed mid-response: {response:?}");
                response.push_str(std::str::from_utf8(&buf[..n]).unwrap());
            }
            assert!(!response.contains("Connection: close"), "{response:?}");
        }
        // An explicit close request still ends the connection after the response.
        socket
            .write_all(b"GET /x HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut rest = Vec::new();
        socket.read_to_end(&mut rest).await.unwrap();
        assert!(String::from_utf8(rest).unwrap().ends_with("hello"));
    }
    #[tokio::test]
    async fn pipelined_requests_are_not_lost() {
        let addr = listening().await;
        let mut socket = TcpStream::connect(addr).await.unwrap();
        socket
            .write_all(
                b"GET /x HTTP/1.1\r\nHost: t\r\n\r\nGET /x HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut out = Vec::new();
        socket.read_to_end(&mut out).await.unwrap();
        let out = String::from_utf8(out).unwrap();
        assert_eq!(out.matches("hello").count(), 2, "{out:?}");
    }
    #[tokio::test]
    async fn head_sends_the_get_headers_and_no_body() {
        let addr = listening().await;
        let get = exchange(
            addr,
            "GET /x HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
        )
        .await;
        let head = exchange(
            addr,
            "HEAD /x HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(get.ends_with("\r\n\r\nhello"), "{get:?}");
        let (get_headers, _) = get.split_once("\r\n\r\n").unwrap();
        let (head_headers, body) = head.split_once("\r\n\r\n").unwrap();
        assert_eq!(get_headers, head_headers);
        assert_eq!(body, "", "HEAD must carry the headers and no body");
    }
}
