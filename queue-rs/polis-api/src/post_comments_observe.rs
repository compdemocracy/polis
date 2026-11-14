//! Observe mode: the comment handler's admission, run on a copy of a comment
//! that Node is answering, with no write of any kind.
//!
//! Built only by the shadow role (`crate::shadow`), and never beside the live
//! handler. It holds two read-only pools and nothing that can write: no
//! insert pool and no notification pool, so the comment's insert, its
//! author's vote, the notification task and the last-interaction update have
//! no connection to run on. Its sessions are read-only (`db::Pool::new`) as
//! the backstop. Admission is the live handler's own (`check`): the same
//! shape check, token verification, admin refusal and admission statement,
//! under the same deadline, on the same limits.
//!
//! From what admission read it derives what the live handler at this commit
//! would do with the request: dispatch the write, answer 409 or 403, or hand
//! the request back, and for which reason. The write itself is not modelled.
//! One decision is read otherwise than live reads it: a comment in a
//! conversation with strict moderation, which live hands back because it
//! sends no moderators' email, is observed as the write Node makes (the row
//! is the same as in any conversation), and the line says what follows the
//! insert (`after_insert`: the moderators' email there, the notification task
//! elsewhere). It reaches this module as a `Modelled` row, which nothing can
//! insert (`Decision::observed`).
//!
//! Node may have stored this very comment before the copy's admission reads.
//! The unique key on (zid, txt) allows one row per text, so the row admission
//! finds is classified: this participant's row, created inside the window
//! after the copy's database-time anchor, is Node's row for this request and
//! not a duplicate; any other row is one. Without the anchor that cannot be
//! told for this participant's row, and the copy is unknown: never a guess.
//!
//! After a wait it reads back what Node stored, by the same unique key, and
//! compares it in process with what live would have stored: the text, the
//! author, the row's columns, the language, and the author's vote through
//! `StorageConvention` only. Classes leave this module, and the number of
//! the conversation an admitted copy is in; the text, the vote's value and
//! every number that names a comment, a participant or a user stay in it.
//!
//! The text is a `CommentText` from the moment it is parsed. Nothing here may
//! slice a string, index into one, or unwrap a value that holds one: a panic
//! for either prints the string.
#![deny(
    clippy::string_slice,
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used
)]
use super::*;
use crate::post_comments_decision::{Observed, Outcome, UNMODERATED, VELOCITY};
use crate::post_comments_text::Compared;
use crate::post_votes::observe::ReadbackTiming;
use crate::shadow::comments::Lane;

/// How long before the copy's anchor Node's row for the same request may
/// have been created: the anchor is read after the copy arrives, and Node
/// may have stored the comment by then.
pub(crate) const OWN_WINDOW_MS: i64 = 5000;

/// The copy's database-time anchor.
pub(crate) const ANCHOR: &str = "select now_as_millis()";

/// What Node stored for this text in this conversation: one row at most, by
/// the unique key on (zid, txt). The last column says whether the row was
/// changed after its insert: the insert gives `created` and `modified` the
/// same value (both default to `now_as_millis()`, the insert's transaction
/// time), and both of Node's moderation writes (`PUT /api/v3/comments` and the
/// topic moderation route) stamp `modified` with their own.
pub(crate) const READBACK: &str =
    "select tid, pid, uid, txt, created, mod, active, is_seed, velocity, anon,
     (lang is not null or lang_confidence is not null),
     (modified is distinct from created)
     from comments where zid = $1 and txt = $2";

/// The author's vote rows on that comment since the anchor: the statement
/// the vote observer reads a stored vote with.
pub(crate) const READBACK_VOTE: &str = "select vote from votes
     where zid=$1 and pid=$2 and tid=$3 and created >= $4::bigint - 5000
     order by created";

/// The server's settings that decide whether a statement's parameters can
/// reach its log. Read once at startup and printed: they are not personal.
pub(crate) const LOGGING_SETTINGS: &str = "select name, setting from pg_settings
     where name in ('log_min_duration_statement', 'log_min_duration_sample', 'log_statement',
     'log_parameter_max_length', 'log_parameter_max_length_on_error', 'log_min_error_statement',
     'shared_preload_libraries')
     order by name";

