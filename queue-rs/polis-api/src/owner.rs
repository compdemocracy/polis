//! A new, owner-only list contract. No legacy Node response is replaced.
//! Credentials are RS256 OIDC access tokens, verified using an operator-supplied
//! JWKS snapshot. Identity lookup never creates users or accepts a UID claim.
use crate::{
    config, db,
    http::{Body, Outgoing, Request},
};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub const PATH: &str = "/api/v3/owner/conversations";
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Filter {
    sort: String,
    min_participants: i32,
    search: String,
    active: Option<bool>,
    draft: Option<bool>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    uid: i32,
    filter: Filter,
    created: i64,
    zid: i32,
}
#[derive(Clone)]
struct Query {
    filter: Filter,
    limit: i64,
    cursor: Option<Cursor>,
}
impl Query {
    fn parse(raw: &str) -> Result<Self> {
        if raw.len() > 8192 {
            bail!("query too long");
        }
        let mut q = Self {
            filter: Filter {
                sort: "newest".into(),
                min_participants: 0,
                search: String::new(),
                active: None,
                draft: None,
            },
            limit: 100,
            cursor: None,
        };
        let mut seen = HashSet::new();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            if !seen.insert(key.to_string()) {
                bail!("duplicate parameter");
            }
            match key.as_ref() {
                "sort" if ["newest", "oldest"].contains(&value.as_ref()) => {
                    q.filter.sort = value.into_owned()
                }
                "min_participants" => q.filter.min_participants = value.parse()?,
                "limit" => q.limit = value.parse()?,
                "search" if value.chars().count() <= 200 => q.filter.search = value.into_owned(),
                "is_active" => q.filter.active = Some(value.parse()?),
                "is_draft" => q.filter.draft = Some(value.parse()?),
                "cursor" if value.len() <= 4096 => {
                    q.cursor = Some(serde_json::from_slice(
                        &URL_SAFE_NO_PAD.decode(value.as_bytes())?,
                    )?)
                }
                _ => bail!("unknown or invalid parameter"),
            }
        }
        if !(1..=500).contains(&q.limit)
            || q.filter.min_participants < 0
            || q.filter.search.contains('\0')
        {
            bail!("invalid bound");
        }
        if let Some(c) = &q.cursor
            && (c.version != 1
                || c.filter != q.filter
                || c.created < 0
                || c.created > MAX_SAFE
                || c.zid <= 0)
        {
            bail!("cursor does not match query");
        }
        Ok(q)
    }
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    exp: u64,
    #[serde(default, deserialize_with = "numeric_nbf")]
    nbf: Option<u64>,
}
// Missing nbf is allowed; a present null, string or other non-number is not.
fn numeric_nbf<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    u64::deserialize(d).map(Some)
}
struct Verifier {
    keys: JwkSet,
    validation: Validation,
}
impl Verifier {
    fn new(keys: JwkSet, issuer: &str, audience: &str) -> Result<Self> {
        if issuer.is_empty() || audience.is_empty() || keys.keys.is_empty() || keys.keys.len() > 32
        {
            bail!("invalid OIDC configuration");
        }
        let mut ids = HashSet::new();
        for key in &keys.keys {
            let kid = key.common.key_id.as_ref().context("JWKS key needs kid")?;
            if kid.is_empty() || !ids.insert(kid.clone()) {
                bail!("duplicate or empty kid");
            }
        }
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&[audience]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        // Use typed claims and one explicit clock below: Node expires at
        // now >= exp, while the library's default accepts exp == now.
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.leeway = 0;
        Ok(Self { keys, validation })
    }
    fn subject(&self, authorization: Option<&str>) -> Result<String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        self.subject_at(authorization, now)
    }
    fn subject_at(&self, authorization: Option<&str>, now: u64) -> Result<String> {
        let raw = authorization.context("missing bearer")?;
        let (scheme, token) = raw.split_once(' ').context("invalid bearer")?;
        if !scheme.eq_ignore_ascii_case("Bearer") || token.len() > 16384 || token.is_empty() {
            bail!("invalid bearer");
        }
        let header = decode_header(token)?;
        if header.alg != Algorithm::RS256 {
            bail!("wrong algorithm");
        }
        let key = self
            .keys
            .find(header.kid.as_deref().context("missing kid")?)
            .context("unknown kid")?;
        let claims =
            decode::<Claims>(token, &DecodingKey::from_jwk(key)?, &self.validation)?.claims;
        if claims.exp <= now || claims.nbf.is_some_and(|nbf| nbf > now) {
            bail!("invalid token time");
        }
        if claims.sub.is_empty() || claims.sub.len() > 255 {
            bail!("invalid subject");
        }
        Ok(claims.sub)
    }
}

