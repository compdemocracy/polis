//! What the process does when it is told to stop. `docker stop`, `docker
//! compose down` and the web deploy send SIGTERM and, 10 s later, SIGKILL.
//! Each test here starts the real binary against its own database, puts work
//! in flight, and sends the signal the way the container runtime sends it.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What the container runtime allows between SIGTERM and SIGKILL: Compose's
/// default `stop_grace_period`, which the polis-api services do not change.
const STOP_WINDOW: Duration = Duration::from_secs(10);
/// The most a stop may take, so that it ends inside that window with margin.
const STOP_MOST: Duration = Duration::from_secs(7);
/// A watchdog for events that take milliseconds; never a measure of order.
const WATCHDOG: Duration = Duration::from_secs(30);

/// A database of its own, from the migrations the vote writer's own tests
/// use, holding one open conversation with one participant.
struct Database {
    admin: postgres::Client,
    name: String,
    url: url::Url,
}

impl Database {
    fn new(label: &str) -> Self {
        let base = std::env::var("POLIS_API_TEST_DATABASE_URL")
            .expect("db-tests requires POLIS_API_TEST_DATABASE_URL");
        let mut admin = postgres::Client::connect(&base, postgres::NoTls).unwrap();
        let name = format!("stopping_{label}_{}", std::process::id());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        let mut url = url::Url::parse(&base).expect("POLIS_API_TEST_DATABASE_URL is a URL");
        url.set_path(&format!("/{name}"));
        let db = Self { admin, name, url };
        let mut c = db.connect();
        for migration in [
            include_str!("../../../server/postgres/migrations/000000_initial.sql"),
            include_str!("../../../server/postgres/migrations/000006_update_votes_rule.sql"),
            include_str!("../../../server/postgres/migrations/000008_add_comment_priority.sql"),
            include_str!("../../../server/postgres/migrations/000016_add_orig_id.sql"),
        ] {
            c.batch_execute(migration).unwrap();
        }
        c.batch_execute(
            "ALTER TABLE conversations ADD treevite_enabled boolean DEFAULT false;
             ALTER TABLE conversations ADD xid_required boolean DEFAULT false;
             CREATE TABLE treevite_login_codes(zid integer, pid integer, revoked boolean);
             INSERT INTO users(uid) VALUES(1);
             INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
             INSERT INTO zinvites(zid,zinvite) VALUES(1,'2fixture');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,0,1,3);
             ALTER TABLE participants ENABLE TRIGGER USER;",
        )
        .unwrap();
        db
    }

    fn connect(&self) -> postgres::Client {
        postgres::Client::connect(self.url.as_str(), postgres::NoTls).unwrap()
    }

    /// History rows for the participant's vote on `tid`.
    fn votes_on(&self, tid: i32) -> i64 {
        self.connect()
            .query_one(
                "SELECT count(*) FROM votes WHERE zid=1 AND pid=0 AND tid=$1",
                &[&tid],
            )
            .unwrap()
            .get(0)
    }

    fn wait_for(&self, label: &str, sql: &str) {
        let mut c = self.connect();
        let deadline = Instant::now() + WATCHDOG;
        while !c.query_one(sql, &[]).unwrap().get::<_, bool>(0) {
            assert!(Instant::now() < deadline, "not observed: {label}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        let _ = self
            .admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name));
    }
}

/// A participant's signing key and the token it signs for the conversation.
struct Keys {
    public: String,
    token: String,
}

fn keys() -> Keys {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let token = encode(
        &Header::new(Algorithm::RS256),
        &serde_json::json!({
            "uid":1,"pid":0,"conversation_id":"2fixture","sub":"anon:1",
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,
            "anonymous_participant":true
        }),
        &key,
    )
    .unwrap();
    Keys {
        public: String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap(),
        token,
    }
}

/// The real binary, with its stderr collected line by line.
struct Api {
    child: Child,
    lines: Arc<Mutex<Vec<String>>>,
    address: SocketAddr,
}

