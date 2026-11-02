//! Loopback-only conformance worker for staged admission, never a product route.
//! Run via polis-api/conformance/mixed-identity-run.sh. The ordinary crate suite
//! exercises the configuration gate; the stack runner supplies real traffic.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used)]
use jsonwebtoken::{Algorithm, Header, encode};
use polis_auth::{PostgresLookup, Zid, admission, keys::Keys, oidc, participant, provider};
use postgres::{Client, NoTls};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn dispatch(c: &mut Client, v: &Value, keys: &Keys, provider: &provider::Verifier) -> Value {
    let cid = v["cid"].as_str().unwrap();
    if let Some(token) = v["verify"].as_str() {
        let verifier = participant::Verifier::new(
            &std::fs::read(std::env::var("JWT_PUBLIC_KEY_PATH").unwrap()).unwrap(),
            "https://pol.is/",
            "participants",
        )
        .unwrap();
        let mut lookup = PostgresLookup(c);
        let mut check = polis_auth::xid_account::Check {
            db: &mut lookup,
            admin_uids: &[],
        };
        return match verifier.verify_for_request(
            &format!("Bearer {token}"),
            cid,
            None,
            now(),
            &mut check,
        ) {
            Ok(Some(id)) => json!({"uid":id.uid().unwrap().0,"pid":id.pid().unwrap().0}),
            _ => json!({"error":"verification failed"}),
        };
    }
    c.query_one(
        "SELECT set_config('mixed.caller',$1,false)",
        &[&v["caller"].as_str().unwrap()],
    )
    .unwrap();
    let mut subject = None;
    let identity = if let Some(token) = v["oidc"].as_str() {
        let claims = provider
            .verify_at(&format!("Bearer {token}"), now())
            .unwrap();
        let profile = oidc::Profile::from_verified_claims(&claims, provider.namespace()).unwrap();
        subject = Some(profile.subject.clone());
        match oidc::provision(c, &profile, &polis_auth::observability::PROCESS) {
            Ok(uid) => admission::Identity::Account(uid),
            Err(e) => return json!({"error":format!("oidc {e:?}")}),
        }
    } else {
        admission::Identity::without_token(v["xid"].as_str())
    };
    let entry = if let Some(code) = v["invite"].as_str() {
        admission::Entry::Invite {
            code,
            recovery: admission::PreparedRecovery {
                code: v["recovery"].as_str().unwrap(),
                bcrypt_hash: v["hash"].as_str().unwrap(),
                lookup: v["lookup"].as_str().unwrap(),
                fingerprint_key: b"generated-mixed-fingerprint",
            },
        }
    } else {
        admission::Entry::Participation {
            create_if_missing: true,
        }
    };
    let started = std::time::Instant::now();
    let admitted = admission::admit(
        c,
        &admission::Request {
            zid: Zid(v["zid"].as_i64().unwrap() as i32),
            identity,
            entry,
            admin_uids: &[],
            x_name: None,
            x_email: None,
            x_profile_image_url: None,
        },
    );
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let a = match admitted {
        Ok(Some(a)) => a,
        Err(admission::Error::Refused(reason)) => {
            return json!({"status":reason.status,"error":reason.code,"admissionMs":elapsed});
        }
        other => return json!({"status":503,"error":format!("{other:?}"),"admissionMs":elapsed}),
    };
    // Test-only minter: the staged library intentionally has no serving minter.
    let mut claims = json!({"aud":"participants","iss":"https://pol.is/","pid":a.pid.0,
        "uid":a.uid.0,"exp":now()+3600,"iat":now(),"conversation_id":cid});
    if let Some(sub) = subject {
        claims["sub"] = json!(format!("user:{sub}"));
        claims["oidc_sub"] = json!(sub);
        claims["standard_user_participant"] = json!(true);
    } else if let Some(xid) = v["xid"].as_str() {
        claims["sub"] = json!(format!("xid:{xid}"));
        claims["xid"] = json!(xid);
        claims["xid_participant"] = json!(true);
    } else {
        claims["sub"] = json!(format!("anon:{}", a.uid.0));
        claims["anonymous_participant"] = json!(true);
    }
    let token = encode(
        &Header::new(Algorithm::RS256),
        &claims,
        keys.private_key().unwrap(),
    )
    .unwrap();
    json!({"token":token,"uid":a.uid.0,"pid":a.pid.0,"newParticipant":a.new_participant,"admissionMs":elapsed})
}

#[test]
fn mixed_writer_worker() {
    let Ok(port) = std::env::var("POLIS_MIXED_WORKER_PORT") else {
        return;
    };
    let listener = Arc::new(TcpListener::bind(format!("127.0.0.1:{port}")).unwrap());
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let keys = Arc::new(Keys::from_env().unwrap());
    let snapshot = std::fs::read(std::env::var("POLIS_MIXED_JWKS").unwrap()).unwrap();
    let (provider, _) = provider::Verifier::from_environment(&snapshot).unwrap();
    let provider = Arc::new(provider);
    let mut workers = Vec::new();
    for _ in 0..16 {
        let (listener, stop, keys, provider) = (
            listener.clone(),
            stop.clone(),
            keys.clone(),
            provider.clone(),
        );
        workers.push(std::thread::spawn(move || {
            let mut c = Client::connect(&std::env::var("DATABASE_URL").unwrap(), NoTls).unwrap();
            c.batch_execute("SET application_name='mixed-rust'")
                .unwrap();
            while !stop.load(Ordering::Relaxed) {
                let (mut socket, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut line = String::new();
                BufReader::new(&socket).read_line(&mut line).unwrap();
                let v: Value = serde_json::from_str(&line).unwrap();
                let result = if v["stop"] == true {
                    stop.store(true, Ordering::Relaxed);
                    json!({"stopped":true})
                } else if v["ready"] == true {
                    json!({"ready":true})
                } else {
                    dispatch(&mut c, &v, &keys, &provider)
                };
                writeln!(socket, "{result}").unwrap();
            }
        }));
    }
    println!("MIXED_WORKER_READY");
    for worker in workers {
        worker.join().unwrap();
    }
}