pub struct App {
    pool: Arc<db::Pool>,
    verifier: Arc<Verifier>,
    admission: Arc<Semaphore>,
}
impl App {
    pub fn from_env() -> Result<Option<Arc<Self>>> {
        if std::env::var("POLIS_API_OWNER_LIST").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let path = std::env::var("POLIS_API_OWNER_JWKS_FILE")
            .context("POLIS_API_OWNER_JWKS_FILE required")?;
        let bytes = std::fs::read(path).context("read owner JWKS")?;
        if bytes.len() > 65536 {
            bail!("owner JWKS exceeds 64 KiB");
        }
        let verifier = Verifier::new(
            serde_json::from_slice(&bytes)?,
            &std::env::var("AUTH_ISSUER")?,
            &std::env::var("AUTH_AUDIENCE")?,
        )?;
        // An explicit DSN prevents accidentally sharing the participation pool.
        let dsn = std::env::var("POLIS_API_OWNER_DATABASE_URL")
            .context("POLIS_API_OWNER_DATABASE_URL required")?;
        let pool = db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-owner/1")?,
            db::Limits {
                size: 2,
                acquire_timeout: Duration::from_millis(250),
                statement_timeout: Duration::from_millis(1000),
                max_lifetime: Duration::from_secs(300),
            },
        );
        Ok(Some(Arc::new(Self {
            pool,
            verifier: Arc::new(verifier),
            admission: Arc::new(Semaphore::new(2)),
        })))
    }
    pub async fn handle(self: &Arc<Self>, req: Request) -> Outgoing {
        if req.method != "GET" && req.method != "HEAD" {
            return error(405, "method_not_allowed");
        }
        if !req.body.is_empty()
            || req.headers.get("content-length").is_some()
            || req.headers.get("transfer-encoding").is_some()
        {
            return error(400, "invalid_request");
        }
        let query = match Query::parse(req.query().unwrap_or_default()) {
            Ok(q) => q,
            Err(_) => return error(400, "invalid_request"),
        };
        let permit = match self.admission.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => return error(503, "owner_list_busy"),
        };
        let verifier = self.verifier.clone();
        let authorization = req.headers.get("authorization").map(str::to_owned);
        // A cancelled caller cannot free admission while signature work continues.
        let verified = tokio::task::spawn_blocking(move || {
            (verifier.subject(authorization.as_deref()), permit)
        })
        .await;
        let (subject, permit) = match verified {
            Ok((Ok(s), p)) => (s, p),
            _ => return error(401, "auth_invalid"),
        };
        let result = self
            .pool
            .with(move |client| {
                let _permit = permit;
                list(client, &subject, &query)
            })
            .await;
        match result {
            Ok(List::Page(page)) => response(200, page),
            Ok(List::Unmapped) => error(403, "owner_identity_unmapped"),
            Ok(List::BadCursor) => error(400, "invalid_cursor"),
            Err(_) => error(503, "owner_list_unavailable"),
        }
    }
}