impl Api {
    /// Starts the binary with `settings` and waits for its listening line
    /// (`event`, carrying the address under `key`).
    fn start(settings: &[(&str, String)], event: &str, key: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_polis-api"))
            .env_clear()
            .envs(settings.iter().map(|(k, v)| (*k, v.as_str())))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let stderr = child.stderr.take().unwrap();
        let collected = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                collected.lock().unwrap().push(line);
            }
        });
        let mut api = Self {
            child,
            lines,
            address: "127.0.0.1:1".parse().unwrap(),
        };
        let line = api.line(event);
        let address = line[key].as_str().unwrap().parse().unwrap();
        api.address = address;
        api
    }

    /// The first line printed with this `event`, waiting for it.
    fn line(&mut self, event: &str) -> serde_json::Value {
        let marker = format!("\"event\":\"{event}\"");
        let deadline = Instant::now() + WATCHDOG;
        loop {
            if let Some(line) = self
                .lines
                .lock()
                .unwrap()
                .iter()
                .find(|line| line.contains(&marker))
            {
                return serde_json::from_str(line).unwrap();
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!(
                    "polis-api exited ({status}) before {event}:\n{}",
                    self.lines.lock().unwrap().join("\n")
                );
            }
            assert!(Instant::now() < deadline, "no {event} line");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn signal(&self, name: &str) -> Instant {
        let sent = Instant::now();
        let status = Command::new("kill")
            .args([format!("-{name}"), self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        sent
    }

    /// Waits for the process to exit: how it exited and how long after `since`.
    fn exit(&mut self, since: Instant) -> (ExitStatus, Duration) {
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return (status, since.elapsed());
            }
            assert!(
                since.elapsed() < WATCHDOG,
                "polis-api did not exit:\n{}",
                self.lines.lock().unwrap().join("\n")
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn printed(&self) -> String {
        self.lines.lock().unwrap().join("\n")
    }

    /// True once a new connection is refused: the listener is closed.
    fn refuses_connections(&self) -> bool {
        TcpStream::connect_timeout(&self.address, Duration::from_millis(200)).is_err()
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The main role with the vote writer on, as production would run it after
/// the flip: `postVotes`'s writer, its database, its required settings, and
/// the participant public key the process loads.
fn writer_settings(db: &Database, writer_url: &str, keys: &Keys) -> Vec<(&'static str, String)> {
    vec![
        ("POLIS_API_DB_TRANSPORT", "loopback".into()),
        ("POLIS_API_LISTEN", "127.0.0.1:0".into()),
        ("POLIS_API_DATABASE_URL", db.url.to_string()),
        ("DATABASE_URL", db.url.to_string()),
        ("MATH_ENV", "test".into()),
        ("NODE_ENV", "production".into()),
        ("TZ", "UTC".into()),
        ("POLIS_API_POST_VOTES", "1".into()),
        ("POLIS_API_POST_VOTES_DATABASE_URL", writer_url.into()),
        ("TOPICAL_COMMENT_RATIO", "0".into()),
        ("SHOULD_USE_TRANSLATION_API", "false".into()),
        ("JWT_PUBLIC_KEY", keys.public.clone()),
        ("POLIS_JWT_ISSUER", "fixture".into()),
        ("POLIS_JWT_AUDIENCE", "fixture".into()),
    ]
}

/// A vote as nginx forwards one: HTTP/1.0, `Connection: close`, a
/// Content-Length, and the scheme the client used. The choice is a pass; the
/// tests ask only whether the vote was written.
fn vote(token: &str, tid: i32) -> Vec<u8> {
    let body = format!(r#"{{"conversation_id":"2fixture","tid":{tid},"vote":0}}"#);
    format!(
        "POST /api/v3/votes HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\nX-Forwarded-Proto: https\r\nContent-Type: application/json\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Sends a request and reads the whole answer on another thread.
fn send(address: SocketAddr, request: Vec<u8>) -> std::thread::JoinHandle<String> {
    let mut stream = TcpStream::connect(address).unwrap();
    stream.write_all(&request).unwrap();
    read_answer(stream)
}

fn read_answer(mut stream: TcpStream) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        // A socket the server has reset refuses the option (EINVAL on macOS);
        // what follows then reads nothing, and the caller sees no answer.
        let _ = stream.set_read_timeout(Some(WATCHDOG));
        let mut answer = Vec::new();
        let _ = stream.read_to_end(&mut answer);
        String::from_utf8_lossy(&answer).into_owned()
    })
}

fn status(answer: &str) -> u16 {
    answer
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no status line: {answer:?}"))
}

/// One vote on a statement no test holds, until it is written: it opens the
/// writer's connections, so the votes the tests time do not include setup.
fn warm(api: &Api, token: &str) {
    let deadline = Instant::now() + WATCHDOG;
    loop {
        let answer = send(api.address, vote(token, 6)).join().unwrap();
        if status(&answer) == 200 {
            return;
        }
        // A cold admission can miss its 250 ms deadline and hand back.
        assert_eq!(status(&answer), 502, "{answer}");
        assert!(
            Instant::now() < deadline,
            "the warm-up vote was never written"
        );
    }
}

fn stop_line(api: &mut Api) -> serde_json::Value {
    api.line("polis_api_stopped")
}

/// SIGTERM while one vote is inside its transaction and another has not been
/// dispatched (its body is still arriving): the listener closes at once, the
/// first vote commits and is answered, the second is handed back with the
/// marker nginx sends to Node and is not written, and the process exits zero
/// as soon as nothing is in flight. Before this, SIGTERM killed the process
/// at once outside a container, and inside one (as PID 1) it was ignored
/// until SIGKILL: either way the dispatched vote's caller got no answer.
#[test]
fn sigterm_lets_a_dispatched_vote_commit_and_hands_back_one_not_dispatched() {
    let db = Database::new("commit");
    let keys = keys();
    let mut api = Api::start(
        &writer_settings(&db, db.url.as_str(), &keys),
        "polis_api_listening",
        "addr",
    );
    warm(&api, &keys.token);
    // The vote on statement 7 waits, inside its transaction, on a lock this
    // test holds. The trigger lifts only the lock wait's own cutoff; the
    // writer's one-second statement timeout still applies.
    let mut holder = db.connect();
    holder
        .batch_execute(
            "SELECT pg_advisory_lock(7320);
             CREATE FUNCTION hold_vote() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
               IF NEW.tid = 7 THEN
                 PERFORM set_config('lock_timeout', '0', true);
                 PERFORM pg_advisory_xact_lock(7320);
               END IF;
               RETURN NEW;
             END $$;
             CREATE TRIGGER hold_vote BEFORE INSERT ON votes_latest_unique
               FOR EACH ROW EXECUTE FUNCTION hold_vote();",
        )
        .unwrap();
    // A vote on statement 8 whose body has not all arrived: accepted, not
    // yet dispatched.
    let partial = vote(&keys.token, 8);
    let split = partial.len() - 5;
    let mut undispatched = TcpStream::connect(api.address).unwrap();
    undispatched.write_all(&partial[..split]).unwrap();
    let dispatched = send(api.address, vote(&keys.token, 7));
    db.wait_for(
        "the vote on statement 7 waits inside its transaction",
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
           AND query ILIKE 'insert into votes_latest_unique%')",
    );
    let sent = api.signal("TERM");
    let deadline = Instant::now() + WATCHDOG;
    while !api.refuses_connections() {
        assert!(Instant::now() < deadline, "the listener never closed");
    }
    holder
        .batch_execute("SELECT pg_advisory_unlock(7320)")
        .unwrap();
    undispatched.write_all(&partial[split..]).unwrap();
    let undispatched = read_answer(undispatched).join().unwrap();
    let dispatched = dispatched.join().unwrap();
    let (exit, took) = api.exit(sent);

    // The dispatched vote: committed and answered, 200 with its receipt or,
    // past its one-second deadline, 202 "acceptance unknown".
    assert!(
        matches!(status(&dispatched), 200 | 202),
        "{dispatched}\n{}",
        api.printed()
    );
    assert_eq!(db.votes_on(7), 1, "the dispatched vote is written once");
    // The vote not yet dispatched: handed back, marked, and not written.
    assert_eq!(status(&undispatched), 502, "{undispatched}");
    assert!(
        undispatched.contains("\r\nX-Polis-Vote-Dispatch: not-started\r\n"),
        "{undispatched}"
    );
    assert_eq!(db.votes_on(8), 0, "the handed-back vote is not written");
    // The process stopped cleanly, as soon as nothing was in flight: before
    // its drain bound, not at it. The hand-back was the stop's.
    assert!(exit.success(), "{exit}\n{}", api.printed());
    let stopped = stop_line(&mut api);
    eprintln!("stopped {took:?} after SIGTERM: {stopped}");
    assert_eq!(stopped["drained"], true, "{stopped}");
    assert_eq!(stopped["handedBack"], 1, "{stopped}");
    let bound = Duration::from_millis(stopped["boundMs"].as_u64().unwrap());
    assert!(took < bound, "{took:?}\n{}", api.printed());
    assert_eq!(api.line("polis_api_stopping")["signal"], "SIGTERM");
}

/// A TCP proxy in front of PostgreSQL. Once a connection carries the first
/// query of the vote's next-statement selection (`TRIGGER`, which admission
/// never sends), everything the client sends on it is held back `delay`
/// before it is passed on. The client writes once per round trip and a query
/// is two round trips (prepare, then execute), so each query still succeeds,
/// in twice `delay`, inside the five seconds the client allows one call; the
/// selection goes on, slowly, past the drain bound. (The vote's transaction
/// cannot be held this way: the writer's sessions set
/// `idle_in_transaction_session_timeout` to one second, and PostgreSQL ends
/// a transaction whose client is that slow.) When either side closes, the
/// other is closed.
fn slow_proxy(upstream: SocketAddr, delay: Duration) -> SocketAddr {
    const TRIGGER: &[u8] = b"select strict_moderation from conversations";
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for client in listener.incoming() {
            let Ok(client) = client else { return };
            let Ok(server) = TcpStream::connect(upstream) else {
                return;
            };
            let (mut from_client, mut to_server) =
                (client.try_clone().unwrap(), server.try_clone().unwrap());
            let (mut from_server, mut to_client) = (server, client);
            std::thread::spawn(move || {
                let mut slow = false;
                let mut tail: Vec<u8> = Vec::new();
                let mut buf = [0u8; 16384];
                while let Ok(n) = from_client.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    tail.extend_from_slice(&buf[..n]);
                    slow |= tail.windows(TRIGGER.len()).any(|w| w == TRIGGER);
                    let keep = tail.len().saturating_sub(TRIGGER.len());
                    tail.drain(..keep);
                    if slow {
                        std::thread::sleep(delay);
                    }
                    if to_server.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
                let _ = to_server.shutdown(std::net::Shutdown::Both);
            });
            std::thread::spawn(move || {
                let mut buf = [0u8; 16384];
                while let Ok(n) = from_server.read(&mut buf) {
                    if n == 0 || to_client.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
                let _ = to_client.shutdown(std::net::Shutdown::Both);
                let _ = from_server.shutdown(std::net::Shutdown::Both);
            });
        }
    });
    address
}

/// SIGTERM while a dispatched vote cannot finish: it committed, but every
/// query its next-statement selection sends is held back two seconds on the
/// way to the database, so the selection is still running when the drain
/// bound ends. The
/// caller was already answered at the one-second deadline: 200, the vote's
/// receipt, the next statement marked degraded (optional, best-effort work,
/// as the contract names it). The process waits the bound, says what it left,
/// and exits zero inside the stop window. The vote stays written once.
#[test]
fn sigterm_exits_inside_the_bound_when_a_dispatch_does_not_finish() {
    let db = Database::new("bound");
    let keys = keys();
    let upstream = format!(
        "{}:{}",
        db.url.host_str().unwrap(),
        db.url.port().unwrap_or(5432)
    )
    .parse()
    .unwrap();
    let mut through = db.url.clone();
    let proxy = slow_proxy(upstream, Duration::from_secs(2));
    through.set_port(Some(proxy.port())).unwrap();
    let mut api = Api::start(
        &writer_settings(&db, through.as_str(), &keys),
        "polis_api_listening",
        "addr",
    );
    let deadline = Instant::now() + WATCHDOG;
    let answer = loop {
        let answer = send(api.address, vote(&keys.token, 7)).join().unwrap();
        // A cold admission can miss its 250 ms deadline and hand back.
        if status(&answer) != 502 {
            break answer;
        }
        assert!(Instant::now() < deadline, "the vote was never dispatched");
    };
    assert_eq!(status(&answer), 200, "{answer}");
    assert!(answer.contains(r#""replayed":false"#), "{answer}");
    assert!(answer.contains(r#""nextComment":"degraded""#), "{answer}");
    assert_eq!(db.votes_on(7), 1, "the vote is written before the stop");
    let sent = api.signal("TERM");
    let (exit, took) = api.exit(sent);
    let stopped = stop_line(&mut api);
    eprintln!("stopped {took:?} after SIGTERM: {stopped}");
    assert_eq!(stopped["drained"], false, "{stopped}\n{}", api.printed());
    assert_eq!(stopped["dispatches"], 1, "{stopped}");
    let bound = Duration::from_millis(stopped["boundMs"].as_u64().unwrap());
    assert!(exit.success(), "{exit}\n{}", api.printed());
    assert!(took >= bound, "it waited the bound: {took:?}");
    assert!(took < STOP_MOST, "{took:?}\n{}", api.printed());
    assert!(STOP_MOST < STOP_WINDOW);
    assert_eq!(db.votes_on(7), 1, "the vote is still written once");
}

/// Nothing in flight: both roles exit zero at once on SIGTERM, and the main
/// role on SIGINT as it always has. The shadow role writes nothing and waits
/// for nothing. Before this, as PID 1 in its container, each ignored SIGTERM
/// until SIGKILL (`docker stop` took 10 s and exited 137).
#[test]
fn both_roles_exit_at_once_when_idle() {
    let db = Database::new("idle");
    let keys = keys();
    for signal in ["TERM", "INT"] {
        let mut api = Api::start(
            &writer_settings(&db, db.url.as_str(), &keys),
            "polis_api_listening",
            "addr",
        );
        let sent = api.signal(signal);
        let (exit, took) = api.exit(sent);
        eprintln!("main role, idle, SIG{signal}: stopped {took:?} after the signal");
        assert!(exit.success(), "SIG{signal}: {exit}\n{}", api.printed());
        assert!(took < Duration::from_secs(1), "SIG{signal}: {took:?}");
        assert_eq!(stop_line(&mut api)["drained"], true);
    }
    let shadow = [
        ("POLIS_API_ROLE", "shadow".to_owned()),
        ("POLIS_API_SHADOW_LISTEN", "127.0.0.1:0".into()),
        ("POLIS_API_SHADOW_MAX_PER_SECOND", "1".into()),
        ("POLIS_API_POST_VOTES", "observe".into()),
        ("POLIS_API_POST_VOTES_DATABASE_URL", db.url.to_string()),
        ("POLIS_API_DB_TRANSPORT", "loopback".into()),
        ("POLIS_API_DATABASE_URL", db.url.to_string()),
        ("DATABASE_URL", db.url.to_string()),
        ("MATH_ENV", "test".into()),
        ("NODE_ENV", "production".into()),
        ("TOPICAL_COMMENT_RATIO", "0".into()),
        ("SHOULD_USE_TRANSLATION_API", "false".into()),
        ("JWT_PUBLIC_KEY", keys.public.clone()),
        ("POLIS_JWT_ISSUER", "fixture".into()),
        ("POLIS_JWT_AUDIENCE", "fixture".into()),
    ];
    let mut api = Api::start(&shadow, "shadow_listening", "address");
    let sent = api.signal("TERM");
    let (exit, took) = api.exit(sent);
    eprintln!("shadow role, idle, SIGTERM: stopped {took:?} after the signal");
    assert!(exit.success(), "shadow: {exit}\n{}", api.printed());
    assert!(took < Duration::from_secs(1), "shadow: {took:?}");
    assert_eq!(api.line("shadow_stopping")["signal"], "SIGTERM");
}
