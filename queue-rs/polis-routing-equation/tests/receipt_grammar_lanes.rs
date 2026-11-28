//! The receipt format grows without breaking. Every receipt recorded before
//! the floor and the uniform rule were added still reads back and writes out
//! byte for byte, and the first receipts of the new shapes are recorded in a
//! second golden file that pins their bytes.
#![allow(clippy::unwrap_used, clippy::panic)]

mod support;

use polis_routing_equation::{
    Candidates, CommentId, Counts, CurrentGroupFrame, Drawn, Extremity, ExtremityFrame,
    FloorParams, GroupId, HistoricalCountFrame, MetaComments, StoredWeights, Unit,
    stored_weights_1, symmetric_gic_1, symmetric_gic_floor_1, uniform_1,
};
use support::src;

const V1: &str = include_str!("golden/receipts-v1.txt");
const LANES: &str = include_str!("golden/receipts-2.txt");

fn cands(ids: &[u32]) -> Candidates {
    Candidates::new(ids.iter().map(|i| CommentId::new(*i)).collect()).unwrap()
}

fn produced() -> Vec<String> {
    let p = src("participant");
    let mut out = vec![];
    // The earlier shape, stored-weights/1, with the two kinds of weights the
    // first golden file has no receipt of: no map, and the engine's map.
    let stored = StoredWeights::from_json(src("math"), r#"{"3":0,"5":2.5}"#).unwrap();
    for weights in [None, Some(&stored)] {
        out.push(
            stored_weights_1(weights, &cands(&[3, 5, 9]), Unit::new(0.6).unwrap(), &p)
                .unwrap()
                .to_plain(),
        );
    }
    for (ids, x) in [(&[3u32, 5, 9][..], 0.5), (&[4][..], 0.25)] {
        out.push(
            uniform_1(&cands(ids), Unit::new(x).unwrap(), &p)
                .unwrap()
                .to_plain(),
        );
    }
    let (a, b, c) = (CommentId::new(1), CommentId::new(2), CommentId::new(3));
    let counts = HistoricalCountFrame::new(
        src("previous"),
        [
            (a, Counts::new(3, 1, 0)),
            (b, Counts::new(0, 4, 2)),
            (c, Counts::new(1, 0, 0)),
        ],
    )
    .unwrap();
    let e = |x| Extremity::new(x).unwrap();
    let extremity = ExtremityFrame::new(src("current"), [(a, e(0.5)), (b, e(1.25))]).unwrap();
    let groups = CurrentGroupFrame::new(
        src("groups"),
        [(GroupId::new(0), 10), (GroupId::new(2), 8)],
        [
            (GroupId::new(0), a, Counts::new(3, 0, 1)),
            (GroupId::new(2), b, Counts::new(0, 3, 0)),
        ],
        None,
    )
    .unwrap();
    let params = FloorParams::default();
    let meta = MetaComments::none();
    let weights = symmetric_gic_1(params.base(), &counts, &extremity, &groups, &meta).unwrap();
    let plan = symmetric_gic_floor_1(&params, weights, &meta).unwrap();
    for (ids, x) in [
        (&[1u32, 2, 3][..], 0.1),
        (&[1, 2, 3][..], 0.9),
        (&[2][..], 0.5),
    ] {
        let r = plan
            .draw(&cands(ids), Unit::new(x).unwrap(), &src("weights"), &p)
            .unwrap();
        out.push(r.to_plain());
    }
    out
}

#[test]
fn every_earlier_receipt_still_reads_back_identically() {
    let lines: Vec<&str> = V1.lines().chain(LANES.lines()).collect();
    // A receipt of the earlier shape with each kind of weights: none, the
    // engine's, and computed by historical/1 (the first file's).
    for kind in ["\"no-map\"", "\"math-engine-stored\"", "\"historical/1\""] {
        assert!(
            lines
                .iter()
                .any(|l| l.contains("stored-weights/1") && l.contains(kind)),
            "no earlier-shape receipt with {kind}"
        );
    }
    for line in lines {
        let back = Drawn::from_plain(line).unwrap_or_else(|e| panic!("{line}: {e}"));
        assert_eq!(back.to_plain(), line);
    }
}

#[test]
fn the_new_shapes_are_recorded_and_read_back_identically() {
    let now = produced();
    let recorded: Vec<&str> = LANES.lines().collect();
    assert_eq!(
        recorded,
        now,
        "recorded receipts differ; now:\n{}",
        now.join("\n")
    );
    for line in recorded {
        let back = Drawn::from_plain(line).unwrap_or_else(|e| panic!("{line}: {e}"));
        assert_eq!(back.to_plain(), line);
    }
}
