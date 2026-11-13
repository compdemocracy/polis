//! Identity, observed on a copy of a vote: what the participation entry of
//! admission would decide for a request the vote writer hands back for its
//! identity, and what Node did, by reads alone.
//!
//! Built only beside the vote observer in the shadow role, and only when
//! `POLIS_API_POST_VOTES_IDENTITY=observe`. It creates nobody: it holds one
//! read-only pool of its own and nothing that can write, and every statement
//! it sends for a decision or a read-back runs inside one read-only
//! transaction at one snapshot, bounded by the server
//! (`polis_auth::admission::snapshot`).
//!
//! A copy is an identity copy when the vote writer, unchanged, hands it back
//! for one of these reasons: it carries no token; it carries a token the vote
//! writer's verifier refuses (a token for another conversation, a token bound
//! to an external id, a signed-in account's provider token); its body names
//! an external id (`xid`, which the vote writer's shape check refuses); or
//! its token verifies and the membership read finds no member. For such a
//! copy this module decides what `polis_auth::admission::admit` would decide
//! at one instant with nobody else joining (`Snapshot::decide`), and, after a
//! wait, reads what Node left: the participant row, the binding of the
//! external id, the stored vote.
//!
//! The copy's own outcome, reason and every other key of its line are the
//! vote observer's, computed before this module runs and never changed by
//! it. A copy with an external id is still handed back: it is let through
//! here for the identity keys only.
//!
//! What leaves this module is a number, a boolean or a word from a closed
//! set. The external id is an `ExternalId` from the moment it is read out of
//! the body: it has no `Debug` and no `Display`, it is sent to the database
//! only as a bound parameter, and only when the server's logging settings
//! show a parameter cannot reach its log. It is dropped when the read-back
//! ends. No token, user number, participant number, name, address or
//! database message is printed, and nothing here may slice a string, index
//! into one, or unwrap a value that holds one: a panic for either prints it.
#![deny(
    clippy::string_slice,
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used
)]
use super::observe::{NodeVote, ReadbackTiming};
use super::*;
use crate::votes::{StorageConvention, VoteChoice};
use polis_auth::{
    PostgresLookup, Uid,
    admission::{self, Bounds, MemberRow, Outcome, RulesSeen, XidSeen},
    participant::Kind,
    xid_account,
};

/// The switch: unset, empty or `0` is off; `observe` is on. Read only by the
/// shadow role.
pub(crate) const SWITCH: &str = "POLIS_API_POST_VOTES_IDENTITY";

/// Identity copies deciding or waiting for their read-back at once. A copy
/// beyond this is not decided, and its line says so.
pub(crate) const WAITING: usize = 64;

/// How long before the copy's anchor Node's participant for the same request
/// may have been created: the anchor is read after the copy arrives.
pub(crate) const WINDOW_MS: i64 = 5000;

/// How many of a conversation's newest participants a read-back looks at.
pub(crate) const NEWEST: i64 = 8;

/// The body keys that name an external id or come with one. The vote
/// writer's shape check refuses each of them.
const XID_KEYS: [&str; 4] = ["xid", "x_name", "x_profile_image_url", "x_email"];

/// The conversation a code names: the statement the vote writer's admission
/// reads it with.
pub(crate) const ZID: &str = "select zid from zinvites where zinvite = ($1)";

/// The highest participant number of a conversation at the decision's
/// snapshot, by the unique index on (zid, pid).
pub(crate) const TOP: &str =
    "select pid from participants where zid = $1 order by pid desc limit 1";

/// The conversation's newest participants by number, by the same index.
pub(crate) const NEWEST_PARTICIPANTS: &str =
    "select pid, created from participants where zid = $1 order by pid desc limit $2";

/// A user's participant row in a conversation, by the unique index on
/// (zid, uid).
pub(crate) const PARTICIPANT: &str =
    "select pid, created from participants where zid = $1 and uid = $2";

/// The binding of an external id under a conversation's owner, by the unique
/// index on (owner, xid). The external id is the second parameter and is
/// never part of the statement's text.
pub(crate) const BINDING: &str = "select uid, zid, pid from xids where owner = $1 and xid = $2";

/// A participant's vote rows on a statement since the anchor: the statement
/// the vote observer reads a stored vote with.
pub(crate) const VOTE: &str = "select vote from votes
     where zid=$1 and pid=$2 and tid=$3 and created >= $4::bigint - 5000
     order by created";

/// Every setting of the server that can cause a statement, its parameters,
/// its plan or its parse tree to be written to the server's log. Read in the
/// same transaction as, and just before, each statement that binds an
/// external id (`xid_lookup_rule` says what each must be).
pub(crate) const LOGGING_SETTINGS: &str = "select name, setting from pg_settings
     where name in ('log_statement', 'log_min_duration_statement', 'log_min_duration_sample',
     'log_transaction_sample_rate', 'log_parameter_max_length',
     'log_parameter_max_length_on_error', 'log_min_error_statement', 'log_min_messages',
     'debug_print_parse', 'debug_print_rewritten', 'debug_print_plan',
     'shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries')
     order by name";

/// `identity`: one connection for decisions, read-backs and the settings
/// read. Never an admission slot and never the vote observer's read-back
/// connection. A copy has been answered long before it asks, so it may wait
/// a second for the connection.
pub(crate) fn limits() -> db::Limits {
    db::Limits {
        size: 1,
        acquire_timeout: Duration::from_secs(1),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

/// Whether the shadow role is asked to observe identity.
pub(super) fn switch() -> Result<bool> {
    match std::env::var(SWITCH).ok().as_deref() {
        None | Some("" | "0") => Ok(false),
        Some("observe") => Ok(true),
        Some(_) => anyhow::bail!("{SWITCH} must be unset, 0 or observe"),
    }
}

/// An external id, as a request's body names it. It cannot be formatted:
/// there is no `Debug` and no `Display`, so no line, error or panic message
/// can be built from it. Its one use is as a bound query parameter.
pub(crate) struct ExternalId(String);

impl ExternalId {
    fn parameter(&self) -> &str {
        &self.0
    }
}

/// How the request identified itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    /// No token and no external id.
    Nothing,
    /// An external id and no token.
    Xid,
    AnonymousToken,
    XidToken,
    StandardUserToken,
    /// A Bearer credential that carries none of the participant claims: a
    /// signed-in account's provider token, if it is genuine. This process
    /// holds no provider keys and cannot tell.
    ForeignToken,
    /// A Bearer credential with participant claims that did not verify.
    RefusedToken,
}

impl Entry {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Nothing => "none",
            Self::Xid => "xid",
            Self::AnonymousToken => "anonymous_token",
            Self::XidToken => "xid_token",
            Self::StandardUserToken => "standard_user_token",
            Self::ForeignToken => "foreign_token",
            Self::RefusedToken => "refused_token",
        }
    }
}

