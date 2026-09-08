//! HTTP/1 compatibility transport. Axum dispatches the single route; this writer
//! preserves the contract's header spelling/order (hyper's HeaderMap cannot).
//! One request per connection; Connection is excluded by the pinned wire policy.
use crate::{Error, OrderedHeaders};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tower::ServiceExt;
const LIMIT: usize = 1024 * 1024;
pub async fn serve(listener: TcpListener, router: Router) -> Result<(), Error> {
    loop {
        let (socket, _) = listener.accept().await?;
        let router = router.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(std::time::Duration::from_secs(15), one(socket, router))
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("http connection: {e}"),
                Err(_) => eprintln!("http request deadline"),
            }
        });
    }
}
async fn one(mut socket: TcpStream, router: Router) -> Result<(), Error> {
    let mut input = Vec::new();
    let mut buf = [0u8; 8192];
    let (header_len, method, path, headers, length) = loop {
        let n = socket.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        input.extend_from_slice(&buf[..n]);
        if input.len() > LIMIT {
            return Err("request exceeds limit".into());
        }
        let mut fields = [httparse::EMPTY_HEADER; 128];
        let mut req = httparse::Request::new(&mut fields);
        if let httparse::Status::Complete(offset) = req.parse(&input)? {
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
            break (
                offset,
                req.method.unwrap().to_string(),
                req.path.unwrap().to_string(),
                headers,
                length,
            );
        }
    };
    while input.len() < header_len + length {
        let n = socket.read(&mut buf).await?;
        if n == 0 {
            return Err("truncated request".into());
        }
        input.extend_from_slice(&buf[..n]);
    }
    let mut request = Request::builder().method(method.as_str()).uri(path);
    for (k, v) in headers {
        request = request.header(k, v);
    }
    let request = request.body(Body::from(input[header_len..header_len + length].to_vec()))?;
    let result = router.oneshot(request).await?;
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
    output.push_str("Connection: close\r\n\r\n");
    socket.write_all(output.as_bytes()).await?;
    // Express matches HEAD to the app.get route, runs the handler and calls
    // `res.end()` with no chunk, so the headers stand and no body is written.
    if method.eq_ignore_ascii_case("HEAD") {
        socket.shutdown().await?;
        return Ok(());
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
    socket.shutdown().await?;
    Ok(())
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = Router::new().route("/x", get(hello).head(hello));
        tokio::spawn(async move { serve(listener, router).await });
        addr
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
