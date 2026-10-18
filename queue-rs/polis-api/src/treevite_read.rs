//! Verified, conversation-scoped identities and the legacy site-moderator rule.
use crate::{db::Pool, http::Request, route::App};
use polis_auth::{Authority, Level, PostgresLookup, Principal, Uid, Zid};
use std::sync::Arc;
pub async fn identity(app: &App, req: &Request, pool: &Arc<Pool>, cid: &str) -> Option<(i32, Uid)> {
    let uid = crate::hybrid_read::resolve_scoped(
        req.headers.get("authorization"),
        app.participant_verifier.as_deref(),
        app.read_oidc.as_deref(),
        pool,
        Some(cid),
    )
    .await?
    .uid()?;
    let cid = cid.to_owned();
    let zid = pool
        .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
        .await
        .ok()
        .flatten()?;
    (zid > 0).then_some((zid, uid))
}
pub fn permits(
    c: &mut postgres::Client,
    zid: i32,
    uid: Uid,
    admins: &[i32],
) -> anyhow::Result<bool> {
    let admins = admins.iter().copied().map(Uid).collect::<Vec<_>>();
    let principal = Principal::User {
        uid,
        oidc_sub: None,
    };
    let authority = Authority::for_conversation(
        &mut PostgresLookup(c),
        Zid(zid),
        &principal,
        Level::Moderator,
        &admins,
    )
    .map_err(|_| anyhow::anyhow!("authority lookup unavailable"))?;
    Ok(authority == Authority::SiteModerator)
}