/// `readback`: one connection for the database-time anchor and the read-back.
/// Never an admission slot.
pub(crate) fn readback_limits() -> db::Limits {
    db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

pub(crate) struct Observer {
    verifier: participant::Verifier,
    reads: Arc<db::Pool>,
    readback: Arc<db::Pool>,
    admins: Vec<i32>,
    /// This route's own lane: its bound on observations in admission at once,
    /// its bound on waiting read-backs and its rate bucket.
    pub(crate) lane: Arc<Lane>,
    pub(crate) timing: ReadbackTiming,
}

/// The observer the shadow role builds, on the handler's own database. The
/// lane's rate is required: there is no default for how many comment copies a
/// second this process may observe.
pub(super) fn build(
    dsn: &str,
    verifier: participant::Verifier,
    admins: Vec<i32>,
) -> Result<Configured> {
    let max_per_second = std::env::var("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=10_000).contains(value))
        .context(
            "comment observe mode requires POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND, 1 to 10000",
        )?;
    Ok(Configured::Observe(Box::new(Observer::new(
        verifier,
        db::Pool::new(
            config::connector_for_dsn(dsn, "polis-api-comment-reads/1")?,
            read_limits(),
        ),
        db::Pool::new(
            config::connector_for_dsn(dsn, "polis-api-comment-shadow-readback/1")?,
            readback_limits(),
        ),
        admins,
        max_per_second,
    ))))
}

impl Observer {
    pub(super) fn new(
        verifier: participant::Verifier,
        reads: Arc<db::Pool>,
        readback: Arc<db::Pool>,
        admins: Vec<i32>,
        max_per_second: u32,
    ) -> Self {
        Self {
            verifier,
            reads,
            readback,
            admins,
            lane: Lane::new(max_per_second),
            timing: ReadbackTiming::default(),
        }
    }

    /// Every pool observe mode builds: the two read-only pools, and no insert
    /// or notification pool. No rest pattern: a new field must be classified.
    #[cfg(test)]
    pub(crate) fn startup_pools(&self) -> [(&'static str, &Arc<db::Pool>); 2] {
        let Self {
            verifier: _,
            reads,
            readback,
            admins: _,
            lane: _,
            timing: _,
        } = self;
        [("reads", reads), ("readback", readback)]
    }

    pub(crate) fn pools_health(&self, readback_reachable: bool) -> Js {
        let mut pools = js::Obj::new();
        pools.set("reads", self.reads.health(true));
        pools.set("readback", self.readback.health(readback_reachable));
        Js::Obj(pools)
    }

    pub(crate) async fn ping(&self) -> bool {
        self.readback.ping().await
    }

    pub(crate) fn set_revocations(&mut self, snapshot: Arc<polis_auth::revocation::Revocations>) {
        self.verifier.set_revocations(snapshot);
    }

    pub(crate) fn check_revocation(&self, raw: &str, now: u64) -> Result<(), polis_auth::Refusal> {
        self.verifier.check_revocation(raw, now)
    }

    fn admission(&self) -> Admission<'_> {
        Admission {
            verifier: &self.verifier,
            reads: &self.reads,
            admins: &self.admins,
        }
    }

    /// Database time at the copy's arrival, on `readback`. None when that
    /// pool does not answer; nothing is then read back, and a text match of
    /// this participant's is unknown.
    pub(crate) async fn anchor(&self) -> Option<i64> {
        self.readback
            .with(|c| Ok(c.query_one(ANCHOR, &[])?.try_get::<_, i64>(0)?))
            .await
            .ok()
    }

    /// The server's logging settings, by name. None when the read fails.
    pub(crate) async fn logging_settings(&self) -> Option<Vec<(String, String)>> {
        self.readback
            .with(|c| {
                c.query(LOGGING_SETTINGS, &[])?
                    .iter()
                    .map(|row| Ok((row.try_get(0)?, row.try_get(1)?)))
                    .collect()
            })
            .await
            .ok()
    }

    /// What Node stored for the copy's text, first at `timing.first` after
    /// receipt and once more at `timing.retry` when no row is there yet, or
    /// when the comment is there and the vote the copy carried is not. No
    /// connection is held while waiting. Returns the classes and the delay
    /// that decided them.
    pub(crate) async fn read_back(
        &self,
        subject: &Subject,
        anchor: i64,
        received: tokio::time::Instant,
    ) -> (Stored, Option<f64>) {
        let mut decided = None;
        let mut found: Option<Stored> = None;
        for delay in [self.timing.first, self.timing.retry] {
            tokio::time::sleep_until(received + delay).await;
            decided = Some(delay.as_secs_f64());
            let again = subject.again();
            let looked = self
                .readback
                .with(move |c| look(c, &again, anchor).map_err(scrubbed))
                .await;
            match looked {
                // A second look that fails keeps what the first found, and
                // says the vote could not be read.
                Err(_) => {
                    return match found {
                        Some(mut stored) => {
                            stored.vote = AuthorVote::Unavailable;
                            (stored, decided)
                        }
                        None => (Stored::of(NodeComment::Unavailable), decided),
                    };
                }
                Ok(None) => {}
                Ok(Some(stored)) => {
                    if stored.vote != AuthorVote::Absent {
                        return (stored, decided);
                    }
                    found = Some(stored);
                }
            }
        }
        (
            found.unwrap_or_else(|| Stored::of(NodeComment::Absent)),
            decided,
        )
    }
}

/// A database error with nothing of the statement, its parameters or the
/// server's message left in it: only the SQLSTATE. The server's message for
/// a failing comparison can quote the text it was given.
fn scrubbed(error: anyhow::Error) -> anyhow::Error {
    match error
        .downcast_ref::<postgres::Error>()
        .and_then(postgres::Error::code)
    {
        Some(code) => anyhow::anyhow!("comment read-back failed: SQLSTATE {}", code.code()),
        None => anyhow::anyhow!("comment read-back failed"),
    }
}

/// One look at what Node stored. None: no row has this text.
fn look(c: &mut Client, subject: &Subject, anchor: i64) -> Result<Option<Stored>> {
    let rows = c.query(READBACK, &[&subject.zid, &subject.text])?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let pid: Option<i32> = row.try_get(1)?;
    let created: Option<i64> = row.try_get(4)?;
    if !pid.is_some_and(|pid| own(pid, created, subject.pid, anchor)) {
        return Ok(Some(Stored::of(NodeComment::Other)));
    }
    let tid: i32 = row.try_get(0)?;
    let uid: Option<i32> = row.try_get(2)?;
    // The stored text goes no further than this comparison.
    let text = match row.try_get::<_, Option<String>>(3)? {
        Some(stored) => subject.text.compare(&stored),
        None => subject.text.compare(""),
    };
    let vote = match subject.vote {
        None => AuthorVote::NotSent,
        Some(expected) => {
            let stored = c
                .query(READBACK_VOTE, &[&subject.zid, &subject.pid, &tid, &anchor])?
                .iter()
                .map(|row| row.try_get::<_, Option<i16>>(0))
                .collect::<Result<Vec<_>, _>>()?;
            AuthorVote::classify(&stored, expected)
        }
    };
    Ok(Some(Stored {
        comment: NodeComment::Own,
        text: Some(text),
        author: Some(uid == Some(subject.uid)),
        row: Some(row_class(
            row.try_get(5)?,
            row.try_get(6)?,
            row.try_get(7)?,
            row.try_get(8)?,
            row.try_get(9)?,
            row.try_get::<_, Option<bool>>(11)?.unwrap_or(false),
        )),
        lang: Some(row.try_get::<_, Option<bool>>(10)?.unwrap_or(false)),
        vote,
    }))
}

/// A row with this text is Node's row for this very request when it is this
/// participant's and was created no earlier than the window before the
/// copy's anchor.
fn own(row_pid: i32, created: Option<i64>, pid: i32, anchor: i64) -> bool {
    row_pid == pid && created.is_some_and(|created| created >= anchor.saturating_sub(OWN_WINDOW_MS))
}

/// The row admission found with the copy's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextRow {
    /// No row has this text.
    None,
    /// Node's row for this request: not a duplicate.
    Own,
    /// Another participant's row, or this participant's from before the
    /// window: a duplicate, as it is for Node.
    Other,
    /// This participant's row, and no anchor to place it by.
    Unknown,
}

impl TextRow {
    pub(crate) fn classify(existing: Option<Existing>, pid: i32, anchor: Option<i64>) -> Self {
        match (existing, anchor) {
            (None, _) => Self::None,
            // Another participant's row is never this request's.
            (Some(row), _) if row.pid != pid => Self::Other,
            (Some(_), None) => Self::Unknown,
            (Some(row), Some(anchor)) => {
                if own(row.pid, row.created, pid, anchor) {
                    Self::Own
                } else {
                    Self::Other
                }
            }
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Own => "own",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

/// What the read-back found with the copy's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NodeComment {
    /// Node's row for this request.
    Own,
    /// A row that is not this request's.
    Other,
    /// No row at either look.
    Absent,
    /// Not looked for: the copy has no anchor.
    Unknown,
    /// The read failed.
    Unavailable,
    /// Not looked for: the copy was not admitted, or too many were waiting.
    NotChecked,
}

impl NodeComment {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Own => "own",
            Self::Other => "other",
            Self::Absent => "absent",
            Self::Unknown => "unknown",
            Self::Unavailable => "unavailable",
            Self::NotChecked => "not_checked",
        }
    }
}

/// How Node's stored vote rows compare with the vote the copy carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AuthorVote {
    /// Every row carries the copy's choice.
    Same,
    /// Some do and some do not: a quick change of vote, not a stop.
    Ambiguous,
    /// None does: a vote-sign stop until explained.
    Different,
    /// The comment is stored and no vote of its author's is.
    Absent,
    /// The copy carried no vote.
    NotSent,
    Unavailable,
    NotChecked,
}

