//! Opt-in credential exchanges with independent database and crypto capacity.
//! No handoff is permitted once enabled, and no crypto runs in admission locks.
use crate::{
    config, db,
    http::{Outgoing, Request},
    js::{self, Js},
    params,
    route::{self, App, Res},
    treevite_write_contract::{self as contract, Operation},
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use polis_auth::{
    Uid, Zid,
    admission::{self, Entry, Identity, PreparedRecovery, VerifiedLogin},
    participant,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

const PREFLIGHT_DEADLINE: Duration = Duration::from_millis(250);
const DISPATCH_DEADLINE: Duration = Duration::from_secs(1);
const CRYPTO_WORKERS: usize = 4;
const DISPATCH_LIMIT: usize = 8;

pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    children: Arc<db::Pool>,
    crypto: Arc<Semaphore>,
    dispatches: Arc<Semaphore>,
    keys: polis_auth::keys::Keys,
    verifier: participant::Verifier,
    issuer: String,
    audience: String,
    pepper: String,
    fingerprint: Vec<u8>,
    admins: Vec<Uid>,
}
impl Writer {
    pub(crate) fn from_env() -> Result<Option<Arc<Self>>> {
        if std::env::var("POLIS_API_TREEVITE_WRITE").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let dsn = std::env::var("POLIS_API_TREEVITE_WRITE_DATABASE_URL")
            .context("Treevite requires an explicit primary database")?;
        let keys = polis_auth::keys::Keys::from_env()?;
        anyhow::ensure!(
            keys.private_key().is_some(),
            "Treevite requires the participant signing key"
        );
        let issuer = std::env::var("POLIS_JWT_ISSUER")?;
        let audience = std::env::var("POLIS_JWT_AUDIENCE")?;
        let verifier = keys
            .verifier(&issuer, &audience)
            .context("invalid participant verifier configuration")?;
        let (pepper, fingerprint) = peppers(|name| std::env::var(name).ok());
        let admins: Vec<i32> =
            serde_json::from_str(&std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()))?;
        Ok(Some(Arc::new(Self {
            pool: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-treevite-admission/1")?,
                limits(8),
            ),
            children: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-treevite-children/1")?,
                limits(2),
            ),
            crypto: Arc::new(Semaphore::new(CRYPTO_WORKERS)),
            dispatches: Arc::new(Semaphore::new(DISPATCH_LIMIT)),
            keys,
            verifier,
            issuer,
            audience,
            pepper,
            fingerprint,
            admins: admins.into_iter().map(Uid).collect(),
        })))
    }
    async fn crypto<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = tokio::time::timeout(
            Duration::from_millis(250),
            self.crypto.clone().acquire_owned(),
        )
        .await??;
        // The permit belongs to the blocking worker, even if its caller leaves.
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        })
        .await?
    }
}
fn limits(size: usize) -> db::Limits {
    db::Limits {
        size,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_secs(1),
        max_lifetime: Duration::from_secs(300),
    }
}
fn peppers(get: impl Fn(&str) -> Option<String>) -> (String, Vec<u8>) {
    let encryption = get("ENCRYPTION_PASSWORD_00001").filter(|v| !v.is_empty());
    (
        get("LOGIN_CODE_PEPPER")
            .filter(|v| !v.is_empty())
            .or_else(|| encryption.clone())
            .unwrap_or_else(|| "polis_treevite_pepper".into()),
        encryption
            .unwrap_or_else(|| "polis_treevite_fingerprint_key".into())
            .into_bytes(),
    )
}
fn lookup(code: &str, pepper: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(code.as_bytes());
    digest.update(pepper.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn code(alphabet: &[u8], len: usize) -> String {
    (0..len)
        .map(|_| alphabet[rand::random_range(0..alphabet.len())] as char)
        .collect()
}
const LOGIN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
pub(crate) fn matches(path: &str) -> bool {
    Operation::from_path(path).is_some()
}

#[derive(Clone, Copy)]
struct Refused {
    status: u16,
    code: &'static str,
}
fn refusal(status: u16, code: &'static str) -> Refused {
    Refused { status, code }
}
const UNAVAILABLE: Refused = Refused {
    status: 503,
    code: "polis_err_treevite_unavailable",
};
const INVALID_LOGIN: Refused = Refused {
    status: 401,
    code: "polis_err_treevite_login_code_invalid",
};

#[derive(Clone)]
enum Evidence {
    Anonymous,
    Participant(Uid, Zid),
    Converted,
}
impl Evidence {
    fn identity(&self) -> Identity<'_> {
        match self {
            Self::Anonymous => Identity::Anonymous,
            Self::Participant(uid, conversation) => Identity::AnonymousParticipant {
                uid: *uid,
                conversation: *conversation,
            },
            Self::Converted => Identity::Account(Uid(0)),
        }
    }
}

pub(crate) async fn handle(app: &App, req: &Request, body: &Js, res: Res) -> Outgoing {
    let Some(writer) = app.treevite_write.clone() else {
        return route::bad_gateway();
    };
    let Some(operation) = Operation::from_path(req.path()) else {
        return route::bad_gateway();
    };
    let fields = params::merged(body, &params::parse_query(req.query().unwrap_or_default()));
    let fail = |r: Refused| {
        if r.code == "polis_err_authentication_required" {
            route::json_text(req, res.clone(), 401, r#"{"error":"Invalid token format","details":"Token does not match any supported JWT type"}"#.into())
        } else {
            route::fail_json(req, res.clone(), r.status, Js::Str(r.code.into()))
        }
    };
    let cid = match fields.get("conversation_id") {
        Some(Js::Str(s)) if s.encode_utf16().count() <= 100 => Some(s.trim_matches(' ').to_owned()),
        _ => None,
    };
    let input = match fields.get(operation.field()) {
        Some(Js::Str(s)) if s.encode_utf16().count() <= operation.limit() => {
            Some(contract::trim_code(s).to_owned())
        }
        _ => None,
    };
    let Ok(permit) = writer.dispatches.clone().try_acquire_owned() else {
        return fail(UNAVAILABLE);
    };
    let auth = req
        .headers
        .get("authorization")
        .filter(|raw| raw.starts_with("Bearer "))
        .map(str::to_owned);
    let account = auth.as_deref().is_some_and(|raw| {
        app.read_oidc
            .as_ref()
            .is_some_and(|oidc| oidc.verifies(raw, (crate::clock::now_ms() / 1000.0) as u64))
    });
    let w = writer.clone();
    let preliminary = writer.pool.with(
        move |c| -> Result<std::result::Result<(Zid, String, Evidence), Refused>> {
            let evidence = if account {
                Evidence::Converted
            } else if let Some(auth) = auth {
                // Hints select the signed scope only. Verification is still mandatory.
                let hints = polis_auth::observability::credential_hints(&auth);
                let signed_cid = hints
                    .as_ref()
                    .and_then(|p| p.get("conversation_id"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let mut db = polis_auth::PostgresLookup(c);
                let mut check = polis_auth::xid_account::Check {
                    db: &mut db,
                    admin_uids: &w.admins,
                };
                let identity = w.verifier.verify_for_request(
                    &auth,
                    signed_cid,
                    None,
                    (crate::clock::now_ms() / 1000.0) as u64,
                    &mut check,
                );
                match identity {
                    Ok(Some(identity)) if identity.kind == participant::Kind::Anonymous => {
                        let scope = db::zid_for_conversation_id(c, signed_cid)?.unwrap_or(-1);
                        identity.uid().map_or(Evidence::Anonymous, |uid| {
                            Evidence::Participant(uid, Zid(scope))
                        })
                    }
                    Ok(Some(_)) => Evidence::Converted,
                    Err(polis_auth::xid_account::Refusal::Privileged(_)) => {
                        return Ok(Err(refusal(403, "polis_err_xid_owner_account")));
                    }
                    Err(polis_auth::xid_account::Refusal::CheckFailed) => {
                        return Ok(Err(refusal(500, "polis_err_participant_creation")));
                    }
                    Ok(None) => return Ok(Err(refusal(401, "polis_err_authentication_required"))),
                }
            } else {
                Evidence::Anonymous
            };
            let Some(cid) = cid else {
                return Ok(Err(refusal(400, "parameter_error")));
            };
            let Some(zid) = db::zid_for_conversation_id(c, &cid)? else {
                return Ok(Err(refusal(
                    404,
                    "polis_err_fetching_zid_for_conversation_id",
                )));
            };
            let canonical: String = c
                .query_one("SELECT zinvite FROM zinvites WHERE zid=$1 LIMIT 1", &[&zid])?
                .try_get(0)?;
            Ok(Ok((Zid(zid), canonical, evidence)))
        },
    );
    let preliminary = tokio::time::timeout(PREFLIGHT_DEADLINE, preliminary).await;
    let (zid, canonical, evidence) = match preliminary {
        Ok(Ok(Ok(v))) => v,
        Ok(Ok(Err(Refused {
            code: "parameter_error",
            ..
        }))) => return route::parameter_error(app, req, res),
        Ok(Ok(Err(r))) => return fail(r),
        _ => return fail(UNAVAILABLE),
    };
    let Some(input) = input else {
        return route::parameter_error(app, req, res);
    };
    if input.is_empty() {
        return fail(refusal(400, "polis_err_treevite_invalid_request"));
    }
    if matches!(evidence, Evidence::Converted) {
        return fail(refusal(403, "polis_err_treevite_identity_conversion"));
    }
    let receipt = Arc::new(Mutex::new(None));
    let receipt_task = receipt.clone();
    // Detached on deadline/disconnect. Keep the dispatch permit through all work.
    let task = tokio::spawn(async move {
        let _permit = permit;
        dispatch(
            writer,
            operation,
            zid,
            canonical,
            evidence,
            input,
            receipt_task,
        )
        .await
    });
    match tokio::time::timeout(DISPATCH_DEADLINE, task).await {
        Ok(Ok(Ok(success))) => success_response(req, res, operation, success),
        Ok(Ok(Err(r))) => fail(r),
        _ => {
            let success = receipt.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(success) = success {
                success_response(req, res, operation, success)
            } else {
                route::json_text(
                    req,
                    res,
                    202,
                    serde_json::to_string(&contract::Unknown {
                        acceptance: "unknown",
                        error: "polis_err_treevite_acceptance_unknown",
                        retry: "do_not_retry_invite",
                    })
                    .unwrap_or_default(),
                )
            }
        }
    }
}
fn success_response(
    req: &Request,
    res: Res,
    operation: Operation,
    success: contract::Success,
) -> Outgoing {
    route::json_text(
        req,
        res,
        if matches!(success, contract::Success::Pending(_)) {
            202
        } else if operation == Operation::Accept {
            201
        } else {
            200
        },
        serde_json::to_string(&success).unwrap_or_default(),
    )
}

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    writer: Arc<Writer>,
    operation: Operation,
    zid: Zid,
    canonical: String,
    evidence: Evidence,
    input: String,
    receipt: Arc<Mutex<Option<contract::Success>>>,
) -> std::result::Result<contract::Success, Refused> {
    let pepper = writer.pepper.clone();
    let (raw, hash, digest) = if operation == Operation::Accept {
        // Repair acknowledged membership independently of this attempt's
        // admission outcome, including spent retries and second-invite burns.
        let member = match evidence {
            Evidence::Participant(uid, scope) if scope == zid => Some(uid.0),
            _ => None,
        };
        let consumed = input.clone();
        if writer
            .children
            .with(move |c| reconcile_children(c, zid, &consumed, member))
            .await
            .is_err()
        {
            eprintln!("{{\"event\":\"treevite_children_pending\"}}");
        }
        let probe = input.clone();
        let valid = writer
            .pool
            .with(move |c| {
                Ok(c.query_opt(
                    "SELECT 1 FROM treevite_invites WHERE zid=$1 AND invite_code=$2 AND status=0",
                    &[&zid.0, &probe],
                )?
                .is_some())
            })
            .await
            .map_err(|_| UNAVAILABLE)?;
        if !valid {
            return Err(refusal(400, "polis_err_treevite_invalid_or_used_invite"));
        }
        writer
            .crypto(move || {
                let raw = code(LOGIN_ALPHABET, 16);
                let digest = lookup(&raw, &pepper);
                let hash = bcrypt::hash(&raw, 10)?;
                Ok((raw, hash, digest))
            })
            .await
            .map_err(|_| UNAVAILABLE)?
    } else {
        let digest = writer
            .crypto({
                let input = input.clone();
                move || Ok(lookup(&input, &pepper))
            })
            .await
            .map_err(|_| UNAVAILABLE)?;
        let d = digest.clone();
        let candidate = writer.pool.with(move |c| Ok(c.query_opt("SELECT login_code_hash FROM treevite_login_codes WHERE zid=$1 AND login_code_lookup=$2 AND NOT revoked", &[&zid.0, &d])?.map(|r| r.try_get::<_, String>(0)).transpose()?)).await.map_err(|_| UNAVAILABLE)?.ok_or(INVALID_LOGIN)?;
        let login_input = input.clone();
        writer
            .crypto(move || {
                if !bcrypt::verify(&login_input, &candidate).unwrap_or(false) {
                    return Ok(None);
                }
                Ok(Some((String::new(), candidate, digest)))
            })
            .await
            .map_err(|_| UNAVAILABLE)?
            .ok_or(INVALID_LOGIN)?
    };
    let w = writer.clone();
    let raw2 = raw.clone();
    let result = writer
        .pool
        .with(move |c| {
            let entry = if operation == Operation::Accept {
                Entry::Invite {
                    code: &input,
                    recovery: PreparedRecovery {
                        code: &raw2,
                        bcrypt_hash: &hash,
                        lookup: &digest,
                        fingerprint_key: &w.fingerprint,
                    },
                }
            } else {
                Entry::Login(VerifiedLogin {
                    lookup: &digest,
                    bcrypt_hash: &hash,
                })
            };
            Ok(admission::admit(
                c,
                &admission::Request {
                    zid,
                    identity: evidence.identity(),
                    entry,
                    admin_uids: &w.admins,
                    x_name: None,
                    x_email: None,
                    x_profile_image_url: None,
                },
            ))
        })
        .await
        .map_err(|_| UNAVAILABLE)?;
    let admitted = match result {
        Ok(Some(a)) => a,
        Err(admission::Error::Refused(r)) => return Err(refusal(r.status, r.code)),
        Err(admission::Error::CommitUnknown) => {
            return Err(refusal(202, "polis_err_treevite_acceptance_unknown"));
        }
        _ => return Err(UNAVAILABLE),
    };
    // Publish the durable recovery credential before any fallible signing work.
    // A deadline after commit must not discard the client's only way back.
    let pending = admitted.invite.map(|(invite, wave)| {
        contract::Success::Pending(contract::AcceptedPending {
            status: "accepted",
            wave_id: wave.to_string(),
            invite_id: invite.to_string(),
            login_code: raw.clone(),
            error: "polis_err_treevite_accepted_token_unavailable",
            retry: "login_with_saved_code",
        })
    });
    *receipt.lock().unwrap_or_else(|e| e.into_inner()) = pending.clone();
    let w = writer.clone();
    let success = match writer.crypto(move || sign(&w, &canonical, admitted)).await {
        Ok(auth) => match admitted.invite {
            Some((invite, wave)) => contract::Success::Accepted(contract::Accepted {
                status: "ok",
                wave_id: wave.to_string(),
                invite_id: invite.to_string(),
                login_code: raw,
                auth,
            }),
            None => contract::Success::LoggedIn(contract::LoggedIn { status: "ok", auth }),
        },
        Err(_) => pending.ok_or(refusal(503, "polis_err_treevite_login_failed"))?,
    };
    *receipt.lock().unwrap_or_else(|e| e.into_inner()) = Some(success.clone());
    // A later login retries discovery/top-up after an interrupted acceptance.
    // Discovery uses primary, and every top-up counts all statuses under lock.
    let result = writer.children.with(move |c| {
        let parents = if let Some(invite) = admitted.invite { vec![invite] } else {
            c.query("SELECT id,wave_id FROM treevite_invites WHERE zid=$1 AND invite_used_by_pid=$2 AND status=1 ORDER BY id LIMIT 11", &[&zid.0, &(admitted.pid.0 as i32)])?
                .iter().map(|row| Ok((row.try_get(0)?,row.try_get(1)?))).collect::<Result<Vec<(i64,i64)>>>()?
        };
        anyhow::ensure!(parents.len() <= 10, "parent invite reconciliation required");
        for (invite,wave) in parents { issue_children(c,zid,admitted.pid.0 as i32,wave,invite)?; }
        Ok(())
    }).await;
    if result.is_err() {
        eprintln!("{{\"event\":\"treevite_children_pending\"}}");
    }
    Ok(success)
}

#[derive(Serialize)]
struct Claims<'a> {
    aud: &'a str,
    iss: &'a str,
    pid: u32,
    uid: i32,
    exp: u64,
    iat: u64,
    conversation_id: &'a str,
    sub: String,
    anonymous_participant: bool,
}
fn sign(writer: &Writer, cid: &str, admitted: admission::Admitted) -> Result<contract::Auth> {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let claims = Claims {
        aud: &writer.audience,
        iss: &writer.issuer,
        pid: admitted.pid.0,
        uid: admitted.uid.0,
        exp: now + contract::SESSION_SECONDS,
        iat: now,
        conversation_id: cid,
        sub: format!("anon:{}", admitted.uid.0),
        anonymous_participant: true,
    };
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
    let signing_input = format!("{header}.{payload}");
    let signature = jsonwebtoken::crypto::sign(
        signing_input.as_bytes(),
        writer
            .keys
            .private_key()
            .context("signing key unavailable")?,
        jsonwebtoken::Algorithm::RS256,
    )?;
    let token = format!("{signing_input}.{signature}");
    Ok(contract::Auth {
        token,
        token_type: "Bearer",
        expires_in: contract::SESSION_SECONDS,
    })
}
fn issue_children(
    c: &mut postgres::Client,
    zid: Zid,
    pid: i32,
    wave: i64,
    invite: i64,
) -> Result<()> {
    let children = c.query("SELECT child.id,child.invites_per_user FROM treevite_waves child JOIN treevite_waves parent ON parent.id=$2 AND parent.zid=child.zid AND parent.wave=child.parent_wave WHERE child.zid=$1 AND child.invites_per_user>0 ORDER BY child.id LIMIT 11", &[&zid.0, &wave])?;
    anyhow::ensure!(children.len() <= 10, "child wave reconciliation required");
    for child in children {
        let id: i64 = child.try_get(0)?;
        let allowance: i32 = child.try_get(1)?;
        fill_child(c, zid, pid, invite, id, allowance)?;
    }
    Ok(())
}

// Discover only missing allocations from committed consumed parents. Limit
// work, not the number of historical parents: completed rows cannot starve
// later gaps. Child codes in every state count toward the original promise.
fn reconcile_children(
    c: &mut postgres::Client,
    zid: Zid,
    consumed: &str,
    member: Option<i32>,
) -> Result<()> {
    let gaps = c.query(
        "SELECT DISTINCT ON (child.id,i.invite_used_by_pid)
            child.id,child.invites_per_user,i.invite_used_by_pid,i.id
         FROM treevite_invites i
         JOIN treevite_waves parent ON parent.id=i.wave_id AND parent.zid=i.zid
         JOIN treevite_waves child ON child.zid=parent.zid AND child.parent_wave=parent.wave
         JOIN participants p ON p.zid=i.zid AND p.pid=i.invite_used_by_pid
         WHERE i.zid=$1 AND i.status=1 AND (i.invite_code=$2 OR p.uid=$3)
           AND child.invites_per_user BETWEEN 1 AND 5
           AND (SELECT count(*) FROM treevite_invites issued
                WHERE issued.wave_id=child.id AND issued.invite_owner_pid=i.invite_used_by_pid)
               < child.invites_per_user
         ORDER BY child.id,i.invite_used_by_pid,i.id LIMIT 10",
        &[&zid.0, &consumed, &member],
    )?;
    for gap in gaps {
        fill_child(
            c,
            zid,
            gap.try_get(2)?,
            gap.try_get(3)?,
            gap.try_get(0)?,
            gap.try_get(1)?,
        )?;
    }
    Ok(())
}

fn fill_child(
    c: &mut postgres::Client,
    zid: Zid,
    pid: i32,
    invite: i64,
    id: i64,
    allowance: i32,
) -> Result<()> {
    anyhow::ensure!(allowance <= 5, "child allowance reconciliation required");
    let mut tx = c.transaction()?;
    tx.batch_execute("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='1s'")?;
    tx.query_one("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:per-user-codes', $1::bigint, $2::int)::text,0))", &[&id, &pid])?;
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM treevite_invites WHERE wave_id=$1 AND invite_owner_pid=$2",
            &[&id, &pid],
        )?
        .try_get(0)?;
    for _ in count..i64::from(allowance) {
        let mut inserted = false;
        for _ in 0..5 {
            let code = code(INVITE_ALPHABET, 10);
            if tx.execute("INSERT INTO treevite_invites(zid,wave_id,parent_invite_id,invite_code,invite_owner_pid) VALUES($1,$2,$3,$4,$5) ON CONFLICT(zid,invite_code) DO NOTHING", &[&zid.0, &id, &invite, &code, &pid])? == 1 { inserted = true; break; }
        }
        anyhow::ensure!(inserted, "child invite collision limit");
    }
    tx.commit()?;
    Ok(())
}
pub(crate) fn health(app: &App) -> Js {
    let mut body = js::Obj::new();
    body.set("enabled", Js::Bool(app.treevite_write.is_some()));
    body.set("dispatchLimit", Js::Num(DISPATCH_LIMIT as f64));
    body.set("cryptoWorkers", Js::Num(CRYPTO_WORKERS as f64));
    body.set(
        "dispatchDeadlineMs",
        Js::Num(DISPATCH_DEADLINE.as_millis() as f64),
    );
    Js::Obj(body)
}

#[cfg(test)]
#[path = "treevite_write_tests.rs"]
mod tests;