/// What admission would do, or why nothing was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decided {
    CreateUserAndParticipant,
    CreateParticipant,
    /// An existing member: nothing to create.
    Found,
    Refuse,
    /// Reads alone cannot say (`why` names the case).
    CannotDecide,
    /// The reads did not answer, or may not be sent.
    Unavailable,
    /// Too many identity copies were waiting.
    Shed,
}

impl Decided {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CreateUserAndParticipant => "create_user_and_participant",
            Self::CreateParticipant => "create_participant",
            Self::Found => "found",
            Self::Refuse => "refuse",
            Self::CannotDecide => "cannot_decide",
            Self::Unavailable => "unavailable",
            Self::Shed => "shed",
        }
    }
}

/// The rule a refusal is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    Closed,
    XidRequired,
    XidNotAllowed,
    XidAccount,
    Treevite,
    UnknownConversation,
    /// The body's `xid` is not a string of at most 999 units.
    XidInvalid,
    Other,
}

impl Refused {
    fn of(code: &str) -> Self {
        match code {
            "polis_err_conversation_is_closed" => Self::Closed,
            "polis_err_xid_required" => Self::XidRequired,
            "polis_err_xid_not_allowed" => Self::XidNotAllowed,
            "polis_err_xid_owner_account" => Self::XidAccount,
            "polis_err_treevite_auth_required" => Self::Treevite,
            "polis_err_fetching_zid_for_conversation_id" => Self::UnknownConversation,
            _ => Self::Other,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::XidRequired => "xid_required",
            Self::XidNotAllowed => "xid_not_allowed",
            Self::XidAccount => "xid_account",
            Self::Treevite => "treevite",
            Self::UnknownConversation => "unknown_conversation",
            Self::XidInvalid => "xid_invalid",
            Self::Other => "other",
        }
    }
}

/// Why nothing was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Why {
    /// The token did not verify with the participant key.
    TokenUnverified,
    /// The server's logging settings could put a parameter in its log, so
    /// the external id is not sent.
    XidLookupDisabled,
    /// Those settings could not be read.
    LoggingSettingsUnread,
    ReadsFailed,
    WaitingFull,
}

impl Why {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::TokenUnverified => "token_unverified",
            Self::XidLookupDisabled => "xid_lookup_disabled",
            Self::LoggingSettingsUnread => "logging_settings_unread",
            Self::ReadsFailed => "reads_failed",
            Self::WaitingFull => "waiting_full",
        }
    }
}

fn xid_word(seen: XidSeen) -> &'static str {
    match seen {
        XidSeen::NotNamed => "none",
        XidSeen::Bound => "bound",
        XidSeen::Unbound => "unbound",
        XidSeen::NotReached => "not_looked_up",
    }
}

/// A verified token holder's row, for a copy the membership read refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Row {
    Matches,
    Absent,
    Differs,
    /// The read failed, or what it read would not have been refused: the
    /// state changed after admission read it.
    Unknown,
}

impl Row {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Matches => "matches",
            Self::Absent => "absent",
            Self::Differs => "differs",
            Self::Unknown => "unknown",
        }
    }
}

/// What the read-back found of Node's participant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Node {
    /// A participant row created inside the window.
    Created,
    /// A participant row from before the window.
    Found,
    /// No such row at either look.
    None,
    /// More than one row could be this request's, or more rows are new than
    /// a look reads.
    Ambiguous,
    Unavailable,
    /// Not looked for: the copy has no database-time anchor.
    NoAnchor,
    /// Not looked for: nothing to look by, or nothing was decided.
    NotChecked,
}

impl Node {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Found => "found",
            Self::None => "none",
            Self::Ambiguous => "ambiguous",
            Self::Unavailable => "unavailable",
            Self::NoAnchor => "no_anchor",
            Self::NotChecked => "not_checked",
        }
    }
}

/// What the read-back found of the external id's binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NodeXid {
    /// Bound, to this conversation's participant row.
    BoundHere,
    /// Bound, and the row names another conversation or another number: a
    /// person who first arrived in another conversation of the same owner.
    BoundElsewhere,
    /// Bound with no participant number: Node read the number where the new
    /// row was not yet visible.
    BoundNoNumber,
    Unbound,
}

impl NodeXid {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BoundHere => "bound_here",
            Self::BoundElsewhere => "bound_elsewhere",
            Self::BoundNoNumber => "bound_no_number",
            Self::Unbound => "unbound",
        }
    }
}

/// Whether the decision's snapshot already held what Node created: taken
/// from what the decision saw, never from two clocks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Timing {
    /// The decision did not see Node's row: it decided first.
    BeforeNode,
    /// The decision saw the row Node had just created.
    AfterNode,
}

impl Timing {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BeforeNode => "before_node",
            Self::AfterNode => "after_node",
        }
    }
}

/// The decision beside the read-back, on one question: was a participant
/// created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Compare {
    /// Found by the request's own identity, and the two agree.
    Agree,
    /// Rust would create, and exactly one new participant has the copy's
    /// vote on the copy's statement. Found only by inference: that
    /// participant may be somebody else, and Node may have created nobody
    /// for this request. Never counted as agreement.
    AgreeByNumber,
    /// Rust would refuse a first vote into a closed conversation before
    /// creating anyone; Node creates the participant and then refuses.
    ExpectedDifference,
    Differs,
    Unknown,
}

impl Compare {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agree => "agree",
            Self::AgreeByNumber => "agree_by_number",
            Self::ExpectedDifference => "expected_difference",
            Self::Differs => "differs",
            Self::Unknown => "unknown",
        }
    }
}

/// `tied`: the read-back found its row by the request's own identity (a
/// token's user, an external id). Otherwise it found a new participant with a
/// vote on the copy's statement, who may be somebody else.
pub(crate) fn compare(
    decided: Decided,
    refusal: Option<Refused>,
    node: Node,
    node_vote: Option<NodeVote>,
    timing: Option<Timing>,
    tied: bool,
) -> Compare {
    let created = match node {
        Node::Created => true,
        Node::Found => false,
        // None, ambiguous, unavailable, no anchor and not checked are
        // unknown: never agreement and never disagreement.
        Node::None | Node::Ambiguous | Node::Unavailable | Node::NoAnchor | Node::NotChecked => {
            return Compare::Unknown;
        }
    };
    match decided {
        Decided::CreateUserAndParticipant | Decided::CreateParticipant => {
            if created && tied {
                Compare::Agree
            } else if created && node_vote == Some(NodeVote::Same) {
                // Node stores the vote the request carried: a new participant
                // with another vote on the statement is somebody else.
                Compare::AgreeByNumber
            } else if created {
                Compare::Unknown
            } else if tied {
                Compare::Differs
            } else {
                Compare::Unknown
            }
        }
        Decided::Found => {
            if !created {
                Compare::Agree
            } else if timing == Some(Timing::AfterNode) {
                // Right for the instant it was taken at, and silent about
                // the instant before.
                Compare::Unknown
            } else {
                Compare::Differs
            }
        }
        Decided::Refuse => {
            if !created {
                Compare::Agree
            } else if !tied {
                Compare::Unknown
            } else if refusal == Some(Refused::Closed) {
                Compare::ExpectedDifference
            } else {
                Compare::Differs
            }
        }
        Decided::CannotDecide | Decided::Unavailable | Decided::Shed => Compare::Unknown,
    }
}

