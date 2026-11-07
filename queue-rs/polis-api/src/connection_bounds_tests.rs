//! Fault-injection checks for connection capacity, using an ACKing silent peer.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};

// This is a reclamation ceiling, not a request deadline. The peer remains
// silent until after the observation so closing the fixture cannot pass it.
const RECLAIM_CEILING: Duration = Duration::from_secs(6);

fn fault_ports() -> (u16, u16) {
    static PORTS: std::sync::OnceLock<(u16, u16)> = std::sync::OnceLock::new();
    *PORTS.get_or_init(|| {
        // Use the same definition and override variables as the host harnesses.
        let output = std::process::Command::new("python3")
            .args(["-c", "import os, sys; sys.path.insert(0, sys.argv[1]); from host_ports import DEFAULT_WINDOW, port; print(port(os.environ.get('P027_PORT_MIN', DEFAULT_WINDOW[0]))); print(port(os.environ.get('P027_PORT_MAX', DEFAULT_WINDOW[1])))"])
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../ci"))
            .output().expect("read shared host-port policy");
        assert!(output.status.success(), "invalid fault port window: {}", String::from_utf8_lossy(&output.stderr));
        let values: Vec<u16> = String::from_utf8(output.stdout).unwrap().lines()
            .map(|value| value.parse().unwrap()).collect();
        assert_eq!(values.len(), 2);
        assert!(values[0] <= values[1], "fault port window is reversed");
        (values[0], values[1])
    })
}

fn test_url() -> String {
    std::env::var("POLIS_API_TEST_DATABASE_URL").expect("provide the isolated test database")
}

pub(crate) struct Peer {
    pub(crate) port: u16,
    mode: watch::Sender<u8>,
    pub(crate) accepted: Arc<AtomicUsize>,
    pub(crate) closed: Arc<AtomicUsize>,
    ready: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Peer {
    pub(crate) async fn new(upstream: Option<u16>) -> Self {
        Self::spawn(upstream, false).await
    }

    async fn session_setup(upstream: u16) -> Self {
        Self::spawn(Some(upstream), true).await
    }

    async fn spawn(upstream: Option<u16>, stop_after_ready: bool) -> Self {
        let mut listener = None;
        for port in fault_ports().0..=fault_ports().1 {
            if let Ok(bound) = TcpListener::bind(("127.0.0.1", port)).await {
                listener = Some(bound);
                break;
            }
        }
        let listener = listener.expect("an owned fault-injection port is available");
        let port = listener.local_addr().unwrap().port();
        let (mode, mut receiver) = watch::channel(if upstream.is_some() { 0 } else { 1 });
        let accepted = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(AtomicUsize::new(0));
        let ready_copy = ready.clone();
        let accepted_copy = accepted.clone();
        let closed_copy = closed.clone();
        let task = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = receiver.changed() => {
                        if *receiver.borrow() == 2 { break; }
                    }
                    incoming = listener.accept() => {
                        let (mut client, _) = incoming.unwrap();
                        // Match the real driver: the forwarding fixture must
                        // not add Nagle/delayed-ACK pauses to healthy queries.
                        client.set_nodelay(true).unwrap();
                        accepted_copy.fetch_add(1, SeqCst);
                        let mut mode = receiver.clone();
                        let closed = closed_copy.clone();
                        let ready = ready_copy.clone();
                        children.spawn(async move {
                            // Keep the upstream open after forwarding stops. The
                            // client sees neither FIN nor RST from this fixture.
                            let mut server = if let Some(port) = upstream {
                                let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                                stream.set_nodelay(true).unwrap();
                                Some(stream)
                            } else { None };
                            if *mode.borrow() == 0 && stop_after_ready {
                                let (mut cr, mut cw) = tokio::io::split(&mut client);
                                let (mut sr, mut sw) = tokio::io::split(server.as_mut().unwrap());
                                let responses = async {
                                    loop {
                                        let mut header = [0; 5];
                                        sr.read_exact(&mut header).await.unwrap();
                                        let len = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
                                        assert!((4..65536).contains(&len));
                                        let mut body = vec![0; len - 4];
                                        sr.read_exact(&mut body).await.unwrap();
                                        cw.write_all(&header).await.unwrap();
                                        cw.write_all(&body).await.unwrap();
                                        if header[0] == b'Z' {
                                            ready.fetch_add(1, SeqCst);
                                            break;
                                        }
                                    }
                                };
                                tokio::select! {
                                    _ = mode.changed() => {}
                                    _ = responses => {}
                                    _ = tokio::io::copy(&mut cr, &mut sw) => {}
                                }
                            } else if *mode.borrow() == 0 {
                                tokio::select! {
                                    _ = mode.changed() => {}
                                    _ = tokio::io::copy_bidirectional(&mut client, server.as_mut().unwrap()) => { return; }
                                }
                            }
                            let mut bytes = [0; 4096];
                            loop {
                                if *mode.borrow() == 2 { break; }
                                tokio::select! {
                                    _ = mode.changed() => {}
                                    read = client.read(&mut bytes) => {
                                        match read {
                                            Ok(0) | Err(_) => { closed.fetch_add(1, SeqCst); break; }
                                            Ok(_) => {} // ACK and discard; never send a reply.
                                        }
                                    }
                                }
                            }
                        });
                    }
                }
            }
            while children.join_next().await.is_some() {}
        });
        Self {
            port,
            mode,
            accepted,
            closed,
            ready,
            task,
        }
    }

    pub(crate) fn silence(&self) {
        self.mode.send_replace(1);
    }
    pub(crate) fn resume(&self) {
        self.mode.send_replace(0);
    }

    pub(crate) async fn stop(self) {
        self.mode.send_replace(2);
        self.task.await.unwrap();
    }
    pub(crate) fn connector(&self, template: &str) -> Connector {
        let mut config: postgres::Config = template.parse().unwrap();
        // The test DSN has one literal IPv4 host and no TLS.
        assert_eq!(config.get_hosts().len(), 1);
        let dsn = template.replace(
            &format!(":{}", config.get_ports()[0]),
            &format!(":{}", self.port),
        );
        config = dsn.parse().unwrap();
        Connector::Plain(Box::new(config))
    }
}