impl AuthorVote {
    /// `rows` are stored values; each is read through the storage convention
    /// and compared as a choice, never as a number.
    pub(crate) fn classify(rows: &[Option<i16>], expected: VoteChoice) -> Self {
        let matches = rows
            .iter()
            .filter(|raw| StorageConvention::CURRENT.decode(raw.map(i32::from)) == Some(expected))
            .count();
        if rows.is_empty() {
            Self::Absent
        } else if matches == 0 {
            Self::Different
        } else if matches == rows.len() {
            Self::Same
        } else {
            Self::Ambiguous
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Same => "same",
            Self::Ambiguous => "ambiguous",
            Self::Different => "different",
            Self::Absent => "absent",
            Self::NotSent => "not_sent",
            Self::Unavailable => "unavailable",
            Self::NotChecked => "not_checked",
        }
    }
}

/// The stored row's columns against the row the live insert stores for every
/// request it admits. The first column that differs, by name; or `moderated`
/// when only the moderation columns differ and the row was changed after its
/// insert (`changed_later`): a moderator approved or rejected the comment
/// between Node's insert and this read, which says nothing about the insert.
pub(crate) fn row_class(
    moderation: Option<i32>,
    active: Option<bool>,
    is_seed: Option<bool>,
    velocity: Option<f32>,
    anon: Option<bool>,
    changed_later: bool,
) -> &'static str {
    let moderated = moderation != Some(UNMODERATED) || active != Some(Row::ACTIVE);
    let rest_as_inserted =
        is_seed == Some(Row::IS_SEED) && velocity == Some(VELOCITY) && anon == Some(Row::ANON);
    if moderated && changed_later && rest_as_inserted {
        "moderated"
    } else if moderation != Some(UNMODERATED) {
        "mod"
    } else if active != Some(Row::ACTIVE) {
        "active"
    } else if is_seed != Some(Row::IS_SEED) {
        "is_seed"
    } else if velocity != Some(VELOCITY) {
        "velocity"
    } else if anon != Some(Row::ANON) {
        "anon"
    } else {
        "as_expected"
    }
}

