//! The comment route's queries. Node writes no line of its own for a comment:
//! its side is its access line (`http_request`: status, duration, request id)
//! and nginx's two lines. The shadow's line carries no comment, participant
//! or user number and no text; nginx's request id is the only thing that
//! joins it to Node's. So every comparison with Node is made inside one
//! query, request by request, and what leaves AWS is counts of requests in
//! each class. An admitted copy's line names its conversation by number
//! (`zid`), as a vote's does; the one thing read from it is how many
//! conversations the admitted copies are in, a count and never a number.
use crate::query::*;
use crate::route::{JOIN_PAD_S, Route};

/// A would-be duplicate beside Node's 200 is not judged when the copy's
/// observation started this long after the copy arrived (`queue_ms`), in
/// milliseconds. The shadow calls a row Node's own for this request when it
/// is this participant's and no older than five seconds at the moment the
/// observation starts; an observation that starts late finds Node's own row
/// older than that and calls it someone else's. That takes an observation
/// starting more than five seconds after Node stored the row, so this bound
/// errs toward "not known": a would-be duplicate on a copy observed between
/// two and five seconds late is a disagreement filed as not known.
pub const LATE_COPY_MS: i64 = 2_000;

/// The line's `outcome` words (docs/post-comments-rust-handler.md, "Observe
/// mode"). The first five are observed copies; the last two were not
/// observed.
pub const OUTCOMES: [&str; 7] = [
    "would_serve",
    "would_answer",
    "would_hand_back",
    "would_fail",
    "unknown",
    "shed",
    "not_observed",
];
pub const OBSERVED: [&str; 5] = [
    "would_serve",
    "would_answer",
    "would_hand_back",
    "would_fail",
    "unknown",
];
pub const TEXT_ROW: [&str; 4] = ["none", "own", "other", "unknown"];
pub const NODE_COMMENT: [&str; 6] = [
    "own",
    "other",
    "absent",
    "unknown",
    "unavailable",
    "not_checked",
];
/// `node_comment` values that say the stored comment was not read: never an
/// agreement and never a disagreement.
pub const NOT_READ: [&str; 3] = ["unknown", "unavailable", "not_checked"];
pub const NODE_TXT: [&str; 2] = ["same", "different"];
pub const NODE_TXT_DIFFERENCE: [&str; 5] = ["space", "control", "case", "truncated", "other"];
pub const NODE_AUTHOR: [&str; 2] = ["same", "different"];
pub const NODE_ROW: [&str; 7] = [
    "as_expected",
    "mod",
    "active",
    "is_seed",
    "velocity",
    "anon",
    "moderated",
];
/// `node_row` values that name a column stored otherwise than the handler
/// would store it. Not `moderated`: a moderator changed the row after Node's
/// insert and before the read-back, so what the insert stored is not known;
/// never an agreement and never a disagreement.
pub const ROW_DIFFERS: [&str; 5] = ["mod", "active", "is_seed", "velocity", "anon"];
pub const NODE_LANG: [&str; 2] = ["unset", "set"];
pub const NODE_VOTE: [&str; 7] = [
    "same",
    "different",
    "ambiguous",
    "absent",
    "not_sent",
    "unavailable",
    "not_checked",
];
/// `node_vote` values that say the author's vote could not be compared.
pub const VOTE_NOT_COMPARED: [&str; 3] = ["ambiguous", "unavailable", "not_checked"];
pub const BODY_CLASS: [&str; 4] = ["le_1k", "le_4k", "le_10k", "over_10k"];
/// Every `reason` word the line can carry. A report prints a reason only when
/// it is one of these.
pub const REASONS: [&str; 42] = [
    "rate_cap",
    "lane_full",
    "unconfigured",
    "revoked",
    "not_production",
    "not_https",
    "body_unmodelled",
    "parameter",
    "shape_method",
    "shape_query",
    "shape_size",
    "shape_encoding",
    "shape_content_type",
    "shape_json",
    "shape_keys",
    "shape_conversation_id",
    "xid_key",
    "xid_profile_key",
    "txt_invalid",
    "vote_invalid",
    "is_seed_invalid",
    "txt_empty",
    "txt_nul",
    "is_seed",
    "no_token",
    "token_oidc",
    "token_xid",
    "token_other_conversation",
    "token_refused",
    "admin",
    "unknown_conversation",
    "treevite",
    "not_a_participant",
    "moderator",
    "xid_required",
    "xid_allowlist",
    "admission_unavailable",
    "admission_timeout",
    "strict_moderation",
    "duplicate",
    "closed",
    "no_anchor",
];
/// What the line says Node does after it stores the comment (`after_insert`,
/// on a `would_serve` line only): the notification task, or, in a
/// conversation with strict moderation, the moderators' email.
pub const AFTER_INSERT: [&str; 2] = ["notification_task", "moderator_email"];
/// A comment in a conversation with strict moderation, observed as the write
/// Node makes: `would_serve` with this word. The live handler hands such a
/// comment back to Node; the shadow compares it as any other.
pub const MODERATOR_EMAIL: &str = "moderator_email";
/// The reason of the one hand-back whose comment is modelled and read back.
/// Lines printed by an observer before strict comments were compared as
/// writes carry it; a line printed since carries `MODERATOR_EMAIL` instead.
pub const STRICT: &str = "strict_moderation";

