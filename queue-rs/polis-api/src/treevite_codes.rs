//! Off by default. Explicit owner actions on a dedicated primary pool and
//! dedicated bounded crypto thread; no participation resource is borrowed.
use crate::{
    config, db,
    http::{Outgoing, Request},
    js::Js,
    owner,
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use polis_auth::login_code::{LIFETIME_SECONDS, Prepared, Settings};
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};
#[path = "../../polis-contracts/src/treevite_codes.rs"]
mod contract;
use contract::Error;
pub use contract::{REISSUE_PATH, REVOKE_PATH};

pub(crate) fn matches(path: &str) -> bool {
    matches!(path, REVOKE_PATH | REISSUE_PATH)
}
struct Job {
    zid: i32,
    pid: i32,
    reply: tokio::sync::oneshot::Sender<Result<Prepared, polis_auth::Unavailable>>,
}
struct Crypto(mpsc::SyncSender<Job>);
impl Crypto {
    fn new(settings: Settings) -> Result<Self> {
        let (send, recv) = mpsc::sync_channel::<Job>(2);
        std::thread::Builder::new()
            .name("treevite-code-crypto".into())
            .spawn(move || {
                while let Ok(job) = recv.recv() {
                    let _ = job.reply.send(settings.prepare(job.zid, job.pid));
                }
            })?;
        Ok(Self(send))
    }
    async fn prepare(&self, zid: i32, pid: i32) -> Result<Prepared, Error> {
        let (reply, recv) = tokio::sync::oneshot::channel();
        self.0
            .try_send(Job { zid, pid, reply })
            .map_err(|_| Error::Unavailable)?;
        recv.await
            .map_err(|_| Error::Unavailable)?
            .map_err(|_| Error::Unavailable)
    }
}
pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    verifier: owner::Verifier,
    admins: Vec<i32>,
    crypto: Crypto,
    admitted: Arc<tokio::sync::Semaphore>,
}
impl Writer {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        if std::env::var("POLIS_API_TREEVITE_CODE_WRITES")
            .ok()
            .as_deref()
            != Some("1")
        {
            return Ok(None);
        }
        let dsn = std::env::var("POLIS_API_TREEVITE_CODE_DATABASE_URL")
            .context("Treevite code writes require an explicit primary database")?;
        let jwks = std::fs::read(std::env::var("POLIS_API_READ_JWKS_FILE")?)?;
        anyhow::ensure!(jwks.len() <= 65536, "JWKS exceeds 64 KiB");
        Ok(Some(Self {
            pool: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-treevite-codes/1")?,
                db::Limits {
                    size: 2,
                    acquire_timeout: Duration::from_millis(100),
                    statement_timeout: Duration::from_secs(1),
                    max_lifetime: Duration::from_secs(300),
                },
            ),
            verifier: owner::Verifier::new(
                serde_json::from_slice(&jwks)?,
                &std::env::var("AUTH_ISSUER")?,
                &std::env::var("AUTH_AUDIENCE")?,
            )?,
            admins: serde_json::from_str(
                &std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()),
            )?,
            crypto: Crypto::new(Settings::from_lookup(|name| std::env::var(name).ok()))?,
            admitted: Arc::new(tokio::sync::Semaphore::new(4)),
        }))
    }
}

// Only authentication/authority tables are read before permission is established.
// No participant or login-code row (including existence) leaks across this gate.
fn authorize(
    c: &mut impl postgres::GenericClient,
    sub: &str,
    cid: &str,
    admins: &[i32],
) -> Result<Option<i32>> {
    let Some(row) = c.query_opt("SELECT z.zid,m.uid,c.owner FROM oidc_user_mappings m JOIN users u ON u.uid=m.uid CROSS JOIN zinvites z JOIN conversations c ON c.zid=z.zid WHERE m.oidc_sub=$1 AND z.zinvite=$2", &[&sub, &cid])? else { return Ok(None); };
    let zid: i32 = row.try_get(0)?;
    let uid: i32 = row.try_get(1)?;
    if uid <= 0 {
        return Ok(None);
    }
    let owner: Option<i32> = row.try_get(2)?;
    if owner == Some(uid) || admins.contains(&uid) {
        return Ok(Some(zid));
    }
    let count: i64 = c
        .query_one(polis_auth::MODERATOR_SQL, &[&zid, &uid])?
        .try_get(0)?;
    Ok((count > 0).then_some(zid))
}

