//! Counterexamples kept as tests, not promises of immunity. Each test shows
//! that a stated weakness of the group-informed consensus factor, or of a
//! rule built on it, is real, with the arithmetic written out beside the
//! assertions: a brigade inside one fixed group lifts a comment; splitting
//! one group into two, with no vote changed, moves the factor either way;
//! and swapping every agree and disagree changes the floor rule's chances.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use polis_routing_equation::*;

const X: CommentId = CommentId::new(0);
const Y: CommentId = CommentId::new(1);
const MEAN: ConsensusForm = ConsensusForm::GicMean1;
const GEO: ConsensusForm = ConsensusForm::GicGeomean1;

fn source(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

/// A group frame from (group id, members, cells as (comment, agreed,
/// disagreed, passed)).
type Group<'a> = (u32, u32, &'a [(CommentId, u32, u32, u32)]);

fn groups(spec: &[Group<'_>]) -> CurrentGroupFrame {
    let members = spec.iter().map(|(g, m, _)| (GroupId::new(*g), *m));
    let cells = spec.iter().flat_map(|(g, _, cells)| {
        cells
            .iter()
            .map(|(c, a, d, p)| (GroupId::new(*g), *c, Counts::new(*a, *d, *p)))
    });
    CurrentGroupFrame::new(source("groups"), members, cells, None).unwrap()
}

fn g(form: ConsensusForm, frame: &CurrentGroupFrame, c: CommentId) -> f64 {
    consensus(form, &GicParams::default(), frame, c)
        .g()
        .unwrap()
}

fn close(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() < 1e-12, "{what}: {a} against {b}");
}

/// A brigade inside one fixed group. Two groups of 10. Comment X: each group
/// has 2 agrees and 2 disagrees, so each group's share is (2 + 1) / (4 + 2)
/// = 1/2 and G = 1/2 under both forms. Comment Y: each group has 5 agrees
/// and 3 disagrees, (5 + 1) / (8 + 2) = 0.6, so G = 0.6: both groups lean
/// toward it.
///
/// Six members of group 1 who had not voted on X now all agree with it; the
/// groups are not refitted. Group 1's share for X becomes (8 + 1) / (10 + 2)
/// = 3/4, group 0's stays 1/2:
/// - mean: (1/2 + 3/4) / 2 = 0.625;
/// - geometric mean: sqrt(1/2 x 3/4) = sqrt(0.375) = 0.6123724356957945.
///
/// Both exceed Y's 0.6: a comment group 0 is still split on now has more
/// group-informed consensus than one both groups lean toward. The factor
/// reads groups as they are drawn; coordinated votes inside one group move it.
#[test]
fn a_brigade_inside_one_fixed_group_lifts_a_comment_above_a_shared_one() {
    let before = groups(&[
        (0, 10, &[(X, 2, 2, 0), (Y, 5, 3, 0)]),
        (1, 10, &[(X, 2, 2, 0), (Y, 5, 3, 0)]),
    ]);
    let after = groups(&[
        (0, 10, &[(X, 2, 2, 0), (Y, 5, 3, 0)]),
        (1, 10, &[(X, 8, 2, 0), (Y, 5, 3, 0)]),
    ]);
    for form in [MEAN, GEO] {
        close(g(form, &before, X), 0.5, "X before");
        close(g(form, &before, Y), 0.6, "Y");
        close(g(form, &after, Y), 0.6, "Y after");
        assert!(g(form, &before, X) < g(form, &before, Y));
        assert!(g(form, &after, X) > g(form, &after, Y));
    }
    close(g(MEAN, &after, X), 0.625, "X after, mean");
    close(
        g(GEO, &after, X),
        0.375f64.sqrt(),
        "X after, geometric mean",
    );
    close(0.375f64.sqrt(), 0.6123724356957945, "sqrt(0.375)");
}

