//! Scope release after a terminal attempt (P-073 r2; operating-surface map,
//! finding 2). `pd_enqueue` holds one guard per scope (`delphi_job_guards`)
//! until an explicit, safe release: `pd_release_scope` deletes it only when
//! every job of the root's tree is terminal, every attempt's exit is proven
//! and no provider request is open, and returns false otherwise. Nobody
//! called it, so the first terminal job occupied its conversation forever.
//!
//! The daemon calls it here, right after a terminal reply (succeeded, dead,
//! cancelled) for an attempt whose exit it proved: the scope comes from
//! `pd_job_view` (`scope_key`, polis-queue/3). The SQL re-checks every
//! condition, so a false reply is never an error: the guard stays and the
//! transition says why. On a `/2` database the view has no scope key and the
//! guard stays (`scope_unknown`). Terminal status alone releases nothing.
use super::{
    readiness::{Counters, Transition},
    rpc::{Rpc, db_message},
    task,
};
use serde_json::{Value, json};

pub const TERMINAL: [&str; 3] = ["succeeded", "dead", "cancelled"];

/// After a terminal reply: release the job's scope if the database agrees.
/// Emits one transition (`scope_released` or `scope_held`, with the reason).
pub fn after_terminal(
    rpc: &mut Rpc,
    counters: &Counters,
    owner: &str,
    env: &str,
    job_id: &str,
    state: &str,
) {
    if !TERMINAL.contains(&state) {
        return;
    }
    let mut t = Transition {
        env: env.to_owned(),
        job_id: job_id.to_owned(),
        from: state.to_owned(),
        to: "scope_held".into(),
        owner: owner.to_owned(),
        ..Default::default()
    };
    let view = match rpc.committed("pd_job_view", &[json!(env), json!(job_id)]) {
        Ok(v) => v,
        Err(e) => {
            t.reason = Some(db_message(&e).unwrap_or_else(|| "job_view_unavailable".into()));
            t.emit();
            return;
        }
    };
    let Some(scope) = view["scope_key"].as_str().filter(|s| !s.is_empty()) else {
        // A /2 database (no scope key in the view), or already released.
        t.reason = Some(if view.get("scope_key").is_some() {
            "scope_already_released".into()
        } else {
            "scope_unknown".into()
        });
        t.emit();
        return;
    };
    match task::terminal(rpc, "pd_release_scope", &[json!(env), json!(scope)]) {
        Ok(Value::Bool(true)) => {
            Counters::bump(&counters.released);
            t.to = "scope_released".into();
            t.reason = Some(scope.to_owned());
        }
        Ok(_) => {
            // Descendants active, an exit unproven or provider work open.
            t.reason = Some(format!("release_refused:{scope}"));
        }
        Err(e) => {
            t.reason = Some(db_message(&e).unwrap_or_else(|| "database_unreachable".into()));
        }
    }
    t.emit();
}
