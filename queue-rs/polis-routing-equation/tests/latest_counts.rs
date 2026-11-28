//! The count-input policy and the latest-count frame: its names, its one
//! constructor, what it holds, and where it refuses. All data constructed;
//! every id is made up.

#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

mod support;

use polis_routing_equation::{
    CommentId, CountPolicy, Counts, CurrentGroupFrame, GroupId, LatestCountFrame, Refusal,
};
use std::panic::{AssertUnwindSafe, catch_unwind};
use support::{XorShift, src};

const MAX: u32 = u32::MAX;

fn g(id: u32) -> GroupId {
    GroupId::new(id)
}
fn c(id: u32) -> CommentId {
    CommentId::new(id)
}
fn seen(a: u32, d: u32, s: u64) -> Counts {
    Counts::from_seen(a, d, s).unwrap()
}

fn frame(
    members: &[(u32, u32)],
    cells: &[(u32, u32, Counts)],
) -> Result<CurrentGroupFrame, Refusal> {
    CurrentGroupFrame::new(
        src("tick-b"),
        members.iter().map(|&(group, n)| (g(group), n)),
        cells
            .iter()
            .map(|&(group, comment, k)| (g(group), c(comment), k)),
        None,
    )
}

fn latest(
    members: &[(u32, u32)],
    cells: &[(u32, u32, Counts)],
) -> Result<LatestCountFrame, Refusal> {
    LatestCountFrame::from_groups(&frame(members, cells).unwrap())
}

/// The witness's update u: groups 0 (4 members) and 2 (3 members).
fn witness_cells() -> Vec<(u32, u32, Counts)> {
    vec![
        (0, 7, seen(3, 0, 4)),
        (0, 8, seen(1, 1, 2)),
        (2, 7, seen(0, 2, 2)),
        (2, 8, seen(0, 1, 3)),
    ]
}

#[test]
fn the_policies_have_exactly_two_names() {
    assert_eq!(CountPolicy::Lag1.name(), "base-counts:lag-1");
    assert_eq!(CountPolicy::Lag0.name(), "base-counts:lag-0");
    for p in CountPolicy::ALL {
        assert_eq!(CountPolicy::from_name(p.name()), Some(p));
    }
    for asked in [
        "",
        "lag-0",
        "lag-1",
        "base-counts:lag-2",
        "base-counts:lag0",
        "Base-counts:lag-0",
        "base-counts:lag-0 ",
        " base-counts:lag-1",
        "base-counts",
    ] {
        assert_eq!(CountPolicy::from_name(asked), None, "{asked:?}");
    }
}

#[test]
fn the_witness_sums_over_its_groups() {
    let l = latest(&[(0, 4), (2, 3)], &witness_cells()).unwrap();
    assert_eq!(l.source().as_str(), "tick-b");
    assert_eq!(l.get(c(7)), Some(Counts::new(3, 2, 1)));
    assert_eq!(l.get(c(8)), Some(Counts::new(1, 2, 2)));
    assert_eq!(l.ids().collect::<Vec<_>>(), vec![c(7), c(8)]);
    assert_eq!(l.len(), 2);
}

#[test]
fn zero_groups_refuse_and_groups_without_cells_are_an_empty_frame() {
    let none = CurrentGroupFrame::new(src("tick-b"), [], [], None).unwrap();
    assert_eq!(
        LatestCountFrame::from_groups(&none),
        Err(Refusal::NoLatestCounts)
    );
    let none_declared = CurrentGroupFrame::new(src("tick-b"), [], [], Some(12)).unwrap();
    assert_eq!(
        LatestCountFrame::from_groups(&none_declared),
        Err(Refusal::NoLatestCounts)
    );
    let l = latest(&[(0, 4), (5, 1)], &[]).unwrap();
    assert!(l.is_empty());
    assert_eq!(l.len(), 0);
    assert_eq!(l.get(c(7)), None);
    assert_eq!(l.source().as_str(), "tick-b");
}

#[test]
fn one_group_is_its_own_sum() {
    let l = latest(&[(3, 5)], &[(3, 1, seen(2, 1, 5))]).unwrap();
    assert_eq!(l.get(c(1)), Some(Counts::new(2, 1, 2)));
}

#[test]
fn a_present_zero_cell_is_present_and_an_absent_one_is_absent() {
    // Comment 9 has a cell of zeros in group 0 only; comment 10 has none.
    let l = latest(
        &[(0, 4), (2, 3)],
        &[(0, 9, Counts::new(0, 0, 0)), (2, 7, seen(1, 0, 1))],
    )
    .unwrap();
    assert_eq!(l.get(c(9)), Some(Counts::new(0, 0, 0)));
    assert_eq!(l.get(c(7)), Some(Counts::new(1, 0, 0)));
    assert_eq!(l.get(c(10)), None);
    assert_eq!(l.ids().collect::<Vec<_>>(), vec![c(7), c(9)]);
}