/// One group split in two, with no vote changed. Comment X has 18 agrees
/// and 18 disagrees in all, so its count term is the same in every case
/// below; only the grouping differs.
///
/// Two groups of 20: group A agrees 18 to 0, (18 + 1) / (18 + 2) = 19/20;
/// group B disagrees 0 to 18, (0 + 1) / (18 + 2) = 1/20.
/// - mean: (19/20 + 1/20) / 2 = 1/2;
/// - geometric mean: sqrt(19/20 x 1/20) = sqrt(19/400) = 0.21794494717703367.
///
/// A split into A1 and A2 of 10 each, 9 to 0, each (9 + 1) / (9 + 2) = 10/11:
/// - mean: (10/11 + 10/11 + 1/20) / 3 = (200 + 200 + 11) / 660 = 411/660;
/// - geometric mean: (10/11 x 10/11 x 1/20)^(1/3) = (5/121)^(1/3).
///
/// B split instead into B1 and B2, 0 to 9 each, (0 + 1) / (9 + 2) = 1/11:
/// - mean: (19/20 + 1/11 + 1/11) / 3 = (209 + 20 + 20) / 660 = 249/660;
/// - geometric mean: (19/20 x 1/11 x 1/11)^(1/3) = (19/2420)^(1/3).
///
/// Splitting the agreeing group raises G and splitting the dissenting group
/// lowers it, under both forms: G depends on how the clustering cuts the
/// participants, not on the votes alone.
#[test]
fn splitting_one_group_with_no_vote_changed_moves_the_factor_either_way() {
    let two = groups(&[(0, 20, &[(X, 18, 0, 0)]), (1, 20, &[(X, 0, 18, 0)])]);
    let split_a = groups(&[
        (0, 10, &[(X, 9, 0, 0)]),
        (2, 10, &[(X, 9, 0, 0)]),
        (1, 20, &[(X, 0, 18, 0)]),
    ]);
    let split_b = groups(&[
        (0, 20, &[(X, 18, 0, 0)]),
        (1, 10, &[(X, 0, 9, 0)]),
        (3, 10, &[(X, 0, 9, 0)]),
    ]);
    close(g(MEAN, &two, X), 0.5, "two groups, mean");
    close(
        g(GEO, &two, X),
        (19.0f64 / 400.0).sqrt(),
        "two groups, geomean",
    );
    close(
        (19.0f64 / 400.0).sqrt(),
        0.21794494717703367,
        "sqrt(19/400)",
    );
    close(g(MEAN, &split_a, X), 411.0 / 660.0, "A split, mean");
    close(
        g(GEO, &split_a, X),
        (5.0f64 / 121.0).cbrt(),
        "A split, geomean",
    );
    close(g(MEAN, &split_b, X), 249.0 / 660.0, "B split, mean");
    close(
        g(GEO, &split_b, X),
        (19.0f64 / 2420.0).cbrt(),
        "B split, geomean",
    );
    for form in [MEAN, GEO] {
        assert!(g(form, &split_a, X) > g(form, &two, X));
        assert!(g(form, &split_b, X) < g(form, &two, X));
    }
}

/// Swapping every agree and disagree changes `symmetric-gic-floor/1`'s
/// chances, at its defaults (geometric mean, floor share 0.1), with E held
/// at 0.5 for both comments (in a real conversation the swap would move E
/// too; holding it fixed isolates the factor).
///
/// Two groups of 10. Comment X: each group 9 agrees, 1 disagree (in all 18
/// and 2). Comment Y: each group 5 and 5 (in all 10 and 10), its own mirror.
/// Both have S = 20 votes and R = (A + D + 1) / (S + 2) = 21/22, so their
/// `symmetric/1` weights are the same number s. The factors, 0.5 + G:
/// - X: (9 + 1) / (10 + 2) = 5/6 in each group, G = 5/6, factor 4/3;
/// - Y: (5 + 1) / 12 = 1/2, G = 1/2, factor 1.
///
/// Chances, q = 0.1 / 2 + 0.9 x w / W:
/// - X: 0.05 + 0.9 x (4/3) / (4/3 + 1) = 0.05 + 0.9 x 4/7 = 0.5642857142857143;
/// - Y: 0.05 + 0.9 x 3/7 = 0.4357142857142857.
///
/// Swapped, X's groups are 1 agree and 9 disagrees: (1 + 1) / 12 = 1/6,
/// factor 2/3; Y is unchanged:
/// - X: 0.05 + 0.9 x (2/3) / (2/3 + 1) = 0.05 + 0.9 x 2/5 = 0.41;
/// - Y: 0.05 + 0.9 x 3/5 = 0.59.
///
/// The more likely comment changes. The floor keeps both at least 0.05.
#[test]
fn swapping_every_agree_and_disagree_changes_the_floor_rules_chances() {
    let p = FloorParams::default();
    let none = MetaComments::none();
    let e = ExtremityFrame::new(
        source("current"),
        [X, Y].map(|c| (c, Extremity::new(0.5).unwrap())),
    )
    .unwrap();
    let chances = |x: (u32, u32), group_x: (u32, u32)| {
        let counts = HistoricalCountFrame::new(
            source("previous"),
            [(X, Counts::new(x.0, x.1, 0)), (Y, Counts::new(10, 10, 0))],
        )
        .unwrap();
        let cells = [(X, group_x.0, group_x.1, 0), (Y, 5, 5, 0)];
        let frame = groups(&[(0, 10, &cells), (1, 10, &cells)]);
        let w = symmetric_gic_1(p.base(), &counts, &e, &frame, &none).unwrap();
        let plan = symmetric_gic_floor_1(&p, w, &none).unwrap();
        let d = plan
            .probabilities(&Candidates::new(vec![X, Y]).unwrap())
            .unwrap()
            .draw_weights()
            .to_vec();
        let total = d[0] + d[1];
        [d[0] / total, d[1] / total]
    };
    let before = chances((18, 2), (9, 1));
    let after = chances((2, 18), (1, 9));
    close(before[0], 0.05 + 0.9 * 4.0 / 7.0, "X before");
    close(before[1], 0.05 + 0.9 * 3.0 / 7.0, "Y before");
    close(before[0], 0.5642857142857143, "X before, decimal");
    close(after[0], 0.41, "X swapped");
    close(after[1], 0.59, "Y swapped");
    assert!(before[0] > before[1] && after[0] < after[1]);
    assert!(
        after
            .iter()
            .chain(before.iter())
            .all(|q| *q >= 0.05 - 1e-12)
    );
}