enum List {
    Page(serde_json::Value),
    Unmapped,
    BadCursor,
}
fn list(client: &mut postgres::Client, subject: &str, q: &Query) -> Result<List> {
    let mapping = client.query_opt(
        "select m.uid from oidc_user_mappings m join users u on u.uid=m.uid where m.oidc_sub=$1",
        &[&subject],
    )?;
    let Some(mapping) = mapping else {
        return Ok(List::Unmapped);
    };
    let uid: i32 = mapping.try_get(0)?;
    if q.cursor.as_ref().is_some_and(|c| c.uid != uid) {
        return Ok(List::BadCursor);
    }
    let direction = if q.filter.sort == "oldest" {
        "ASC"
    } else {
        "DESC"
    };
    let comparison = if q.filter.sort == "oldest" { ">" } else { "<" };
    let sql = format!(
        "select c.zid, coalesce(c.created,0), z.zinvite, c.topic, c.description, coalesce(c.participant_count,0), c.is_active, c.is_draft, c.modified from conversations c join lateral (select zinvite from zinvites where zid=c.zid order by created asc nulls last, zinvite asc limit 1) z on true where c.owner=$1 and coalesce(c.participant_count,0)>=$2 and strpos(lower(coalesce(c.topic,'')),lower($3))>0 and ($4::boolean is null or c.is_active=$4) and ($5::boolean is null or c.is_draft=$5) and ($6::bigint is null or (coalesce(c.created,0),c.zid) {comparison} ($6,$7::integer)) order by coalesce(c.created,0) {direction}, c.zid {direction} limit $8"
    );
    let created = q.cursor.as_ref().map(|c| c.created);
    let zid = q.cursor.as_ref().map(|c| c.zid);
    let rows = client.query(
        &sql,
        &[
            &uid,
            &q.filter.min_participants,
            &q.filter.search,
            &q.filter.active,
            &q.filter.draft,
            &created,
            &zid,
            &(q.limit + 1),
        ],
    )?;
    let more = rows.len() as i64 > q.limit;
    let mut items = Vec::new();
    let mut last = None;
    for row in rows.iter().take(q.limit as usize) {
        let created: i64 = row.try_get(1)?;
        let modified: Option<i64> = row.try_get(8)?;
        if !(0..=MAX_SAFE).contains(&created)
            || modified.is_some_and(|n| !(0..=MAX_SAFE).contains(&n))
        {
            bail!("invalid stored timestamp");
        }
        items.push(json!({"conversation_id":row.try_get::<_, String>(2)?, "topic":row.try_get::<_, Option<String>>(3)?, "description":row.try_get::<_, Option<String>>(4)?, "created":created, "modified":modified, "participant_count":row.try_get::<_, i32>(5)?, "is_active":row.try_get::<_, Option<bool>>(6)?, "is_draft":row.try_get::<_, Option<bool>>(7)?}));
        last = Some(Cursor {
            version: 1,
            uid,
            filter: q.filter.clone(),
            created,
            zid: row.try_get(0)?,
        });
    }
    let next = if more {
        last.map(|c| serde_json::to_vec(&c).map(|v| URL_SAFE_NO_PAD.encode(v)))
            .transpose()?
    } else {
        None
    };
    Ok(List::Page(
        json!({"scope":"owner", "conversations":items, "pagination":{"limit":q.limit,"has_more":more,"next_cursor":next}, "sort":q.filter.sort}),
    ))
}

