//! The recorded public replays: every input the Python engine's priority
//! formula was fed, tick by tick, while replaying two public conversations
//! (and a few constructed ones), and the priority it returned. `historical/1`
//! at its defaults must return the same numbers, to relative 1e-12, with exact
//! zeros exact. The wrong-on-purpose cell (an extremity computed from the
//! served centre) must not reproduce its priority.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

use polis_routing_equation::*;
use serde_json::Value;

const VW: &str = include_str!("fixtures/historical-1/vw.json");
const BIODIVERSITY: &str = include_str!("fixtures/historical-1/biodiversity.json");
const CONSTRUCTED: &str = include_str!("fixtures/historical-1/constructed.json");

fn load(name: &str) -> Value {
    let text = match name {
        "vw" => VW,
        "biodiversity" => BIODIVERSITY,
        _ => CONSTRUCTED,
    };
    serde_json::from_str(text).unwrap()
}

fn num(v: &Value, key: &str) -> f64 {
    let x = v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} is not a number"));
    assert!(x.is_finite(), "{key} is not finite");
    x
}

fn count(v: &Value, key: &str) -> u32 {
    u32::try_from(v[key].as_u64().unwrap()).unwrap()
}

fn src(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

/// `historical/1` at its defaults over one tick's recorded cells.
fn weights(cells: &[Value], override_e: Option<(u32, f64)>) -> HistoricalWeights {
    let mut counts = vec![];
    let mut extremities = vec![];
    let mut meta = vec![];
    for c in cells {
        let tid = count(c, "tid");
        let id = CommentId::new(tid);
        let (a, d, p) = (
            count(c, "agreed"),
            count(c, "disagreed"),
            count(c, "passed"),
        );
        assert_eq!(
            u64::from(a) + u64::from(d) + u64::from(p),
            c["seen"].as_u64().unwrap()
        );
        counts.push((id, Counts::new(a, d, p)));
        let e = match override_e {
            Some((t, e)) if t == tid => e,
            _ => num(c, "extremity"),
        };
        extremities.push((id, Extremity::new(e).unwrap()));
        if c["meta"].as_bool().unwrap() {
            meta.push(id);
        }
    }
    let c = HistoricalCountFrame::new(src("previous tick"), counts).unwrap();
    let e = ExtremityFrame::new(src("current tick"), extremities).unwrap();
    let m = MetaComments::new(meta).unwrap();
    historical_1(&HistoricalParams::default(), &c, &e, &m).unwrap()
}

#[derive(Default)]
struct Tally {
    ticks: usize,
    no_call_ticks: usize,
    cells: usize,
    bit_exact: usize,
    exact_zeros: usize,
    meta: usize,
    max_rel: f64,
}

fn compare(ticks: &[Value], t: &mut Tally) {
    for tick in ticks {
        t.ticks += 1;
        let cells = tick["cells"].as_array().unwrap();
        if tick.get("no_priority_calls").is_some() {
            assert!(cells.is_empty());
            t.no_call_ticks += 1;
            continue;
        }
        assert_eq!(cells.len() as u64, tick["calls"].as_u64().unwrap());
        let w = weights(cells, None);
        for c in cells {
            let id = CommentId::new(count(c, "tid"));
            let python = num(c, "weight");
            let rust = w.get(id).unwrap().weight().get();
            t.cells += 1;
            t.meta += usize::from(c["meta"].as_bool().unwrap());
            if python == 0.0 {
                assert_eq!(
                    rust.to_bits(),
                    python.to_bits(),
                    "exact zero, comment {id:?}"
                );
                t.exact_zeros += 1;
                continue;
            }
            let rel = ((rust - python) / python).abs();
            assert!(
                rel <= 1e-12,
                "tick {} comment {id:?}: rust {rust:e}, python {python:e}, relative {rel:e}",
                tick["tick"]
            );
            t.bit_exact += usize::from(rust.to_bits() == python.to_bits());
            t.max_rel = t.max_rel.max(rel);
        }
    }
}

#[test]
fn recorded_replays_reproduce_through_historical_1() {
    let mut total = Tally::default();
    for name in ["vw", "biodiversity"] {
        let f = load(name);
        assert_eq!(f["header"]["rule"], "historical/1");
        assert!(
            f["header"]["proves"]
                .as_str()
                .unwrap()
                .contains("does not prove")
        );
        let ticks = f["ticks"].as_array().unwrap();
        assert_eq!(ticks.len(), 10, "{name}: ten prefixes");
        let mut t = Tally::default();
        compare(ticks, &mut t);
        println!(
            "{name}: {} ticks, {} cells ({} meta), {} bit-exact, {} exact zeros; max relative {:e}",
            t.ticks, t.cells, t.meta, t.bit_exact, t.exact_zeros, t.max_rel
        );
        // The deliberately wrong extremity must not reproduce the priority.
        let witness = &f["wrong_on_purpose"];
        assert_eq!(witness["cell"]["wrong_on_purpose"], true);
        let tick = &ticks[witness["tick"].as_u64().unwrap() as usize - 1];
        let tid = count(&witness["cell"], "tid");
        let wrong = weights(
            tick["cells"].as_array().unwrap(),
            Some((tid, num(&witness["cell"], "extremity"))),
        );
        let got = wrong.get(CommentId::new(tid)).unwrap().weight().get();
        let recorded = num(&witness["cell"], "weight");
        let rel = ((got - recorded) / recorded).abs();
        println!(
            "{name}: wrong-on-purpose comment {tid}: relative difference {rel:e} (must be large)"
        );
        assert!(
            rel > 1e-3,
            "the served-centre extremity reproduced the priority"
        );
        total.ticks += t.ticks;
        total.cells += t.cells;
        total.bit_exact += t.bit_exact;
        total.max_rel = total.max_rel.max(t.max_rel);
    }
    let f = load("constructed");
    let mut t = Tally::default();
    for case in f["cases"].as_array().unwrap() {
        compare(case["ticks"].as_array().unwrap(), &mut t);
    }
    println!(
        "constructed: {} ticks ({} with no priority calls), {} cells ({} meta), {} bit-exact; max relative {:e}",
        t.ticks, t.no_call_ticks, t.cells, t.meta, t.bit_exact, t.max_rel
    );
    println!(
        "replays: {} ticks, {} cells, {} bit-exact; max relative {:e}",
        total.ticks, total.cells, total.bit_exact, total.max_rel
    );
}

#[test]
fn empty_engine_recompute_records_no_priority_calls() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/historical-1/no-calls.json")).unwrap();
    assert_eq!(fixture["header"]["rule"], "historical/1");
    let ticks = fixture["ticks"].as_array().unwrap();
    assert_eq!(ticks.len(), 1);
    let tick = &ticks[0];
    assert_eq!(tick["no_priority_calls"], true);
    assert_eq!(tick["calls"], 0);
    assert_eq!(tick["columns"], 0);
    assert!(tick["pca"].is_null());
    assert!(tick["priorities"].as_object().unwrap().is_empty());
    let cells = tick["cells"].as_array().unwrap();
    assert!(cells.is_empty());
    let result = weights(cells, None);
    assert_eq!(result.scored().count(), 0);
    assert_eq!(result.unscored().count(), 0);
    let mut tally = Tally::default();
    compare(ticks, &mut tally);
    assert_eq!(tally.no_call_ticks, 1);
}
