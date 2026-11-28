//! The current-tick frames and their validation across records: each
//! refusal the contract lists is reached, and each defined case (no groups, a
//! group with no votes, sparse ids, an absent cell) is accepted.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

mod support;

use polis_routing_equation::{
    CommentId, CommentMarks, Counts, CurrentFrames, CurrentGroupFrame, EveryoneFrame, GroupId,
    GroupMarks, ImportanceMarks, MarkTotals, Marks, Refusal, VoterWeightFrame,
};
use std::panic::{AssertUnwindSafe, catch_unwind};
use support::{XorShift, src};

fn g(id: u32) -> GroupId {
    GroupId::new(id)
}
fn c(id: u32) -> CommentId {
    CommentId::new(id)
}
fn n(a: u32, d: u32, p: u32) -> Counts {
    Counts::new(a, d, p)
}

fn groups(
    members: &[(u32, u32)],
    cells: &[(u32, u32, Counts)],
    participants: Option<u64>,
) -> Result<CurrentGroupFrame, Refusal> {
    CurrentGroupFrame::new(
        src("tick 4 groups"),
        members.iter().map(|(id, m)| (g(*id), *m)),
        cells.iter().map(|(gid, cid, k)| (g(*gid), c(*cid), *k)),
        participants,
    )
}

#[test]
fn group_frame_accepts_sparse_ids_and_its_defined_cases() {
    // Sparse ids 0, 2, 7; group 7 has members and no votes at all; group 2
    // has no cell for comment 1.
    let f = groups(
        &[(7, 3), (0, 5), (2, 4)],
        &[(0, 1, n(3, 1, 1)), (2, 9, n(0, 0, 4)), (0, 9, n(0, 0, 0))],
        Some(12),
    )
    .unwrap();
    assert_eq!(f.group_count(), 3);
    assert_eq!(
        f.groups().map(|(id, _)| id.get()).collect::<Vec<_>>(),
        [0, 2, 7]
    );
    assert_eq!(f.total_members(), 12);
    assert_eq!(f.cell(g(2), c(1)), None);
    assert_eq!(f.cell(g(0), c(9)), Some(n(0, 0, 0)));
    let for_one: Vec<_> = f.cells_for(c(1)).collect();
    assert_eq!(
        for_one,
        [(g(0), Some(n(3, 1, 1))), (g(2), None), (g(7), None)]
    );
    assert_eq!(f.summed(c(9)), [0, 0, 4]);
    assert_eq!(
        f.comment_ids()
            .into_iter()
            .map(CommentId::get)
            .collect::<Vec<_>>(),
        [1, 9]
    );
    // No groups at all is a frame too.
    let empty = groups(&[], &[], None).unwrap();
    assert_eq!(empty.group_count(), 0);
    assert_eq!(empty.summed(c(1)), [0, 0, 0]);
}

#[test]
fn group_frame_refusals() {
    assert_eq!(
        groups(&[(1, 2), (1, 3)], &[], None),
        Err(Refusal::DuplicateGroup(g(1)))
    );
    assert_eq!(groups(&[(4, 0)], &[], None), Err(Refusal::EmptyGroup(g(4))));
    assert_eq!(
        groups(&[(1, 2)], &[(3, 5, n(1, 0, 0))], None),
        Err(Refusal::UnknownGroup {
            group: g(3),
            comment: c(5)
        })
    );
    // Seen 3 in a group of 2; seen 2 is accepted (the boundary).
    assert_eq!(
        groups(&[(1, 2)], &[(1, 5, n(1, 1, 1))], None),
        Err(Refusal::SeenAboveMembers {
            group: g(1),
            comment: c(5)
        })
    );
    assert!(groups(&[(1, 2)], &[(1, 5, n(1, 0, 1))], None).is_ok());
    assert_eq!(
        groups(&[(1, 2)], &[(1, 5, n(1, 0, 0)), (1, 5, n(0, 1, 0))], None),
        Err(Refusal::DuplicateCell {
            group: g(1),
            comment: c(5)
        })
    );
    // Members 2 + 3 = 5: participants 4 refused, 5 accepted.
    assert_eq!(
        groups(&[(1, 2), (2, 3)], &[], Some(4)),
        Err(Refusal::MembersAboveParticipants)
    );
    assert!(groups(&[(1, 2), (2, 3)], &[], Some(5)).is_ok());
    // The members' sum is checked, never wrapped.
    let many: Vec<(u32, u32)> = (0..3).map(|i| (i, u32::MAX)).collect();
    assert!(groups(&many, &[], None).is_ok());
}

