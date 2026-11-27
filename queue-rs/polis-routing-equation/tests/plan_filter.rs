//! `FloorPlan::excludes`: the plan's own exclusion check, so that a caller
//! can filter the candidate query's rows in one pass with the plan's
//! snapshot of meta state and no second copy of it. Explicit cases: every
//! candidate meta (empty after the filter, so today's path serves); a
//! comment that became meta after the plan was built (the plan's snapshot
//! decides, so it is not excluded and is drawn); a meta comment in neither
//! scoring frame (excluded under `exclude`); an id the plan does not know
//! (not excluded; the draw refuses it as `NeedsBaseline`); and the other two
//! policies, under which no meta comment is excluded.
//!
//! Constructed data only: named, unsigned counts; no vote value anywhere.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_equation::{
    Candidates, CommentId, ConsensusForm, Counts, CurrentGroupFrame, DrawRefusal, Extremity,
    ExtremityFrame, FloorParams, FloorPlan, GicParams, GroupId, HistoricalCountFrame, MetaComments,
    MetaPolicy, SourceId, SymmetricGicParams, SymmetricParams, Unit, symmetric_gic_1,
    symmetric_gic_floor_1,
};

fn src(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

fn id(n: u32) -> CommentId {
    CommentId::new(n)
}

/// Comments 1 to 10 scored in two groups; 11 has extremity only (unscored);
/// `meta` declared meta (it may name ids in neither frame).
fn plan(policy: MetaPolicy, meta: &[u32]) -> FloorPlan {
    let scored: Vec<u32> = (1..=10).collect();
    let counts = HistoricalCountFrame::new(
        src("constructed:counts"),
        scored.iter().map(|n| {
            (
                id(*n),
                Counts::from_seen(*n, 1, u64::from(2 * n + 3)).unwrap(),
            )
        }),
    )
    .unwrap();
    let extremity = ExtremityFrame::new(
        src("constructed:extremity"),
        (1..=11).map(|n| (id(n), Extremity::new(0.1 * f64::from(n)).unwrap())),
    )
    .unwrap();
    let cells = scored.iter().flat_map(|n| {
        [0u32, 1].map(|g| (GroupId::new(g), id(*n), Counts::from_seen(1, 1, 4).unwrap()))
    });
    let groups = CurrentGroupFrame::new(
        src("constructed:groups"),
        [(GroupId::new(0), 50), (GroupId::new(1), 50)],
        cells,
        None,
    )
    .unwrap();
    let meta = MetaComments::new(meta.iter().map(|n| id(*n))).unwrap();
    let base = SymmetricParams::new(1.0, 2.0, 1.0, 8.0, 5.0, 2, 7.0, policy).unwrap();
    let params = FloorParams::new(
        SymmetricGicParams::new(base, ConsensusForm::GicGeomean1, GicParams::default()),
        0.1,
    )
    .unwrap();
    let w = symmetric_gic_1(params.base(), &counts, &extremity, &groups, &meta).unwrap();
    symmetric_gic_floor_1(&params, w, &meta).unwrap()
}

fn filtered(p: &FloorPlan, rows: &[u32]) -> Vec<CommentId> {
    rows.iter()
        .map(|n| id(*n))
        .filter(|c| !p.excludes(*c))
        .collect()
}

fn draw(p: &FloorPlan, ids: Vec<CommentId>) -> Result<CommentId, DrawRefusal> {
    let c = Candidates::new(ids)?;
    let u = Unit::new(0.5).unwrap();
    p.draw(&c, u, &src("plan"), &src("participant"))
        .map(|d| d.comment())
}

#[test]
fn every_candidate_meta_leaves_nothing_and_todays_path_serves() {
    let p = plan(MetaPolicy::Exclude, &[2, 4, 6]);
    assert_eq!(filtered(&p, &[6, 2, 4]), vec![]);
    assert_eq!(draw(&p, filtered(&p, &[6, 2, 4])), Err(DrawRefusal::Empty));
}

#[test]
fn the_plans_snapshot_decides_not_current_meta_state() {
    // Comment 3 became meta after this plan was built: the plan does not
    // know it as meta, so it is not excluded and may be drawn.
    let p = plan(MetaPolicy::Exclude, &[2]);
    assert!(!p.excludes(id(3)));
    assert_eq!(filtered(&p, &[3]), vec![id(3)]);
    assert_eq!(draw(&p, vec![id(3)]), Ok(id(3)));
}

#[test]
fn a_meta_comment_in_neither_frame_is_excluded() {
    let p = plan(MetaPolicy::Exclude, &[2, 40]);
    assert!(p.excludes(id(40)) && p.excludes(id(2)));
    assert!(p.weights().excluded().any(|c| c == id(40)));
    assert_eq!(filtered(&p, &[5, 40, 2, 11, 1]), vec![id(5), id(11), id(1)]);
    // Unfiltered, the draw refuses the first excluded candidate.
    assert_eq!(
        draw(&p, vec![id(5), id(40), id(2)]),
        Err(DrawRefusal::ExcludedCandidate(id(40)))
    );
    assert!(draw(&p, filtered(&p, &[5, 40, 2, 11, 1])).is_ok());
}

#[test]
fn an_unknown_id_is_not_excluded_and_the_draw_refuses_it() {
    let p = plan(MetaPolicy::Exclude, &[2]);
    assert!(!p.excludes(id(999)));
    assert_eq!(filtered(&p, &[1, 999]), vec![id(1), id(999)]);
    assert_eq!(
        draw(&p, filtered(&p, &[1, 999])),
        Err(DrawRefusal::NeedsBaseline(id(999)))
    );
}

#[test]
fn under_the_other_policies_no_meta_comment_is_excluded() {
    for policy in [MetaPolicy::Fixed, MetaPolicy::Ordinary] {
        let p = plan(policy, &[2, 4]);
        assert!(!p.excludes(id(2)) && !p.excludes(id(4)));
        assert_eq!(filtered(&p, &[4, 2, 1]), vec![id(4), id(2), id(1)]);
        assert!(draw(&p, filtered(&p, &[4, 2, 1])).is_ok());
    }
}
