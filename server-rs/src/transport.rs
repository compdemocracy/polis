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