#[test]
fn everyone_frame_and_coverage() {
    let e = |cells: &[(u32, Counts)], participants| {
        EveryoneFrame::new(
            src("tick 4 everyone"),
            participants,
            cells.iter().map(|(cid, k)| (c(*cid), *k)),
        )
    };
    assert_eq!(
        e(&[(1, n(2, 2, 1))], 4),
        Err(Refusal::SeenAboveParticipants(c(1)))
    );
    assert_eq!(
        e(&[(1, n(1, 0, 0)), (1, n(1, 0, 0))], 4),
        Err(Refusal::DuplicateComment(c(1)))
    );
    let all = e(&[(1, n(4, 2, 1)), (2, n(0, 0, 0))], 9).unwrap();
    assert_eq!(all.get(c(3)), n(0, 0, 0));

    let grouped = groups(
        &[(0, 3), (5, 6)],
        &[(0, 1, n(2, 1, 0)), (5, 1, n(2, 1, 1))],
        None,
    )
    .unwrap();
    // Sums 4, 2, 1 against everyone's 4, 2, 1: covered (equality allowed).
    assert!(CurrentFrames::new(Some(grouped.clone()), Some(all.clone())).is_ok());
    // One field at a time over everyone's count.
    for (field, cell) in [
        ("agreed", n(3, 1, 1)),
        ("disagreed", n(2, 2, 0)),
        ("passed", n(2, 1, 2)),
    ] {
        let over = groups(&[(0, 3), (5, 6)], &[(0, 1, n(2, 1, 0)), (5, 1, cell)], None).unwrap();
        assert_eq!(
            CurrentFrames::new(Some(over), Some(all.clone())),
            Err(Refusal::FrameInconsistent {
                comment: c(1),
                field
            })
        );
    }
    // A comment the groups have voted on and everyone's frame lacks.
    let unseen = groups(&[(0, 3)], &[(0, 7, n(1, 0, 0))], None).unwrap();
    assert_eq!(
        CurrentFrames::new(Some(unseen), Some(all.clone())),
        Err(Refusal::FrameInconsistent {
            comment: c(7),
            field: "agreed"
        })
    );
    // Members 7 against 6 participants.
    let few = e(&[(1, n(4, 2, 0))], 6).unwrap();
    assert_eq!(
        CurrentFrames::new(Some(grouped.clone()), Some(few)),
        Err(Refusal::MembersAboveParticipants)
    );
    // Either frame alone, or neither, is accepted: they need not agree with
    // anything else.
    assert!(CurrentFrames::new(Some(grouped), None).is_ok());
    assert!(CurrentFrames::new(None, Some(all)).is_ok());
    assert!(CurrentFrames::new(None, None).is_ok());
}

#[test]
fn importance_marks_and_their_joint_validation() {
    assert_eq!(Marks::new(3, 2), Err(Refusal::MarksAboveEligible));
    let m = |a, b| Marks::new(a, b).unwrap();
    let per = |source: &str, cohort: &str, cells: &[(u32, Marks)]| {
        CommentMarks::new(
            src(source),
            src(cohort),
            cells.iter().map(|(id, k)| (c(*id), *k)),
        )
        .unwrap()
    };
    assert_eq!(
        CommentMarks::new(src("m"), src("latest"), [(c(1), m(0, 1)), (c(1), m(0, 1))]),
        Err(Refusal::DuplicateComment(c(1)))
    );
    let totals = MarkTotals::new(src("m"), src("latest"), m(5, 40));
    let none = CurrentFrames::default();
    // 2 + 3 = 5 marked against a total of 5: accepted; 6 refused.
    assert!(
        ImportanceMarks::new(
            Some(per("m", "latest", &[(1, m(2, 9)), (2, m(3, 3))])),
            Some(totals.clone()),
            None,
            &none
        )
        .is_ok()
    );
    assert_eq!(
        ImportanceMarks::new(
            Some(per("m", "latest", &[(1, m(3, 9)), (2, m(3, 3))])),
            Some(totals.clone()),
            None,
            &none
        ),
        Err(Refusal::MarksAboveTotal)
    );
    // Different source, or different cohort, from the totals.
    for (s, k) in [("other", "latest"), ("m", "every mark")] {
        assert_eq!(
            ImportanceMarks::new(Some(per(s, k, &[])), Some(totals.clone()), None, &none),
            Err(Refusal::MarksSourceMismatch)
        );
    }
    // Unavailable parts are accepted as unavailable.
    assert!(ImportanceMarks::new(None, Some(totals.clone()), None, &none).is_ok());
    assert!(ImportanceMarks::new(Some(per("x", "y", &[])), None, None, &none).is_ok());

    // Group marks: only with a group frame of the same source, a member group,
    // and eligible at most the members.
    let gm = |source: &str, cells: &[(u32, u32, Marks)]| {
        GroupMarks::new(
            src(source),
            src("latest"),
            cells.iter().map(|(gid, cid, k)| (g(*gid), c(*cid), *k)),
        )
        .unwrap()
    };
    assert_eq!(
        GroupMarks::new(
            src("m"),
            src("latest"),
            [(g(0), c(1), m(0, 0)), (g(0), c(1), m(0, 0))]
        ),
        Err(Refusal::DuplicateCell {
            group: g(0),
            comment: c(1)
        })
    );
    let frame =
        CurrentFrames::new(Some(groups(&[(0, 3), (2, 4)], &[], None).unwrap()), None).unwrap();
    // The group frame's source is "tick 4 groups".
    let ok = gm("tick 4 groups", &[(0, 1, m(1, 3)), (2, 1, m(4, 4))]);
    assert!(ImportanceMarks::new(None, None, Some(ok.clone()), &frame).is_ok());
    assert_eq!(
        ImportanceMarks::new(None, None, Some(ok), &none),
        Err(Refusal::GroupMarksWithoutGroups)
    );
    assert_eq!(
        ImportanceMarks::new(None, None, Some(gm("elsewhere", &[])), &frame),
        Err(Refusal::GroupMarksWithoutGroups)
    );
    assert_eq!(
        ImportanceMarks::new(
            None,
            None,
            Some(gm("tick 4 groups", &[(1, 1, m(0, 1))])),
            &frame
        ),
        Err(Refusal::UnknownGroup {
            group: g(1),
            comment: c(1)
        })
    );
    assert_eq!(
        ImportanceMarks::new(
            None,
            None,
            Some(gm("tick 4 groups", &[(0, 1, m(0, 4))])),
            &frame
        ),
        Err(Refusal::MarksAboveMembers {
            group: g(0),
            comment: c(1)
        })
    );
}