/// What the read-back looks for, in process only: the conversation, the
/// participant, the user, the text and the choice the copy carried. It has no
/// `Debug`: nothing can format it.
pub(crate) struct Subject {
    pub(crate) zid: i32,
    pub(crate) pid: i32,
    pub(crate) uid: i32,
    pub(crate) text: CommentText,
    pub(crate) vote: Option<VoteChoice>,
}

impl Subject {
    /// The same subject, for one look on a blocking thread.
    fn again(&self) -> Self {
        Self {
            zid: self.zid,
            pid: self.pid,
            uid: self.uid,
            text: self.text.clone(),
            vote: self.vote,
        }
    }
}

/// What the read-back found, as classes.
pub(crate) struct Stored {
    pub(crate) comment: NodeComment,
    /// The stored text against the parsed text.
    pub(crate) text: Option<Compared>,
    /// Whether the stored user is the user admission resolved.
    pub(crate) author: Option<bool>,
    /// `as_expected`, the first column live would have stored otherwise, or
    /// `moderated` (changed by a moderator after the insert).
    pub(crate) row: Option<&'static str>,
    /// Whether a language is stored.
    pub(crate) lang: Option<bool>,
    pub(crate) vote: AuthorVote,
}

impl Stored {
    /// Nothing to compare: no row of this request's was read.
    pub(crate) fn of(comment: NodeComment) -> Self {
        Self {
            comment,
            text: None,
            author: None,
            row: None,
            lang: None,
            vote: AuthorVote::NotChecked,
        }
    }
}

