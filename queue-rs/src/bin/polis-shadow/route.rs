//! The shadowed routes and the queries compiled for each. A route entry names
//! what its lines are called and which comparison it gets; every filter is
//! built from those names, so each route's queries name their own path and
//! their own shadow, and no query of one route can read a line of another.
use crate::query::*;

/// What Node writes for a route, which decides the comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Node's handler writes a line for each reply it gave (`node_line`),
    /// beside its access line.
    Votes { node_line: &'static str },
    /// Node writes no line of its own for the route: its access line is its
    /// whole side (`route_comments.rs`).
    Comments,
}

/// One shadowed route.
#[derive(Clone, Copy, Debug)]
pub struct Route {
    /// The `--route` value.
    pub key: &'static str,
    /// The selector name nginx and the shadow service put on their lines.
    pub shadow: &'static str,
    /// The `route` field of nginx's `shadow_edge` line and Node's reply line.
    pub route: &'static str,
    /// The HTTP method, as Node's `http_request` line has it.
    pub method: &'static str,
    /// The Express route path on Node's access line (`http.route`).
    pub path: &'static str,
    pub kind: Kind,
}

pub const VOTES: Route = Route {
    key: "votes",
    shadow: "votesShadow",
    route: "POST /api/v3/votes",
    method: "POST",
    path: "/api/v3/votes",
    kind: Kind::Votes {
        node_line: "vote_reply",
    },
};

pub const COMMENTS: Route = Route {
    key: "comments",
    shadow: "commentsShadow",
    route: "POST /api/v3/comments",
    method: "POST",
    path: "/api/v3/comments",
    kind: Kind::Comments,
};

pub const ROUTES: &[Route] = &[VOTES, COMMENTS];

pub fn find(key: &str) -> Option<Route> {
    ROUTES.iter().copied().find(|route| route.key == key)
}

/// The most rows Logs Insights returns for one query.
pub const ROW_LIMIT: usize = 10_000;

/// The most requests one join query is given (`slices.rs`). A join's first
/// stage has one row for each request id in its time range: these requests,
/// those of the 60 s it reads on each side, and ids that have no nginx line.
/// 4,000 leaves 6,000 of the 10,000 for the two margins, which is 50 requests
/// a second there; the busiest half hour on record had under four a second.
pub const SLICE_MAX_REQUESTS: u64 = 4_000;

/// The width of the bins the request counts are taken in, in seconds
/// (`Key::FiveMinutes`). A slice is a run of whole bins.
pub const BIN_S: i64 = 300;

/// The stop rule is read over at most this much of the end of a window: the
/// vote route's whole window, and the last eight days of a longer comments
/// window. The rule is about what the copy is doing to production while it
/// runs. Over months it would report any slow three hours there ever were,
/// and five-minute database CPU is not kept that long.
pub const STOP_SPAN_S: i64 = 8 * 86_400;

/// The part of a window the stop rule is read over.
pub fn stop_span(window: crate::aws::Window) -> crate::aws::Window {
    crate::aws::Window {
        from_s: window.from_s.max(window.to_s - STOP_SPAN_S),
        to_s: window.to_s,
    }
}

/// The most of a window the request counts are asked for at once: thirty
/// days, which is 8,640 five-minute bins, under the 10,000 rows returned.
pub const BINS_CHUNK_S: i64 = 30 * 86_400;

/// How far a join reads beyond its time range on each side, in seconds: a
/// request's lines are written up to the shadow's second read-back (10 s)
/// apart.
pub const JOIN_PAD_S: i64 = 60;

/// The shadow's `outcome` values for an observed copy.
const WOULD: [&str; 3] = ["would_serve", "would_hand_back", "would_fail"];

pub(crate) fn shadow_line(message: &'static str) -> E {
    and(vec![is("listener", "shadow"), is("message", message)])
}

