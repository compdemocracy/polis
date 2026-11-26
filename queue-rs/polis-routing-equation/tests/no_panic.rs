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
