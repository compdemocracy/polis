//! The plan build and the one-call draw, on constructed conversations.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, DrawRefusal, HistoricalCountFrame, HistoricalParams, MetaComments,
    MetaPolicy, ParamSet, RuleId, SourceId, StoredWeights, Unit, historical_1, stored_weights_1,
    symmetric_gic_2, symmetric_gic_floor_2, uniform_1,
};
use polis_routing_equation::{Counts, Extremity, ExtremityFrame};
use polis_routing_plan::{
    BuildRefusal, Fallback, MAX_EXCLUDE_META_COMMENTS, MAX_PLAN_CANDIDATES, NeededFrame, Plan,
    PlanKind, RuleConfig,
};
use serde_json::{Map, Value, json};
use support::*;

fn ids(list: &[i32]) -> Vec<CommentId> {
    list.iter().map(|t| CommentId::new(*t as u32)).collect()
}

/// Every rule the library knows, at its default parameters: three are
/// built, every other pair is refused.
#[test]
fn unsupported_pairs_refuse() {
    for rule in RuleId::ALL {
        let plain = ParamSet::default_for(rule).to_plain();
        let policy = rule.count_policy().map(|p| p.name());
        let got = RuleConfig::parse(&plain, policy);
        match rule {
            RuleId::StoredWeights1 => assert_eq!(got, Ok(RuleConfig::StoredWeights1)),
            RuleId::Uniform1 => assert_eq!(got, Ok(RuleConfig::Uniform1)),
            RuleId::SymmetricGicFloor2 => {
                let config = got.unwrap();
                assert_eq!(config.to_plain(), plain);
            }
            _ => assert_eq!(got, Err(BuildRefusal::Unsupported), "{}", rule.name()),
        }
    }
    let floor = ParamSet::default_for(RuleId::SymmetricGicFloor2).to_plain();
    // The policy is named, and only where the rule reads base counts.
    for bad in [None, Some("base-counts:lag-1"), Some("lag-0")] {
        assert_eq!(
            RuleConfig::parse(&floor, bad),
            Err(BuildRefusal::InvalidConfig)
        );
    }
    let uniform = ParamSet::Uniform1.to_plain();
    assert_eq!(
        RuleConfig::parse(&uniform, Some("base-counts:lag-0")),
        Err(BuildRefusal::InvalidConfig)
    );
    // One spelling: the canonical form only.
    let spaced = uniform.replace(",", ", ");
    assert_eq!(
        RuleConfig::parse(&spaced, None),
        Err(BuildRefusal::InvalidConfig)
    );
    assert_eq!(
        RuleConfig::parse("not json", None),
        Err(BuildRefusal::InvalidConfig)
    );
    // Each rule's frames.
    assert!(stored().needs().stored_weights && !stored().needs().groups);
    assert_eq!(uniform_config_needs(), Default::default());
    let f = support::floor(MetaPolicy::Exclude, 0.1).needs();
    assert!(f.extremity && f.groups && f.meta && !f.stored_weights);
}

fn uniform_config_needs() -> polis_routing_plan::FrameNeeds {
    support::uniform().needs()
}

/// Frames read without a frame the rule needs are refused, never read as
/// "no map".
#[test]
fn missing_frames_refuse() {
    let c = conversation(3, 20, 2, 4, 0, Priorities::Mixed);
    let none = frames(&c.value, &support::uniform());
    assert_eq!(
        Plan::build(&none, &stored()),
        Err(BuildRefusal::MissingFrame {
            frame: NeededFrame::StoredWeights
        })
    );
    assert_eq!(
        Plan::build(&none, &support::floor(MetaPolicy::Fixed, 0.1)),
        Err(BuildRefusal::MissingFrame {
            frame: NeededFrame::Extremity
        })
    );
    assert_eq!(
        Plan::build(&none, &support::uniform()).unwrap().kind(),
        PlanKind::Uniform
    );
}

