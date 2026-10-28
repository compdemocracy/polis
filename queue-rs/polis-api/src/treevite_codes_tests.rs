use super::*;
use crate::http::{Body, Headers};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

struct Fixture {
    config: postgres::Config,
    name: String,
    admin: postgres::Client,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let mut config: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
            .unwrap()
            .parse()
            .unwrap();
        let mut admin = config.connect(postgres::NoTls).unwrap();
        let name = format!("treevite_codes_{label}_{}", std::process::id());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        config.dbname(&name);
        let f = Self {
            config,
            name,
            admin,
        };
        let mut c = f.connect();
        c.batch_execute(include_str!(
            "../../../server/postgres/migrations/000000_initial.sql"
        ))
        .unwrap();
        c.batch_execute(include_str!(
            "../../../server/postgres/migrations/000010_create_oidc_user_mappings.sql"
        ))
        .unwrap();
        c.batch_execute(include_str!(
            "../../../server/postgres/migrations/000013_create_treevite.sql"
        ))
        .unwrap();
        c.batch_execute("CREATE EXTENSION pgcrypto; ALTER TABLE conversations ADD xid_required boolean NOT NULL DEFAULT false;
            INSERT INTO users(uid,site_id) VALUES(1,'owner'),(2,'owner'),(3,'other'),(4,'member'),(5,'other'),(6,'other');
            INSERT INTO oidc_user_mappings(uid,oidc_sub) VALUES(1,'owner'),(2,'moderator'),(3,'stranger'),(5,'admin');
            INSERT INTO conversations(zid,owner,is_active) VALUES(1,1,true),(2,3,true);
            INSERT INTO zinvites(zid,zinvite) VALUES(1,'fixture'),(1,'alias'),(2,'other');
            ALTER TABLE participants DISABLE TRIGGER USER;
            INSERT INTO participants(zid,pid,uid) VALUES(1,0,4),(1,1,6),(2,0,4);
            ALTER TABLE participants ENABLE TRIGGER USER;
            INSERT INTO treevite_login_codes(zid,pid,login_code_hash,login_code_fingerprint,login_code_lookup)
            VALUES(1,0,'oldhash','oldfp','oldlookup'),(2,0,'otherhash','otherfp','otherlookup');").unwrap();
        f
    }
    fn connect(&self) -> postgres::Client {
        self.config.connect(postgres::NoTls).unwrap()
    }
    fn pool(&self, write: bool) -> Arc<db::Pool> {
        let connector = Connector::Plain(Box::new(self.config.clone()));
        if write {
            db::Pool::writer(connector, crate::revocation::limits())
        } else {
            db::Pool::new(connector, crate::revocation::limits())
        }
    }
    fn app(&self) -> (App, EncodingKey) {
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
        let jwks = serde_json::from_value(json!({"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"fixture","n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),"e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())}]})).unwrap();
        let cfg = config::Config {
            listen: String::new(),
            math_env: "test".into(),
            cache_size: 10,
            dev_mode: true,
            use_network_host: false,
            production: true,
            pool: crate::revocation::limits(),
        };
        let mut app = App::new(&cfg, self.pool(false));
        app.participant_verifier = Some(Arc::new(
            polis_auth::participant::Verifier::new(
                &rsa.public_key_to_pem().unwrap(),
                "participants",
                "participants",
            )
            .unwrap(),
        ));
        app.treevite_codes = Some(Writer {
            pool: self.pool(true),
            verifier: owner::Verifier::new(jwks, "owners", "owners").unwrap(),
            admins: vec![5],
            crypto: Crypto::new(Settings::from_lookup(|_| None)).unwrap(),
            admitted: Arc::new(tokio::sync::Semaphore::new(4)),
        });
        (app, key)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .unwrap();
    }
}
fn now() -> u64 {
    (crate::clock::now_ms() / 1000.0) as u64
}
fn sign(key: &EncodingKey, claims: Value) -> String {
    let mut h = Header::new(Algorithm::RS256);
    h.kid = Some("fixture".into());
    format!("Bearer {}", encode(&h, &claims, key).unwrap())
}
fn participant_token(key: &EncodingKey, claims: Value) -> String {
    // Existing participant sessions have a bare RS256 header, without a kid.
    format!(
        "Bearer {}",
        encode(&Header::new(Algorithm::RS256), &claims, key).unwrap()
    )
}
fn owner_token(key: &EncodingKey, sub: &str) -> String {
    sign(
        key,
        json!({"sub":sub,"iss":"owners","aud":"owners","exp":now()+300}),
    )
}
fn request(path: &str, token: &str, cid: &str, pid: i32) -> Request {
    Request {
        method: "POST".into(),
        target: path.into(),
        headers: Headers::from_raw([
            ("host", "localhost"),
            ("content-type", "application/json"),
            ("authorization", token),
        ]),
        body: serde_json::to_vec(&json!({"conversation_id":cid,"pid":pid})).unwrap(),
    }
}
fn body(out: Outgoing) -> Value {
    let Body::Fixed(bytes) = out.body else {
        panic!("fixed JSON")
    };
    serde_json::from_slice(&bytes).unwrap()
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn authority_idempotence_not_found_and_reissue_crypto() {
    let f = Fixture::new("authority");
    let (app, key) = f.app();
    let app = Arc::new(app);
    let mut c = f.connect();
    runtime().block_on(async {
        for path in [REVOKE_PATH, REISSUE_PATH] {
            for invalid in ["", "Bearer invalid"] {
                let out = route::handle(app.clone(), request(path,invalid,"fixture",0)).await;
                assert_eq!(out.status,403);
            }
            let participant = participant_token(&key,json!({"uid":4,"pid":0,"conversation_id":"fixture","sub":"anon:4","iss":"participants","aud":"participants","exp":now()+300,"iat":now(),"anonymous_participant":true}));
            let out = route::handle(app.clone(),request(path,&participant,"fixture",0)).await;
            assert_eq!(out.status,403);
        }
        for sub in ["stranger","unmapped"] {
            for path in [REVOKE_PATH,REISSUE_PATH] {
                let out = route::handle(app.clone(), request(path,&owner_token(&key,sub),"fixture",0)).await;
                assert_eq!(out.status,403);
            }
        }
        // No login-code table access is possible: unauthorized callers still
        // receive 403 when that table cannot even be resolved.
        tokio::task::block_in_place(|| c.batch_execute("ALTER TABLE treevite_login_codes RENAME TO hidden_codes").unwrap());
        let out = route::handle(app.clone(),request(REISSUE_PATH,&owner_token(&key,"stranger"),"fixture",0)).await;
        assert_eq!(out.status,403);
        tokio::task::block_in_place(|| c.batch_execute("ALTER TABLE hidden_codes RENAME TO treevite_login_codes").unwrap());
        for sub in ["owner","moderator","admin","owner"] {
            let out = route::handle(app.clone(),request(REVOKE_PATH,&owner_token(&key,sub),"fixture",0)).await;
            assert_eq!(out.status,200); assert_eq!(body(out),json!({"revoked":true}));
        }
        for path in [REVOKE_PATH,REISSUE_PATH] {
            let out = route::handle(app.clone(),request(path,&owner_token(&key,"owner"),"fixture",1)).await;
            assert_eq!(out.status,404); assert_eq!(body(out)["error"],Error::NotFound.code());
        }
        let out = route::handle(app.clone(),request(REISSUE_PATH,&owner_token(&key,"moderator"),"fixture",0)).await;
        assert_eq!(out.status,200);
        assert!(out.headers.iter().any(|(k,v)| k.eq_ignore_ascii_case("cache-control") && v=="no-store"));
        let response = body(out); let raw = response["login_code"].as_str().unwrap();
        assert_eq!(raw.len(),16); assert_eq!(response["expires_in"],31_536_000);
        tokio::task::block_in_place(|| {
            let row = c.query_one("SELECT revoked,crypt($1,login_code_hash)=login_code_hash, login_code_lookup=encode(digest($1 || 'polis_treevite_pepper','sha256'),'hex'), login_code_fingerprint=encode(hmac('1:0:' || $1,'polis_treevite_fingerprint_key','sha256'),'hex'), expires_at > now()+interval '364 days' AND expires_at <= now()+interval '365 days',fp_kid,login_code_hash FROM treevite_login_codes WHERE zid=1 AND pid=0", &[&raw]).unwrap();
            assert!(!row.get::<_,bool>(0)); for i in 1..=4 { assert!(row.get::<_,bool>(i),"column {i}"); }
            assert_eq!(row.get::<_,i16>(5),1); assert!(row.get::<_,String>(6).starts_with("$2a$10$"));
            assert!(!c.query_one("SELECT revoked FROM treevite_login_codes WHERE zid=2 AND pid=0",&[]).unwrap().get::<_,bool>(0));
        });
    });
}

#[test]
fn real_refresh_ends_all_derived_sessions_including_legacy_year_tokens() {
    let f = Fixture::new("deadline");
    let (mut app, key) = f.app();
    let pool = f.pool(false);
    runtime().block_on(async {
        let refresh = crate::revocation::Refresh::load(pool).await.unwrap();
        Arc::get_mut(app.participant_verifier.as_mut().unwrap()).unwrap().set_revocations(refresh.snapshot.clone());
        app.revocations = Some(refresh.clone());
        let app = Arc::new(app);
        let issued = route::handle(app.clone(), request(REISSUE_PATH, &owner_token(&key,"owner"),"fixture",0)).await;
        assert_eq!(issued.status,200);
        let issued = body(issued);
        let raw = issued["login_code"].as_str().unwrap();
        // Prove these are sessions for the actual stored code, using the existing
        // admission transaction after an independent bcrypt comparison.
        let admitted = tokio::task::block_in_place(|| {
            let mut c = f.connect();
            let row = c.query_one("SELECT login_code_hash,login_code_lookup,crypt($1,login_code_hash)=login_code_hash FROM treevite_login_codes WHERE zid=1 AND pid=0", &[&raw]).unwrap();
            assert!(row.get::<_,bool>(2));
            let hash: String = row.get(0); let lookup: String = row.get(1);
            polis_auth::admission::admit(&mut c, &polis_auth::admission::Request {
                zid: polis_auth::Zid(1), identity: polis_auth::admission::Identity::Anonymous,
                entry: polis_auth::admission::Entry::Login(polis_auth::admission::VerifiedLogin { lookup: &lookup, bcrypt_hash: &hash }),
                admin_uids: &[], x_name: None, x_email: None, x_profile_image_url: None,
            }).unwrap().unwrap()
        });
        assert_eq!(admitted.uid,polis_auth::Uid(4)); assert_eq!(admitted.pid,polis_auth::Pid(0));
        let tokens: Vec<_> = ["fixture","alias"].into_iter().flat_map(|cid| [60,3600,86400,31_000_000].into_iter().map(move |age| (cid,age))).map(|(cid,age)| {
            let issued = now()-age+1;
            (cid,participant_token(&key,json!({"uid":4,"pid":0,"conversation_id":cid,"sub":"anon:4","iss":"participants","aud":"participants","exp":issued+31_536_000,"iat":issued,"anonymous_participant":true})))
        }).collect();
        for (cid,t) in &tokens { assert!(app.participant_verifier.as_ref().unwrap().verify_checked(t,cid,now()).unwrap().is_some()); }
        let task = tokio::spawn(refresh.clone().run());
        // Revoke immediately after the initial load: almost a full refresh period
        // must elapse. No paused Tokio clock or shortened test-only interval.
        let started = std::time::Instant::now();
        let out = route::handle(app.clone(),request(REVOKE_PATH,&owner_token(&key,"owner"),"fixture",0)).await;
        assert_eq!(out.status,200);
        tokio::time::timeout(Duration::from_secs(59),async {
            while !refresh.snapshot.contains("fixture",0) { tokio::time::sleep(Duration::from_millis(50)).await; }
        }).await.unwrap();
        assert!(started.elapsed() >= Duration::from_secs(29));
        assert!(started.elapsed() < Duration::from_secs(60));
        for (cid,t) in &tokens {
            let error = app.participant_verifier.as_ref().unwrap().verify_checked(t,cid,now()).err().unwrap();
            assert_eq!(error.status,401); assert_eq!(error.code,"polis_err_treevite_session_revoked");
            for path in [crate::post_votes::PATH,crate::comments::PATH,crate::next_comment::PATH,crate::treevite_me::PATH,crate::topic_selections::PATH] {
                let out = route::handle(app.clone(),request(path,t,cid,0)).await;
                assert_eq!(out.status,401,"{path}");
                assert_eq!(body(out)["error"],"polis_err_treevite_session_revoked");
            }
        }
        // A revoked PID is scoped to its conversation, not a global PID or UID.
        let other = participant_token(&key,json!({"uid":4,"pid":0,"conversation_id":"other","sub":"anon:4","iss":"participants","aud":"participants","exp":now()+300,"iat":now(),"anonymous_participant":true}));
        assert!(app.participant_verifier.as_ref().unwrap().verify_checked(&other,"other",now()).unwrap().is_some());
        // An untrusted payload must not be enough to report a revoked session.
        let bad_rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let bad_key = EncodingKey::from_rsa_pem(&bad_rsa.private_key_to_pem().unwrap()).unwrap();
        let forged = participant_token(&bad_key,json!({"uid":4,"pid":0,"conversation_id":"fixture","sub":"anon:4","iss":"participants","aud":"participants","exp":now()+300,"iat":now(),"anonymous_participant":true}));
        assert!(app.participant_verifier.as_ref().unwrap().verify_checked(&forged,"fixture",now()).unwrap().is_none());
        println!("all eight derived tokens refused after {:?} with the real 30-second refresh", started.elapsed());
        task.abort(); let _ = task.await;
        // Failed refresh retains exactly the last good snapshot.
        tokio::task::block_in_place(|| f.connect().batch_execute("ALTER TABLE treevite_login_codes RENAME TO hidden_codes").unwrap());
        refresh.refresh().await;
        assert!(refresh.snapshot.contains("alias",0));
    });
}