#[test]
fn the_order_and_the_ids_of_groups_change_nothing() {
    let first = latest(&[(0, 4), (2, 3)], &witness_cells()).unwrap();
    // The same groups given in reverse, and renamed 0 -> 41 and 2 -> 6.
    let rename = |group: u32| if group == 0 { 41 } else { 6 };
    let mut cells: Vec<_> = witness_cells()
        .into_iter()
        .map(|(group, comment, k)| (rename(group), comment, k))
        .collect();
    cells.reverse();
    let second = latest(&[(6, 3), (41, 4)], &cells).unwrap();
    assert_eq!(first, second);
}

#[test]
fn each_count_may_reach_u32_max_and_seen_may_pass_it() {
    // One group at the limit.
    let l = latest(&[(0, MAX)], &[(0, 1, Counts::new(MAX, 0, 0))]).unwrap();
    assert_eq!(l.get(c(1)), Some(Counts::new(MAX, 0, 0)));
    // Each of the three counts at the limit, from three groups: accepted,
    // with a seen count of three times u32::MAX.
    let l = latest(
        &[(0, MAX), (1, MAX), (2, MAX)],
        &[
            (0, 1, Counts::new(MAX, 0, 0)),
            (1, 1, Counts::new(0, MAX, 0)),
            (2, 1, Counts::new(0, 0, MAX)),
        ],
    )
    .unwrap();
    let k = l.get(c(1)).unwrap();
    assert_eq!((k.agreed(), k.disagreed(), k.passed()), (MAX, MAX, MAX));
    assert_eq!(k.seen(), 3 * u64::from(MAX));
    assert!(k.seen() > u64::from(MAX));
    // Sums that reach the limit exactly from two groups are accepted.
    let l = latest(
        &[(0, MAX), (1, 1)],
        &[
            (0, 1, Counts::new(MAX - 1, 0, 0)),
            (1, 1, Counts::new(1, 0, 0)),
        ],
    )
    .unwrap();
    assert_eq!(l.get(c(1)), Some(Counts::new(MAX, 0, 0)));
}

#[test]
fn a_summed_count_above_u32_max_refuses_the_frame() {
    let one_over =
        |k: fn(u32) -> Counts| latest(&[(0, MAX), (1, 1)], &[(0, 1, k(MAX)), (1, 1, k(1))]);
    assert_eq!(
        one_over(|n| Counts::new(n, 0, 0)),
        Err(Refusal::CountOverflow)
    );
    assert_eq!(
        one_over(|n| Counts::new(0, n, 0)),
        Err(Refusal::CountOverflow)
    );
    assert_eq!(
        one_over(|n| Counts::new(0, 0, n)),
        Err(Refusal::CountOverflow)
    );
}

#[test]
fn the_whole_frame_is_checked_not_only_the_comments_a_rule_would_score() {
    // Comment 7 is ordinary; comment 99 overflows. A rule might exclude 99
    // or find no extremity for it; the frame is refused all the same.
    let r = latest(
        &[(0, MAX), (1, 4)],
        &[
            (0, 7, seen(1, 0, 1)),
            (1, 7, seen(0, 1, 1)),
            (0, 99, Counts::new(0, MAX, 0)),
            (1, 99, Counts::new(0, 1, 0)),
        ],
    );
    assert_eq!(r, Err(Refusal::CountOverflow));
}

#[test]
fn the_constructor_never_panics_on_constructed_frames() {
    let mut rng = XorShift::new(0x4c61_7465_7374);
    for _ in 0..2_000 {
        let groups = rng.below(5) as u32;
        let members: Vec<(u32, u32)> = (0..groups)
            .map(|i| {
                let n = if rng.below(4) == 0 {
                    MAX
                } else {
                    1 + rng.below(9) as u32
                };
                (i * 3, n)
            })
            .collect();
        let mut cells = vec![];
        for &(group, n) in &members {
            for comment in 0..4u32 {
                if rng.below(3) == 0 {
                    continue;
                }
                let a = rng.below(u64::from(n) + 1) as u32;
                let d = rng.below(u64::from(n - a) + 1) as u32;
                let p = rng.below(u64::from(n - a - d) + 1) as u32;
                cells.push((group, comment, Counts::new(a, d, p)));
            }
        }
        let Ok(f) = frame(&members, &cells) else {
            continue;
        };
        let result = catch_unwind(AssertUnwindSafe(|| LatestCountFrame::from_groups(&f)));
        let result = result.unwrap_or_else(|_| panic!("panicked on {members:?} {cells:?}"));
        match result {
            Err(Refusal::NoLatestCounts) => assert!(members.is_empty()),
            Err(Refusal::CountOverflow) => {}
            Err(other) => panic!("{other:?}"),
            Ok(l) => {
                // Every present comment is the exact sum of its cells.
                for id in l.ids() {
                    let s = f.summed(id);
                    let k = l.get(id).unwrap();
                    assert_eq!([k.agreed(), k.disagreed(), k.passed()].map(u64::from), s);
                }
                assert_eq!(
                    l.ids().collect::<std::collections::BTreeSet<_>>(),
                    f.comment_ids()
                );
            }
        }
    }
}
