//! What Node would do with an admitted comment, as a value.
//!
//! Admission reads the conversation, the member and any existing comment with
//! the same text. `decide` turns that into the decision Node's handler
//! reaches (`server/src/routes/comments.ts`, `handle_POST_comments`), in
//! Node's order: the duplicate check, then the closed conversation, then the
//! insert.
//!
//! Strict moderation does not change the row Node stores: a participant's
//! comment is inserted active with `mod` 0 in a strict conversation exactly
//! as in any other (moderation state is read when comments are listed). What
//! it changes is what Node does after the insert: it counts the conversation's
//! unmoderated comments and emails its moderators, and it does not upsert the
//! notification task. This crate sends no email, so the live handler must
//! never store a comment in a strict conversation; it hands that request to
//! Node. The types here make that a property of the code: the insert takes a
//! `Writable`, the only constructor of a `Writable` is in `decide`, and
//! `decide` builds one only for a conversation that is not strict. A strict
//! conversation's comment is a `Modelled`: the same row, readable for
//! comparison with what Node stored, with no way to turn it into a
//! `Writable`.
//!
//! The parts of a decision the live handler does not read (the modelled row,
//! what follows the insert, the status) are read by this crate's tests, and
//! are there for the mode that compares a decision with what Node stored.
#![allow(dead_code)]
use crate::post_comments_text::CommentText;
use crate::votes::VoteChoice;

/// The value Node writes in `velocity` for every new comment.
pub(crate) const VELOCITY: f32 = 1.0;
/// Node's `polisTypes.mod.unmoderated`: where a participant's comment starts.
pub(crate) const UNMODERATED: i32 = 0;

/// The comment row Node would insert for an admitted request, and the
/// author's vote it would store after it. The columns the request does not
/// decide are constants for every request this handler admits (a member who
/// is not a moderator, no seed flag, no language detection): `velocity` 1,
/// `active` true, `mod` 0, `anon` false, `is_seed` false, `lang` and
/// `lang_confidence` null, `tid` and `created` assigned by the database.
#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub(crate) zid: i32,
    pub(crate) pid: i32,
    pub(crate) uid: i32,
    pub(crate) text: CommentText,
    /// The author's vote, only when the request carries one.
    pub(crate) vote: Option<VoteChoice>,
}

impl Row {
    pub(crate) const ACTIVE: bool = true;
    pub(crate) const ANON: bool = false;
    pub(crate) const IS_SEED: bool = false;
}

/// The existing comment with the same text in the conversation. The unique
/// key on (zid, txt) allows at most one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Existing {
    pub(crate) tid: i32,
    pub(crate) pid: i32,
    pub(crate) created: Option<i64>,
}

/// What admission read.
#[derive(Clone, Debug)]
pub(crate) struct Admitted {
    pub(crate) zid: i32,
    pub(crate) pid: i32,
    pub(crate) uid: i32,
    pub(crate) active: bool,
    pub(crate) strict: bool,
    pub(crate) existing: Option<Existing>,
}

/// A row the live handler may insert. Private field, no public constructor.
#[derive(Clone, Debug)]
pub(crate) struct Writable(Row);

impl Writable {
    pub(crate) fn row(&self) -> &Row {
        &self.0
    }
}

/// A row Node would store that this crate must not: the comment of a
/// conversation with strict moderation.
#[derive(Clone, Debug)]
pub(crate) struct Modelled(Row);

impl Modelled {
    pub(crate) fn row(&self) -> &Row {
        &self.0
    }
}

/// What Node does after the insert, besides the author's last-interaction
/// update it makes either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AfterInsert {
    /// Upsert the conversation's notification task.
    NotificationTask,
    /// Count the unmoderated comments and email the moderators; no task.
    ModeratorEmail,
}

#[derive(Clone, Debug)]
pub(crate) enum Store {
    Ordinary(Writable),
    Strict(Modelled),
}

impl Store {
    pub(crate) fn row(&self) -> &Row {
        match self {
            Self::Ordinary(row) => row.row(),
            Self::Strict(row) => row.row(),
        }
    }

    pub(crate) fn after_insert(&self) -> AfterInsert {
        match self {
            Self::Ordinary(_) => AfterInsert::NotificationTask,
            Self::Strict(_) => AfterInsert::ModeratorEmail,
        }
    }
}

/// Node's answer to an admitted request.
#[derive(Clone, Debug)]
pub(crate) enum Outcome {
    /// 409 `polis_err_post_comment_duplicate`. The existing row is kept for
    /// a reader that must tell whose row it is; the live handler does not
    /// need it.
    Duplicate(Existing),
    /// 403 `polis_err_conversation_is_closed`.
    Closed,
    /// 200 `{tid, currentPid}`: the comment number the insert assigns and
    /// the row's `pid`.
    Store(Store),
}

#[derive(Clone, Debug)]
pub(crate) struct Decision {
    pub(crate) zid: i32,
    /// The conversation has strict moderation, whatever the outcome.
    pub(crate) strict: bool,
    pub(crate) outcome: Outcome,
}