impl Route {
    pub(crate) fn comment_queries(&self) -> Vec<Query> {
        vec![
            self.comment_lines(),
            self.mirror_query(),
            self.mirror_hours(),
            self.edge_query(),
            self.edge_bins(),
            self.comment_observations(),
            self.comment_conversations(),
            self.comment_facts(),
            self.comment_readback(),
            self.comment_latency(),
            self.comment_join(),
            self.node_requests("node_requests", Key::Day),
        ]
    }

    fn comment_lines(&self) -> Query {
        Self::one(
            "lines",
            "Lines of each kind: coverage at a glance.",
            or(vec![
                self.edge(),
                self.mirror(),
                self.observation(),
                self.http(),
            ]),
            Stats {
                aggs: vec![("lines", Agg::Count)],
                by: vec![Key::Field("message")],
            },
        )
    }

    fn comment_observations(&self) -> Query {
        Self::one(
            "observations",
            "The shadow's outcomes, would-be statuses and reasons, whether the conversation has strict moderation, and what Node does after it stores the comment.",
            self.observation(),
            Stats {
                aggs: vec![("n", Agg::Count)],
                by: vec![
                    Key::Field("outcome"),
                    Key::Field("admitted"),
                    Key::Field("status"),
                    Key::Field("reason"),
                    Key::Field("strict"),
                    Key::Field("after_insert"),
                ],
            },
        )
    }

