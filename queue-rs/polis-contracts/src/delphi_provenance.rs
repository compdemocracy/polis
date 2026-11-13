//! The run a Delphi result came from, read as types instead of by splitting
//! strings.
//!
//! A reader of Delphi results holds a run's identity in three forms today:
//!
//! - a **topic key**, `<job>#<layer>#<cluster>` ([`TopicKey`]): the job is
//!   the run that named the topic. Topic names, topic statistics, collective
//!   statements and a participant's saved topic choices all carry it, and it
//!   is the only run identity most replies carry. [`TopicKey::producer`] and
//!   [`TopicKey::parts`] read it;
//! - a **public job id** ([`PublicJobId`]): a uuid, or the frozen alias of a
//!   legacy import. Only a uuid can have a run record (`delphi-run/1`) to
//!   ask for; [`PublicJobId::run_record_id`] gives its id or `None`. A uuid
//!   is not a promise of a record: the job inside a topic key that was
//!   imported from the earlier store is the id that store gave the run,
//!   which is no row of `delphi_jobs`, so the record route answers 404;
//! - a **run record** ([`DelphiRun`]): for each family of the bundle a job
//!   published, the run that produced it and the run each upstream family
//!   came from. [`DelphiRun::inputs_from_other_runs`] lists the families
//!   that were computed from another run than the one published beside
//!   them: a collective statement written over one run's topics and now
//!   served with the next run's topic names, for example.
//!
//! The record speaks of whole families. A family that is rewritten whole by
//! each write (collective statements, narrative reports) names its last
//! writer as its producer, so [`DelphiRun::inputs_from_other_runs`] cannot
//! see a row inside it that an earlier write made over an earlier run's
//! topics: that row's own topic key is the only place its run is named.
//!
//! Nothing here changes a wire format: the keys and the record are read as
//! they are stored and served.
use crate::delphi_job_result::{Cluster, LayerId, PublicJobId, TopicKey};
use crate::delphi_run::{DelphiRun, JobId, ResultFamily, RunFamily, RunRef};

/// The separator of a topic key's three parts.
const SEPARATOR: char = '#';

/// A topic key's three parts: the job that named the topic, the hierarchy
/// layer and the cluster in that layer.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TopicKeyParts {
    pub job: PublicJobId,
    pub layer: LayerId,
    pub cluster: Cluster,
}

/// Written as the key itself: `<job>#<layer>#<cluster>`.
impl std::fmt::Display for TopicKeyParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}{SEPARATOR}{}{SEPARATOR}", self.job, self.layer.get())?;
        match self.cluster {
            Cluster::Unassigned => f.write_str("-1"),
            Cluster::Id(n) => write!(f, "{n}"),
        }
    }
}

/// A non-negative integer in its one decimal spelling: digits only, no sign
/// and no leading zero.
fn canonical_u32(text: &str) -> Option<u32> {
    let canonical = !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    text.parse().ok().filter(|_| canonical)
}

impl TopicKey {
    /// The job that named the topic: the text before the first separator,
    /// when there is a separator and the text is not empty. This is the rule
    /// `polis delphi show` applied by hand before it called this. Other
    /// readers of topic keys apply other rules today (the server reads the
    /// layer and cluster of any key with three or more parts and never the
    /// job; `polis topic prioritize` takes the whole key when it has no
    /// separator); nothing here changes them.
    pub fn producer(&self) -> Option<PublicJobId> {
        let (job, _) = self.as_str().split_once(SEPARATOR)?;
        PublicJobId::new(job).ok()
    }

    /// The key's job, layer and cluster, when the key is exactly
    /// `<job>#<layer>#<cluster>` with each number in the one spelling the
    /// pipeline writes (a canonical decimal; `-1` for the unassigned
    /// cluster). A key in any other shape has no parts: none are invented.
    pub fn parts(&self) -> Option<TopicKeyParts> {
        let mut parts = self.as_str().split(SEPARATOR);
        let (job, layer, cluster) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        Some(TopicKeyParts {
            job: PublicJobId::new(job).ok()?,
            layer: LayerId::new(canonical_u32(layer)?),
            cluster: match cluster {
                "-1" => Cluster::Unassigned,
                id => Cluster::Id(canonical_u32(id)?),
            },
        })
    }
}

impl PublicJobId {
    /// The id to ask the run record for: this id when it is a lowercase
    /// canonical uuid (the spelling of `delphi_jobs.job_id`), `None` for
    /// anything else. `Some` says only that the id can be asked for: a job
    /// that ran on the earlier store, and whose id an import kept inside its
    /// topic keys, has this spelling and no record.
    pub fn run_record_id(&self) -> Option<JobId> {
        JobId::new(self.as_str()).ok()
    }
}

/// A family of a published bundle that was computed from one run of an
/// upstream family while another run's output of that upstream family is
/// published beside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputFromAnotherRun {
    /// The family that was computed.
    pub family: ResultFamily,
    /// The upstream family it was computed from.
    pub upstream: RunFamily,
    /// The run whose output of `upstream` it was computed from.
    pub computed_from: RunRef,
    /// The run whose output of `upstream` the bundle holds.
    pub published: RunRef,
}

impl DelphiRun {
    /// The families of this record's bundle that were computed from another
    /// run of an upstream family than the run whose output of that family
    /// the same bundle holds, in family order. Empty when every family was
    /// computed from what is published beside it.
    ///
    /// A family is compared whole, by the producer the record names for it.
    /// A family rewritten whole by each write (collective statements,
    /// narrative reports) is therefore listed or not by its last writer:
    /// an empty answer does not say that every row in such a family was
    /// written over the topics published beside it.
    pub fn inputs_from_other_runs(&self) -> Vec<InputFromAnotherRun> {
        let families = &self.outputs.families;
        let mut out = Vec::new();
        for output in families.iter() {
            let Some(computation) = output.state.computation() else {
                continue;
            };
            for input in &computation.upstream {
                let published = families
                    .get(ResultFamily::Run(input.family))
                    .and_then(|f| f.state.computation())
                    .map(|c| &c.producer);
                if let Some(published) = published.filter(|p| p.job_id != input.job_id) {
                    out.push(InputFromAnotherRun {
                        family: output.family,
                        upstream: input.family,
                        computed_from: RunRef {
                            job_id: input.job_id.clone(),
                            run_id: input.run_id.clone(),
                        },
                        published: published.clone(),
                    });
                }
            }
        }
        out
    }
}