#[test]
fn voter_weight_frame() {
    let vw = |cells: &[(u32, u64, f64)], tv, ts| {
        VoterWeightFrame::new(
            src("w"),
            cells.iter().map(|(id, v, s)| (c(*id), *v, *s)),
            tv,
            ts,
        )
    };
    // The issue's three voters on one comment: 51 + 26 + 1 = 78.
    let f = vw(&[(1, 3, 78.0), (2, 0, 0.0)], 10, 90.0).unwrap();
    assert_eq!(f.get(c(1)).unwrap().weight_sum(), 78.0);
    assert_eq!(f.get(c(3)), None);
    assert_eq!(f.totals().voters(), 10);
    for (bad, at) in [
        ((1, 3, 2.5), Some(c(1))),      // below its voters
        ((1, 0, 1.0), Some(c(1))),      // non-zero with no voters
        ((1, 1, f64::NAN), Some(c(1))), // not finite
        ((1, 1, f64::INFINITY), Some(c(1))),
    ] {
        assert_eq!(vw(&[bad], 10, 90.0), Err(Refusal::InvalidVoterWeight(at)));
    }
    assert_eq!(vw(&[], 3, 2.0), Err(Refusal::InvalidVoterWeight(None)));
    assert_eq!(
        vw(&[(1, 1, 1.0), (1, 1, 1.0)], 10, 90.0),
        Err(Refusal::DuplicateComment(c(1)))
    );
    assert_eq!(
        vw(&[(1, 6, 6.0), (2, 5, 5.0)], 10, 90.0),
        Err(Refusal::VoterWeightAboveTotal)
    );
    assert_eq!(
        vw(&[(1, 3, 78.0), (2, 5, 13.0)], 10, 90.0),
        Err(Refusal::VoterWeightAboveTotal)
    );
    // -0.0 is stored as +0.
    let z = vw(&[(1, 0, -0.0)], 0, 0.0).unwrap();
    assert!(z.get(c(1)).unwrap().weight_sum().is_sign_positive());
}

#[test]
fn frame_constructors_never_panic() {
    let mut rng = XorShift::new(0xF4A3E5);
    for _ in 0..2000 {
        let pick = |r: &mut XorShift| match r.below(4) {
            0 => 0,
            1 => 1,
            2 => u32::MAX,
            _ => r.below(6) as u32,
        };
        let groups_n = rng.below(65) as usize;
        let members: Vec<_> = (0..groups_n)
            .map(|_| (g(pick(&mut rng)), pick(&mut rng)))
            .collect();
        let cells: Vec<_> = (0..rng.below(20))
            .map(|_| {
                (
                    g(pick(&mut rng)),
                    c(pick(&mut rng)),
                    n(pick(&mut rng), pick(&mut rng), pick(&mut rng)),
                )
            })
            .collect();
        let participants = match rng.below(3) {
            0 => None,
            1 => Some(u64::MAX),
            _ => Some(rng.below(10)),
        };
        let everyone: Vec<_> = (0..rng.below(8))
            .map(|_| {
                (
                    c(pick(&mut rng)),
                    n(pick(&mut rng), pick(&mut rng), pick(&mut rng)),
                )
            })
            .collect();
        let (s1, s2) = (rng.any_f64(), rng.any_f64());
        let (v1, v2) = (rng.next(), rng.below(5));
        let ok = catch_unwind(AssertUnwindSafe(|| {
            let gf = CurrentGroupFrame::new(src("g"), members.clone(), cells.clone(), participants);
            let ef = EveryoneFrame::new(src("e"), participants.unwrap_or(7), everyone.clone());
            let _ = CurrentFrames::new(gf.ok(), ef.ok());
            let _ = VoterWeightFrame::new(src("w"), [(c(1), v2, s1)], v1, s2);
            let _ = Marks::new(v1, v2);
        }));
        assert!(ok.is_ok());
    }
}