fn write(
    c: &mut postgres::Client,
    sub: &str,
    input: &contract::Request,
    admins: &[i32],
    prepared: Option<&Prepared>,
    expected_zid: i32,
) -> Result<(), Error> {
    let mut tx = c.transaction().map_err(|_| Error::Unavailable)?;
    let zid = authorize(&mut tx, sub, &input.conversation_id, admins)
        .map_err(|_| Error::Unavailable)?
        .ok_or(Error::Forbidden)?;
    if zid != expected_zid {
        return Err(Error::Unavailable);
    }
    let changed = if let Some(p) = prepared {
        tx.execute("UPDATE treevite_login_codes SET login_code_hash=$3,login_code_lookup=$4,login_code_fingerprint=$5,fp_kid=1,revoked=false,expires_at=now()+interval '365 days',updated_at=now() WHERE zid=$1 AND pid=$2", &[&zid, &input.pid, &p.hash, &p.lookup, &p.fingerprint])
    } else {
        tx.execute("UPDATE treevite_login_codes SET revoked=true, updated_at=now() WHERE zid=$1 AND pid=$2", &[&zid, &input.pid])
    }.map_err(|_| Error::Unavailable)?;
    if changed == 0 {
        return Err(Error::NotFound);
    }
    tx.commit().map_err(|_| Error::OutcomeUnknown)
}
pub(crate) fn session_revoked(req: &Request, res: Res) -> Outgoing {
    fail(req, res, Error::SessionRevoked)
}
fn fail(req: &Request, res: Res, error: Error) -> Outgoing {
    route::fail_json(req, res, error.status(), Js::Str(error.code().into()))
}
pub(crate) async fn handle(app: &App, req: &Request, mut res: Res) -> Outgoing {
    let Some(writer) = &app.treevite_codes else {
        return route::bad_gateway();
    };
    res.set("Cache-Control", "no-store");
    if !app.production
        || !(app.dev_mode
            || app.use_network_host
            || req.headers.get("x-forwarded-proto") == Some("https"))
    {
        return fail(req, res, Error::InvalidRequest);
    }
    let Ok(sub) = writer.verifier.subject_at(
        req.headers.get("authorization"),
        (crate::clock::now_ms() / 1000.0) as u64,
    ) else {
        return fail(req, res, Error::Forbidden);
    };
    if req.method != "POST"
        || req.query().is_some_and(|q| !q.is_empty())
        || req.body.len() > 4096
        || req.headers.get("cookie").is_some()
        || req.headers.get("content-encoding").is_some()
        || !matches!(
            req.headers.get("content-type"),
            Some("application/json" | "application/json; charset=utf-8")
        )
    {
        return fail(req, res, Error::InvalidRequest);
    }
    let Ok(input) = serde_json::from_slice::<contract::Request>(&req.body) else {
        return fail(req, res, Error::InvalidRequest);
    };
    if !input.valid() {
        return fail(req, res, Error::InvalidRequest);
    }
    let Ok(permit) = writer.admitted.clone().try_acquire_owned() else {
        return fail(req, res, Error::Unavailable);
    };
    let auth_sub = sub.clone();
    let cid = input.conversation_id.clone();
    let admins = writer.admins.clone();
    let zid = match writer
        .pool
        .with(move |c| authorize(c, &auth_sub, &cid, &admins))
        .await
    {
        Ok(Some(zid)) => zid,
        Ok(None) => return fail(req, res, Error::Forbidden),
        Err(_) => return fail(req, res, Error::Unavailable),
    };
    let prepared = if req.path() == REISSUE_PATH {
        match writer.crypto.prepare(zid, input.pid).await {
            Ok(p) => Some(p),
            Err(e) => return fail(req, res, e),
        }
    } else {
        None
    };
    let admins = writer.admins.clone();
    // Once dispatched, complete the transaction even if the caller disconnects.
    // Never retry an uncertain commit or a lost reply automatically.
    let result = writer
        .pool
        .with(move |c| {
            let _permit = permit;
            let outcome = write(c, &sub, &input, &admins, prepared.as_ref(), zid);
            Ok(outcome.map(|()| prepared.map(|p| p.code)))
        })
        .await;
    let code = match result {
        Ok(Ok(code)) => code,
        Ok(Err(e)) => return fail(req, res, e),
        Err(_) => return fail(req, res, Error::OutcomeUnknown),
    };
    let body = match code {
        Some(login_code) => serde_json::to_string(&contract::Reissued {
            login_code,
            expires_in: LIFETIME_SECONDS,
        }),
        None => serde_json::to_string(&contract::Revoked { revoked: true }),
    };
    match body {
        Ok(body) => route::json_text(req, res, 200, body),
        Err(_) => fail(req, res, Error::OutcomeUnknown),
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "treevite_codes_tests.rs"]
mod tests;
