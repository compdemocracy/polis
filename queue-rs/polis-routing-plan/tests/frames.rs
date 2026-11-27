//! The frames adapter on constructed projections: where each count lands,
//! the source id, and one test per refusal.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_equation::{CommentId, Counts, GroupId, SourceId, StoredWeights};
use polis_routing_plan::{
    FrameNeeds, Key, Limit, Projection, RowIdentity, SOURCE_ID_PREFIX, SourceLimits, SourceRefusal,
    source_id,
};
use serde_json::{Value, json};

fn row(tick: i64) -> RowIdentity {
    RowIdentity {
        zid: 7,
        math_env: "example".into(),
        math_tick: tick,
        last_vote_timestamp: Some(1_700_000_000_000),
        db_now_ms: 1_700_000_100_000,
    }
}

/// A constructed math result: three comments, two groups over three base
/// clusters whose ids (100 to 102) differ from the participant ids (7 to 11).
fn blob() -> Value {
    json!({
        "tids": [1, 2, 3],
        "pca": {
            "center": [9.0, -9.0],
            "comment-projection": [[5.0, 6.0, 7.0], [1.0, 2.0, 3.0]],
            "comment-extremity": [0.5, 1.25, 0.0]
        },
        "meta-tids": [3],
        "comment-priorities": {"1": 2.5, "2": null, "3": false},
        "group-votes": {
            "0": {"id": 0, "n-members": 3, "votes": {
                "1": {"A": 1, "D": 0, "S": 1},
                "2": {"A": 0, "D": 1, "S": 1}
            }},
            "1": {"id": 1, "n-members": 2, "votes": {
                "1": {"A": 0, "D": 0, "S": 0},
                "3": {"A": 1, "D": 0, "S": 2}
            }}
        },
        "group-clusters": [
            {"id": 0, "members": [100], "center": [0.0, 0.0]},
            {"id": 1, "members": [101, 102], "center": [1.0, 1.0]}
        ],
        "base-clusters": {
            "id": [100, 101, 102],
            "members": [[7, 8, 9], [10], [11]],
            "count": [3, 1, 1],
            "x": [0.0, 0.0, 0.0],
            "y": [0.0, 0.0, 0.0]
        },
        "group_clusters": [{"id": 0, "members": [7]}, {"id": 1, "members": [8]}],
        "math_tick": 877
    })
}

fn bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}

fn parse(v: &Value) -> Result<Projection, SourceRefusal> {
    Projection::parse(&bytes(v), row(41), &SourceLimits::default())
}

fn frames(v: &Value, needs: FrameNeeds) -> Result<polis_routing_plan::Frames, SourceRefusal> {
    parse(v)?.frames(needs)
}

fn refused(v: &Value, needs: FrameNeeds) -> SourceRefusal {
    frames(v, needs).expect_err("the projection should be refused")
}

fn groups_only() -> FrameNeeds {
    FrameNeeds {
        groups: true,
        ..FrameNeeds::default()
    }
}

fn extremity_only() -> FrameNeeds {
    FrameNeeds {
        extremity: true,
        ..FrameNeeds::default()
    }
}

fn cell(f: &polis_routing_plan::Frames, g: u32, c: u32) -> Option<Counts> {
    f.groups().unwrap().cell(GroupId::new(g), CommentId::new(c))
}

#[test]
fn agree_lands_in_agreed() {
    // Group 0 agrees with comment 1 and disagrees with comment 2: A and D
    // are the engine's counts; no vote value or sign is read here.
    let f = frames(&blob(), groups_only()).unwrap();
    let c1 = cell(&f, 0, 1).unwrap();
    let c2 = cell(&f, 0, 2).unwrap();
    assert_eq!((c1.agreed(), c1.disagreed(), c1.passed()), (1, 0, 0));
    assert_eq!((c2.agreed(), c2.disagreed(), c2.passed()), (0, 1, 0));
}

#[test]
fn pass_lands_only_in_passed() {
    // Group 1 on comment 3: A 1, D 0, S 2, so one pass (S - A - D).
    let f = frames(&blob(), groups_only()).unwrap();
    let c = cell(&f, 1, 3).unwrap();
    assert_eq!((c.agreed(), c.disagreed(), c.passed()), (1, 0, 1));
    assert_eq!(c.seen(), 2);
}

#[test]
fn present_zero_stays_present() {
    let f = frames(&blob(), groups_only()).unwrap();
    assert_eq!(cell(&f, 1, 1), Some(Counts::new(0, 0, 0)));
    assert_eq!(cell(&f, 1, 2), None, "an absent cell is not a zero cell");
}