/// Two builds from the same bytes give byte-identical receipts for 10,000
/// seeded units.
#[test]
fn same_bundle_same_plan() {
    let c = conversation(11, 60, 3, 5, 3, Priorities::Mixed);
    for config in [
        support::floor(MetaPolicy::Exclude, 0.1),
        stored(),
        support::uniform(),
    ] {
        let a = Plan::build(&frames(&c.value, &config), &config).unwrap();
        let b = Plan::build(&frames(&c.value, &config), &config).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.charged_bytes(), b.charged_bytes());
        let mut rng = XorShift(99);
        for _ in 0..10_000 {
            let u = rng.unit();
            let x = a.draw(&c.tids, u).map(|d| d.drawn().to_plain());
            let y = b.draw(&c.tids, u).map(|d| d.drawn().to_plain());
            assert_eq!(x, y);
        }
    }
}

/// Each variant's receipt equals a direct call of its own library function
/// on the same inputs.
#[test]
fn variant_dispatch() {
    let mut rng = XorShift(5);
    for seed in 1..25 {
        let c = conversation(seed, 40, 3, 0, 0, Priorities::Mixed);
        let fixed = floor_params(MetaPolicy::Fixed, 0.25);
        let configs = [
            stored(),
            support::uniform(),
            RuleConfig::SymmetricGicFloor2(fixed),
        ];
        for config in configs {
            let f = frames(&c.value, &config);
            let plan = Plan::build(&f, &config).unwrap();
            let direct_floor = match config {
                RuleConfig::SymmetricGicFloor2(p) => {
                    let w = symmetric_gic_2(
                        p.base(),
                        f.groups().unwrap(),
                        f.extremity().unwrap(),
                        f.meta().unwrap(),
                    )
                    .unwrap();
                    let d = symmetric_gic_floor_2(&p, w, f.meta().unwrap()).unwrap();
                    assert_eq!(plan.floor(), Some(&d));
                    Some(d)
                }
                _ => None,
            };
            for _ in 0..40 {
                let list: Vec<i32> = c
                    .tids
                    .iter()
                    .copied()
                    .filter(|_| rng.below(3) > 0)
                    .collect();
                if list.is_empty() {
                    continue;
                }
                let u = rng.unit();
                let cands = Candidates::new(ids(&list)).unwrap();
                let unit = Unit::new(u).unwrap();
                let direct = match plan.kind() {
                    PlanKind::StoredWeights => {
                        stored_weights_1(f.stored(), &cands, unit, f.source())
                    }
                    PlanKind::Uniform => uniform_1(&cands, unit, f.source()),
                    PlanKind::Floor => {
                        direct_floor
                            .as_ref()
                            .unwrap()
                            .draw(&cands, unit, f.source(), f.source())
                    }
                };
                let got = plan.draw(&list, u);
                match (got, direct) {
                    (Ok(p), Ok(d)) => {
                        assert_eq!(p.drawn().to_plain(), d.to_plain());
                        assert_eq!(p.tid() as u32, d.comment().get());
                    }
                    (Err(p), Err(d)) => assert_eq!(p, Fallback::from_refusal(d)),
                    (p, d) => panic!("plan {p:?} against library {d:?}"),
                }
            }
        }
    }
}

/// The floor wrapper with `meta_policy = exclude` is the direct sequence:
/// leave out what `excludes` names, in order, then one `draw`.
#[test]
fn draw_is_sequence_s() {
    let mut rng = XorShift(17);
    for seed in 1..30 {
        let c = conversation(seed, 50, 1 + (seed % 4) as u32, 3, 4, Priorities::Absent);
        let config = support::floor(MetaPolicy::Exclude, [0.0, 0.1, 0.5][seed as usize % 3]);
        let f = frames(&c.value, &config);
        let plan = Plan::build(&f, &config).unwrap();
        let direct = plan.floor().unwrap().clone();
        for _ in 0..30 {
            let mut list: Vec<i32> = c
                .tids
                .iter()
                .copied()
                .filter(|_| rng.below(3) > 0)
                .collect();
            if rng.below(2) == 0 {
                list.push(c.meta[rng.below(c.meta.len() as u64) as usize]);
            }
            if rng.below(4) == 0 {
                list.push(9_999_999); // a comment newer than the read
            }
            let u = rng.unit();
            let kept: Vec<CommentId> = ids(&list)
                .into_iter()
                .filter(|i| !direct.excludes(*i))
                .collect();
            let expected = if kept.is_empty() && !list.is_empty() {
                Err(Fallback::AllExcluded)
            } else {
                Candidates::new(kept)
                    .and_then(|cands| direct.draw(&cands, Unit::new(u)?, f.source(), f.source()))
                    .map(|d| d.to_plain())
                    .map_err(Fallback::from_refusal)
            };
            assert_eq!(plan.draw(&list, u).map(|d| d.drawn().to_plain()), expected);
        }
    }
}

