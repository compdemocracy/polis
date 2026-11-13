//! The clustering and the run a Delphi result belongs to, read as types
//! instead of by splitting strings.
//!
//! A reader of Delphi results holds that identity in these forms today:
//!
//! - a **topic key**, `<label>#<layer>#<cluster>` ([`TopicKey`]). The first
//!   part is a **clustering label** ([`ClusteringLabel`]): the text the run
//!   that clustered the comments wrote into every key of its topics. For a
//!   run on the Postgres result store it is that run's job id. It is not a
//!   promise of a job: a key imported from the earlier store carries the id
//!   that store gave the run, the pipeline run by hand writes
//!   `pipeline_run_<uuid>`, and a key written without one has the form
//!   `layer<L>_<C>` and carries no label at all. One text in that place is
//!   no clustering's label: `unknown_job`, which every run given no job id
//!   writes ([`ClusteringLabel::names_one_clustering`]). A label is compared
//!   with a label; it is never looked up as a run. [`TopicKey::clustering_label`], [`TopicKey::parts`] and
//!   [`TopicKey::unlabelled`] read it;
//! - a **narrative section's name** ([`SectionKey`]). A topic section is
//!   named with its topic key, each separator written as `_`, so it holds
//!   the same label; a global section names no topic.
//!   [`SectionKey::reading`] reads it, from the right;
//! - a **public job id** ([`PublicJobId`]): a uuid, or the frozen alias of a
//!   legacy import. Only a uuid can have a run record (`delphi-run/1`) to
//!   ask for; [`PublicJobId::run_record_id`] gives its id or `None`;
//! - a **run record** ([`DelphiRun`]): for each family of the bundle a job
//!   published, one run, and the run each upstream family came from.
//!
//! # A family's batch names a producer, or only a last writer
//!
//! A full pipeline run replaces most families whole from its own
//! computation, so the one run a record names for such a family produced
//! every row of it. Three families are different. Collective statements,
//! narrative reports and the server's report-narrative cache are rewritten
//! whole by every write, with every earlier row copied forward into the new
//! batch (`pd_result_mutate` in
//! `server/postgres/migrations/000030_create_delphi_writers.sql`; the
//! narrative job's scratch store in
//! `delphi/polismath/delphi_storage/writer.py`, which starts from the
//! published rows and which a full run's reset leaves alone). The run a
//! record names for one of them is its **last writer**; the rows inside
//! were written by many jobs, possibly over many clusterings.
//! [`ResultFamily::rows`] says which kind a family is, and
//! [`DelphiRun::written_by`] gives the record's run as what it is, a
//! [`WrittenBy::Producer`] or a [`WrittenBy::LastWriter`].
//!
//! For those three families the clustering a row was written over is read
//! from the row itself ([`RowLabel`]): a collective statement's own topic
//! key, a narrative report's own section name. The report-narrative cache
//! carries no clustering at all. What is read is what the row says. A
//! collective statement's topic key is the key the caller of the save sent:
//! the server stores it as given and reads the topic's comments by the
//! key's layer and cluster from the assignments published at that moment
//! (`server/src/routes/collectiveStatement.ts`), without comparing the
//! key's label with the published one. [`TopicKey::clustering`] and
//! [`SectionKey::clustering`] give a row's [`RowClustering`];
//! [`PublishedLabels`] collects the labels the published topic names carry
//! and says where a row stands against them ([`RowStanding`]).
//!
//! [`DelphiRun::inputs_from_other_runs`] still speaks of whole families:
//! for a family rewritten whole it compares what the last writer read, and
//! an empty answer says nothing about the rows earlier writes left there.
//!
//! Nothing here changes a wire format: the keys, the names and the record
//! are read as they are stored and served.
use crate::delphi_job_result::{Cluster, LayerId, PublicJobId, SectionKey, TopicKey};
use crate::delphi_run::{DelphiRun, JobId, LegacyFamily, ResultFamily, RunFamily, RunRef};
use crate::wire::{self, text};
use std::collections::BTreeSet;

/// The separator of a topic key's three parts.
const SEPARATOR: char = '#';
/// What a narrative section's name writes in place of [`SEPARATOR`].
const SECTION_SEPARATOR: char = '_';
/// What a topic key written without a label begins with.
const UNLABELLED_PREFIX: &str = "layer";