fn response(status: u16, body: serde_json::Value) -> Outgoing {
    let bytes = body.to_string().into_bytes();
    Outgoing {
        status,
        headers: vec![
            (
                "Content-Type".into(),
                "application/json; charset=utf-8".into(),
            ),
            ("Cache-Control".into(), "no-store".into()),
            ("Vary".into(), "Authorization".into()),
            ("Content-Length".into(), bytes.len().to_string()),
        ],
        body: Body::Fixed(bytes),
        close: false,
    }
}
pub fn error(status: u16, code: &str) -> Outgoing {
    response(status, json!({"error":code}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use openssl::rsa::Rsa;

    fn credentials() -> (Verifier, EncodingKey) {
        let rsa = Rsa::generate(2048).unwrap();
        let keys = serde_json::from_value(json!({"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"fixture","n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),"e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())}]})).unwrap();
        (
            Verifier::new(keys, "https://issuer.example/", "polis-api").unwrap(),
            EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        )
    }
    fn claims() -> serde_json::Value {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        json!({"sub":"owner-a", "iss":"https://issuer.example/", "aud":"polis-api", "exp":now+300, "uid":999})
    }
    fn token(key: &EncodingKey, claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("fixture".into());
        format!("Bearer {}", encode(&header, &claims, key).unwrap())
    }
    #[test]
    fn signed_identity_requires_issuer_audience_expiry_subject_and_rs256() {
        let (v, key) = credentials();
        assert_eq!(v.subject(Some(&token(&key, claims()))).unwrap(), "owner-a");
        for (field, value) in [
            ("iss", json!("https://elsewhere.example/")),
            ("aud", json!("other")),
            ("sub", json!("")),
            ("exp", json!(1)),
            ("nbf", json!(9_999_999_999u64)),
        ] {
            let mut c = claims();
            c[field] = value;
            assert!(v.subject(Some(&token(&key, c))).is_err(), "{field}");
        }
        for field in ["exp", "iss", "aud", "sub"] {
            let mut c = claims();
            c.as_object_mut().unwrap().remove(field);
            assert!(v.subject(Some(&token(&key, c))).is_err(), "missing {field}");
        }
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some("fixture".into());
        let hs = format!(
            "Bearer {}",
            encode(&header, &claims(), &EncodingKey::from_secret(b"fixture")).unwrap()
        );
        assert!(v.subject(Some(&hs)).is_err());
        let (_, other_key) = credentials();
        assert!(v.subject(Some(&token(&other_key, claims()))).is_err());
        for raw in [
            None,
            Some(""),
            Some("Bearer malformed"),
            Some("Basic anything"),
        ] {
            assert!(v.subject(raw).is_err());
        }
    }
    #[test]
    fn time_claims_reject_present_non_numeric_values() {
        let (v, key) = credentials();
        for field in ["exp", "nbf"] {
            for value in [
                json!("9999999999"),
                json!(null),
                json!(true),
                json!([]),
                json!({}),
            ] {
                let mut c = claims();
                c[field] = value;
                assert!(v.subject(Some(&token(&key, c))).is_err(), "{field}");
            }
        }
    }
    #[test]
    fn expiry_is_exclusive_and_not_before_is_inclusive() {
        let (v, key) = credentials();
        let mut c = claims();
        c["exp"] = json!(200);
        c["nbf"] = json!(100);
        let signed = token(&key, c);
        assert!(v.subject_at(Some(&signed), 99).is_err());
        for now in [100, 199] {
            assert_eq!(v.subject_at(Some(&signed), now).unwrap(), "owner-a");
        }
        for now in [200, 201] {
            assert!(v.subject_at(Some(&signed), now).is_err());
        }
    }
    #[test]
    fn query_rejects_duplicates_unknown_fields_and_mismatched_cursors() {
        for raw in [
            "limit=0",
            "limit=501",
            "limit=-1",
            "sort=arbitrary",
            "sort=newest&sort=oldest",
            "owner=1",
            "offset=1",
            "min_participants=-1",
            "is_active=1",
            "cursor=garbage",
            "search=%00",
        ] {
            assert!(Query::parse(raw).is_err(), "{raw}");
        }
        let q =
            Query::parse("sort=oldest&min_participants=2&search=%25_%20O%27Brien&is_active=false")
                .unwrap();
        assert_eq!(q.filter.search, "%_ O'Brien");
        let cursor = Cursor {
            version: 1,
            uid: 1,
            filter: q.filter.clone(),
            created: 7,
            zid: 4,
        };
        let raw = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap());
        assert!(Query::parse(&format!("cursor={raw}")).is_err());
        assert!(Query::parse(&format!("sort=oldest&min_participants=2&search=%25_%20O%27Brien&is_active=false&cursor={raw}")).is_ok());
    }

    #[cfg(feature = "db-tests")]
    fn request(query: &str, auth: Option<&str>) -> Request {
        let headers = auth.map(|a| vec![("authorization", a)]).unwrap_or_default();
        Request {
            method: "GET".into(),
            target: format!("{PATH}?{query}"),
            headers: crate::http::Headers::from_raw(headers),
            body: vec![],
        }
    }
    #[cfg(feature = "db-tests")]
    fn body(out: Outgoing) -> serde_json::Value {
        assert_eq!(out.status, 200);
        assert!(
            out.headers
                .contains(&("Cache-Control".into(), "no-store".into()))
        );
        match out.body {
            Body::Fixed(bytes) => serde_json::from_slice(&bytes).unwrap(),
            _ => panic!("fixed JSON contract"),
        }
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn owner_contract_on_postgres_and_saturated_pool_isolation() {
        use polis_queue_adapter::jobs::transport::Connector;
        use postgres::{Config, NoTls};
        let url =
            std::env::var("POLIS_API_TEST_DATABASE_URL").expect("db-tests requires PostgreSQL");
        let schema = format!("owner_list_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c=postgres::Client::connect(&setup_url,NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
            CREATE TABLE users(uid integer primary key);
            CREATE TABLE oidc_user_mappings(oidc_sub varchar(255) primary key,uid integer references users);
            CREATE TABLE conversations(zid integer primary key, owner integer, topic text, description text, created bigint, modified bigint, participant_count integer, is_active boolean, is_draft boolean);
            CREATE TABLE zinvites(zid integer,zinvite text,created bigint);
            INSERT INTO users VALUES (1),(2);
            INSERT INTO oidc_user_mappings VALUES ('owner-a',1),('owner-b',2);
            INSERT INTO conversations VALUES
            (1,1,'Alpha',null,100,100,5,true,false),
            (2,1,'beta',null,200,200,10,true,false),
            (3,1,'ALPHA %_',null,200,200,15,false,true),
            (4,2,'Alpha foreign',null,300,300,100,true,false),
            (5,1,'no link',null,300,300,20,true,false);
            INSERT INTO zinvites VALUES (1,'first',1),(1,'later',2),(2,'second',1),(3,'third',1),(4,'foreign',1);" )).unwrap();
        }).await.unwrap();
        let mut cfg: Config = url.parse().unwrap();
        cfg.options(&format!("-c search_path={schema}"));
        let limits = db::Limits {
            size: 2,
            acquire_timeout: Duration::from_millis(50),
            statement_timeout: Duration::from_millis(500),
            max_lifetime: Duration::from_secs(60),
        };
        let pool = db::Pool::new(Connector::Plain(Box::new(cfg.clone())), limits.clone());
        let other_pool = db::Pool::new(Connector::Plain(Box::new(cfg)), limits);
        let (verifier, key) = credentials();
        let app = Arc::new(App {
            pool: pool.clone(),
            verifier: Arc::new(verifier),
            admission: Arc::new(Semaphore::new(2)),
        });
        let auth = token(&key, claims());
        assert_eq!(app.handle(request("", None)).await.status, 401);
        assert_eq!(
            app.handle(request("", Some("Bearer invalid"))).await.status,
            401
        );
        let mut unknown = claims();
        unknown["sub"] = json!("unmapped");
        assert_eq!(
            app.handle(request("", Some(&token(&key, unknown))))
                .await
                .status,
            403
        );
        let one = body(app.handle(request("limit=1", Some(&auth))).await);
        assert_eq!(one["conversations"][0]["conversation_id"], "third");
        let cursor = one["pagination"]["next_cursor"].as_str().unwrap();
        let two = body(
            app.handle(request(&format!("limit=1&cursor={cursor}"), Some(&auth)))
                .await,
        );
        assert_eq!(two["conversations"][0]["conversation_id"], "second");
        let last = body(
            app.handle(request(
                &format!(
                    "limit=1&cursor={}",
                    two["pagination"]["next_cursor"].as_str().unwrap()
                ),
                Some(&auth),
            ))
            .await,
        );
        assert_eq!(last["conversations"][0]["conversation_id"], "first");
        assert_eq!(last["pagination"]["next_cursor"], serde_json::Value::Null);
        assert_eq!(last["pagination"]["has_more"], false);
        let mut foreign = claims();
        foreign["sub"] = json!("owner-b");
        assert_eq!(
            app.handle(request(
                &format!("limit=1&cursor={cursor}"),
                Some(&token(&key, foreign.clone()))
            ))
            .await
            .status,
            400
        );
        let theirs = body(app.handle(request("", Some(&token(&key, foreign)))).await);
        assert_eq!(theirs["conversations"].as_array().unwrap().len(), 1);
        assert_eq!(theirs["conversations"][0]["conversation_id"], "foreign");
        for (query, ids) in [
            ("sort=oldest", vec!["first", "second", "third"]),
            ("min_participants=10", vec!["third", "second"]),
            ("search=alpha", vec!["third", "first"]),
            ("search=%25_", vec!["third"]),
            ("is_active=true&is_draft=false", vec!["second", "first"]),
            ("search=%27%20OR%201%3D1", vec![]),
        ] {
            let page = body(app.handle(request(query, Some(&auth))).await);
            let got: Vec<_> = page["conversations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["conversation_id"].as_str().unwrap())
                .collect();
            assert_eq!(got, ids, "{query}");
        }
        // Saturate every owner DB slot with work which has definitely started.
        // A separate pool remains usable; owner requests shed load themselves.
        let mut tasks = vec![];
        let mut releases = vec![];
        for _ in 0..2 {
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            releases.push(release_tx);
            let p = pool.clone();
            tasks.push(tokio::spawn(async move {
                p.with(move |c| {
                    c.simple_query("select 1")?;
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
                .unwrap()
            }));
            entered_rx.await.unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(300), other_pool.ping())
                .await
                .unwrap()
        );
        assert_eq!(app.handle(request("", Some(&auth))).await.status, 503);
        for release in releases {
            release.send(()).unwrap();
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(app.handle(request("", Some(&auth))).await.status, 200);
        // Read-only sessions refuse mutations even if the login can write.
        assert!(
            pool.with(|c| Ok(c.batch_execute("delete from conversations")?))
                .await
                .is_err()
        );
        tokio::task::spawn_blocking(move || {
            drop(app);
            drop(pool);
            drop(other_pool);
            let mut c = postgres::Client::connect(&url, NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
}