impl Route {
    /// nginx's line for each shadowed request (Node's status as nginx saw it).
    pub(crate) fn edge(&self) -> E {
        and(vec![shadow_line("shadow_edge"), is("route", self.route)])
    }
    /// nginx's line for each copy sent to the shadow.
    pub(crate) fn mirror(&self) -> E {
        and(vec![
            shadow_line("shadow_mirror"),
            is("shadow", self.shadow),
        ])
    }
    /// Node's line for each reply its handler gave.
    fn node(&self, node_line: &'static str) -> E {
        and(vec![shadow_line(node_line), is("route", self.route)])
    }
    /// The shadow's line for each copy.
    pub(crate) fn observation(&self) -> E {
        and(vec![
            shadow_line("shadow_observation"),
            is("shadow", self.shadow),
        ])
    }
    /// Node's access line for this route's requests that carry nginx's
    /// request id (a refusal by the route's own middleware included). The
    /// path is named: nginx puts its request id on every route it copies, so
    /// without it another copied route's requests would be read as this
    /// route's. A request Node refuses before its router has matched a route
    /// has an access line with no `http.route`, and is not read.
    pub(crate) fn http(&self) -> E {
        and(vec![
            E::In("message", ACCESS_LINE.to_vec()),
            is("service", "server"),
            E::Present("request_id"),
            is("http.method", self.method),
            is("http.route", self.path),
        ])
    }

    /// The queries `run` issues, in order. None reads a statement number:
    /// neither the shadow's line nor Node's carries one, and the one Node's
    /// older lines name (`node_next_tid`) is never read.
    pub fn queries(&self) -> Vec<Query> {
        match self.kind {
            Kind::Votes { node_line } => vec![
                self.lines(node_line),
                self.mirror_query(),
                self.mirror_hours(),
                self.edge_query(),
                self.edge_bins(),
                self.observations(),
                self.conversations(),
                self.latency(),
                self.join(node_line),
                self.node_requests("node_votes", Key::Hour),
            ],
            Kind::Comments => self.comment_queries(),
        }
    }

    pub(crate) fn one(name: &'static str, about: &'static str, filter: E, stats: Stats) -> Query {
        Query {
            name,
            about,
            filter,
            fields: vec![],
            stages: vec![stats],
            pad_s: 0,
            previous_week: false,
            recent: false,
            chunk_s: 0,
            sliced: false,
        }
    }

    fn lines(&self, node_line: &'static str) -> Query {
        Self::one(
            "lines",
            "Lines of each kind: coverage at a glance.",
            or(vec![
                self.edge(),
                self.mirror(),
                self.node(node_line),
                self.observation(),
                self.http(),
            ]),
            Stats {
                aggs: vec![("lines", Agg::Count)],
                by: vec![Key::Field("message")],
            },
        )
    }