/// The observe path of `post_comments::handle`: the live admission, then the
/// decision in place of the dispatch. The answer is the would-be answer; the
/// shadow answers nginx 204 whatever it is.
pub(super) async fn handle(observer: &Observer, req: &Request, res: Res) -> Outgoing {
    let Checked {
        admitted,
        text,
        vote,
        admission,
    } = match check(observer.admission(), req).await {
        Ok(checked) => checked,
        Err(refused) => {
            crate::shadow::comments::record(|record| {
                record.reason = Some(refused.reason);
                record.admission = refused.admission;
            });
            return route::bad_gateway();
        }
    };
    #[cfg(test)]
    tests::panic_point(req);
    let anchor = crate::shadow::comments::record(|record| record.anchor).flatten();
    let text_row = TextRow::classify(admitted.existing, admitted.pid, anchor);
    crate::shadow::comments::record(|record| {
        record.admitted = true;
        record.zid = Some(admitted.zid);
        record.strict = Some(admitted.strict);
        record.admission = Some(admission);
        record.text_row = Some(text_row);
        record.subject = Some(Subject {
            zid: admitted.zid,
            pid: admitted.pid,
            uid: admitted.uid,
            text: text.clone(),
            vote,
        });
    });
    if text_row == TextRow::Unknown {
        // Own or other cannot be told, so neither can the answer.
        crate::shadow::comments::record(|record| record.unknown = true);
        return no_answer();
    }
    // Node's row for this very request is not a duplicate: the live handler,
    // answering in Node's place, would have found no row.
    let modelled = Admitted {
        existing: admitted.existing.filter(|_| text_row != TextRow::Own),
        ..admitted
    };
    let decision = decide(&modelled, text, vote);
    let answered = match decision.outcome {
        Outcome::Duplicate(_) => Some("duplicate"),
        Outcome::Closed => Some("closed"),
        Outcome::Store(_) => None,
    };
    match decision.observed() {
        Observed::Answer(status, code) => {
            crate::shadow::comments::record(|record| record.reason = answered);
            route::fail_json(req, res, status, Js::Str(code.into()))
        }
        // Node stores the comment: the live handler dispatches the write
        // here, or, in a conversation with strict moderation, hands it to
        // Node, which stores the same row and then emails the moderators. The
        // row is dropped: it is a `Modelled`, this mode has nothing to write
        // it with, and the write (the insert, the comment's number, the
        // author's vote, the notification work or email and the reply
        // deadline) is not modelled. What Node stored is read back and
        // compared all the same.
        Observed::Stored { row: _, after } => {
            crate::shadow::comments::record(|record| record.after_insert = Some(after));
            no_answer()
        }
    }
}

/// The observe path's stand-in for the reply to a dispatched write.
fn no_answer() -> Outgoing {
    Outgoing {
        status: 200,
        headers: vec![],
        body: crate::http::Body::Empty,
        close: false,
    }
}

#[cfg(test)]
#[path = "post_comments_observe_tests.rs"]
pub(crate) mod tests;
