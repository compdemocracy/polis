//! A local HTTP stub of the Messages API, and the fixtures. No test makes a
//! call to any provider: every call goes to 127.0.0.1.

#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use polis_topic_names::{Hierarchy, Namer, client::Settings};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

pub fn fixture_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(rel)
}

pub fn fixture(rel: &str) -> String {
    std::fs::read_to_string(fixture_path(rel)).unwrap()
}

pub fn hierarchy(conv: &str) -> Hierarchy {
    Hierarchy::from_json(&fixture(&format!("hierarchies/{conv}.json"))).unwrap()
}

pub fn namer(model: &str, thinking: &str) -> Namer {
    Namer::from_json(&format!(
        r#"{{"model":"claude-{model}-5-5","prompt":"polis-topic-names/1","thinking":"{thinking}"}}"#
    ))
    .unwrap()
}

/// Settings for the stub: short timeout, no wait before a second try to
/// connect.
pub fn settings(url: &str) -> Settings {
    Settings {
        api_base: url.to_string(),
        timeout: Duration::from_secs(10),
        connect_timeout: Duration::from_secs(5),
        reconnect_wait: Duration::from_millis(0),
        resolver: None,
    }
}

/// What the stub does with one connection.
#[derive(Clone)]
pub enum Reply {
    Http {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Read the request, then say nothing for this long.
    Hang(Duration),
    /// Read the request's head, then close with the rest of it unread, which
    /// resets the connection.
    Reset,
    /// Read the whole request, then close without a reply.
    Close,
    /// HTTP 200 whose `content-length` is the whole body's, with only its
    /// first half written before the connection closes.
    Truncated(Vec<u8>),
}

impl Reply {
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self::Http {
            status: 200,
            headers: vec![],
            body: body.into(),
        }
    }

    pub fn status(status: u16, retry_after: Option<&str>) -> Self {
        Self::Http {
            status,
            headers: retry_after
                .map(|r| vec![("retry-after".to_string(), r.to_string())])
                .unwrap_or_default(),
            body: br#"{"type":"error","error":{"type":"rate_limit_error","message":"stub"}}"#
                .to_vec(),
        }
    }
}

/// One request as the stub received it.
#[derive(Clone, Debug)]
pub struct Received {
    pub request_line: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub struct Stub {
    pub url: String,
    pub port: u16,
    received: Arc<Mutex<Vec<Received>>>,
    handle: Option<JoinHandle<()>>,
}

impl Stub {
    /// Serves the replies in order, one per connection, then closes.
    pub fn start(replies: Vec<Reply>) -> Self {
        Self::start_counting(replies, Duration::ZERO)
    }

    /// Serves the replies in order, one per connection, then keeps listening
    /// for `grace`, answering any further request with HTTP 500 and counting
    /// it, so a request sent again is seen rather than refused.
    pub fn start_counting(replies: Vec<Reply>, grace: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/v1");
        let received = Arc::new(Mutex::new(Vec::new()));
        let rec = Arc::clone(&received);
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            let mut replies = replies.into_iter();
            let mut extra_until = None;
            loop {
                let reply = match replies.next() {
                    Some(r) => r,
                    None if grace.is_zero() => return,
                    None => {
                        let until =
                            *extra_until.get_or_insert_with(|| std::time::Instant::now() + grace);
                        if std::time::Instant::now() > until {
                            return;
                        }
                        Reply::status(500, Some("0"))
                    }
                };
                let deadline = extra_until.unwrap_or(deadline);
                // Poll, so a client that makes fewer calls than expected ends
                // the stub (and the test's assertion fails) instead of hanging.
                let mut stream = loop {
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            if std::time::Instant::now() > deadline {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => return,
                    }
                };
                if stream.set_nonblocking(false).is_err() {
                    return;
                }
                if let Reply::Reset = reply {
                    if let Some(req) = read_head(&mut stream) {
                        rec.lock().unwrap().push(req);
                    }
                    drop(stream);
                    continue;
                }
                let Some(req) = read_request(&mut stream) else {
                    return;
                };
                rec.lock().unwrap().push(req);
                match reply {
                    Reply::Http {
                        status,
                        headers,
                        body,
                    } => {
                        let mut head = format!(
                            "HTTP/1.1 {status} STUB\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
                            body.len()
                        );
                        for (k, v) in headers {
                            head.push_str(&format!("{k}: {v}\r\n"));
                        }
                        head.push_str("\r\n");
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(&body);
                        let _ = stream.flush();
                    }
                    Reply::Hang(d) => std::thread::sleep(d),
                    Reply::Reset => {}
                    Reply::Close => {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                    Reply::Truncated(body) => {
                        let head = format!(
                            "HTTP/1.1 200 STUB\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(&body[..body.len() / 2]);
                        let _ = stream.flush();
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                }
            }
        });
        Self {
            url,
            port,
            received,
            handle: Some(handle),
        }
    }

    /// The requests received, after the stub has served every reply or the
    /// client has gone.
    pub fn received(&self) -> Vec<Received> {
        self.received.lock().unwrap().clone()
    }

    /// Waits for the stub to serve every reply (or give up waiting) and
    /// returns what it received.
    pub fn finish(mut self) -> Vec<Received> {
        if let Some(h) = self.handle.take() {
            h.join().unwrap();
        }
        self.received()
    }
}

/// Reads only the request's head (and whatever of the body came with it).
fn read_head(stream: &mut TcpStream) -> Option<Received> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_string();
            return Some(Received {
                request_line: head.split("\r\n").next()?.to_string(),
                headers: vec![],
                body: vec![],
            });
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Received> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Received {
        request_line,
        headers,
        body,
    })
}

/// A reply body in the provider's shape whose text is `text`.
pub fn message(text: &str, stop_reason: &str) -> String {
    serde_json::json!({
        "id": "msg_stub",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-5-5",
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "usage": {"input_tokens": 100, "output_tokens": 50}
    })
    .to_string()
}

/// The `{"topics": [...]}` text of a saved reply, as a list of (id, name).
pub fn saved_topics(rel: &str) -> Vec<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(&fixture(rel)).unwrap();
    let text: String = v["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b["type"] == "text")
        .map(|b| b["text"].as_str().unwrap().to_string())
        .collect();
    let t: serde_json::Value = serde_json::from_str(&text).unwrap();
    t["topics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["id"].as_str().unwrap().to_string(),
                i["name"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// The reply text for a list of (id, name).
pub fn topics_text(items: &[(String, String)]) -> String {
    let list: Vec<serde_json::Value> = items
        .iter()
        .map(|(id, name)| serde_json::json!({"id": id, "name": name}))
        .collect();
    serde_json::json!({ "topics": list }).to_string()
}