/// The comment to fetch is the receipt's comment, never the caller's list
/// indexed with the receipt's index, which counts the filtered list.
#[test]
fn fetch_id_is_receipt_id() {
    let config = support::floor(MetaPolicy::Exclude, 0.1);
    let sql = [10, 20, 30];
    // Original [10, 20, 30] with 10 excluded: filtered index 0 is 20.
    let plan = Plan::build(&frames(&tiny(&[10]), &config), &config).unwrap();
    let d = plan.draw(&sql, 0.0).unwrap();
    assert_eq!(d.drawn().index(), 0);
    assert_eq!(d.tid(), 20);
    assert_ne!(d.tid(), sql[d.drawn().index()]);
    for excluded in [10, 20, 30] {
        let plan = Plan::build(&frames(&tiny(&[excluded]), &config), &config).unwrap();
        let mut differs = false;
        for k in 0..1000 {
            let d = plan.draw(&sql, k as f64 / 1000.0).unwrap();
            assert_eq!(d.tid() as u32, d.drawn().comment().get());
            assert_ne!(d.tid(), excluded);
            differs |= sql[d.drawn().index()] != d.tid();
        }
        // Excluding the first or the middle shifts a position the draw
        // reaches; excluding the last shifts none.
        assert_eq!(differs, excluded != 30, "excluding {excluded}");
    }
}

#[test]
fn all_filtered_away_is_all_excluded() {
    let config = support::floor(MetaPolicy::Exclude, 0.1);
    let plan = Plan::build(&frames(&tiny(&[10, 30]), &config), &config).unwrap();
    assert_eq!(plan.draw(&[10, 30], 0.5), Err(Fallback::AllExcluded));
    assert_eq!(plan.draw(&[10], 0.5), Err(Fallback::AllExcluded));
    // No candidates at all is the query running dry, not exclusion.
    assert_eq!(plan.draw(&[], 0.5), Err(Fallback::Empty));
    assert_eq!(plan.draw(&[30, 20, 10], 0.5).unwrap().tid(), 20);
}

#[test]
fn unknown_invalid_duplicate_ids() {
    let config = support::floor(MetaPolicy::Exclude, 0.1);
    let plan = Plan::build(&frames(&tiny(&[10]), &config), &config).unwrap();
    assert_eq!(plan.draw(&[20, 77], 0.5), Err(Fallback::NeedsBaseline));
    assert_eq!(plan.draw(&[20, -5], 0.5), Err(Fallback::InvalidCandidateId));
    assert_eq!(
        plan.draw(&[i32::MIN], 0.5),
        Err(Fallback::InvalidCandidateId)
    );
    assert_eq!(
        plan.draw(&[20, 30, 20], 0.5),
        Err(Fallback::DuplicateCandidate)
    );
    let u = Plan::build(
        &frames(&tiny(&[]), &support::uniform()),
        &support::uniform(),
    )
    .unwrap();
    assert_eq!(u.draw(&[20, 20], 0.5), Err(Fallback::DuplicateCandidate));
    assert_eq!(u.draw(&[77, -5], 0.5), Err(Fallback::InvalidCandidateId));
    assert_eq!(u.draw(&[77], 0.5).unwrap().tid(), 77);
}