/// What the live handler does with a decision.
#[derive(Debug)]
pub(crate) enum Live {
    /// Answer as Node does; nothing is written.
    Answer(u16, &'static str),
    /// Hand the request to Node before any write, with this reason.
    HandBack(&'static str),
    /// Insert the row.
    Write(Writable),
}

impl Decision {
    pub(crate) fn status(&self) -> u16 {
        match self.outcome {
            Outcome::Duplicate(_) => 409,
            Outcome::Closed => 403,
            Outcome::Store(_) => 200,
        }
    }

    /// The one place a decision becomes a write. A duplicate and a closed
    /// conversation are answered as Node answers them, strict or not: Node
    /// stores nothing and sends no email for either.
    pub(crate) fn live(self) -> Live {
        match self.outcome {
            Outcome::Duplicate(_) => Live::Answer(409, "polis_err_post_comment_duplicate"),
            Outcome::Closed => Live::Answer(403, "polis_err_conversation_is_closed"),
            Outcome::Store(Store::Strict(_)) => Live::HandBack("strict_moderation"),
            Outcome::Store(Store::Ordinary(row)) => Live::Write(row),
        }
    }
}

/// Node's order: an existing text answers 409 before a closed conversation
/// answers 403.
pub(crate) fn decide(admitted: &Admitted, text: CommentText, vote: Option<VoteChoice>) -> Decision {
    let outcome = if let Some(existing) = admitted.existing {
        Outcome::Duplicate(existing)
    } else if !admitted.active {
        Outcome::Closed
    } else {
        let row = Row {
            zid: admitted.zid,
            pid: admitted.pid,
            uid: admitted.uid,
            text,
            vote,
        };
        Outcome::Store(if admitted.strict {
            Store::Strict(Modelled(row))
        } else {
            Store::Ordinary(Writable(row))
        })
    };
    Decision {
        zid: admitted.zid,
        strict: admitted.strict,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admitted(active: bool, strict: bool, duplicate: bool) -> Admitted {
        Admitted {
            zid: 1,
            pid: 2,
            uid: 3,
            active,
            strict,
            existing: duplicate.then_some(Existing {
                tid: 4,
                pid: 5,
                created: Some(6),
            }),
        }
    }

    fn decided(active: bool, strict: bool, duplicate: bool, vote: Option<VoteChoice>) -> Decision {
        decide(
            &admitted(active, strict, duplicate),
            CommentText::new("generated".into()),
            vote,
        )
    }

    /// Every combination of what admission can read. The live handler gets a
    /// row to write only from an open, non-strict conversation with no
    /// existing text; in a strict conversation it never does.
    #[test]
    fn live_never_writes_a_strict_conversation_and_keeps_nodes_order() {
        for active in [true, false] {
            for strict in [true, false] {
                for duplicate in [true, false] {
                    let decision = decided(active, strict, duplicate, None);
                    assert_eq!(decision.strict, strict);
                    let status = decision.status();
                    let live = decision.live();
                    match (duplicate, active, strict) {
                        (true, _, _) => {
                            assert_eq!(status, 409);
                            assert!(matches!(
                                live,
                                Live::Answer(409, "polis_err_post_comment_duplicate")
                            ));
                        }
                        (false, false, _) => {
                            assert_eq!(status, 403);
                            assert!(matches!(
                                live,
                                Live::Answer(403, "polis_err_conversation_is_closed")
                            ));
                        }
                        (false, true, true) => {
                            assert_eq!(status, 200);
                            assert!(matches!(live, Live::HandBack("strict_moderation")));
                        }
                        (false, true, false) => {
                            assert_eq!(status, 200);
                            assert!(matches!(live, Live::Write(_)));
                        }
                    }
                }
            }
        }
    }

    /// The row Node stores in a strict conversation is the row it stores in
    /// any other; only what follows the insert differs.
    #[test]
    fn a_strict_conversation_gets_the_same_row_and_another_notification() {
        for vote in [
            None,
            Some(VoteChoice::Agree),
            Some(VoteChoice::Disagree),
            Some(VoteChoice::Pass),
        ] {
            let strict = decided(true, true, false, vote);
            let ordinary = decided(true, false, false, vote);
            let (Outcome::Store(strict), Outcome::Store(ordinary)) =
                (strict.outcome, ordinary.outcome)
            else {
                panic!("both are stored by Node");
            };
            assert!(matches!(strict, Store::Strict(_)));
            assert!(matches!(ordinary, Store::Ordinary(_)));
            let (a, b) = (strict.row(), ordinary.row());
            assert_eq!((a.zid, a.pid, a.uid, a.vote), (b.zid, b.pid, b.uid, b.vote));
            assert_eq!(a.vote, vote);
            assert_eq!(a.text.bytes(), b.text.bytes());
            assert_eq!(strict.after_insert(), AfterInsert::ModeratorEmail);
            assert_eq!(ordinary.after_insert(), AfterInsert::NotificationTask);
        }
    }
}
