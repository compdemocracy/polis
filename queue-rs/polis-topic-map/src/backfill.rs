//! The Delphi shadow's scheduler with the derived-map backfill: the same
//! scheduler (`polis_queue_adapter::shadow`), given the derived jobs' one
//! admission call ([`derived::admit`], asker `scheduler`). `polis-delphi-shadow`
//! replaces itself with `polis-topic-map shadow-scheduler` when
//! `DELPHI_SHADOW_DERIVED_BACKFILL=1`; with it off it never does, and runs as
//! it always has.
use crate::{derived, stored};
use polis_queue_adapter::shadow::{
    backfill::{Admitter, Outcome, Source},
    config, scheduler,
};

/// Who the backfill asks as: logged by the admission, never part of a key.
pub const ASKER: &str = "scheduler";

/// [`derived::admit`] for the topic map, version 1, as asker `scheduler`.
pub struct TopicMap<G: Fn(&str) -> Option<String>> {
    pub get: G,
}

impl<G: Fn(&str) -> Option<String>> Admitter for TopicMap<G> {
    fn switched_on(&self) -> bool {
        (self.get)(derived::SWITCH).as_deref() == Some("1")
    }
    fn alias(&self, env: &str, source_job_id: &str) -> String {
        derived::alias(&derived::key(
            derived::Operation::TopicMap,
            1,
            env,
            source_job_id,
        ))
    }
    fn admit(
        &mut self,
        client: &mut postgres::Client,
        source: &Source,
        code: &str,
    ) -> Result<Outcome, String> {
        let req = derived::Request {
            operation: derived::Operation::TopicMap,
            version: 1,
            env: source.env.clone(),
            source_job_id: source.job_id.clone(),
            conversation_id: source.zid,
            selection: source.selection.clone(),
            inputs_sha256: None,
            asker: ASKER.into(),
        };
        Ok(match derived::admit(client, &self.get, &req, code)? {
            derived::Admission::Enqueued(_) => Outcome::Enqueued,
            derived::Admission::Existing(_) => Outcome::Existing,
            derived::Admission::Refused(r) => Outcome::Refused(r.word().into()),
        })
    }
    fn inputs(&self) -> &'static [&'static str] {
        &stored::INPUTS
    }
    fn map_family(&self) -> &'static str {
        stored::FAMILY
    }
}

/// `polis-topic-map shadow-scheduler`: `polis-delphi-shadow`'s scheduler,
/// with the backfill's admitter. The same exit codes.
pub fn scheduler_main() -> i32 {
    let cfg = match config::load(|k| std::env::var(k).ok()) {
        Ok(config::Load::Disabled) => return 0,
        Ok(config::Load::Ready(cfg)) => cfg,
        Err(e) => {
            eprintln!("{e}");
            return scheduler::EXIT_CONFIG;
        }
    };
    scheduler::install_signal_handlers();
    match scheduler::Scheduler::new(&cfg) {
        Ok(s) => s
            .with_admitter(Box::new(TopicMap {
                get: |k: &str| std::env::var(k).ok(),
            }))
            .run(),
        Err(e) => {
            eprintln!("polis-delphi-shadow: state file: {e}");
            scheduler::EXIT_CONFIG
        }
    }
}