    /// How many conversations the admitted copies are in. The number of a
    /// conversation never leaves AWS: only how many distinct ones there are,
    /// and how many admitted lines carry one at all (a line written before
    /// the observer printed the number carries none).
    fn comment_conversations(&self) -> Query {
        Self::one(
            "conversations",
            "Admitted observations, how many name their conversation, and how many conversations those span (counts, never an id).",
            and(vec![self.observation(), num_is("admitted", 1)]),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("named", Agg::Sum(E::Present("zid"))),
                    ("conversations", Agg::CountDistinct("zid")),
                ],
                by: vec![],
            },
        )
    }

    fn comment_facts(&self) -> Query {
        Self::one(
            "facts",
            "What a copy says of itself: whether it carries a vote or a seed flag, and its size class.",
            self.observation(),
            Stats {
                aggs: vec![("n", Agg::Count)],
                by: vec![
                    Key::Field("vote_present"),
                    Key::Field("seed_present"),
                    Key::Field("body_class"),
                ],
            },
        )
    }

    fn comment_readback(&self) -> Query {
        Self::one(
            "readback",
            "What the shadow read in the database for admitted copies, as classes.",
            and(vec![self.observation(), num_is("admitted", 1)]),
            Stats {
                aggs: vec![("n", Agg::Count)],
                by: vec![
                    Key::Field("text_row"),
                    Key::Field("node_comment"),
                    Key::Field("node_txt"),
                    Key::Field("node_txt_difference"),
                    Key::Field("node_author"),
                    Key::Field("node_row"),
                    Key::Field("node_lang"),
                    Key::Field("node_vote"),
                ],
            },
        )
    }

    fn comment_latency(&self) -> Query {
        Self::one(
            "latency",
            "The shadow's latency on admitted copies (the write is not modelled).",
            and(vec![self.observation(), num_is("admitted", 1)]),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("queue_p99", Agg::Pct("queue_ms", 99)),
                    ("queue_max", Agg::Max("queue_ms")),
                    ("admission_p50", Agg::Pct("admission_ms", 50)),
                    ("admission_p99", Agg::Pct("admission_ms", 99)),
                    ("admission_max", Agg::Max("admission_ms")),
                    ("total_p50", Agg::Pct("total_ms", 50)),
                    ("total_p99", Agg::Pct("total_ms", 99)),
                    ("total_max", Agg::Max("total_ms")),
                    ("readback_p99", Agg::Pct("readback_s", 99)),
                ],
                by: vec![],
            },
        )
    }

    /// The join. The first stage gathers each request id's lines (nginx's
    /// two, Node's access line, the shadow's observation) into one row and
    /// classes the observation; it never leaves AWS. The second stage counts
    /// requests in each class, grouped only by three statuses: nginx's,
    /// Node's and the shadow's would-be one. A request is paired when it has
    /// exactly one nginx line inside the window, one Node access line and one
    /// observation; only paired requests are ever judged.
    fn comment_join(&self) -> Query {
        let message = |m: &'static str| is("message", m);
        let class = |field: &'static str, word: &'static str| Agg::Sum(is(field, word));
        let first = Stats {
            aggs: vec![
                ("n_edge", Agg::Sum(message("shadow_edge"))),
                (
                    "n_edge_in",
                    Agg::Sum(and(vec![
                        message("shadow_edge"),
                        ge(f("t"), E::Param(Param::FromMs)),
                        lt(f("t"), E::Param(Param::ToMs)),
                    ])),
                ),
                ("n_mirror", Agg::Sum(message("shadow_mirror"))),
                (
                    "n_copied",
                    Agg::Sum(and(vec![
                        message("shadow_mirror"),
                        E::HasDigit("mirror_upstream_status"),
                    ])),
                ),
                (
                    "n_answered",
                    Agg::Sum(and(vec![
                        message("shadow_mirror"),
                        is("mirror_upstream_status", "204"),
                    ])),
                ),
                (
                    "n_mirror_204",
                    Agg::Sum(and(vec![
                        message("shadow_mirror"),
                        num_is("mirror_status", 204),
                    ])),
                ),
                ("n_http", Agg::Sum(E::In("message", ACCESS_LINE.to_vec()))),
                ("n_obs", Agg::Sum(message("shadow_observation"))),
                ("t0", Agg::Min("t")),
                ("edge_st", Agg::Max("edge_status")),
                ("http_st", Agg::Max("http.status_code")),
                ("rust_st", Agg::Max("status")),
                ("o_serve", class("outcome", "would_serve")),
                // Of those, the comments in conversations with strict
                // moderation: Node stores them and emails the moderators,
                // and the live handler hands them back.
                (
                    "o_strict",
                    Agg::Sum(and(vec![
                        is("outcome", "would_serve"),
                        is("after_insert", MODERATOR_EMAIL),
                    ])),
                ),
                ("o_answer", class("outcome", "would_answer")),
                ("o_hand", class("outcome", "would_hand_back")),
                ("o_fail", class("outcome", "would_fail")),
                ("o_unknown", class("outcome", "unknown")),
                (
                    "o_out",
                    Agg::Sum(E::In("outcome", vec!["shed", "not_observed"])),
                ),
                // The copies whose comment is modelled and read back: the
                // ones the handler would store, and the ones it would hand
                // back only because the conversation has strict moderation.
                (
                    "rb",
                    Agg::Sum(and(vec![
                        num_is("admitted", 1),
                        or(vec![is("outcome", "would_serve"), is("reason", STRICT)]),
                    ])),
                ),
                ("tr_own", class("text_row", "own")),
                // A row with the copy's text that is this participant's and
                // no older than the window, at admission or at the read-back:
                // beside Node's 409 it is an earlier request's row (the same
                // text sent twice), whichever of the two looks found it.
                (
                    "own_any",
                    Agg::Sum(or(vec![is("text_row", "own"), is("node_comment", "own")])),
                ),
                (
                    "late",
                    Agg::Sum(and(vec![
                        is("text_row", "other"),
                        gt(f("queue_ms"), n(LATE_COPY_MS)),
                    ])),
                ),
                ("b_own", class("node_comment", "own")),
                ("b_absent", class("node_comment", "absent")),
                ("b_other", class("node_comment", "other")),
                (
                    "b_unread",
                    Agg::Sum(E::In("node_comment", NOT_READ.to_vec())),
                ),
                // Node's own row, stored as the handler would store it.
                (
                    "b_clean",
                    Agg::Sum(and(vec![
                        is("node_comment", "own"),
                        is("node_txt", "same"),
                        is("node_author", "same"),
                        is("node_row", "as_expected"),
                        is("node_lang", "unset"),
                        E::In("node_vote", vec!["same", "not_sent"]),
                    ])),
                ),
                // A definite difference from what the handler would store.
                (
                    "b_diff",
                    Agg::Sum(or(vec![
                        E::In("node_comment", vec!["absent", "other"]),
                        is("node_txt", "different"),
                        is("node_author", "different"),
                        E::In("node_row", ROW_DIFFERS.to_vec()),
                        is("node_lang", "set"),
                        E::In("node_vote", vec!["different", "absent"]),
                    ])),
                ),
                ("x_diff", class("node_txt", "different")),
                ("a_diff", class("node_author", "different")),
                ("w_diff", Agg::Sum(E::In("node_row", ROW_DIFFERS.to_vec()))),
                ("l_set", class("node_lang", "set")),
                ("v_same", class("node_vote", "same")),
                ("v_diff", class("node_vote", "different")),
                ("v_absent", class("node_vote", "absent")),
                (
                    "v_unk",
                    Agg::Sum(and(vec![
                        is("node_comment", "own"),
                        E::In("node_vote", VOTE_NOT_COMPARED.to_vec()),
                    ])),
                ),
            ],
            by: vec![Key::Field("request_id")],
        };
        let one = |name: &'static str| num_is(name, 1);
        // A shadowed comment: exactly one nginx line, inside the window.
        let request = || vec![one("n_edge"), one("n_edge_in")];
        // A shadowed comment with its Node access line and its observation.
        let pair = || {
            let mut base = request();
            base.extend([one("n_http"), one("n_obs")]);
            base
        };
        let with = |mut base: Vec<E>, more: Vec<E>| {
            base.extend(more);
            Agg::Sum(and(base))
        };
        let begins_here = || {
            vec![
                ge(f("t0"), E::Param(Param::FromMs)),
                lt(f("t0"), E::Param(Param::ToMs)),
            ]
        };
        let paired =
            |names: &[&'static str]| with(pair(), names.iter().map(|name| one(name)).collect());
        let second = Stats {
            aggs: vec![
                ("ids", Agg::Count),
                // Every nginx line inside the window, whatever its id: equal
                // to the one-stage count when both stages ran as written.
                ("edge_lines", Agg::Total("n_edge_in")),
                ("comments", Agg::Sum(and(request()))),
                (
                    "repeated",
                    with(
                        begins_here(),
                        vec![or(vec![
                            gt(f("n_edge"), n(1)),
                            gt(f("n_mirror"), n(1)),
                            gt(f("n_http"), n(1)),
                            gt(f("n_obs"), n(1)),
                        ])],
                    ),
                ),
                (
                    "without_edge",
                    with(begins_here(), vec![num_is("n_edge", 0)]),
                ),
                ("no_mirror", with(request(), vec![num_is("n_mirror", 0)])),
                (
                    "not_copied",
                    with(
                        request(),
                        vec![one("n_mirror"), num_is("n_copied", 0), one("n_mirror_204")],
                    ),
                ),
                (
                    "host_absent",
                    with(
                        request(),
                        vec![
                            one("n_mirror"),
                            num_is("n_copied", 0),
                            num_is("n_mirror_204", 0),
                        ],
                    ),
                ),
                (
                    "copied",
                    with(request(), vec![one("n_mirror"), one("n_copied")]),
                ),
                (
                    "answered",
                    with(request(), vec![one("n_mirror"), one("n_answered")]),
                ),
                (
                    "covered",
                    with(
                        request(),
                        vec![one("n_mirror"), one("n_copied"), one("n_obs")],
                    ),
                ),
                ("node_lines", with(request(), vec![one("n_http")])),
                // An observation whose request has no Node access line, and
                // a Node access line whose request has no observation.
                (
                    "no_node",
                    with(request(), vec![one("n_obs"), num_is("n_http", 0)]),
                ),
                (
                    "no_obs",
                    with(request(), vec![one("n_http"), num_is("n_obs", 0)]),
                ),
                // An observation with no Node access line, by what the
                // handler would do: Node's status is not in hand for these,
                // but nginx's is (the group key), and the report says when
                // the two cannot both be right.
                (
                    "no_node_serve",
                    with(
                        request(),
                        vec![one("n_obs"), num_is("n_http", 0), one("o_serve")],
                    ),
                ),
                (
                    "no_node_answer",
                    with(
                        request(),
                        vec![one("n_obs"), num_is("n_http", 0), one("o_answer")],
                    ),
                ),
                (
                    "no_obs_copied",
                    with(
                        request(),
                        vec![
                            one("n_http"),
                            num_is("n_obs", 0),
                            one("n_mirror"),
                            one("n_copied"),
                        ],
                    ),
                ),
                ("paired", Agg::Sum(and(pair()))),
                (
                    "http_edge_mismatch",
                    with(
                        request(),
                        vec![one("n_http"), ne(f("http_st"), f("edge_st"))],
                    ),
                ),
                ("serve", paired(&["o_serve"])),
                ("serve_clean", paired(&["o_serve", "b_clean"])),
                ("serve_diff", paired(&["o_serve", "b_diff"])),
                ("serve_own", paired(&["o_serve", "b_own"])),
                ("serve_any_own", paired(&["o_serve", "own_any"])),
                // The same five, for the strict ones among them.
                ("strict", paired(&["o_strict"])),
                ("strict_clean", paired(&["o_strict", "b_clean"])),
                ("strict_diff", paired(&["o_strict", "b_diff"])),
                ("strict_own", paired(&["o_strict", "b_own"])),
                ("strict_any_own", paired(&["o_strict", "own_any"])),
                ("answer", paired(&["o_answer"])),
                ("answer_late", paired(&["o_answer", "late"])),
                ("answer_tr_own", paired(&["o_answer", "tr_own"])),
                ("hand", paired(&["o_hand"])),
                ("unknown", paired(&["o_unknown"])),
                ("unobserved", paired(&["o_out"])),
                ("failed", paired(&["o_fail"])),
                ("read", paired(&["rb"])),
                ("read_clean", paired(&["rb", "b_clean"])),
                ("read_diff", paired(&["rb", "b_diff"])),
                ("read_own", paired(&["rb", "b_own"])),
                ("read_absent", paired(&["rb", "b_absent"])),
                ("read_other", paired(&["rb", "b_other"])),
                ("read_unread", paired(&["rb", "b_unread"])),
                ("read_x_diff", paired(&["rb", "x_diff"])),
                ("read_a_diff", paired(&["rb", "a_diff"])),
                ("read_w_diff", paired(&["rb", "w_diff"])),
                ("read_l_set", paired(&["rb", "l_set"])),
                ("read_v_same", paired(&["rb", "v_same"])),
                ("read_v_diff", paired(&["rb", "v_diff"])),
                ("read_v_absent", paired(&["rb", "v_absent"])),
                ("read_v_unk", paired(&["rb", "v_unk"])),
            ],
            by: vec![
                Key::Field("edge_st"),
                Key::Field("http_st"),
                Key::Field("rust_st"),
            ],
        };
        Query {
            name: "join",
            about: "Each request's lines joined on the request id (first stage, stays in AWS), then counted by class.",
            // A line without a request id joins nothing; it is counted by the
            // one-stage queries instead.
            filter: and(vec![
                E::Present("request_id"),
                or(vec![
                    self.edge(),
                    self.mirror(),
                    self.observation(),
                    self.http(),
                ]),
            ]),
            fields: vec![("t", E::TimestampMs)],
            stages: vec![first, second],
            pad_s: JOIN_PAD_S,
            previous_week: false,
            recent: false,
            chunk_s: 0,
            sliced: true,
        }
    }
}