text!(
    /// The label of a clustering: the first part of each of its topic keys.
    /// Two keys with the same label, layer and cluster name the same topic;
    /// two labels name two clusterings, whose layers and clusters do not
    /// correspond. A label may be the job id of the run that clustered the
    /// comments, and it may name no job at all (see the module's first
    /// section), so it is compared with other labels and never asked for as
    /// a run. One text of this type is the label of no one clustering:
    /// [`ClusteringLabel::names_one_clustering`].
    ClusteringLabel,
    wire::non_empty
);

/// What the pipeline writes as a key's first part when a run is given no job
/// id (`create_llm_topic_name` in
/// `delphi/umap_narrative/polismath_commentgraph/utils/converter.py`).
const NO_JOB_ID: &str = "unknown_job";

impl ClusteringLabel {
    /// Whether this text is the label of one clustering. One text is not:
    /// `unknown_job`, which the pipeline writes for every run it is given no
    /// job id for, so that two clusterings can carry it and equal keys under
    /// it can name different topics. Every other text is taken as one
    /// clustering's label.
    pub fn names_one_clustering(&self) -> bool {
        self.as_str() != NO_JOB_ID
    }
}

/// A topic key's three parts: the clustering label, the hierarchy layer and
/// the cluster in that layer.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TopicKeyParts {
    pub label: ClusteringLabel,
    pub layer: LayerId,
    pub cluster: Cluster,
}

/// Written as the key itself: `<label>#<layer>#<cluster>`.
impl std::fmt::Display for TopicKeyParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}{SEPARATOR}{}{SEPARATOR}",
            self.label,
            self.layer.get()
        )?;
        write_cluster(f, self.cluster)
    }
}

/// The topic a key written without a label names: `layer<L>_<C>`, the form
/// the pipeline's models write when they are given no key. A layer and a
/// cluster, and no clustering.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct UnlabelledTopic {
    pub layer: LayerId,
    pub cluster: Cluster,
}

/// Written as the key itself: `layer<L>_<C>`.
impl std::fmt::Display for UnlabelledTopic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{UNLABELLED_PREFIX}{}{SECTION_SEPARATOR}",
            self.layer.get()
        )?;
        write_cluster(f, self.cluster)
    }
}

fn write_cluster(f: &mut std::fmt::Formatter<'_>, cluster: Cluster) -> std::fmt::Result {
    match cluster {
        Cluster::Unassigned => f.write_str("-1"),
        Cluster::Id(n) => write!(f, "{n}"),
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

/// A cluster in the one spelling the pipeline writes: `-1` for the
/// unassigned cluster, else a canonical decimal.
fn canonical_cluster(text: &str) -> Option<Cluster> {
    match text {
        "-1" => Some(Cluster::Unassigned),
        id => canonical_u32(id).map(Cluster::Id),
    }
}

/// `layer<L>_<C>`, exactly.
fn unlabelled_topic(text: &str) -> Option<UnlabelledTopic> {
    let (layer, cluster) = text
        .strip_prefix(UNLABELLED_PREFIX)?
        .split_once(SECTION_SEPARATOR)?;
    Some(UnlabelledTopic {
        layer: LayerId::new(canonical_u32(layer)?),
        cluster: canonical_cluster(cluster)?,
    })
}

/// What a result row's own key says of the clustering the row was written
/// over. It is what the row carries, not a lookup: nothing is invented for
/// a row that carries less.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RowClustering {
    /// The row names a clustering by its label.
    Label(ClusteringLabel),
    /// The row names a topic and no one clustering: its key has the form
    /// without a label (`layer<L>_<C>`), or carries the text written for
    /// every run given no job id (`unknown_job`). Which clustering it
    /// belongs to is not stored.
    NoLabel,
    /// The row is about no topic (a global narrative section), so it
    /// belongs to no clustering.
    NoTopic,
    /// The key or name is in no form read here. Nothing is read from it.
    Unread,
}

impl RowClustering {
    /// A row whose key or name carries this text as its first part: the
    /// label, unless the text is no one clustering's
    /// ([`ClusteringLabel::names_one_clustering`]).
    fn of(label: ClusteringLabel) -> Self {
        if label.names_one_clustering() {
            Self::Label(label)
        } else {
            Self::NoLabel
        }
    }
}

impl TopicKey {
    /// The key's clustering label: the text before the first separator,
    /// when there is a separator and the text is not empty. This is the
    /// rule `polis delphi show` applied by hand before it called this, and
    /// it reads a label from any key that begins with one, whatever
    /// follows. Other readers of topic keys apply other rules today (the
    /// server reads the layer and cluster of any key with three or more
    /// parts and never the label; `polis topic prioritize` takes the whole
    /// key when it has no separator); nothing here changes them.
    ///
    /// The label is a text to compare with other labels. It may be a job
    /// id, and a job with that id may or may not exist.
    pub fn clustering_label(&self) -> Option<ClusteringLabel> {
        let (label, _) = self.as_str().split_once(SEPARATOR)?;
        ClusteringLabel::new(label).ok()
    }

    /// The key's label, layer and cluster, when the key is exactly
    /// `<label>#<layer>#<cluster>` with each number in the one spelling the
    /// pipeline writes (a canonical decimal; `-1` for the unassigned
    /// cluster). A key in any other shape has no parts: none are invented.
    pub fn parts(&self) -> Option<TopicKeyParts> {
        let mut parts = self.as_str().split(SEPARATOR);
        let (label, layer, cluster) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        Some(TopicKeyParts {
            label: ClusteringLabel::new(label).ok()?,
            layer: LayerId::new(canonical_u32(layer)?),
            cluster: canonical_cluster(cluster)?,
        })
    }

    /// The layer and cluster of a key written without a label, when the key
    /// is exactly `layer<L>_<C>` with each number in its one spelling.
    pub fn unlabelled(&self) -> Option<UnlabelledTopic> {
        unlabelled_topic(self.as_str())
    }

    /// What this key, as a row's own key, says of the row's clustering: its
    /// label when it begins with one ([`TopicKey::clustering_label`]) that
    /// names one clustering, [`RowClustering::NoLabel`] for the form
    /// without a label and for `unknown_job`, and [`RowClustering::Unread`]
    /// for anything else. A collective statement row is read this way, from
    /// its `topic_key`.
    pub fn clustering(&self) -> RowClustering {
        if let Some(label) = self.clustering_label() {
            RowClustering::of(label)
        } else if self.unlabelled().is_some() {
            RowClustering::NoLabel
        } else {
            RowClustering::Unread
        }
    }
}

/// A narrative section that is about the whole conversation, not a topic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GlobalSection {
    Groups,
    GroupInformedConsensus,
    Uncertainty,
}

