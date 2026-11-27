//! Every public constructor and entry point, over a deterministic corpus of
//! awkward values, returns a value or a typed refusal and never panics. This
//! is useful evidence, not an exhaustive proof.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, Counts, Extremity, ExtremityFrame, HistoricalCountFrame,
    HistoricalParams, MetaComments, ParamSet, SourceId, StoredWeight, StoredWeights, Unit, cdf,
    historical_1, lookup, stored_weights_1,
};
use std::panic::{AssertUnwindSafe, catch_unwind};
use support::XorShift;

fn never_panics(what: &str, f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_ok(), "{what} panicked");
}

#[test]
fn no_public_entry_point_panics() {
    let mut rng = XorShift::new(0xC0FFEE);
    let u32s = [0u32, 1, 2, u32::MAX - 1, u32::MAX];
    let jsons = [
        "",
        "{",
        "[]",
        "[1,2]",
        "null",
        "1",
        "{\"0\":1,\"0\":2}",
        "{\"-1\":1}",
        "{\"01\":1}",
        "{\"4294967296\":1}",
        "{\"0\":true}",
        "{\"0\":\"1\"}",
        "{\"0\":[1]}",
        "{\"0\":{}}",
        "{\"0\":1e400}",
        "{\"0\":-0.0}",
        "{\"0\":-5}",
        "{\"0\":1e308}",
        "{\"0\":null,\"1\":false}",
        "{\"a\":{\"b\":1,\"b\":2}}",
    ];
    for i in 0..20000u64 {
        let f = rng.any_f64();
        let g = rng.any_f64();
        let a = u32s[rng.below(5) as usize];
        let d = u32s[rng.below(5) as usize];
        let p = u32s[rng.below(5) as usize];
        never_panics("constructors", || {
            let _ = CommentId::try_from(rng.next() as i32);
            let _ = CommentId::try_from(rng.next() as i64);
            let bytes: Vec<u8> = (0..rng.below(140)).map(|_| rng.next() as u8).collect();
            let _ = SourceId::new(String::from_utf8_lossy(&bytes).into_owned());
            let _ = Counts::from_seen(a, d, rng.next());
            let _ = Counts::from_seen(a, d, u64::from(a) + u64::from(d) + u64::from(p));
            let _ = Extremity::new(f);
            let _ = Unit::new(f);
            let _ = HistoricalParams::new(
                f,
                g,
                rng.any_f64(),
                rng.any_f64(),
                rng.any_f64(),
                rng.any_f64(),
                rng.next() as u8,
                rng.any_f64(),
            );
            let _ = lookup(&String::from_utf8_lossy(&bytes));
        });
        never_panics("historical_1", || {
            let n = rng.below(6) as u32;
            let cells: Vec<_> = (0..n)
                .map(|t| (CommentId::new(t % 4), Counts::new(a, d, p)))
                .collect();
            let es: Vec<_> = (0..n)
                .filter_map(|t| {
                    Extremity::new(rng.any_f64())
                        .ok()
                        .map(|e| (CommentId::new(t), e))
                })
                .collect();
            let src = SourceId::new("corpus").unwrap();
            if let (Ok(c), Ok(e)) = (
                HistoricalCountFrame::new(src.clone(), cells),
                ExtremityFrame::new(src, es),
            ) {
                let _ = c.total_seen();
                for params in [
                    HistoricalParams::default(),
                    HistoricalParams::new(1e-3, 1e-3, 2e-3, 1e-3, 1000.0, 1e-3, 4, 1e6).unwrap(),
                ] {
                    let _ = historical_1(
                        &params,
                        &c,
                        &e,
                        &MetaComments::new([CommentId::new(1)]).unwrap(),
                    );
                }
            }
        });
        never_panics("stored_weights_1 and cdf", || {
            let src = SourceId::new("corpus").unwrap();
            let entries: Vec<_> = (0..rng.below(5) as u32)
                .map(|t| {
                    (
                        CommentId::new(t),
                        match rng.below(3) {
                            0 => StoredWeight::Null,
                            1 => StoredWeight::False,
                            _ => StoredWeight::Number(rng.any_f64()),
                        },
                    )
                })
                .collect();
            let stored = StoredWeights::new(src.clone(), entries).ok();
            let ids: Vec<_> = (0..rng.below(6) as u32)
                .map(|t| CommentId::new(t * (1 + (i as u32 % 3))))
                .collect();
            if let (Ok(c), Ok(u)) = (Candidates::new(ids), Unit::new(rng.unit())) {
                let _ = stored_weights_1(stored.as_ref(), &c, u, &src);
                let _ = stored_weights_1(None, &c, u, &src);
            }
            let weights: Vec<f64> = (0..rng.below(6)).map(|_| rng.any_f64()).collect();
            if let Ok(u) = Unit::new(rng.unit()) {
                let _ = cdf(&weights, u);
            }
            let _ = StoredWeights::from_json(src, jsons[rng.below(jsons.len() as u64) as usize]);
        });
        never_panics("plain form", || {
            let good =
                ParamSet::default_for(polis_routing_equation::RuleId::Historical1).to_plain();
            let cut = rng.below(good.len() as u64) as usize;
            let _ = ParamSet::from_plain(&good[..cut]);
            let _ = ParamSet::from_plain(jsons[rng.below(jsons.len() as u64) as usize]);
            let mut bytes = good.into_bytes();
            let at = rng.below(bytes.len() as u64) as usize;
            bytes[at] = rng.next() as u8;
            let _ = ParamSet::from_plain(&String::from_utf8_lossy(&bytes));
        });
    }
    let deep = format!("{}{}", "[".repeat(10000), "]".repeat(10000));
    never_panics("deep JSON", || {
        let _ = ParamSet::from_plain(&deep);
        let _ = StoredWeights::from_json(SourceId::new("x").unwrap(), &deep);
    });
}