#[test]
fn group_clusters_are_base_cluster_ids() {
    // Group 0's one member is base cluster 100, which holds participants 7,
    // 8 and 9: three members. Read as participant ids, it would be one.
    let f = frames(&blob(), groups_only()).unwrap();
    assert_eq!(f.groups().unwrap().members(GroupId::new(0)), Some(3));
    let mut v = blob();
    v["group-votes"]["0"]["n-members"] = json!(1);
    v["group-votes"]["0"]["votes"] = json!({});
    assert_eq!(refused(&v, groups_only()), SourceRefusal::MembersMismatch);
    // The legacy key is never read, whatever it holds.
    let mut v = blob();
    v["group_clusters"] = json!("not read");
    assert!(frames(&v, groups_only()).is_ok());
}

#[test]
fn row_tick_not_blob_tick() {
    let p = parse(&blob()).unwrap();
    assert_eq!(p.row().math_tick, 41);
    let content = *p.content();
    assert_eq!(p.source(), &source_id(&row(41), &content).unwrap());
    assert_ne!(p.source(), &source_id(&row(877), &content).unwrap());
}

#[test]
fn zero_vote_comment_absent() {
    // A comment no one has voted on is not a column of the vote matrix, so
    // the engine writes it in neither `tids` nor `group-votes`: it is
    // absent from every frame, never a zero.
    let f = frames(&blob(), FrameNeeds::all()).unwrap();
    let nine = CommentId::new(9);
    assert_eq!(f.extremity().unwrap().get(nine), None);
    assert!(!f.groups().unwrap().comment_ids().contains(&nine));
    assert_eq!(f.stored().unwrap().get(nine), None);
}

#[test]
fn source_id_fits_and_is_shared() {
    let big = RowIdentity {
        zid: i32::MAX,
        math_env: "e".repeat(10_000),
        math_tick: i64::MAX,
        last_vote_timestamp: Some(i64::MIN),
        db_now_ms: i64::MAX,
    };
    let p = Projection::parse(&bytes(&blob()), big.clone(), &SourceLimits::default()).unwrap();
    let id = p.source().as_str();
    assert!(id.len() <= 128 && id.bytes().all(|b| (0x20..0x7f).contains(&b)));
    assert!(id.starts_with(SOURCE_ID_PREFIX));
    assert_eq!(id.len(), SOURCE_ID_PREFIX.len() + 64);
    let f = p.frames(FrameNeeds::all()).unwrap();
    assert_eq!(f.source(), p.source());
    assert_eq!(f.extremity().unwrap().source(), p.source());
    assert_eq!(f.groups().unwrap().source(), p.source());
    assert_eq!(f.stored().unwrap().source(), p.source());
    // When the row was read is not part of what was read.
    let mut later = big.clone();
    later.db_now_ms = 0;
    assert_eq!(&source_id(&later, p.content()).unwrap(), p.source());
    let mut other = big;
    other.last_vote_timestamp = None;
    assert_ne!(&source_id(&other, p.content()).unwrap(), p.source());
}

#[test]
fn extremity_is_the_stored_value() {
    // The stored `pca.comment-extremity`, bit for bit; the centre and the
    // projection beside it are not read.
    let f = frames(&blob(), extremity_only()).unwrap();
    let e = f.extremity().unwrap();
    for (tid, want) in [(1, 0.5f64), (2, 1.25), (3, 0.0)] {
        assert_eq!(
            e.get(CommentId::new(tid)).unwrap().get().to_bits(),
            want.to_bits()
        );
    }
}

#[test]
fn stored_weights_read_as_the_equation_crate_reads_them() {
    let f = frames(
        &blob(),
        FrameNeeds {
            stored_weights: true,
            ..FrameNeeds::default()
        },
    )
    .unwrap();
    let text = serde_json::to_string(&blob()["comment-priorities"]).unwrap();
    let theirs = StoredWeights::from_json(f.source().clone(), &text).unwrap();
    assert_eq!(f.stored(), Some(&theirs));
    // Absent or null: no map, as today's readers read it.
    for absent in [None, Some(Value::Null)] {
        let mut v = blob();
        match absent {
            None => {
                v.as_object_mut().unwrap().remove("comment-priorities");
            }
            Some(n) => v["comment-priorities"] = n,
        }
        let f = frames(
            &v,
            FrameNeeds {
                stored_weights: true,
                ..FrameNeeds::default()
            },
        )
        .unwrap();
        assert_eq!(f.stored(), None);
    }
}

#[test]
fn unneeded_frames_are_not_made() {
    let f = frames(&blob(), FrameNeeds::default()).unwrap();
    assert!(f.extremity().is_none() && f.groups().is_none());
    assert!(f.meta().is_none() && f.stored().is_none());
    let _: &SourceId = f.source();
}

