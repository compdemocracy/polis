//! Exit code / signal / timeout / fence / shutdown → the `/2` call that ends
//! the attempt (build spec §1.3). Every row runs only after the child's
//! process group has been reaped, so the exit-proof argument is always `true`.
use super::manifest::{Invalid, Manifest, Outcome};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    /// The group leader exited with this code.
    Code(i32),
    /// The leader died of a signal the daemon did not send.
    Signal(i32),
    /// The daemon killed the group at `POLIS_JOBS_CHILD_TIMEOUT_SECONDS`.
    Timeout,
    /// A heartbeat returned `fenced` (cancel, lease loss, a newer epoch):
    /// the daemon killed the group.
    Fenced,
    /// SIGTERM to the daemon: the daemon killed the group.
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Manifest row → `pq_end_attempt(…,'confirm_exit',NULL,true)` → `pq_finalize/7`.
    Finalize,
    /// `pq_park(…,'awaiting_provider',true,eligible_at)`.
    Park { eligible_at: String },
    /// `pq_fail(…,permanent,code,true)`.
    Fail { permanent: bool, code: String },
    /// `pq_end_attempt(…,'confirm_exit',NULL,true)` with this attempt's identity.
    ConfirmExit,
}

/// Daemon-mode exit codes of the child (P1-b): 0 ok, 1 stage failed,
/// 2 environment/frame refused, 4 math export failed, 5 manifest unbuildable,
/// 6 provider intent not acknowledged (no provider call was made).
pub const EXIT_MATH_EXPORT: i32 = 4;
pub const EXIT_MANIFEST_UNBUILDABLE: i32 = 5;
pub const EXIT_INTENT_UNACKNOWLEDGED: i32 = 6;

pub fn decide(exit: &Exit, manifest: &Result<Manifest, Invalid>) -> Action {
    let fail = |code: &str| Action::Fail {
        permanent: false,
        code: code.to_owned(),
    };
    match exit {
        Exit::Fenced => Action::ConfirmExit,
        Exit::Shutdown => fail("interrupted_by_shutdown"),
        Exit::Timeout => fail("timeout"),
        Exit::Signal(sig) => fail(&format!("stage_failed:signal_{sig}")),
        Exit::Code(0) => match manifest {
            Ok(m) if m.outcome == Outcome::Succeeded => Action::Finalize,
            Ok(m) => match &m.recheck_after {
                Some(at) => Action::Park {
                    eligible_at: at.clone(),
                },
                None => fail("manifest_invalid"),
            },
            Err(_) => fail("manifest_invalid"),
        },
        Exit::Code(EXIT_MATH_EXPORT) => fail("stage_failed:math_export"),
        Exit::Code(EXIT_MANIFEST_UNBUILDABLE) => fail("manifest_invalid"),
        Exit::Code(EXIT_INTENT_UNACKNOWLEDGED) => fail("provider_intent_unacknowledged"),
        Exit::Code(code) => fail(&format!("stage_failed:{code}")),
    }
}

/// Codes whose repetition to `max_attempts` makes the job poison.
pub fn is_poison_code(code: &str) -> bool {
    code.starts_with("stage_failed") || code == "manifest_invalid"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::manifest::{fixture, validate};

    const J: &str = "00000000-0000-4000-8000-000000000001";
    const A: &str = "00000000-0000-4000-8000-000000000002";

    fn manifest(outcome: &str) -> Result<Manifest, Invalid> {
        let bytes =
            serde_json::to_vec(&fixture(J, A, "delphi_full_pipeline", outcome)).unwrap_or_default();
        validate(Some(&bytes), J, A, "delphi_full_pipeline")
    }

    fn fail(code: &str) -> Action {
        Action::Fail {
            permanent: false,
            code: code.into(),
        }
    }

    #[test]
    fn the_outcome_table() {
        let ok = manifest("succeeded");
        let parked = manifest("parked");
        let missing = Err(Invalid::Missing);
        let rows: Vec<(Exit, &Result<Manifest, Invalid>, Action)> = vec![
            (Exit::Code(0), &ok, Action::Finalize),
            (
                Exit::Code(0),
                &parked,
                Action::Park {
                    eligible_at: "2026-10-03T00:10:00Z".into(),
                },
            ),
            (Exit::Code(0), &missing, fail("manifest_invalid")),
            (Exit::Code(4), &ok, fail("stage_failed:math_export")),
            (Exit::Code(1), &ok, fail("stage_failed:1")),
            (Exit::Code(2), &missing, fail("stage_failed:2")),
            (Exit::Code(5), &missing, fail("manifest_invalid")),
            (
                Exit::Code(6),
                &missing,
                fail("provider_intent_unacknowledged"),
            ),
            (Exit::Code(255), &missing, fail("stage_failed:255")),
            (Exit::Timeout, &ok, fail("timeout")),
            (Exit::Signal(9), &missing, fail("stage_failed:signal_9")),
            (Exit::Fenced, &ok, Action::ConfirmExit),
            (Exit::Fenced, &missing, Action::ConfirmExit),
            (Exit::Shutdown, &ok, fail("interrupted_by_shutdown")),
        ];
        for (exit, m, expected) in rows {
            assert_eq!(decide(&exit, m), expected, "{exit:?}");
        }
    }

    #[test]
    fn poison_codes() {
        assert!(is_poison_code("stage_failed:1"));
        assert!(is_poison_code("stage_failed:math_export"));
        assert!(is_poison_code("manifest_invalid"));
        assert!(!is_poison_code("interrupted_by_shutdown"));
        assert!(!is_poison_code("daemon_restarted"));
        assert!(!is_poison_code("timeout"));
    }
}