    pub(crate) fn mirror_query(&self) -> Query {
        Self::one(
            "mirror",
            "The copy's cost and what became of each copy (an empty upstream status: not copied).",
            self.mirror(),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("p50_s", Agg::Pct("mirror_s", 50)),
                    ("p99_s", Agg::Pct("mirror_s", 99)),
                    ("max_s", Agg::Max("mirror_s")),
                ],
                by: vec![
                    Key::Field("mirror_status"),
                    Key::Field("mirror_upstream_status"),
                ],
            },
        )
    }

    pub(crate) fn mirror_hours(&self) -> Query {
        Self::one(
            "mirror_hours",
            "The copy's hold by hour (stop rule 2).",
            self.mirror(),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("p99_s", Agg::Pct("mirror_s", 99)),
                    ("max_s", Agg::Max("mirror_s")),
                ],
                by: vec![Key::Hour],
            },
        )
    }

    /// How many requests nginx logged in each five minutes: what a run plans
    /// the join's slices from, and what each slice's total is checked
    /// against. It counts a line by the same test of its time as the join
    /// does (from the window's start, up to and not at its end), so the two
    /// agree to the line. A window of more than thirty days has more bins
    /// than Logs Insights returns rows, so it is read thirty days at a time.
    pub(crate) fn edge_bins(&self) -> Query {
        Query {
            fields: vec![("t", E::TimestampMs)],
            chunk_s: BINS_CHUNK_S,
            ..Self::one(
                "edge_bins",
                "Shadowed requests in each five minutes (the join is run in slices of these).",
                self.edge(),
                Stats {
                    aggs: vec![(
                        "n",
                        Agg::Sum(and(vec![
                            ge(f("t"), E::Param(Param::FromMs)),
                            lt(f("t"), E::Param(Param::ToMs)),
                        ])),
                    )],
                    by: vec![Key::FiveMinutes],
                },
            )
        }
    }

    pub(crate) fn edge_query(&self) -> Query {
        Self::one(
            "edge",
            "Node's status and time for shadowed requests, as nginx saw them.",
            self.edge(),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("node_p50_s", Agg::Pct("edge_upstream_s", 50)),
                    ("node_p99_s", Agg::Pct("edge_upstream_s", 99)),
                    ("node_max_s", Agg::Max("edge_upstream_s")),
                    ("request_p99_s", Agg::Pct("edge_request_s", 99)),
                ],
                by: vec![Key::Field("edge_status")],
            },
        )
    }

    fn observations(&self) -> Query {
        Self::one(
            "observations",
            "The shadow's outcomes, reasons, would-be statuses, readback and membership classes.",
            self.observation(),
            Stats {
                aggs: vec![("n", Agg::Count)],
                by: vec![
                    Key::Field("outcome"),
                    Key::Field("admitted"),
                    Key::Field("status"),
                    Key::Field("reason"),
                    Key::Field("follow_on"),
                    Key::Field("node_vote"),
                    Key::Field("prev"),
                ],
            },
        )
    }

    fn conversations(&self) -> Query {
        Self::one(
            "conversations",
            "Admitted observations and how many conversations they span (a count, never an id).",
            and(vec![self.observation(), num_is("admitted", 1)]),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("conversations", Agg::CountDistinct("zid")),
                ],
                by: vec![],
            },
        )
    }

    fn latency(&self) -> Query {
        Self::one(
            "latency",
            "The shadow's latency on admitted copies, append excluded (it is not modelled).",
            and(vec![self.observation(), num_is("admitted", 1)]),
            Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("queue_p99", Agg::Pct("queue_ms", 99)),
                    ("admission_p50", Agg::Pct("admission_ms", 50)),
                    ("admission_p99", Agg::Pct("admission_ms", 99)),
                    ("admission_max", Agg::Max("admission_ms")),
                    ("selection_p50", Agg::Pct("selection_ms", 50)),
                    ("selection_p99", Agg::Pct("selection_ms", 99)),
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
    /// two, Node's reply and access lines, the shadow's observation) into one
    /// row of counts and values; it never leaves AWS. The second stage counts
    /// requests in each class, grouped only by Node's status as nginx saw it
    /// and the shadow's would-be status.
    fn join(&self, node_line: &'static str) -> Query {
        let message = |m: &'static str| is("message", m);
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
                ("n_reply", Agg::Sum(message(node_line))),
                ("n_http", Agg::Sum(E::In("message", ACCESS_LINE.to_vec()))),
                ("n_obs", Agg::Sum(message("shadow_observation"))),
                ("n_would", Agg::Sum(E::In("outcome", WOULD.to_vec()))),
                ("n_shed", Agg::Sum(is("outcome", "shed"))),
                ("n_unobserved", Agg::Sum(is("outcome", "not_observed"))),
                ("n_cors", Agg::Sum(is("reason", "cors"))),
                ("edge_st", Agg::Max("edge_status")),
                ("node_st", Agg::Max("node_status")),
                ("http_st", Agg::Max("http.status_code")),
                ("rust_st", Agg::Max("status")),
                ("adm", Agg::Max("admitted")),
                ("v_same", Agg::Sum(is("node_vote", "same"))),
                ("v_ambiguous", Agg::Sum(is("node_vote", "ambiguous"))),
                ("v_different", Agg::Sum(is("node_vote", "different"))),
                ("v_absent", Agg::Sum(is("node_vote", "absent"))),
                ("v_unavailable", Agg::Sum(is("node_vote", "unavailable"))),
                ("f_complete", Agg::Sum(is("follow_on", "complete"))),
                ("f_absent", Agg::Sum(is("follow_on", "absent"))),
                ("f_degraded", Agg::Sum(is("follow_on", "degraded"))),
                ("x_statement", Agg::Sum(is("node_next", "statement"))),
                ("x_topical", Agg::Sum(is("node_next", "topical"))),
                ("x_none", Agg::Sum(is("node_next", "none"))),
                ("nr", Agg::Max("node_remaining")),
                ("nt", Agg::Max("node_total")),
                ("rr", Agg::Max("remaining")),
                ("rt", Agg::Max("total")),
                // The id's earliest line. An id that is not a shadowed vote
                // of the window (a repeated one, one with no nginx line) is
                // counted where this falls, so that the slices of a window
                // each count it once or not at all.
                ("t0", Agg::Min("t")),
            ],
            by: vec![Key::Field("request_id")],
        };
        let one = |name: &'static str| num_is(name, 1);
        let begins_here = || {
            vec![
                ge(f("t0"), E::Param(Param::FromMs)),
                lt(f("t0"), E::Param(Param::ToMs)),
            ]
        };
        // A shadowed vote: exactly one nginx line, inside the window.
        let vote = || vec![one("n_edge"), one("n_edge_in")];
        let with = |mut base: Vec<E>, more: Vec<E>| {
            base.extend(more);
            and(base)
        };
        // An admitted observation of a shadowed vote.
        let admitted = || {
            let mut base = vote();
            base.extend([one("n_obs"), one("n_would"), one("adm")]);
            base
        };
        let second = Stats {
            aggs: vec![
                ("ids", Agg::Count),
                // Every nginx line inside the window, whatever its id: equal
                // to the one-stage count when both stages ran as written.
                ("edge_lines", Agg::Total("n_edge_in")),
                ("votes", Agg::Sum(and(vote()))),
                (
                    "repeated",
                    Agg::Sum(with(
                        begins_here(),
                        vec![or(vec![
                            gt(f("n_edge"), n(1)),
                            gt(f("n_mirror"), n(1)),
                            gt(f("n_reply"), n(1)),
                            gt(f("n_http"), n(1)),
                            gt(f("n_obs"), n(1)),
                        ])],
                    )),
                ),
                (
                    "without_edge",
                    Agg::Sum(with(begins_here(), vec![num_is("n_edge", 0)])),
                ),
                (
                    "no_mirror",
                    Agg::Sum(with(vote(), vec![num_is("n_mirror", 0)])),
                ),
                (
                    "not_copied",
                    Agg::Sum(with(
                        vote(),
                        vec![one("n_mirror"), num_is("n_copied", 0), one("n_mirror_204")],
                    )),
                ),
                // nginx answered the copy itself (the shadow's host absent, a
                // shadow that is down): copied as far as coverage goes.
                (
                    "host_absent",
                    Agg::Sum(with(
                        vote(),
                        vec![
                            one("n_mirror"),
                            num_is("n_copied", 0),
                            num_is("n_mirror_204", 0),
                        ],
                    )),
                ),
                (
                    "copied",
                    Agg::Sum(with(vote(), vec![one("n_mirror"), one("n_copied")])),
                ),
                (
                    "answered",
                    Agg::Sum(with(vote(), vec![one("n_mirror"), one("n_answered")])),
                ),
                (
                    "covered",
                    Agg::Sum(with(
                        vote(),
                        vec![one("n_mirror"), one("n_copied"), one("n_obs")],
                    )),
                ),
                (
                    "observed",
                    Agg::Sum(with(vote(), vec![one("n_obs"), one("n_would")])),
                ),
                (
                    "shed",
                    Agg::Sum(with(vote(), vec![one("n_obs"), one("n_shed")])),
                ),
                (
                    "not_observed",
                    Agg::Sum(with(vote(), vec![one("n_obs"), one("n_unobserved")])),
                ),
                ("admitted_n", Agg::Sum(and(admitted()))),
                ("node_replied", Agg::Sum(with(vote(), vec![one("n_reply")]))),
                (
                    "node_refused_early",
                    Agg::Sum(with(vote(), vec![num_is("n_reply", 0), one("n_http")])),
                ),
                (
                    "node_edge_mismatch",
                    Agg::Sum(with(
                        vote(),
                        vec![one("n_reply"), ne(f("node_st"), f("edge_st"))],
                    )),
                ),
                (
                    "http_edge_mismatch",
                    Agg::Sum(with(
                        vote(),
                        vec![one("n_http"), ne(f("http_st"), f("edge_st"))],
                    )),
                ),
                ("same", Agg::Sum(with(admitted(), vec![one("v_same")]))),
                (
                    "ambiguous",
                    Agg::Sum(with(admitted(), vec![one("v_ambiguous")])),
                ),
                (
                    "different",
                    Agg::Sum(with(admitted(), vec![one("v_different")])),
                ),
                ("absent", Agg::Sum(with(admitted(), vec![one("v_absent")]))),
                (
                    "unavailable",
                    Agg::Sum(with(admitted(), vec![one("v_unavailable")])),
                ),
                (
                    "follow_complete",
                    Agg::Sum(with(admitted(), vec![one("f_complete")])),
                ),
                (
                    "follow_absent",
                    Agg::Sum(with(admitted(), vec![one("f_absent")])),
                ),
                (
                    "follow_degraded",
                    Agg::Sum(with(admitted(), vec![one("f_degraded")])),
                ),
                (
                    "node_statement",
                    Agg::Sum(with(admitted(), vec![one("x_statement")])),
                ),
                (
                    "node_topical",
                    Agg::Sum(with(admitted(), vec![one("x_topical")])),
                ),
                ("node_none", Agg::Sum(with(admitted(), vec![one("x_none")]))),
                (
                    "both_next",
                    Agg::Sum(with(
                        admitted(),
                        vec![one("f_complete"), one("x_statement")],
                    )),
                ),
                (
                    "both_none",
                    Agg::Sum(with(admitted(), vec![one("f_absent"), one("x_none")])),
                ),
                (
                    "rust_none_only",
                    Agg::Sum(with(admitted(), vec![one("f_absent"), one("x_statement")])),
                ),
                (
                    "node_none_only",
                    Agg::Sum(with(admitted(), vec![one("f_complete"), one("x_none")])),
                ),
                (
                    "remaining_equal",
                    Agg::Sum(with(
                        admitted(),
                        vec![one("f_complete"), one("x_statement"), eq(f("nr"), f("rr"))],
                    )),
                ),
                (
                    "total_equal",
                    Agg::Sum(with(
                        admitted(),
                        vec![one("f_complete"), one("x_statement"), eq(f("nt"), f("rt"))],
                    )),
                ),
                ("cors", Agg::Sum(with(vote(), vec![ge(f("n_cors"), n(1))]))),
            ],
            by: vec![
                Key::Field("edge_st"),
                Key::Field("node_st"),
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
                    self.node(node_line),
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

    /// Node's access lines for every request of the route, not only shadowed
    /// ones, by hour: the stop rule's latency and errors. `run` issues it for
    /// the window and for the same window a week earlier.
    pub(crate) fn node_requests(&self, name: &'static str, by: Key) -> Query {
        Query {
            name,
            about: "Node's answers to every request of the route by hour, the window and a week earlier (the stop rule's latency and errors).",
            filter: and(vec![
                E::In("message", ACCESS_LINE.to_vec()),
                is("service", "server"),
                is("http.method", self.method),
                is("http.route", self.path),
            ]),
            fields: vec![],
            stages: vec![Stats {
                aggs: vec![
                    ("n", Agg::Count),
                    ("e5", Agg::Sum(ge(f("http.status_code"), n(500)))),
                    ("p99_ms", Agg::Pct("duration_ms", 99)),
                ],
                by: vec![by],
            }],
            pad_s: 0,
            previous_week: true,
            recent: true,
            chunk_s: 0,
            sliced: false,
        }
    }
}