#[test]
fn unused_malformed_field_does_not_refuse() {
    let mut v = blob();
    v["group-votes"] = json!({"0": "not a group"});
    v["base-clusters"] = json!(5);
    let needs = FrameNeeds {
        stored_weights: true,
        extremity: true,
        meta: true,
        groups: false,
    };
    let f = frames(&v, needs).unwrap();
    assert!(f.groups().is_none());
    assert!(frames(&v, FrameNeeds::default()).is_ok(), "a uniform build");
    assert_eq!(
        refused(&v, groups_only()),
        SourceRefusal::Malformed {
            key: Key::GroupVotes
        }
    );
    let mut v = blob();
    v["comment-priorities"] = json!({"1": "heavy"});
    assert!(frames(&v, groups_only()).is_ok());
}

// One test per refusal, each from a constructed bad projection.

#[test]
fn seen_below_votes_refused() {
    let mut v = blob();
    v["group-votes"]["0"]["votes"]["1"] = json!({"A": 1, "D": 1, "S": 1});
    assert_eq!(refused(&v, groups_only()), SourceRefusal::SeenBelowVotes);
}

#[test]
fn seen_above_members_refused() {
    let mut v = blob();
    v["group-votes"]["1"]["votes"]["3"] = json!({"A": 1, "D": 0, "S": 3});
    assert_eq!(refused(&v, groups_only()), SourceRefusal::SeenAboveMembers);
}

#[test]
fn checked_count_overflow_refused() {
    let mut v = blob();
    v["group-votes"]["0"]["votes"]["1"] = json!({"A": 0, "D": 0, "S": 5_000_000_000u64});
    assert_eq!(refused(&v, groups_only()), SourceRefusal::CountOverflow);
}

#[test]
fn empty_group_refused() {
    let mut v = blob();
    v["base-clusters"]["members"] = json!([[], [10], [11]]);
    v["group-votes"]["0"] = json!({"n-members": 0, "votes": {}});
    assert_eq!(refused(&v, groups_only()), SourceRefusal::EmptyGroup);
}

#[test]
fn duplicate_key_in_raw_bytes_refused() {
    let at_root = br#"{"tids": [1], "pca": {"comment-extremity": [0.5]}, "tids": [2]}"#;
    assert_eq!(
        Projection::parse(at_root, row(41), &SourceLimits::default()).unwrap_err(),
        SourceRefusal::DuplicateKey { key: Key::Tids }
    );
    // Written once plainly and once escaped: the same key.
    let nested = br#"{"group-votes": {"0": {"n-members": 1, "votes": {"1": {"A": 1, "D": 0, "S": 1}, "1": {"A": 0, "D": 1, "S": 1}}}}}"#;
    assert_eq!(
        Projection::parse(nested, row(41), &SourceLimits::default()).unwrap_err(),
        SourceRefusal::DuplicateKey {
            key: Key::GroupVotes
        }
    );
    // Past the first eight keys of an object, too.
    let mut many: String = (0..20).map(|i| format!("\"{i}\": 1, ")).collect();
    many.push_str("\"13\": 2");
    let wide = format!("{{\"comment-priorities\": {{{many}}}}}");
    assert_eq!(
        Projection::parse(wide.as_bytes(), row(41), &SourceLimits::default()).unwrap_err(),
        SourceRefusal::DuplicateKey {
            key: Key::CommentPriorities
        }
    );
}

#[test]
fn depth_limit_refused() {
    let mut v = blob();
    v["unread"] = json!([[[[[[1]]]]]]);
    let limits = SourceLimits {
        max_depth: 5,
        ..SourceLimits::default()
    };
    assert_eq!(
        Projection::parse(&bytes(&v), row(41), &limits).unwrap_err(),
        SourceRefusal::TooLarge { what: Limit::Depth }
    );
}

#[test]
fn extremity_length_mismatch_refused() {
    let mut v = blob();
    v["pca"]["comment-extremity"] = json!([0.5, 1.25]);
    assert_eq!(
        refused(&v, extremity_only()),
        SourceRefusal::ExtremityLengthMismatch
    );
}

#[test]
fn duplicate_tid_refused() {
    let mut v = blob();
    v["tids"] = json!([1, 1, 3]);
    assert_eq!(
        refused(&v, extremity_only()),
        SourceRefusal::DuplicateComment { key: Key::Tids }
    );
    let mut v = blob();
    v["meta-tids"] = json!([3, 3]);
    let meta = FrameNeeds {
        meta: true,
        ..FrameNeeds::default()
    };
    assert_eq!(
        refused(&v, meta),
        SourceRefusal::DuplicateComment { key: Key::MetaTids }
    );
}

#[test]
fn negative_or_non_finite_extremity_refused() {
    let mut v = blob();
    v["pca"]["comment-extremity"] = json!([0.5, -0.25, 0.0]);
    assert_eq!(
        refused(&v, extremity_only()),
        SourceRefusal::InvalidExtremity
    );
    // JSON has no infinity; a literal too large for a double is not read as
    // one, and the projection is refused whole.
    let text = serde_json::to_string(&blob())
        .unwrap()
        .replace("[0.5,1.25,0.0]", "[0.5,1e400,0.0]");
    assert_eq!(
        Projection::parse(text.as_bytes(), row(41), &SourceLimits::default()).unwrap_err(),
        SourceRefusal::Malformed {
            key: Key::Projection
        }
    );
}