impl GlobalSection {
    pub const ALL: [Self; 3] = [
        Self::Groups,
        Self::GroupInformedConsensus,
        Self::Uncertainty,
    ];
    /// The section's own name, without the job a stored name begins with.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Groups => "groups",
            Self::GroupInformedConsensus => "group_informed_consensus",
            Self::Uncertainty => "uncertainty",
        }
    }
    /// The global section a stored name is: the bare name, the legacy
    /// `global_<name>`, or `<text>_global_<name>` with a text that is not
    /// empty (the narrative job's id, or the first eight characters of it
    /// that a provider batch keeps).
    fn of(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|section| match name.strip_suffix(section.as_str()) {
                Some("") | Some("global_") => true,
                Some(before) => before
                    .strip_suffix("_global_")
                    .is_some_and(|text| !text.is_empty()),
                None => false,
            })
    }
}

/// `<label>_<layer>_<cluster>`, read from the right.
fn section_topic(name: &str) -> Option<TopicKeyParts> {
    let mut parts = name.rsplitn(3, SECTION_SEPARATOR);
    let (cluster, layer, label) = (parts.next()?, parts.next()?, parts.next()?);
    Some(TopicKeyParts {
        label: ClusteringLabel::new(label).ok()?,
        layer: LayerId::new(canonical_u32(layer)?),
        cluster: canonical_cluster(cluster)?,
    })
}

/// What a narrative section's name says the section is about.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SectionReading {
    /// A topic of a labelled clustering: `<label>_<layer>_<cluster>`, the
    /// topic key with each separator written as `_`.
    Topic(TopicKeyParts),
    /// A topic named without a label: `layer<L>_<C>`.
    UnlabelledTopic(UnlabelledTopic),
    /// The whole conversation.
    Global(GlobalSection),
    /// A name in no form read here. Nothing is read from it.
    Unread,
}