/// One identity copy, as classes. This is everything of an observation that
/// can reach a line: words from closed sets, booleans and numbers. There is
/// no string field to put a value in.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Observed {
    pub(crate) entry: Option<Entry>,
    /// Whether the token was issued for the conversation code the request
    /// names. None without a verified token.
    pub(crate) same_conversation: Option<bool>,
    pub(crate) decided: Decided,
    pub(crate) refusal: Option<Refused>,
    pub(crate) why: Option<Why>,
    pub(crate) zid: Option<i32>,
    pub(crate) rules: Option<RulesSeen>,
    pub(crate) xid: Option<XidSeen>,
    /// Whether the decision saw a participant row for the identity.
    pub(crate) member: Option<bool>,
    pub(crate) member_treevite: Option<bool>,
    pub(crate) member_row: Option<Row>,
    /// Whether the copy's vote fields parse.
    pub(crate) fields: Option<bool>,
    pub(crate) took: Option<Duration>,
    pub(crate) node: Node,
    pub(crate) node_xid: Option<NodeXid>,
    pub(crate) node_vote: Option<NodeVote>,
    pub(crate) timing: Option<Timing>,
    pub(crate) readback_s: Option<f64>,
    pub(crate) compare: Compare,
}

impl Observed {
    fn undecided(entry: Option<Entry>, decided: Decided, why: Why) -> Self {
        Self {
            entry,
            same_conversation: None,
            decided,
            refusal: None,
            why: Some(why),
            zid: None,
            rules: None,
            xid: None,
            member: None,
            member_treevite: None,
            member_row: None,
            fields: None,
            took: None,
            node: Node::NotChecked,
            node_xid: None,
            node_vote: None,
            timing: None,
            readback_s: None,
            compare: Compare::Unknown,
        }
    }
}

/// The identity keys of the vote copy's `shadow_observation` line, in their
/// order, after the vote observer's own keys.
pub(crate) const LINE_KEYS: [&str; 22] = [
    "id_basis",
    "id_entry",
    "id_token_scope",
    "id_decision",
    "id_refusal",
    "id_why",
    "id_zid",
    "id_xid_required",
    "id_xid_allowlist",
    "id_treevite",
    "id_xid",
    "id_member",
    "id_member_treevite",
    "id_member_row",
    "id_fields",
    "id_decision_ms",
    "id_node",
    "id_node_xid",
    "id_node_vote",
    "id_timing",
    "id_readback_s",
    "id_compare",
];

/// A decision is what admission would decide at one instant, by reads, with
/// nobody else joining. The line says so on every identity copy.
const BASIS: &str = "one_instant_reads";