fn stored_plan(priorities: Value) -> Plan {
    let mut v = tiny(&[]);
    v.as_object_mut()
        .unwrap()
        .insert("comment-priorities".into(), priorities);
    Plan::build(&frames(&v, &stored()), &stored()).unwrap()
}

/// A negative stored weight is refused at the draw, so the route falls back
/// to today's selector (the read route weighs it as itself; the vote's
/// writer refuses it). The build does not reject it.
#[test]
fn stored_weights_negative_refuses() {
    let plan = stored_plan(json!({"10": 1.0, "20": -2.5}));
    assert_eq!(
        plan.draw(&[10, 20], 0.0),
        Err(Fallback::UnsupportedLegacyWeight)
    );
    assert_eq!(plan.draw(&[10, 30], 0.0).unwrap().tid(), 10);
}

/// Every input refusal is the same at units 0, 0.5 and 1 - 2^-53; an invalid
/// unit is `unit_out_of_range` on its own.
#[test]
fn refusal_same_across_valid_units() {
    let floor = support::floor(MetaPolicy::Exclude, 0.1);
    let f = Plan::build(&frames(&tiny(&[10]), &floor), &floor).unwrap();
    let s = stored_plan(json!({"10": -2.5, "20": 1e-310, "30": 1e-310}));
    let long: Vec<i32> = (0..=MAX_EXCLUDE_META_COMMENTS as i32).collect();
    let cases: Vec<(&Plan, Vec<i32>, Fallback)> = vec![
        (&f, long, Fallback::TooManyCandidates),
        (&f, vec![20, -5], Fallback::InvalidCandidateId),
        (&f, vec![10], Fallback::AllExcluded),
        (&f, vec![], Fallback::Empty),
        (&f, vec![20, 20], Fallback::DuplicateCandidate),
        (&f, vec![20, 88], Fallback::NeedsBaseline),
        (&s, vec![10, 20], Fallback::UnsupportedLegacyWeight),
        (&s, vec![20, 30], Fallback::TotalBelowNormal),
    ];
    for (plan, list, want) in &cases {
        for u in [0.0, 0.5, LARGEST_BELOW_ONE] {
            assert_eq!(plan.draw(list, u), Err(*want), "{}", want.name());
        }
    }
    for u in [1.0, -0.25, f64::NAN, f64::INFINITY] {
        assert_eq!(f.draw(&[20, 30], u), Err(Fallback::UnitOutOfRange));
        assert_eq!(s.draw(&[30], u), Err(Fallback::UnitOutOfRange));
    }
}

/// One mapping per library refusal, each to its own closed reason with no
/// id; exactly three are invariant failures. The `match` in
/// `Fallback::from_refusal` has no wildcard, so a refusal the library adds
/// does not compile until it has a reason.
#[test]
fn refusal_mapping_exhaustive() {
    let id = CommentId::new(4);
    let table = [
        (DrawRefusal::UnitOutOfRange, "unit_out_of_range", false),
        (DrawRefusal::Empty, "empty", false),
        (
            DrawRefusal::DuplicateCandidate(id),
            "duplicate_candidate",
            false,
        ),
        (
            DrawRefusal::TooManyCandidates(9),
            "too_many_candidates",
            false,
        ),
        (
            DrawRefusal::UnsupportedLegacyWeight(id),
            "unsupported_legacy_weight",
            false,
        ),
        (
            DrawRefusal::InvalidDrawWeight(2),
            "invalid_draw_weight",
            false,
        ),
        (DrawRefusal::TotalBelowNormal, "total_below_normal", false),
        (DrawRefusal::NoInterval, "no_interval", true),
        (DrawRefusal::ZeroMass, "zero_mass", false),
        (
            DrawRefusal::NumericDegeneracy(1),
            "numeric_degeneracy",
            false,
        ),
        (DrawRefusal::InvalidShare, "invalid_share", false),
        (
            DrawRefusal::ExcludedCandidate(id),
            "excluded_candidate",
            true,
        ),
        (DrawRefusal::NeedsBaseline(id), "needs_baseline", false),
    ];
    let mut names = std::collections::BTreeSet::new();
    for (refusal, name, invariant) in table {
        let f = Fallback::from_refusal(refusal);
        assert_eq!(f.name(), name);
        assert_eq!(f.is_invariant(), invariant, "{name}");
        names.insert(name);
    }
    assert_eq!(names.len(), 13);
    for (f, invariant) in [
        (Fallback::InvalidCandidateId, false),
        (Fallback::AllExcluded, false),
        (Fallback::ReceiptIdOutOfRange, true),
    ] {
        assert_eq!(f.is_invariant(), invariant);
        assert!(!names.contains(f.name()));
    }
}