impl SectionKey {
    /// What the section is about, read from its name alone.
    ///
    /// A topic section is read **from the right**: the cluster is the last
    /// part, the layer the one before it, and the label is everything
    /// before that, because labels the pipeline writes hold the name's own
    /// separator (`pipeline_run_<uuid>`, `unknown_job`). Each number must
    /// be in its one spelling and the label must not be empty.
    ///
    /// The name is a lossy copy of the topic key. A provider batch rebuilds
    /// it from a request id in which every character outside `A-Z`, `a-z`,
    /// `0-9`, `_` and `-` was written as `_` and which was cut at 64
    /// characters. For the labels the pipeline itself writes nothing is
    /// lost that changes the label: a job id (a uuid) is not altered, and
    /// is not cut while the conversation id, the layer and the cluster
    /// have 25 digits or fewer together; a `pipeline_run_<uuid>` name is
    /// cut from 13 digits on, and what is left reads as the same label or
    /// as nothing. For a label of another shape the stored name
    /// can read as another label (two labels that differ only in a
    /// rewritten character are stored as one; a label that is another label
    /// followed by `_<digits>`, cut after its layer, reads as the shorter
    /// one), so what is read here is the label of the name as stored. And a
    /// name in an older form that happens to end in two numbers reads as a
    /// topic with a label no key carries.
    pub fn reading(&self) -> SectionReading {
        let name = self.as_str();
        if let Some(global) = GlobalSection::of(name) {
            return SectionReading::Global(global);
        }
        if let Some(topic) = unlabelled_topic(name) {
            return SectionReading::UnlabelledTopic(topic);
        }
        section_topic(name).map_or(SectionReading::Unread, SectionReading::Topic)
    }

    /// What this name, as a narrative report row's own section name, says
    /// of the row's clustering: the label of a topic section,
    /// [`RowClustering::NoLabel`] for a topic named without one or with
    /// `unknown_job`,
    /// [`RowClustering::NoTopic`] for a global section, and
    /// [`RowClustering::Unread`] for anything else.
    pub fn clustering(&self) -> RowClustering {
        match self.reading() {
            SectionReading::Topic(parts) => RowClustering::of(parts.label),
            SectionReading::UnlabelledTopic(_) => RowClustering::NoLabel,
            SectionReading::Global(_) => RowClustering::NoTopic,
            SectionReading::Unread => RowClustering::Unread,
        }
    }
}

/// Where a row stands against the topic names published beside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RowStanding {
    /// The published topic names carry one label, and it is the row's: the
    /// row was written over the clustering published beside it.
    PublishedClustering,
    /// The published topic names carry several labels and the row's is one
    /// of them. Which of several clusterings a page draws is not decided
    /// here, so this is never reported as [`RowStanding::PublishedClustering`].
    OneOfSeveralPublished,
    /// The row's label is not one the published topic names carry (and
    /// they may carry none): the row was written over another clustering.
    AnotherClustering,
    /// The row names a topic and no clustering: nothing can be compared.
    NoLabel,
    /// The row is about no topic: the comparison does not apply to it.
    NoTopic,
    /// The row's key is in no form read here.
    Unread,
}

/// The clustering labels the keys of a published topic-names family carry.
///
/// One label is the ordinary case: one run clustered the comments and named
/// the topics. Stored data can also hold none (every key in the form
/// without a label or under `unknown_job`, or no key) and several (a store that kept more than one
/// run's names for a conversation). Both are kept as they are, so neither
/// can be drawn as one clustering by mistake.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublishedLabels {
    labels: BTreeSet<ClusteringLabel>,
    unlabelled: usize,
    unread: usize,
}

impl PublishedLabels {
    /// The labels of these topic keys. Keys that name a topic and no one
    /// clustering (the form without a label; `unknown_job`) and keys in no
    /// form read here are counted, not guessed at.
    pub fn of<'a>(topic_keys: impl IntoIterator<Item = &'a TopicKey>) -> Self {
        let mut out = Self::default();
        for key in topic_keys {
            match key.clustering() {
                RowClustering::Label(label) => {
                    out.labels.insert(label);
                }
                RowClustering::NoLabel => out.unlabelled += 1,
                RowClustering::NoTopic | RowClustering::Unread => out.unread += 1,
            }
        }
        out
    }

    /// The distinct labels, in order: none, one or several.
    pub fn labels(&self) -> impl Iterator<Item = &ClusteringLabel> {
        self.labels.iter()
    }

    /// How many keys named a topic and no one clustering.
    pub fn unlabelled(&self) -> usize {
        self.unlabelled
    }

    /// How many keys were in no form read here.
    pub fn unread(&self) -> usize {
        self.unread
    }

    /// Where a row stands against these labels.
    pub fn standing(&self, row: &RowClustering) -> RowStanding {
        match row {
            RowClustering::Label(label) if !self.labels.contains(label) => {
                RowStanding::AnotherClustering
            }
            RowClustering::Label(_) if self.labels.len() == 1 => RowStanding::PublishedClustering,
            RowClustering::Label(_) => RowStanding::OneOfSeveralPublished,
            RowClustering::NoLabel => RowStanding::NoLabel,
            RowClustering::NoTopic => RowStanding::NoTopic,
            RowClustering::Unread => RowStanding::Unread,
        }
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

/// Where a row of a family rewritten whole names the clustering it was
/// written over.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RowLabel {
    /// In the row's `topic_key` ([`TopicKey::clustering`]).
    TopicKey,
    /// In the row's `section` ([`SectionKey::clustering`]).
    SectionName,
    /// Nowhere: the rows carry no clustering, and the family is left out
    /// of any comparison of clusterings.
    None,
}