/// Appends the identity keys to a vote copy's line. A copy that is not an
/// identity copy carries each key as null.
pub(crate) fn print_keys(line: &mut js::Obj, observed: Option<&Observed>) {
    let word = |value: Option<&'static str>| value.map(|v| Js::Str(v.into())).unwrap_or(Js::Null);
    let flag = |value: Option<bool>| value.map(Js::Bool).unwrap_or(Js::Null);
    let number = |value: Option<f64>| value.map(Js::Num).unwrap_or(Js::Null);
    let o = observed;
    let values: [Js; 22] = [
        word(o.map(|_| BASIS)),
        word(o.and_then(|o| o.entry).map(Entry::as_str)),
        word(o.and_then(|o| {
            o.same_conversation
                .map(|same| if same { "this" } else { "other" })
        })),
        word(o.map(|o| o.decided.as_str())),
        word(o.and_then(|o| o.refusal).map(Refused::as_str)),
        word(o.and_then(|o| o.why).map(Why::as_str)),
        number(o.and_then(|o| o.zid).map(f64::from)),
        flag(o.and_then(|o| o.rules).map(|rules| rules.xid_required)),
        flag(o.and_then(|o| o.rules).map(|rules| rules.allowlist)),
        flag(o.and_then(|o| o.rules).map(|rules| rules.treevite)),
        word(o.and_then(|o| o.xid).map(xid_word)),
        flag(o.and_then(|o| o.member)),
        flag(o.and_then(|o| o.member_treevite)),
        word(o.and_then(|o| o.member_row).map(Row::as_str)),
        flag(o.and_then(|o| o.fields)),
        number(
            o.and_then(|o| o.took)
                .map(|took| (took.as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0),
        ),
        word(o.map(|o| o.node.as_str())),
        word(o.and_then(|o| o.node_xid).map(NodeXid::as_str)),
        word(o.and_then(|o| o.node_vote).map(NodeVote::as_str)),
        word(o.and_then(|o| o.timing).map(Timing::as_str)),
        number(o.and_then(|o| o.readback_s)),
        word(o.map(|o| o.compare.as_str())),
    ];
    for (key, value) in LINE_KEYS.into_iter().zip(values) {
        line.set(key, value);
    }
}

/// An event line of the identity observer. Its fields are words of this
/// module's own: an event has no field for anything read from a request, a
/// row or a server.
fn event(name: &'static str, fields: &[(&'static str, &'static str)]) {
    let fields: Vec<(&str, Js)> = fields
        .iter()
        .map(|(key, word)| (*key, Js::Str((*word).into())))
        .collect();
    crate::shadow::event(name, &fields);
}

/// Whether an external id may be sent to the database as a parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum XidLookup {
    Enabled,
    /// The named setting could put a parameter in the server's log.
    Disabled(&'static str),
}

/// The rule: an external id is bound as a parameter only when no setting of
/// the server can write it into the server's log. `settings` are the rows of
/// `LOGGING_SETTINGS`. A setting that is missing counts as unsafe.
///
/// - `log_parameter_max_length_on_error` other than 0 logs the parameters of
///   a statement that fails, and every statement here can fail: each is cut
///   at its statement bound.
/// - With `log_parameter_max_length` other than 0, parameters are logged
///   with a statement that is logged: every statement (`log_statement` =
///   `all`), one that runs past `log_min_duration_statement` or
///   `log_min_duration_sample` (anything but -1), or every statement of a
///   sampled transaction (`log_transaction_sample_rate` other than 0; these
///   statements run in a transaction).
/// - `debug_print_plan` writes the plan, in which a bound parameter can stand
///   as a constant; `debug_print_parse` and `debug_print_rewritten` write the
///   trees it is made from. Each must be off.
/// - `log_min_messages` at a debug level writes the server's internal
///   messages, which nothing promises are free of values.
/// - `auto_explain` and `pgaudit`, preloaded in any of the three ways, log
///   statements by settings of their own.
pub(crate) fn xid_lookup_rule(settings: &[(String, String)]) -> XidLookup {
    let setting = |name: &str| {
        settings
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    if setting("log_parameter_max_length_on_error") != Some("0") {
        return XidLookup::Disabled("log_parameter_max_length_on_error");
    }
    let Some(parameters) = setting("log_parameter_max_length") else {
        return XidLookup::Disabled("log_parameter_max_length");
    };
    if parameters != "0" {
        if !matches!(setting("log_statement"), Some("none" | "ddl" | "mod")) {
            return XidLookup::Disabled("log_statement");
        }
        if setting("log_min_duration_statement") != Some("-1") {
            return XidLookup::Disabled("log_min_duration_statement");
        }
        if setting("log_min_duration_sample") != Some("-1") {
            return XidLookup::Disabled("log_min_duration_sample");
        }
        if setting("log_transaction_sample_rate") != Some("0") {
            return XidLookup::Disabled("log_transaction_sample_rate");
        }
    }
    for name in [
        "debug_print_parse",
        "debug_print_rewritten",
        "debug_print_plan",
    ] {
        if setting(name) != Some("off") {
            return XidLookup::Disabled("debug_print");
        }
    }
    if setting("log_min_messages").is_none_or(|level| level.starts_with("debug")) {
        return XidLookup::Disabled("log_min_messages");
    }
    for name in [
        "shared_preload_libraries",
        "session_preload_libraries",
        "local_preload_libraries",
    ] {
        let Some(libraries) = setting(name) else {
            return XidLookup::Disabled("preload_libraries");
        };
        if libraries.contains("auto_explain") || libraries.contains("pgaudit") {
            return XidLookup::Disabled("preload_libraries");
        }
    }
    XidLookup::Enabled
}

/// One reading of the settings, inside a transaction, for the statement that
/// follows it there. None: they could not be read.
fn read_rule(tx: &mut postgres::Transaction<'_>) -> Option<XidLookup> {
    let rows = tx.query(LOGGING_SETTINGS, &[]).ok()?;
    let settings = rows
        .iter()
        .map(|row| Some((row.try_get(0).ok()?, row.try_get(1).ok()?)))
        .collect::<Option<Vec<(String, String)>>>()?;
    Some(xid_lookup_rule(&settings))
}

/// What a transaction that would bind an external id read of the settings.
#[derive(Clone, Copy)]
enum Reading {
    /// No external id to bind: nothing read.
    NotNeeded,
    Unread,
    Read(XidLookup),
}

impl Reading {
    fn taken(tx: &mut postgres::Transaction<'_>) -> Self {
        read_rule(tx).map_or(Self::Unread, Self::Read)
    }

    fn allows(self) -> bool {
        matches!(self, Self::NotNeeded | Self::Read(XidLookup::Enabled))
    }
}

#[derive(Default)]
struct Counters {
    decided: AtomicU64,
    would_create: AtomicU64,
    would_find: AtomicU64,
    would_refuse: AtomicU64,
    cannot_decide: AtomicU64,
    unavailable: AtomicU64,
    shed: AtomicU64,
    node_created: AtomicU64,
    node_found: AtomicU64,
    node_none: AtomicU64,
    node_ambiguous: AtomicU64,
    compare_agree: AtomicU64,
    compare_expected: AtomicU64,
    compare_differs: AtomicU64,
    compare_by_number: AtomicU64,
}

pub(crate) struct IdentityObserver {
    pool: Arc<db::Pool>,
    waiting: Arc<tokio::sync::Semaphore>,
    /// The last reading of the server's logging settings and when it was
    /// taken (milliseconds since the epoch), for `/health` only: nothing is
    /// decided from it. None until the first reading.
    xid_lookup: Mutex<Option<(XidLookup, f64)>>,
    counters: Counters,
    pub(crate) bounds: Bounds,
    pub(crate) timing: ReadbackTiming,
}

/// What the read-back looks for, in process only. It has no `Debug`: it
/// holds a user number, participant numbers and the external id.
struct Subject {
    zid: i32,
    /// The user the decision resolved.
    uid: Option<i32>,
    /// A named external id and the owner it is bound under.
    xid: Option<(i32, Arc<ExternalId>)>,
    /// The participant number a verified token for this conversation carries:
    /// Node stores the vote under it without reading the row.
    token_pid: Option<i32>,
    vote: Option<(i32, VoteChoice)>,
    /// The highest participant number the decision's snapshot held.
    top_pid: Option<i32>,
    /// Whether the decision saw a participant row for this identity.
    saw_member: bool,
}

/// One look of the read-back, as classes.
struct Looked {
    /// What the look read of the server's settings before binding the
    /// external id.
    reading: Reading,
    node: Node,
    node_xid: Option<NodeXid>,
    node_vote: Option<NodeVote>,
    timing: Option<Timing>,
}

/// A decided copy waiting for its read-back.
pub(crate) struct Pending {
    observed: Observed,
    subject: Option<Subject>,
    tied: bool,
    _waiting: Option<tokio::sync::OwnedSemaphorePermit>,
}

/// What the body says of an external id.
enum Named {
    Nothing,
    Xid(ExternalId),
    Invalid,
}

/// An identity copy, read out of the request.
struct Read {
    cid: String,
    named: Named,
    fields: Option<(i32, VoteChoice)>,
    fields_valid: bool,
}

/// The copy as the vote writer would read it without the external-id keys,
/// and what those keys name. None when the copy is not an identity copy.
fn read(req: &Request, reason: Option<&'static str>) -> Option<Read> {
    let (cid, raw, named) = match reason {
        Some("no_token" | "token_refused" | "not_a_participant") => {
            let (cid, raw) = request_reasoned(req).ok()?;
            (cid, raw, Named::Nothing)
        }
        Some("shape_keys") => {
            let value: serde_json::Value = serde_json::from_slice(&req.body).ok()?;
            let mut object = value.as_object()?.clone();
            if !XID_KEYS.iter().any(|key| object.contains_key(*key)) {
                return None;
            }
            let xid = object.get("xid").cloned();
            for key in XID_KEYS {
                object.remove(key);
            }
            // The vote writer's own shape check, on the rest of the body.
            let rest = Request {
                method: req.method.clone(),
                target: req.target.clone(),
                headers: req.headers.clone(),
                body: serde_json::to_vec(&serde_json::Value::Object(object)).ok()?,
            };
            let (cid, raw) = request_reasoned(&rest).ok()?;
            // Node's own parse: absent or null names nothing; a string of at
            // most 999 units, less its outer spaces; anything else is a 400
            // before anyone is created.
            let named = match xid {
                None | Some(serde_json::Value::Null) => Named::Nothing,
                Some(value) => match contract::string(&value, 999) {
                    // Only whitespace names nothing, by Node's own rule.
                    Some(xid)
                        if matches!(
                            admission::Identity::without_token(Some(&xid)),
                            admission::Identity::Anonymous
                        ) =>
                    {
                        Named::Nothing
                    }
                    Some(xid) => Named::Xid(ExternalId(xid)),
                    None => Named::Invalid,
                },
            };
            (cid, raw, named)
        }
        _ => return None,
    };
    let parsed = raw
        .parse_fields()
        .ok()
        .filter(|fields| (i32::MIN as f64..=i32::MAX as f64).contains(&fields.tid));
    Some(Read {
        cid,
        named,
        fields_valid: parsed.is_some(),
        fields: parsed.map(|fields| (fields.tid as i32, fields.vote)),
    })
}

/// A database error with nothing of the statement, its parameters or the
/// server's message left in it. The server's message for a failing read can
/// quote a key's value.
fn scrubbed(_: anyhow::Error) -> anyhow::Error {
    anyhow::anyhow!("identity read failed")
}

impl IdentityObserver {
    pub(super) fn new(pool: Arc<db::Pool>) -> Self {
        Self {
            pool,
            waiting: Arc::new(tokio::sync::Semaphore::new(WAITING)),
            xid_lookup: Mutex::new(None),
            counters: Counters::default(),
            bounds: Bounds::OBSERVE,
            timing: ReadbackTiming::default(),
        }
    }

    /// The one pool identity observation builds, read-only.
    #[cfg(test)]
    pub(crate) fn startup_pools(&self) -> [(&'static str, &Arc<db::Pool>); 1] {
        let Self {
            pool,
            waiting: _,
            xid_lookup: _,
            counters: _,
            bounds: _,
            timing: _,
        } = self;
        [("identity", pool)]
    }

    pub(crate) fn waiting(&self) -> usize {
        WAITING - self.waiting.available_permits()
    }

    /// One reading of the server's logging settings, for the startup event
    /// and `/health`. It decides nothing: each transaction that would bind an
    /// external id reads them again itself, just before it does. None: they
    /// could not be read.
    pub(crate) async fn xid_lookup(&self) -> Option<XidLookup> {
        let settings: Vec<(String, String)> = self
            .pool
            .with(|c| {
                c.query(LOGGING_SETTINGS, &[])?
                    .iter()
                    .map(|row| Ok((row.try_get(0)?, row.try_get(1)?)))
                    .collect()
            })
            .await
            .ok()?;
        let rule = xid_lookup_rule(&settings);
        self.note(Reading::Read(rule));
        Some(rule)
    }

    /// Keeps a reading for `/health`.
    fn note(&self, reading: Reading) {
        if let Reading::Read(rule) = reading {
            *self.xid_lookup.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((rule, crate::clock::now_ms()));
        }
    }

    /// Reads the server's logging settings and says, once at startup, whether
    /// external ids will be looked up, and for which setting they will not.
    pub(crate) async fn report_logging_settings(&self) {
        let (read, lookup, because) = match self.xid_lookup().await {
            None => ("failed", "disabled", "settings_unread"),
            Some(XidLookup::Enabled) => ("ok", "enabled", "none"),
            Some(XidLookup::Disabled(setting)) => ("ok", "disabled", setting),
        };
        event(
            "shadow_post_votes_identity_database_logging",
            &[("read", read), ("xid_lookup", lookup), ("because", because)],
        );
    }

    pub(crate) fn health(&self, reachable: bool) -> Js {
        let c = &self.counters;
        let mut body = js::Obj::new();
        body.set("mode", Js::Str("observe".into()));
        for (key, value) in [
            ("decided", &c.decided),
            ("wouldCreate", &c.would_create),
            ("wouldFind", &c.would_find),
            ("wouldRefuse", &c.would_refuse),
            ("cannotDecide", &c.cannot_decide),
            ("unavailable", &c.unavailable),
            ("shed", &c.shed),
            ("nodeCreated", &c.node_created),
            ("nodeFound", &c.node_found),
            ("nodeNone", &c.node_none),
            ("nodeAmbiguous", &c.node_ambiguous),
            ("compareAgree", &c.compare_agree),
            ("compareExpectedDifference", &c.compare_expected),
            ("compareDiffers", &c.compare_differs),
            ("compareAgreeByNumber", &c.compare_by_number),
        ] {
            body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
        }
        body.set("waiting", Js::Num(self.waiting() as f64));
        body.set("waitingCapacity", Js::Num(WAITING as f64));
        let last = *self.xid_lookup.lock().unwrap_or_else(|e| e.into_inner());
        let lookup = match last {
            None => "unread",
            Some((XidLookup::Enabled, _)) => "enabled",
            Some((XidLookup::Disabled(_), _)) => "disabled",
        };
        // The last reading, and when it was taken.
        body.set("xidLookup", Js::Str(lookup.into()));
        body.set(
            "xidLookupReadAt",
            last.map(|(_, at)| Js::Num(at)).unwrap_or(Js::Null),
        );
        let mut pools = js::Obj::new();
        pools.set("identity", self.pool.health(reachable));
        body.set("pools", Js::Obj(pools));
        Js::Obj(body)
    }

    pub(crate) async fn ping(&self) -> bool {
        self.pool.ping().await
    }

    /// The decision for one copy, by reads alone. None: not an identity
    /// copy. The request is not needed after this returns.
    pub(crate) async fn decide(
        &self,
        verifier: &participant::Verifier,
        admins: &[i32],
        req: &Request,
        reason: Option<&'static str>,
    ) -> Option<Pending> {
        let read = read(req, reason)?;
        #[cfg(test)]
        tests::panic_point(req);
        let started = tokio::time::Instant::now();
        let authorization = req.headers.get("authorization");
        let Ok(waiting) = self.waiting.clone().try_acquire_owned() else {
            return Some(Pending::undecided(None, Decided::Shed, Why::WaitingFull));
        };
        let now = (crate::clock::now_ms() / 1000.0) as u64;
        // The token, verified with the participant key. The account check of
        // a token bound to an external id runs with the decision's reads, on
        // the user number recorded here.
        let named = match &read.named {
            Named::Xid(xid) => Some(xid.parameter()),
            Named::Nothing | Named::Invalid => None,
        };
        let mut signed = None;
        let mut record = |uid: Uid| {
            signed = Some(uid);
            Ok::<Option<xid_account::Account>, polis_auth::Unavailable>(None)
        };
        let verified = authorization.map(|authorization| {
            verifier
                .verify_for_request(
                    authorization,
                    &read.cid,
                    named,
                    now,
                    &mut xid_account::Check {
                        db: &mut record,
                        admin_uids: &[],
                    },
                )
                .ok()
                .flatten()
        });
        let entry = match (&verified, authorization) {
            (None, _) if named.is_some() => Entry::Xid,
            (None, _) => Entry::Nothing,
            (Some(Some(identity)), _) => match identity.kind {
                Kind::Anonymous => Entry::AnonymousToken,
                Kind::Xid => Entry::XidToken,
                Kind::StandardUser => Entry::StandardUserToken,
            },
            (Some(None), Some(authorization)) => {
                let participant_claims = polis_auth::observability::credential_hints(authorization)
                    .is_some_and(|claims| {
                        [
                            "anonymous_participant",
                            "standard_user_participant",
                            "xid_participant",
                        ]
                        .iter()
                        .any(|claim| claims.get(claim).is_some())
                    });
                if participant_claims {
                    Entry::RefusedToken
                } else {
                    Entry::ForeignToken
                }
            }
            (Some(None), None) => Entry::RefusedToken,
        };
        let mut observed = Observed::undecided(Some(entry), Decided::Unavailable, Why::ReadsFailed);
        observed.fields = Some(read.fields_valid);
        let identity = match verified {
            None => None,
            Some(Some(identity)) => {
                observed.same_conversation = Some(identity.same_conversation());
                Some(identity)
            }
            Some(None) => {
                observed.decided = Decided::CannotDecide;
                observed.why = Some(Why::TokenUnverified);
                return Some(self.pending(observed, None, false, waiting));
            }
        };
        if matches!(read.named, Named::Invalid) {
            observed.decided = Decided::Refuse;
            observed.refusal = Some(Refused::XidInvalid);
            observed.why = None;
            return Some(self.pending(observed, None, false, waiting));
        }
        // The external id that is the request's identity: the body's, or the
        // token's when the token is bound to one.
        let xid = match (
            identity.as_ref().and_then(|identity| identity.xid()),
            read.named,
        ) {
            (Some(xid), _) => Some(Arc::new(ExternalId(xid.to_owned()))),
            (None, Named::Xid(xid)) if identity.is_none() => Some(Arc::new(xid)),
            _ => None,
        };
        // A verified token for this very conversation: the membership read
        // refused it, and this is the same token.
        let member = (reason == Some("not_a_participant"))
            .then(|| {
                authorization.and_then(|authorization| {
                    verifier.verify_unobserved(authorization, &read.cid, now)
                })
            })
            .flatten();
        let token_pid = member.as_ref().map(|member| member.pid().0 as i32);
        // The user a verified token names here: a refusal made before any
        // read of membership (a closed conversation) is still compared with
        // what Node left for that user.
        let token_uid = identity
            .as_ref()
            .and_then(|identity| identity.uid())
            .map(|uid| uid.0);
        let admins: Vec<Uid> = admins.iter().copied().map(Uid).collect();
        let bounds = self.bounds;
        let cid = read.cid;
        let lookup = xid.clone();
        let split = reason == Some("not_a_participant");
        let reads = self
            .pool
            .with(move |c| {
                decide_by_reads(
                    c,
                    &bounds,
                    &cid,
                    identity.as_ref(),
                    lookup.as_deref(),
                    signed,
                    member.as_ref(),
                    split,
                    &admins,
                )
                .map_err(scrubbed)
            })
            .await;
        observed.took = Some(started.elapsed());
        let Ok(reads) = reads else {
            return Some(self.pending(observed, None, false, waiting));
        };
        // The transaction read the server's settings before it would bind
        // the external id, and sent nothing that carries it unless they
        // allow it.
        self.note(reads.reading);
        match reads.reading {
            Reading::Read(XidLookup::Disabled(_)) => {
                observed.why = Some(Why::XidLookupDisabled);
                return Some(self.pending(observed, None, false, waiting));
            }
            Reading::Unread => {
                observed.why = Some(Why::LoggingSettingsUnread);
                return Some(self.pending(observed, None, false, waiting));
            }
            Reading::NotNeeded | Reading::Read(XidLookup::Enabled) => {}
        }
        observed.why = None;
        observed.zid = reads.zid;
        observed.member_treevite = reads.member_treevite;
        observed.member_row = reads.member_row;
        let (Some(zid), Some(outcome)) = (reads.zid, &reads.outcome) else {
            observed.decided = Decided::Refuse;
            observed.refusal = Some(Refused::UnknownConversation);
            return Some(self.pending(observed, None, false, waiting));
        };
        let (uid, owner) = match outcome {
            ReadOutcome::AccountRefused => {
                observed.decided = Decided::Refuse;
                observed.refusal = Some(Refused::XidAccount);
                (None, None)
            }
            ReadOutcome::Decided(decision) => {
                observed.rules = decision.rules;
                observed.xid = Some(decision.xid);
                observed.member = Some(decision.pid().is_some());
                match decision.outcome {
                    Outcome::Found => observed.decided = Decided::Found,
                    Outcome::CreateParticipant => observed.decided = Decided::CreateParticipant,
                    Outcome::CreateUserAndParticipant => {
                        observed.decided = Decided::CreateUserAndParticipant;
                    }
                    // The vote route always creates: nobody is never decided.
                    Outcome::Nobody => observed.decided = Decided::CannotDecide,
                    Outcome::Refused(refusal) => {
                        observed.decided = Decided::Refuse;
                        observed.refusal = Some(Refused::of(refusal.code));
                    }
                }
                (
                    decision.uid().map(|uid| uid.0),
                    decision.owner().map(|owner| owner.0),
                )
            }
        };
        let uid = uid.or(token_uid);
        let bound = xid.zip(owner).map(|(xid, owner)| (owner, xid));
        let tied = uid.is_some() || bound.is_some();
        let subject = Subject {
            zid,
            uid,
            xid: bound,
            token_pid,
            vote: read.fields,
            top_pid: reads.top_pid,
            saw_member: observed.member == Some(true),
        };
        let looks = tied || subject.vote.is_some();
        Some(self.pending(observed, looks.then_some(subject), tied, waiting))
    }

    fn pending(
        &self,
        observed: Observed,
        subject: Option<Subject>,
        tied: bool,
        waiting: tokio::sync::OwnedSemaphorePermit,
    ) -> Pending {
        Pending {
            observed,
            subject,
            tied,
            _waiting: Some(waiting),
        }
    }

    /// What Node left for a decided copy, first at `timing.first` after
    /// receipt and once more at `timing.retry` when nothing is there yet. No
    /// connection is held while waiting. The external id is dropped when
    /// this returns.
    pub(crate) async fn read_back(
        &self,
        pending: Pending,
        anchor: Option<i64>,
        received: tokio::time::Instant,
    ) -> Observed {
        let Pending {
            mut observed,
            subject,
            tied,
            _waiting,
        } = pending;
        if let Some(subject) = subject {
            match anchor {
                // Without the anchor a new row could not be told from an
                // older one, so none is looked for.
                None => observed.node = Node::NoAnchor,
                Some(anchor) => {
                    let subject = Arc::new(subject);
                    let mut found = None;
                    for delay in [self.timing.first, self.timing.retry] {
                        tokio::time::sleep_until(received + delay).await;
                        observed.readback_s = Some(delay.as_secs_f64());
                        let again = subject.clone();
                        let bounds = self.bounds;
                        let looked = self
                            .pool
                            .with(move |c| look(c, &bounds, &again, anchor).map_err(scrubbed))
                            .await;
                        match looked {
                            Err(_) => {
                                found = Some(Looked {
                                    reading: Reading::NotNeeded,
                                    node: Node::Unavailable,
                                    node_xid: None,
                                    node_vote: None,
                                    timing: None,
                                });
                                break;
                            }
                            Ok(looked) => {
                                self.note(looked.reading);
                                // Look again when no row is there yet, or the
                                // row is and the vote is not.
                                let settled = !matches!(looked.node, Node::None)
                                    && looked.node_vote != Some(NodeVote::Absent);
                                found = Some(looked);
                                if settled {
                                    break;
                                }
                            }
                        }
                    }
                    if let Some(looked) = found {
                        observed.node = looked.node;
                        observed.node_xid = looked.node_xid;
                        observed.node_vote = looked.node_vote;
                        observed.timing = looked.timing;
                    }
                }
            }
        }
        observed.compare = compare(
            observed.decided,
            observed.refusal,
            observed.node,
            observed.node_vote,
            observed.timing,
            tied,
        );
        self.count(&observed);
        observed
    }

    fn count(&self, observed: &Observed) {
        let c = &self.counters;
        c.decided.fetch_add(1, Ordering::Relaxed);
        match observed.decided {
            Decided::CreateUserAndParticipant | Decided::CreateParticipant => &c.would_create,
            Decided::Found => &c.would_find,
            Decided::Refuse => &c.would_refuse,
            Decided::CannotDecide => &c.cannot_decide,
            Decided::Unavailable => &c.unavailable,
            Decided::Shed => &c.shed,
        }
        .fetch_add(1, Ordering::Relaxed);
        match observed.node {
            Node::Created => Some(&c.node_created),
            Node::Found => Some(&c.node_found),
            Node::None => Some(&c.node_none),
            Node::Ambiguous => Some(&c.node_ambiguous),
            Node::Unavailable | Node::NoAnchor | Node::NotChecked => None,
        }
        .map(|counter| counter.fetch_add(1, Ordering::Relaxed));
        match observed.compare {
            Compare::Agree => Some(&c.compare_agree),
            Compare::ExpectedDifference => Some(&c.compare_expected),
            Compare::Differs => Some(&c.compare_differs),
            Compare::AgreeByNumber => Some(&c.compare_by_number),
            Compare::Unknown => None,
        }
        .map(|counter| counter.fetch_add(1, Ordering::Relaxed));
    }
}

impl Pending {
    fn undecided(entry: Option<Entry>, decided: Decided, why: Why) -> Self {
        Self {
            observed: Observed::undecided(entry, decided, why),
            subject: None,
            tied: false,
            _waiting: None,
        }
    }
}

enum ReadOutcome {
    /// A token bound to an external id, whose signed user is an account that
    /// may not take part as a participant.
    AccountRefused,
    Decided(admission::Decision),
}

/// What the decision's reads answered, in process only.
struct Reads {
    zid: Option<i32>,
    member_treevite: Option<bool>,
    member_row: Option<Row>,
    /// None when the conversation code names no conversation.
    outcome: Option<ReadOutcome>,
    top_pid: Option<i32>,
    reading: Reading,
}

/// Every read of one decision, in one read-only transaction at one snapshot:
/// the conversation, the account check of a token bound to an external id,
/// the membership read for a token the vote writer refused, admission's own
/// decision, and the highest participant number.
#[allow(clippy::too_many_arguments)]
fn decide_by_reads(
    c: &mut Client,
    bounds: &Bounds,
    cid: &str,
    identity: Option<&participant::RequestIdentity>,
    xid: Option<&ExternalId>,
    signed: Option<Uid>,
    member: Option<&participant::Verified>,
    split: bool,
    admins: &[Uid],
) -> Result<Reads> {
    let unavailable = || anyhow::anyhow!("identity read failed");
    let mut reads = admission::snapshot(c, bounds).map_err(|_| unavailable())?;
    // Before any statement of this transaction binds the external id.
    let reading = match xid {
        None => Reading::NotNeeded,
        Some(_) => Reading::taken(reads.client()),
    };
    if !reading.allows() {
        reads.end();
        return Ok(Reads {
            zid: None,
            member_treevite: None,
            member_row: None,
            outcome: None,
            top_pid: None,
            reading,
        });
    }
    let zid = reads
        .client()
        .query(ZID, &[&cid])?
        .first()
        .map(|row| row.try_get::<_, i32>(0))
        .transpose()?;
    let Some(zid) = zid else {
        reads.end();
        return Ok(Reads {
            zid: None,
            member_treevite: None,
            member_row: None,
            outcome: None,
            top_pid: None,
            reading,
        });
    };
    let zid_typed = polis_auth::Zid(zid);
    if let Some(signed) = signed {
        let refusal = xid_account::Check {
            db: &mut PostgresLookup(reads.client()),
            admin_uids: admins,
        }
        .require_participant(signed);
        match refusal {
            Ok(()) => {}
            Err(xid_account::Refusal::Privileged(_)) => {
                reads.end();
                return Ok(Reads {
                    zid: Some(zid),
                    member_treevite: None,
                    member_row: None,
                    outcome: Some(ReadOutcome::AccountRefused),
                    top_pid: None,
                    reading,
                });
            }
            Err(xid_account::Refusal::CheckFailed) => return Err(unavailable()),
        }
    }
    // The two fields that say why the membership read found no member.
    let (member_treevite, member_row) = match (split, member) {
        (false, _) => (None, None),
        (true, None) => (None, Some(Row::Unknown)),
        (true, Some(member)) => match reads.membership(zid_typed, member) {
            Err(_) | Ok(None) => (None, Some(Row::Unknown)),
            Ok(Some(membership)) => (
                Some(membership.treevite),
                Some(match membership.row {
                    MemberRow::Absent => Row::Absent,
                    MemberRow::Differs => Row::Differs,
                    // A matching row outside Treevite is a member: admission
                    // would not have refused what this read sees.
                    MemberRow::Matches if !membership.treevite => Row::Unknown,
                    MemberRow::Matches => Row::Matches,
                }),
            ),
        },
    };
    let entry = match (identity, xid) {
        (Some(identity), _) => admission::Identity::from_verified(identity, zid_typed),
        (None, xid) => admission::Identity::without_token(xid.map(ExternalId::parameter)),
    };
    let decision = reads
        .decide(&admission::Participation {
            zid: zid_typed,
            identity: &entry,
            create_if_missing: true,
            admin_uids: admins,
        })
        .map_err(|_| unavailable())?;
    let top_pid = reads
        .client()
        .query(TOP, &[&zid])?
        .first()
        .map(|row| row.try_get::<_, i32>(0))
        .transpose()?;
    reads.end();
    Ok(Reads {
        zid: Some(zid),
        member_treevite,
        member_row,
        outcome: Some(ReadOutcome::Decided(decision)),
        top_pid,
        reading,
    })
}

/// A participant row counts as created for this request when it is no older
/// than the window before the copy's anchor.
fn inside_window(created: Option<i64>, anchor: i64) -> bool {
    created.is_some_and(|created| created >= anchor.saturating_sub(WINDOW_MS))
}

fn stored_vote(
    tx: &mut postgres::Transaction<'_>,
    zid: i32,
    pid: i32,
    vote: Option<(i32, VoteChoice)>,
    anchor: i64,
) -> Result<Option<NodeVote>> {
    let Some((tid, expected)) = vote else {
        return Ok(None);
    };
    let rows = tx
        .query(VOTE, &[&zid, &pid, &tid, &anchor])?
        .iter()
        .map(|row| row.try_get::<_, Option<i16>>(0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(classify_vote(&rows, expected)))
}

/// `rows` are stored values; each is read through the storage convention and
/// compared as a choice, never as a number.
fn classify_vote(rows: &[Option<i16>], expected: VoteChoice) -> NodeVote {
    let matches = rows
        .iter()
        .filter(|raw| StorageConvention::CURRENT.decode(raw.map(i32::from)) == Some(expected))
        .count();
    if rows.is_empty() {
        NodeVote::Absent
    } else if matches == 0 {
        NodeVote::Different
    } else if matches == rows.len() {
        NodeVote::Same
    } else {
        NodeVote::Ambiguous
    }
}

/// One look at what Node left, in one read-only transaction at one snapshot.
fn look(c: &mut Client, bounds: &Bounds, subject: &Subject, anchor: i64) -> Result<Looked> {
    let mut reads =
        admission::snapshot(c, bounds).map_err(|_| anyhow::anyhow!("identity read failed"))?;
    let looked = look_in(reads.client(), subject, anchor);
    reads.end();
    looked
}

fn look_in(tx: &mut postgres::Transaction<'_>, subject: &Subject, anchor: i64) -> Result<Looked> {
    let zid = subject.zid;
    let mut uid = subject.uid;
    let mut binding = None;
    // Before the statement of this transaction that binds the external id.
    let reading = match subject.xid {
        None => Reading::NotNeeded,
        Some(_) => Reading::taken(tx),
    };
    if !reading.allows() {
        return Ok(Looked {
            reading,
            node: Node::Unavailable,
            node_xid: None,
            node_vote: None,
            timing: None,
        });
    }
    if let Some((owner, xid)) = &subject.xid {
        let rows = tx.query(BINDING, &[owner, &xid.parameter()])?;
        if let Some(row) = rows.first() {
            let bound_uid: i32 = row.try_get(0)?;
            let bound_zid: Option<i32> = row.try_get(1)?;
            let bound_pid: Option<i32> = row.try_get(2)?;
            uid = uid.or(Some(bound_uid));
            binding = Some((bound_zid, bound_pid));
        } else if uid.is_none() {
            // Named, and bound to nobody: Node created no participant by it.
            return Ok(Looked {
                reading,
                node: Node::None,
                node_xid: Some(NodeXid::Unbound),
                node_vote: None,
                timing: None,
            });
        }
    }
    if let Some(uid) = uid {
        let rows = tx.query(PARTICIPANT, &[&zid, &uid])?;
        let row = match rows.first() {
            None => None,
            Some(row) => Some((row.try_get::<_, i32>(0)?, row.try_get::<_, Option<i64>>(1)?)),
        };
        let node = match row {
            None => Node::None,
            Some((_, created)) if inside_window(created, anchor) => Node::Created,
            Some(_) => Node::Found,
        };
        let node_xid = subject.xid.as_ref().map(|_| match (binding, row) {
            (None, _) => NodeXid::Unbound,
            (Some((_, None)), _) => NodeXid::BoundNoNumber,
            (Some((bound_zid, Some(bound_pid))), Some((pid, _)))
                if bound_zid == Some(zid) && bound_pid == pid =>
            {
                NodeXid::BoundHere
            }
            (Some(_), _) => NodeXid::BoundElsewhere,
        });
        // Node stores a vote under the token's number without reading the
        // row; otherwise under the row's.
        let node_vote = match subject.token_pid.or(row.map(|(pid, _)| pid)) {
            Some(pid) => stored_vote(tx, zid, pid, subject.vote, anchor)?,
            None => None,
        };
        let timing = (node == Node::Created).then_some(if subject.saw_member {
            Timing::AfterNode
        } else {
            Timing::BeforeNode
        });
        return Ok(Looked {
            reading,
            node,
            node_xid,
            node_vote,
            timing,
        });
    }
    // No identity to find a row by: the conversation's newest participants,
    // by number, and among those created inside the window the ones with a
    // vote on the copy's statement.
    let rows = tx.query(NEWEST_PARTICIPANTS, &[&zid, &NEWEST])?;
    let mut recent = Vec::new();
    for row in &rows {
        let pid: i32 = row.try_get(0)?;
        let created: Option<i64> = row.try_get(1)?;
        if inside_window(created, anchor) {
            recent.push(pid);
        }
    }
    // Every row a look reads is new: older new rows may lie beyond it.
    let saturated = recent.len() as i64 >= NEWEST;
    let mut matched = Vec::new();
    for pid in recent {
        if let Some(vote) = stored_vote(tx, zid, pid, subject.vote, anchor)?
            && vote != NodeVote::Absent
        {
            matched.push((pid, vote));
        }
    }
    Ok(match matched.as_slice() {
        [(pid, vote)] if !saturated => Looked {
            reading: Reading::NotNeeded,
            node: Node::Created,
            node_xid: None,
            node_vote: Some(*vote),
            timing: Some(if subject.top_pid.is_some_and(|top| *pid <= top) {
                Timing::AfterNode
            } else {
                Timing::BeforeNode
            }),
        },
        [] if !saturated => Looked {
            reading: Reading::NotNeeded,
            node: Node::None,
            node_xid: None,
            node_vote: None,
            timing: None,
        },
        _ => Looked {
            reading: Reading::NotNeeded,
            node: Node::Ambiguous,
            node_xid: None,
            node_vote: None,
            timing: None,
        },
    })
}

#[cfg(test)]
#[path = "post_votes_identity_tests.rs"]
pub(crate) mod tests;