/// Over constructed accepted inputs for every variant, no invariant failure
/// is ever reached.
#[test]
fn no_interval_unreachable_on_accepted_domain() {
    let mut rng = XorShift(23);
    for seed in 1..40 {
        let c = conversation(seed, 30, 1 + (seed % 3) as u32, 4, 2, Priorities::Mixed);
        let policy =
            [MetaPolicy::Exclude, MetaPolicy::Fixed, MetaPolicy::Ordinary][seed as usize % 3];
        for config in [
            support::floor(policy, 0.1),
            support::floor(policy, 0.0),
            stored(),
            support::uniform(),
        ] {
            let plan = Plan::build(&frames(&c.value, &config), &config).unwrap();
            for _ in 0..20 {
                let mut list: Vec<i32> = c
                    .tids
                    .iter()
                    .copied()
                    .filter(|_| rng.below(2) > 0)
                    .collect();
                if rng.below(3) == 0 {
                    list.extend(c.meta.iter().take(2));
                    list.sort_unstable();
                    list.dedup();
                }
                for u in [0.0, f64::from_bits(1), 0.5, LARGEST_BELOW_ONE, rng.unit()] {
                    if let Err(f) = plan.draw(&list, u) {
                        assert!(!f.is_invariant(), "{} on seed {seed}", f.name());
                    }
                }
            }
        }
    }
}

/// The plan excludes by the meta set of the read it was built from; a later
/// read's meta state changes nothing until a new plan is built.
#[test]
fn exclude_filter_uses_plan_snapshot() {
    let config = support::floor(MetaPolicy::Exclude, 0.1);
    let plan = Plan::build(&frames(&tiny(&[10]), &config), &config).unwrap();
    let later = Plan::build(&frames(&tiny(&[20]), &config), &config).unwrap();
    // 20 is meta in the later read only: this plan still draws it.
    assert_eq!(plan.draw(&[20], 0.5).unwrap().tid(), 20);
    assert_eq!(later.draw(&[20], 0.5), Err(Fallback::AllExcluded));
    for k in 0..200 {
        assert_ne!(
            plan.draw(&[10, 20, 30], k as f64 / 200.0).unwrap().tid(),
            10
        );
    }
}

/// A floor with `meta_policy = exclude` builds at 10,000 comments and is
/// refused at 10,001, counting meta comments in no other key; the draw's
/// candidate bound is 10,000 there and 40,000 elsewhere.
#[test]
fn exclude_meta_size_rule() {
    let config = support::floor(MetaPolicy::Exclude, 0.1);
    let at = conversation(2, MAX_EXCLUDE_META_COMMENTS, 1, 10, 0, Priorities::Absent);
    let plan = Plan::build(&frames(&at.value, &config), &config).unwrap();
    assert_eq!(plan.candidate_bound(), MAX_EXCLUDE_META_COMMENTS);
    let over = conversation(
        2,
        MAX_EXCLUDE_META_COMMENTS + 1,
        1,
        10,
        0,
        Priorities::Absent,
    );
    assert_eq!(
        Plan::build(&frames(&over.value, &config), &config),
        Err(BuildRefusal::ExcludeMetaTooLarge)
    );
    let union = conversation(
        2,
        MAX_EXCLUDE_META_COMMENTS - 10,
        1,
        10,
        11,
        Priorities::Absent,
    );
    assert_eq!(
        Plan::build(&frames(&union.value, &config), &config),
        Err(BuildRefusal::ExcludeMetaTooLarge)
    );
    // The other policies have no such rule, and the wider bound.
    let fixed = support::floor(MetaPolicy::Fixed, 0.1);
    let plan = Plan::build(&frames(&over.value, &fixed), &fixed).unwrap();
    assert_eq!(plan.candidate_bound(), MAX_PLAN_CANDIDATES);
    assert!(plan.draw(&over.tids, 0.5).is_ok());
    let long: Vec<i32> = (0..=MAX_PLAN_CANDIDATES as i32).collect();
    assert_eq!(plan.draw(&long, 0.5), Err(Fallback::TooManyCandidates));
}