/// The entry points added with the corrected rules: the current frames and
/// their joint validation, the importance frames, the corrected rules and the
/// consensus factor, the floor, the stable draw, the uniform rule, the
/// importance helper and terms, every rule's plain form, and the receipt
/// reader over both golden receipt files with bytes altered.
///
/// The counts given to `Issue217Voter::new` and `issue217_voter_weight` span
/// the whole u64 range: the named values below, u64::MAX - 1 and u64::MAX
/// included, and raw 64-bit draws.
#[test]
fn no_corrected_rule_entry_point_panics() {
    use polis_routing_equation::*;
    const ISSUE217_COUNTS: [u64; 10] = [
        0,
        1,
        2,
        100,
        600,
        u32::MAX as u64,
        1 << 62,
        1 << 63,
        u64::MAX - 1,
        u64::MAX,
    ];
    // Every triple of the named counts, marked and unmarked, once; the
    // random loop below adds raw 64-bit draws.
    for v in ISSUE217_COUNTS {
        for u in ISSUE217_COUNTS {
            for s in ISSUE217_COUNTS {
                for marked in [true, false] {
                    if let Ok(voter) = Issue217Voter::new(v, u, marked) {
                        let _ = issue217_voter_weight(voter, s);
                    }
                }
            }
        }
    }
    let mut rng = XorShift::new(0x5EED_F100);
    let u32s = [0u32, 1, 2, 3, u32::MAX - 1, u32::MAX];
    let u64s = [
        0u64,
        1,
        2,
        3,
        10,
        u64::from(u32::MAX),
        u64::MAX - 1,
        u64::MAX,
    ];
    let receipts: Vec<&str> = include_str!("golden/receipts-v1.txt")
        .lines()
        .chain(include_str!("golden/receipts-2.txt").lines())
        .filter(|l| l.starts_with('{'))
        .collect();
    let policies = [MetaPolicy::Fixed, MetaPolicy::Ordinary, MetaPolicy::Exclude];
    let forms = [ConsensusForm::GicMean1, ConsensusForm::GicGeomean1];
    let src = SourceId::new("corpus").unwrap();
    for i in 0..3000u64 {
        let pick32 = |r: &mut XorShift| u32s[r.below(u32s.len() as u64) as usize];
        let pick64 = |r: &mut XorShift| u64s[r.below(u64s.len() as u64) as usize];
        // Frames: 0 to 64 groups, sparse ids, extreme members and counts.
        let groups = rng.below(65) as u32;
        let members: Vec<_> = (0..groups)
            .map(|g| (GroupId::new(g * (1 + (i as u32 % 3))), pick32(&mut rng)))
            .collect();
        let cells: Vec<_> = (0..rng.below(12))
            .map(|_| {
                let g = GroupId::new(rng.below(u64::from(groups) * 3 + 1) as u32);
                let c = CommentId::new(rng.below(6) as u32);
                (
                    g,
                    c,
                    Counts::new(pick32(&mut rng), pick32(&mut rng), pick32(&mut rng)),
                )
            })
            .collect();
        let declared = if rng.below(2) == 0 {
            None
        } else {
            Some(pick64(&mut rng))
        };
        let mut group_frame = None;
        never_panics("group and everyone frames", || {
            group_frame =
                CurrentGroupFrame::new(src.clone(), members.clone(), cells.clone(), declared).ok();
        });
        let everyone_cells: Vec<_> = (0..rng.below(7) as u32)
            .map(|t| {
                (
                    CommentId::new(t % 5),
                    Counts::new(pick32(&mut rng), pick32(&mut rng), pick32(&mut rng)),
                )
            })
            .collect();
        let participants = pick64(&mut rng);
        let mut current = CurrentFrames::default();
        never_panics("current frames", || {
            let e = EveryoneFrame::new(src.clone(), participants, everyone_cells.clone()).ok();
            if let Ok(f) = CurrentFrames::new(group_frame.clone(), e.clone()) {
                current = f;
            }
            let _ = CurrentFrames::new(None, e);
            let _ = CurrentFrames::new(group_frame.clone(), None);
        });
        // Importance frames, over the full u64 range.
        let marks: Vec<_> = (0..rng.below(5) as u32)
            .filter_map(|t| {
                Marks::new(pick64(&mut rng), pick64(&mut rng))
                    .ok()
                    .map(|m| (CommentId::new(t % 4), m))
            })
            .collect();
        let group_marks: Vec<_> = (0..rng.below(4) as u32)
            .filter_map(|t| {
                Marks::new(pick64(&mut rng), pick64(&mut rng))
                    .ok()
                    .map(|m| (GroupId::new(t), CommentId::new(t % 3), m))
            })
            .collect();
        let total = Marks::new(pick64(&mut rng), pick64(&mut rng)).ok();
        let cohort = SourceId::new(if rng.below(4) == 0 { "other" } else { "corpus" }).unwrap();
        let comment_marks = CommentMarks::new(src.clone(), cohort.clone(), marks.clone()).ok();
        let mark_totals = total.map(|t| MarkTotals::new(src.clone(), src.clone(), t));
        never_panics("importance frames", || {
            let gm = GroupMarks::new(src.clone(), cohort.clone(), group_marks.clone()).ok();
            let _ = ImportanceMarks::new(
                comment_marks.clone(),
                mark_totals.clone(),
                gm.clone(),
                &current,
            );
            let _ = ImportanceMarks::new(None, mark_totals.clone(), gm, &current);
        });
        let voter_rows: Vec<_> = (0..rng.below(5) as u32)
            .map(|t| (CommentId::new(t % 4), pick64(&mut rng), rng.any_f64()))
            .collect();
        let mut voter_frame = None;
        never_panics("voter-weight frame", || {
            voter_frame = VoterWeightFrame::new(
                src.clone(),
                voter_rows.clone(),
                pick64(&mut rng),
                rng.any_f64(),
            )
            .ok();
            let ok_rows = [
                (CommentId::new(0), 1u64, 1.0),
                (CommentId::new(1), u64::MAX, f64::MAX),
            ];
            let _ = VoterWeightFrame::new(src.clone(), ok_rows, u64::MAX, f64::MAX);
        });
        // Parameters at any value, and at their extremes.
        never_panics("parameters", || {
            let _ = SymmetricParams::new(
                rng.any_f64(),
                rng.any_f64(),
                rng.any_f64(),
                rng.any_f64(),
                rng.any_f64(),
                rng.next() as u8,
                rng.any_f64(),
                policies[rng.below(3) as usize],
            );
            let _ = GicParams::new(rng.any_f64(), rng.next() as u8);
            let _ = FloorParams::new(SymmetricGicParams::default(), rng.any_f64());
            let _ = LiftParams::new(rng.any_f64(), rng.any_f64());
            let _ = NormalizedLiftParams::new(Some(rng.any_f64()));
        });
        // The corrected rules and the consensus factor.
        let counts: Vec<_> = (0..rng.below(6) as u32)
            .map(|t| {
                (
                    CommentId::new(t % 5),
                    Counts::new(pick32(&mut rng), pick32(&mut rng), pick32(&mut rng)),
                )
            })
            .collect();
        let extremities: Vec<_> = (0..rng.below(6) as u32)
            .filter_map(|t| {
                Extremity::new(rng.any_f64())
                    .ok()
                    .map(|e| (CommentId::new(t), e))
            })
            .collect();
        let (Ok(cf), Ok(ef)) = (
            HistoricalCountFrame::new(src.clone(), counts),
            ExtremityFrame::new(src.clone(), extremities),
        ) else {
            continue;
        };
        let meta = MetaComments::new([CommentId::new(1), CommentId::new(9)]).unwrap();
        let empty_groups = CurrentGroupFrame::new(src.clone(), [], [], None).unwrap();
        let gf = group_frame.clone().unwrap_or(empty_groups);
        let policy = policies[rng.below(3) as usize];
        let extreme = SymmetricParams::new(1e-3, 1e-3, 1e-3, 1000.0, 1e-3, 4, 1e6, policy).unwrap();
        let wide = SymmetricParams::new(1000.0, 1000.0, 100.0, 0.0, 1e6, 1, 1e-3, policy).unwrap();
        let mut built = Vec::new();
        never_panics("corrected rules", || {
            for base in [SymmetricParams::default(), extreme, wide] {
                let _ = symmetric_1(&base, &cf, &ef, &meta);
                for form in forms {
                    for gic in [
                        GicParams::default(),
                        GicParams::new(1e-3, 1).unwrap(),
                        GicParams::new(100.0, 64).unwrap(),
                    ] {
                        for t in 0..6 {
                            let _ = consensus(form, &gic, &gf, CommentId::new(t));
                        }
                        let p = SymmetricGicParams::new(base, form, gic);
                        if let Ok(w) = symmetric_gic_1(&p, &cf, &ef, &gf, &meta) {
                            built.push((p, w));
                        }
                    }
                }
            }
        });
        // Importance terms over the weights the rules produced. The marks use
        // the full u64 range, as do the 2019 helper's counts below.
        let terms = [
            TermParams::ImportanceLift1(LiftParams::default()),
            TermParams::ImportanceLift1(LiftParams::new(0.0, 1000.0).unwrap()),
            TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::default()),
            TermParams::ImportanceNormalizedLift1(NormalizedLiftParams::new(Some(1.0)).unwrap()),
        ];
        let mut lifted = Vec::new();
        never_panics("importance terms", || {
            for (p, w) in built.iter().step_by(5) {
                for term in &terms {
                    let _ = term.to_plain();
                    let mark_inputs = TermInputs::Marks {
                        comments: comment_marks.as_ref(),
                        totals: mark_totals.as_ref(),
                    };
                    let _ = importance_multipliers(w, term, &mark_inputs);
                    if let Ok(x) = with_importance(w.clone(), *term, mark_inputs, src.clone()) {
                        let _ = with_importance(x.clone(), *term, mark_inputs, src.clone());
                        lifted.push((*p, x));
                    }
                    if let Some(v) = &voter_frame {
                        let vi = TermInputs::VoterWeights(v);
                        let _ = importance_multipliers(w, term, &vi);
                        let _ = with_importance(w.clone(), *term, vi, src.clone());
                    }
                }
            }
            let mut count = || {
                if rng.below(4) == 0 {
                    rng.next()
                } else {
                    ISSUE217_COUNTS[rng.below(10) as usize]
                }
            };
            let (v, u, s) = (count(), count(), count());
            if let Ok(voter) = Issue217Voter::new(v, u, rng.below(2) == 0) {
                let _ = issue217_voter_weight(voter, s);
            }
        });
        // The floor, the stable draw and the uniform rule.
        let ids: Vec<_> = (0..rng.below(7) as u32)
            .map(|t| CommentId::new(t * (1 + (i as u32 % 4))))
            .collect();
        let draw_weights: Vec<f64> = (0..rng.below(7)).map(|_| rng.any_f64()).collect();
        let share = rng.any_f64();
        never_panics("floor and stable draw", || {
            if let Ok(u) = Unit::new(rng.unit()) {
                let _ = stable_cdf(&draw_weights, u);
                let _ = stable_cdf(&[], u);
                let _ = cdf(&draw_weights, u);
            }
            let _ = floor_marginals(share, &draw_weights);
            let _ = floor_marginals(0.1, &draw_weights);
            let _ = floor_marginals(0.1, &[]);
            let Ok(c) = Candidates::new(ids.clone()) else {
                return;
            };
            let u = Unit::new(rng.unit()).unwrap();
            let _ = uniform_1(&c, u, &src);
            for (p, w) in built.iter().step_by(7).chain(lifted.iter().step_by(5)) {
                for floor_share in [0.0, 0.1, 1.0 - f64::EPSILON] {
                    let Ok(fp) = FloorParams::new(*p, floor_share) else {
                        continue;
                    };
                    for meta_set in [&meta, &MetaComments::none()] {
                        if let Ok(plan) = symmetric_gic_floor_1(&fp, w.clone(), meta_set) {
                            let _ = plan.probabilities(&c);
                            if let Ok(d) = plan.draw(&c, u, &src, &src) {
                                let _ = Drawn::from_plain(&d.to_plain());
                            }
                        }
                    }
                }
                let other = FloorParams::new(SymmetricGicParams::default(), 0.5).unwrap();
                let _ = symmetric_gic_floor_1(&other, w.clone(), &meta);
            }
        });
        // Every rule's plain form, cut and altered; both receipt files, altered.
        never_panics("plain forms and receipts", || {
            for rule in RuleId::ALL {
                let good = ParamSet::default_for(rule).to_plain();
                let cut = rng.below(good.len() as u64) as usize;
                let _ = ParamSet::from_plain(&good[..cut]);
                let mut bytes = good.into_bytes();
                let at = rng.below(bytes.len() as u64) as usize;
                bytes[at] = rng.next() as u8;
                let _ = ParamSet::from_plain(&String::from_utf8_lossy(&bytes));
            }
            let line = receipts[rng.below(receipts.len() as u64) as usize];
            let _ = Drawn::from_plain(line);
            let cut = rng.below(line.len() as u64) as usize;
            let _ = Drawn::from_plain(&line[..cut]);
            let mut bytes = line.as_bytes().to_vec();
            let at = rng.below(bytes.len() as u64) as usize;
            bytes[at] = b"0123456789-.e\",:{}[]x"[rng.below(21) as usize];
            let _ = Drawn::from_plain(&String::from_utf8_lossy(&bytes));
        });
    }
}