#[test]
fn base_cluster_in_two_groups_refused() {
    let mut v = blob();
    v["group-clusters"][1]["members"] = json!([100, 102]);
    assert_eq!(
        refused(&v, groups_only()),
        SourceRefusal::BaseClusterInTwoGroups
    );
}

#[test]
fn unknown_base_cluster_refused() {
    let mut v = blob();
    v["group-clusters"][1]["members"] = json!([101, 999]);
    assert_eq!(
        refused(&v, groups_only()),
        SourceRefusal::UnknownBaseCluster
    );
}

#[test]
fn members_not_n_members_refused() {
    let mut v = blob();
    v["group-votes"]["1"]["n-members"] = json!(3);
    assert_eq!(refused(&v, groups_only()), SourceRefusal::MembersMismatch);
    let mut v = blob();
    v["group-clusters"] = json!([{"id": 0, "members": [100]}]);
    assert_eq!(refused(&v, groups_only()), SourceRefusal::MembersMismatch);
}

#[test]
fn array_priorities_refused() {
    let mut v = blob();
    v["comment-priorities"] = json!([1.0, 2.0]);
    let needs = FrameNeeds {
        stored_weights: true,
        ..FrameNeeds::default()
    };
    assert_eq!(refused(&v, needs), SourceRefusal::ArrayPriorities);
    v["comment-priorities"] = json!({"1": true});
    assert_eq!(
        refused(&v, needs),
        SourceRefusal::Malformed {
            key: Key::CommentPriorities
        }
    );
}

#[test]
fn bytes_over_the_limit_refused() {
    let b = bytes(&blob());
    let limits = SourceLimits {
        max_bytes: b.len() as u64 - 1,
        ..SourceLimits::default()
    };
    assert_eq!(
        Projection::parse(&b, row(41), &limits).unwrap_err(),
        SourceRefusal::TooLarge { what: Limit::Bytes }
    );
}

#[test]
fn count_limits_refused() {
    let tight = |f: fn(&mut SourceLimits)| {
        let mut l = SourceLimits::default();
        f(&mut l);
        Projection::parse(&bytes(&blob()), row(41), &l).unwrap_err()
    };
    let too = |what| SourceRefusal::TooLarge { what };
    assert_eq!(tight(|l| l.max_comments = 2), too(Limit::Comments));
    assert_eq!(tight(|l| l.max_groups = 1), too(Limit::Groups));
    assert_eq!(tight(|l| l.max_cells = 3), too(Limit::Cells));
    assert_eq!(tight(|l| l.max_memberships = 8), too(Limit::Memberships));
    // The union of tids and meta-tids, when both are read.
    let mut v = blob();
    v["meta-tids"] = json!([4]);
    let l = SourceLimits {
        max_comments: 3,
        ..SourceLimits::default()
    };
    let p = Projection::parse(&bytes(&v), row(41), &l).unwrap();
    assert_eq!(
        p.frames(FrameNeeds::all()).unwrap_err(),
        too(Limit::Comments)
    );
    assert!(
        p.frames(FrameNeeds {
            meta: true,
            ..FrameNeeds::default()
        })
        .is_ok()
    );
}

#[test]
fn missing_and_malformed_keys_refused() {
    let mut v = blob();
    v.as_object_mut().unwrap().remove("tids");
    assert_eq!(
        refused(&v, extremity_only()),
        SourceRefusal::Missing { key: Key::Tids }
    );
    let mut v = blob();
    v["base-clusters"] = Value::Null;
    assert_eq!(
        refused(&v, groups_only()),
        SourceRefusal::Missing {
            key: Key::BaseClusters
        }
    );
    let mut v = blob();
    v["tids"] = json!([1, -2, 3]);
    assert_eq!(
        refused(&v, extremity_only()),
        SourceRefusal::Malformed { key: Key::Tids }
    );
    let mut v = blob();
    let g = v["group-votes"]["1"].take();
    v["group-votes"]["01"] = g;
    v["group-votes"].as_object_mut().unwrap().remove("1");
    assert_eq!(
        refused(&v, groups_only()),
        SourceRefusal::Malformed {
            key: Key::GroupVotes
        }
    );
    for bad in [&b"[1, 2]"[..], b"{\"tids\": [1]} x", b"{\"tids\": [1"] {
        assert_eq!(
            Projection::parse(bad, row(41), &SourceLimits::default()).unwrap_err(),
            SourceRefusal::Malformed {
                key: Key::Projection
            }
        );
    }
}