/// One implementation: for `historical/1`'s weights stored as the math
/// engine stores them, and for stored weights read from a math result, the
/// plan's draw gives the same comment and the same reported chance as the
/// library's own draw on the same inputs and unit.
#[test]
fn historical_and_stored_draw_is_the_librarys() {
    let mut rng = XorShift(41);
    for seed in 1..30u64 {
        let n = 20 + (seed as usize % 7) * 9;
        let tids: Vec<u32> = (0..n as u32).map(|i| 3 * i + 2).collect();
        let source = SourceId::new("constructed:previous").unwrap();
        let mut cells = vec![];
        for t in &tids {
            if rng.below(5) == 0 {
                continue;
            }
            let seen = rng.below(200);
            let agreed = rng.below(seen + 1);
            let disagreed = rng.below(seen - agreed + 1);
            cells.push((
                CommentId::new(*t),
                Counts::from_seen(agreed as u32, disagreed as u32, seen).unwrap(),
            ));
        }
        let counts = HistoricalCountFrame::new(source.clone(), cells).unwrap();
        let extremity = ExtremityFrame::new(
            source.clone(),
            tids.iter()
                .map(|t| {
                    (
                        CommentId::new(*t),
                        Extremity::new(2.0 * rng.unit()).unwrap(),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let meta = MetaComments::new(tids.iter().step_by(6).map(|t| CommentId::new(*t))).unwrap();
        let weights =
            historical_1(&HistoricalParams::default(), &counts, &extremity, &meta).unwrap();
        let library_map = StoredWeights::from_historical(source.clone(), &weights);
        // The map as the math engine writes `comment-priorities`.
        let mut written = Map::new();
        for (id, s) in weights.scored() {
            written.insert(id.get().to_string(), json!(s.weight().get()));
        }
        let mut v = tiny(&[]);
        let obj = v.as_object_mut().unwrap();
        obj.insert("comment-priorities".into(), Value::Object(written));
        obj.insert("tids".into(), json!(tids));
        obj.insert("pca".into(), json!({"comment-extremity": vec![0.5; n]}));
        let f = frames(&v, &stored());
        let plan = Plan::build(&f, &stored()).unwrap();
        for _ in 0..40 {
            let list: Vec<i32> = tids
                .iter()
                .filter(|_| rng.below(4) > 0)
                .map(|t| *t as i32)
                .collect();
            if list.is_empty() {
                continue;
            }
            let cands = Candidates::new(ids(&list)).unwrap();
            for u in [0.0, rng.unit(), rng.unit(), LARGEST_BELOW_ONE] {
                let unit = Unit::new(u).unwrap();
                let lib = stored_weights_1(Some(&library_map), &cands, unit, &source).unwrap();
                let read = stored_weights_1(f.stored(), &cands, unit, f.source()).unwrap();
                let got = plan.draw(&list, u).unwrap();
                assert_eq!(got.tid() as u32, lib.comment().get());
                assert_eq!(got.drawn().index(), lib.index());
                assert_eq!(
                    got.drawn().probability().to_bits(),
                    lib.probability().to_bits()
                );
                assert_eq!(got.drawn().to_plain(), read.to_plain());
            }
        }
    }
}
