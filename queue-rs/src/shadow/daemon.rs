//! `polis-delphi-shadow daemon`: the shadow's job daemon, started only on a
//! shadow env.
//!
//! The shadow's daemon is the ordinary `polis-jobs`, which accepts any env:
//! given the env a reader serves, it would claim that env's jobs and publish
//! under it, a second production daemon. So the shadow's container does not
//! run `polis-jobs` directly. It runs this check, which refuses to start
//! (exit 2, one line, no value printed) unless the daemon's queue env and its
//! result env are the same shadow env, and only then replaces itself with
//! `polis-jobs` (exec: the same process, so the daemon's own signal handling
//! and drain are unchanged). The production `delphi` service never runs it.
use super::config::{ConfigError, ENV_PREFIX, valid_env};

/// The daemon this check starts, looked up on `PATH` as the image installs it.
pub const DAEMON: &str = "polis-jobs";

/// The daemon's envs: `QUEUE_ENV` (the jobs it claims) and
/// `DELPHI_RESULT_ENV` (where the pipeline child writes its results) must
/// both be set, equal, and a shadow env.
pub fn check<F: Fn(&str) -> Option<String>>(get: F) -> Result<String, ConfigError> {
    let queue = get("QUEUE_ENV").unwrap_or_default();
    if !valid_env(&queue) {
        return Err(ConfigError(format!(
            "daemon: QUEUE_ENV must be {ENV_PREFIX} then 1-57 characters of [a-z0-9_-]: the shadow's daemon never claims a served env's jobs"
        )));
    }
    let result = get("DELPHI_RESULT_ENV").unwrap_or_default();
    if result != queue {
        return Err(ConfigError(
            "daemon: DELPHI_RESULT_ENV must equal QUEUE_ENV: the shadow's runs never write results under another env"
                .into(),
        ));
    }
    Ok(queue)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(pairs: &[(&'static str, &str)]) -> Result<String, ConfigError> {
        let m: HashMap<&str, String> = pairs.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
        check(|k| m.get(k).cloned())
    }

    #[test]
    fn the_daemon_starts_only_on_one_shadow_env() {
        assert_eq!(
            with(&[
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "shadow-delphi-1")
            ]),
            Ok("shadow-delphi-1".into())
        );
        assert_eq!(
            with(&[
                ("QUEUE_ENV", "shadow-twin-1"),
                ("DELPHI_RESULT_ENV", "shadow-twin-1")
            ]),
            Ok("shadow-twin-1".into())
        );
        for served in [
            "import-example-1",
            "prod",
            "",
            "shadow-",
            "shadow-UPPER",
            "xshadow-delphi",
        ] {
            assert!(
                with(&[("QUEUE_ENV", served), ("DELPHI_RESULT_ENV", served)]).is_err(),
                "{served:?}"
            );
        }
        // A shadow queue env publishing under a served env, or under none.
        assert!(
            with(&[
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "import-example-1")
            ])
            .is_err()
        );
        assert!(with(&[("QUEUE_ENV", "shadow-delphi-1")]).is_err());
        assert!(
            with(&[
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "shadow-twin-1")
            ])
            .is_err()
        );
        // A served queue env with a shadow result env.
        assert!(
            with(&[
                ("QUEUE_ENV", "import-example-1"),
                ("DELPHI_RESULT_ENV", "shadow-delphi-1")
            ])
            .is_err()
        );
        assert!(with(&[]).is_err());
    }

    #[test]
    fn a_refusal_prints_no_value() {
        for pairs in [
            [
                ("QUEUE_ENV", "import-example-1"),
                ("DELPHI_RESULT_ENV", "import-example-1"),
            ],
            [
                ("QUEUE_ENV", "shadow-delphi-1"),
                ("DELPHI_RESULT_ENV", "import-example-1"),
            ],
        ] {
            let Err(e) = with(&pairs) else {
                panic!("accepted {pairs:?}");
            };
            assert!(!e.to_string().contains("import-example-1"), "{e}");
        }
    }
}
