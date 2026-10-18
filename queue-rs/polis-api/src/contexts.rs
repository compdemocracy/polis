//! Public contexts with verified hybrid auth on separate bounded read-only pools.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
// The contracts crate belongs to the CLI workspace. Compile its shared module
// here too, so both workspaces use the same types without a workspace migration.
#[path = "../../polis-contracts/src/contexts.rs"]
mod contract;
pub use contract::PATH;

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.contexts_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some_and(|q| !q.is_empty())
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    Some(contract::Request::default())
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(_query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Some(pool) = &app.contexts_db else {
        return route::bad_gateway();
    };
    let Some(auth_pool) = &app.contexts_auth_db else {
        return route::bad_gateway();
    };
    let result = tokio::time::timeout(std::time::Duration::from_millis(75), async {
        if !crate::hybrid_read::optional(
            req.headers.get("authorization"),
            app.participant_verifier.as_deref(),
            app.read_oidc.as_deref(),
            auth_pool,
        )
        .await
        {
            return None;
        }
        pool.with(|client| {
            let rows = client.query(
                "select name from contexts where is_public = TRUE order by name;",
                &[],
            )?;
            rows.iter()
                .map(|row| {
                    Ok(contract::Context {
                        name: row.try_get(0)?,
                    })
                })
                .collect::<anyhow::Result<contract::Response>>()
        })
        .await
        .ok()
    })
    .await;
    let Ok(Some(response)) = result else {
        return route::bad_gateway();
    };
    let Ok(encoded) = serde_json::to_string(&response) else {
        return route::bad_gateway();
    };
    let Ok(value) = crate::js::parse(&encoded) else {
        return route::bad_gateway();
    };
    route::json(req, res, &value)
}

pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