fn limits() -> Limits {
    Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(1000),
        max_lifetime: Duration::from_secs(300),
    }
}

async fn wait_for(mut predicate: impl FnMut() -> bool, ceiling: Duration) -> bool {
    tokio::time::timeout(ceiling, async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

async fn stalled_setup(writable: bool) {
    let peer = Peer::new(None).await;
    let connector = peer.connector(&test_url());
    let pool = if writable {
        Pool::writer(connector, limits())
    } else {
        Pool::new(connector, limits())
    };
    let task_pool = pool.clone();
    let work =
        tokio::spawn(async move { task_pool.with(|c| Ok(c.simple_query("SELECT 1")?)).await });
    let accepted = wait_for(|| peer.accepted.load(SeqCst) == 1, Duration::from_secs(2)).await;
    let reclaimed = wait_for(
        || pool.permits.available_permits() == 1 && peer.closed.load(SeqCst) == 1,
        RECLAIM_CEILING,
    )
    .await;
    let peer_closed = peer.closed.load(SeqCst);
    let held = pool.permits.available_permits();
    // Cleanup precedes assertions, including on the defective baseline.
    peer.stop().await;
    let outcome = tokio::time::timeout(Duration::from_secs(2), work)
        .await
        .unwrap()
        .unwrap();
    eprintln!(
        "setup writable={writable} accepted={accepted} reclaimed={reclaimed} available={held} peer_closed={peer_closed} outcome={outcome:?}"
    );
    assert!(accepted, "the peer must accept a real connection attempt");
    assert!(
        reclaimed,
        "stalled setup retained its slot beyond the reclamation ceiling"
    );
    assert_eq!(
        peer_closed, 1,
        "the timed-out attempt must close its socket"
    );
    assert!(outcome.is_err());
}

#[tokio::test]
async fn connection_bounds_stalled_read_setup_reclaims_slot() {
    stalled_setup(false).await;
}

#[tokio::test]
async fn connection_bounds_stalled_writer_setup_reclaims_slot() {
    stalled_setup(true).await;
}

async fn silent_warm(writable: bool) {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let config: postgres::Config = url.parse().unwrap();
    let peer = Peer::new(Some(config.get_ports()[0])).await;
    let pool = if writable {
        Pool::writer(peer.connector(&url), limits())
    } else {
        Pool::new(peer.connector(&url), limits())
    };
    assert!(
        pool.ping().await,
        "complete real setup before silencing the peer"
    );
    assert_eq!(peer.accepted.load(SeqCst), 1);
    peer.silence();
    tokio::time::sleep(Duration::from_millis(30)).await;
    let task_pool = pool.clone();
    let work =
        tokio::spawn(async move { task_pool.with(|c| Ok(c.simple_query("SELECT 1")?)).await });
    let acquired = wait_for(
        || pool.permits.available_permits() == 0,
        Duration::from_secs(2),
    )
    .await;
    let reclaimed = wait_for(
        || pool.permits.available_permits() == 1 && peer.closed.load(SeqCst) == 1,
        RECLAIM_CEILING,
    )
    .await;
    let opens = peer.accepted.load(SeqCst);
    let closed = peer.closed.load(SeqCst);
    peer.stop().await;
    let outcome = tokio::time::timeout(Duration::from_secs(2), work)
        .await
        .unwrap()
        .unwrap();
    eprintln!(
        "warm writable={writable} acquired={acquired} reclaimed={reclaimed} opens={opens} peer_closed={closed} outcome={outcome:?}"
    );
    assert!(acquired);
    assert_eq!(opens, 1, "the work must use the established client");
    assert!(
        reclaimed,
        "an ACKing silent established peer retained its slot"
    );
    assert_eq!(closed, 1, "timeout must close the established socket");
    assert!(outcome.is_err());
    assert_eq!(
        pool.idle_len(),
        0,
        "a failed transport is never returned to idle"
    );
}

#[tokio::test]
async fn connection_bounds_silent_warm_read_reclaims_slot() {
    silent_warm(false).await;
}

#[tokio::test]
async fn connection_bounds_silent_warm_writer_reclaims_slot() {
    silent_warm(true).await;
}

#[tokio::test]
async fn connection_bounds_dispatched_writer_wait_has_cutoff() {
    let peer = Peer::new(None).await;
    let pool = Pool::writer(peer.connector(&test_url()), limits());
    let held = pool.permits.clone().acquire_owned().await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = calls.clone();
    let result = tokio::time::timeout(
        RECLAIM_CEILING,
        pool.with_acquire_alarm(
            Duration::from_millis(20),
            || {},
            move |_| {
                entered.fetch_add(1, SeqCst);
                Ok(())
            },
        ),
    )
    .await;
    let accepted = peer.accepted.load(SeqCst);
    drop(held);
    peer.stop().await;
    eprintln!(
        "writer wait completed={} closure_calls={} connections={accepted}",
        result.is_ok(),
        calls.load(SeqCst)
    );
    assert!(
        result.is_ok(),
        "dispatched writer permit wait has no cutoff"
    );
    assert!(result.unwrap().is_err());
    assert_eq!(calls.load(SeqCst), 0);
    assert_eq!(accepted, 0);
}

#[tokio::test]
async fn connection_bounds_session_setup_shares_the_connect_deadline() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let config: postgres::Config = url.parse().unwrap();
    let peer = Peer::session_setup(config.get_ports()[0]).await;
    let pool = Pool::writer(peer.connector(&url), limits());
    let task_pool = pool.clone();
    let work = tokio::spawn(async move { task_pool.ping().await });
    let reached_setup = wait_for(|| peer.ready.load(SeqCst) == 1, Duration::from_secs(2)).await;
    let reclaimed = wait_for(
        || pool.permits.available_permits() == 1 && peer.closed.load(SeqCst) == 1,
        RECLAIM_CEILING,
    )
    .await;
    let closed = peer.closed.load(SeqCst);
    peer.stop().await;
    let outcome = work.await.unwrap();
    eprintln!("session setup reached={reached_setup} reclaimed={reclaimed} peer_closed={closed}");
    assert!(reached_setup, "authentication must finish before the stall");
    assert!(
        reclaimed,
        "session setup must be inside the same whole-setup bound"
    );
    assert_eq!(closed, 1);
    assert!(!outcome);
}

#[tokio::test]
async fn connection_bounds_stalled_tls_negotiation_reclaims_slot() {
    use polis_queue_adapter::jobs::config::TransportKind;
    let peer = Peer::new(None).await;
    let connector = Connector::from_parts(
        &format!("postgres://postgres@127.0.0.1:{}/postgres", peer.port),
        &TransportKind::Tls {
            ca_file: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("certs/rds-global-bundle.pem"),
            host_allowlist: vec!["127.0.0.1".into()],
        },
        None,
        "connection-timeout-test",
    )
    .unwrap();
    let pool = Pool::new(connector, limits());
    let task_pool = pool.clone();
    let work = tokio::spawn(async move { task_pool.ping().await });
    let accepted = wait_for(|| peer.accepted.load(SeqCst) == 1, Duration::from_secs(2)).await;
    let reclaimed = wait_for(
        || pool.permits.available_permits() == 1 && peer.closed.load(SeqCst) == 1,
        RECLAIM_CEILING,
    )
    .await;
    let closed = peer.closed.load(SeqCst);
    peer.stop().await;
    assert!(!work.await.unwrap());
    assert!(accepted);
    assert!(reclaimed, "TLS negotiation is inside the whole-setup bound");
    assert_eq!(closed, 1);
}

#[tokio::test]
async fn connection_bounds_dead_idle_client_is_not_handed_to_work() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let config: postgres::Config = url.parse().unwrap();
    for writable in [false, true] {
        let peer = Peer::new(Some(config.get_ports()[0])).await;
        let pool = if writable {
            Pool::writer(peer.connector(&url), limits())
        } else {
            Pool::new(peer.connector(&url), limits())
        };
        assert!(pool.ping().await);
        peer.stop().await;
        // Exercise the stale-idle branch without racing a wall-clock sleep.
        pool.idle.lock().unwrap()[0].2 =
            Instant::now() - IDLE_CHECK_AFTER - Duration::from_millis(1);
        let entered = Arc::new(AtomicUsize::new(0));
        let observed = entered.clone();
        let result = pool
            .with(move |_| {
                observed.fetch_add(1, SeqCst);
                Ok(())
            })
            .await;
        eprintln!(
            "dead idle writable={writable} closure_calls={} outcome={result:?}",
            entered.load(SeqCst)
        );
        assert!(
            result.is_err(),
            "replacement must fail at the closed endpoint"
        );
        assert_eq!(
            entered.load(SeqCst),
            0,
            "work must never receive the dead idle client"
        );
    }
}