/// How a family's rows come to be in one batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FamilyRows {
    /// One job wrote every row of the batch from its own work: the job a
    /// run record names for the family is the producer of each row.
    OneProducer,
    /// Every write rewrites the family whole, copying every earlier row
    /// forward: the job a run record names is only the last writer, and
    /// each row's clustering is read from the row.
    Accumulated(RowLabel),
}

impl ResultFamily {
    /// How this family's rows come to be in one batch. The three families
    /// rewritten whole are the three `pd_result_mutate` accepts, which are
    /// also the three written families a full run's reset leaves alone.
    pub const fn rows(self) -> FamilyRows {
        match self {
            Self::Run(RunFamily::CollectiveStatement) => {
                FamilyRows::Accumulated(RowLabel::TopicKey)
            }
            Self::Run(RunFamily::NarrativeReports) => {
                FamilyRows::Accumulated(RowLabel::SectionName)
            }
            Self::Legacy(LegacyFamily::ReportNarrativeStore) => {
                FamilyRows::Accumulated(RowLabel::None)
            }
            Self::Run(
                RunFamily::CommentEmbeddings
                | RunFamily::CommentHierarchicalClusterAssignments
                | RunFamily::UmapGraph
                | RunFamily::UmapConversationConfig
                | RunFamily::CommentClustersStructureKeywords
                | RunFamily::CommentClustersFeatures
                | RunFamily::CommentClustersLlmTopicNames
                | RunFamily::TopicStats
                | RunFamily::Visualizations,
            )
            | Self::Legacy(
                LegacyFamily::PcaConversationConfig
                | LegacyFamily::PcaResults
                | LegacyFamily::KMeansClusters
                | LegacyFamily::CommentRouting
                | LegacyFamily::RepresentativeComments
                | LegacyFamily::PcaParticipantProjections
                | LegacyFamily::CommentExtremity
                | LegacyFamily::TopicAgendaSelections,
            ) => FamilyRows::OneProducer,
        }
    }
}

/// The one run a record names for a family, as what it is to the family's
/// rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WrittenBy<'a> {
    /// The run produced every row of the family.
    Producer(&'a RunRef),
    /// The run wrote the family last. Rows of earlier writes are in it,
    /// copied forward; this run did not produce them.
    LastWriter(&'a RunRef),
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
    /// The run this record names for a family of its bundle, as a producer
    /// or as a last writer ([`ResultFamily::rows`]); `None` when the record
    /// does not list the family or names no run for it yet. The record's
    /// own field is called `producer` for every family; read through this,
    /// a last writer is never taken for the producer of a row.
    pub fn written_by(&self, family: ResultFamily) -> Option<WrittenBy<'_>> {
        let run = &self
            .outputs
            .families
            .get(family)?
            .state
            .computation()?
            .producer;
        Some(match family.rows() {
            FamilyRows::OneProducer => WrittenBy::Producer(run),
            FamilyRows::Accumulated(_) => WrittenBy::LastWriter(run),
        })
    }

    /// The families of this record's bundle that were computed from another
    /// run of an upstream family than the run whose output of that family
    /// the same bundle holds, in family order. Empty when every family was
    /// computed from what is published beside it.
    ///
    /// A family is compared whole, by the one run the record names for it.
    /// A family rewritten whole by each write (collective statements,
    /// narrative reports) is therefore listed or not by what its last
    /// writer read: an empty answer does not say that every row in such a
    /// family was written over the topics published beside it. The rows say
    /// that themselves ([`PublishedLabels::standing`]).
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
