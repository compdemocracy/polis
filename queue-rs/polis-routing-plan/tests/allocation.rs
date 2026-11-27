//! What the adapter allocates, counted by a counting allocator (the one the
//! routing equation's benchmark uses, counting here per thread so that tests
//! running side by side do not count each other).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_plan::{
    FrameNeeds, Key, Limit, Projection, RowIdentity, SourceLimits, SourceRefusal,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static REQUESTED: Cell<u64> = const { Cell::new(0) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
        REQUESTED.with(|r| r.set(r.get() + size as u64));
        LIVE.with(|l| {
            let live = l.get() + size as i64;
            l.set(live);
            PEAK.with(|p| p.set(p.get().max(live)));
        });
    }
}

fn on_free(size: usize) {
    if ON.with(Cell::get) {
        LIVE.with(|l| l.set(l.get() - size as i64));
    }
}

// SAFETY: every call is forwarded to the system allocator unchanged; the
// counters are const-initialised thread locals and never allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        on_alloc(layout.size());
        // SAFETY: the caller's contract is passed through to System.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        on_alloc(layout.size());
        // SAFETY: as above.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        on_free(layout.size());
        // SAFETY: as above.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        on_free(layout.size());
        on_alloc(new_size);
        // SAFETY: as above.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Runs `f` and gives back what this thread asked for while it ran: bytes
/// requested in all, and the peak of live bytes above the start.
fn counted<T>(f: impl FnOnce() -> T) -> (T, u64, i64) {
    REQUESTED.with(|r| r.set(0));
    LIVE.with(|l| l.set(0));
    PEAK.with(|p| p.set(0));
    ON.with(|o| o.set(true));
    let out = f();
    ON.with(|o| o.set(false));
    (out, REQUESTED.with(Cell::get), PEAK.with(Cell::get))
}

fn row() -> RowIdentity {
    RowIdentity {
        zid: 7,
        math_env: "example".into(),
        math_tick: 41,
        last_vote_timestamp: None,
        db_now_ms: 0,
    }
}

/// A constructed worst case for its size: `groups` groups, each with a cell
/// on every one of `comments` comments; every comment meta and weighted; one
/// base cluster of `per` participants per group. Keys are written with
/// escapes in one group so the readers' scratch is used.
fn worst(groups: u32, comments: u32, per: u32) -> Vec<u8> {
    let mut s = String::from("{\"tids\":[");
    let ids: Vec<String> = (0..comments).map(|c| c.to_string()).collect();
    s.push_str(&ids.join(","));
    s.push_str("],\"pca\":{\"comment-extremity\":[");
    let ex: Vec<String> = (0..comments).map(|c| format!("{}.5", c % 7)).collect();
    s.push_str(&ex.join(","));
    s.push_str("]},\"meta-tids\":[");
    s.push_str(&ids.join(","));
    s.push_str("],\"comment-priorities\":{");
    let pr: Vec<String> = (0..comments).map(|c| format!("\"{c}\":1.5")).collect();
    s.push_str(&pr.join(","));
    s.push_str("},\"group-votes\":{");
    let mut gs = Vec::new();
    for g in 0..groups {
        let cells: Vec<String> = (0..comments)
            .map(|c| {
                let key = if g == 0 {
                    c.to_string()
                        .chars()
                        .map(|ch| format!("\\u{:04x}", ch as u32))
                        .collect()
                } else {
                    c.to_string()
                };
                format!("\"{key}\":{{\"A\":1,\"D\":0,\"S\":1}}")
            })
            .collect();
        gs.push(format!(
            "\"{g}\":{{\"id\":{g},\"n-members\":{per},\"votes\":{{{}}}}}",
            cells.join(",")
        ));
    }
    s.push_str(&gs.join(","));
    s.push_str("},\"group-clusters\":[");
    let gc: Vec<String> = (0..groups)
        .map(|g| format!("{{\"id\":{g},\"members\":[{}]}}", 1000 + g))
        .collect();
    s.push_str(&gc.join(","));
    s.push_str("],\"base-clusters\":{\"id\":[");
    let bid: Vec<String> = (0..groups).map(|g| (1000 + g).to_string()).collect();
    s.push_str(&bid.join(","));
    s.push_str("],\"members\":[");
    let bm: Vec<String> = (0..groups)
        .map(|g| {
            let m: Vec<String> = (0..per).map(|p| (g * per + p).to_string()).collect();
            format!("[{}]", m.join(","))
        })
        .collect();
    s.push_str(&bm.join(","));
    s.push_str("]}}");
    s.into_bytes()
}

#[test]
fn limits_refuse_before_allocation() {
    let b = worst(4, 500, 3);
    // Over its length: refused before anything is read.
    let short = SourceLimits {
        max_bytes: b.len() as u64 - 1,
        ..SourceLimits::default()
    };
    let r0 = row();
    let (r, requested, _) = counted(|| Projection::parse(&b, r0, &short));
    assert_eq!(
        r.unwrap_err(),
        SourceRefusal::TooLarge { what: Limit::Bytes }
    );
    assert_eq!(requested, 0, "nothing allocated");
    // Over a count: refused at the first entry over it, having held no more
    // than the source's own size.
    for limits in [
        SourceLimits {
            max_cells: 1_000,
            ..SourceLimits::default()
        },
        SourceLimits {
            max_comments: 400,
            ..SourceLimits::default()
        },
        SourceLimits {
            max_memberships: 10,
            ..SourceLimits::default()
        },
    ] {
        let r0 = row();
        let (r, _, peak) = counted(|| Projection::parse(&b, r0, &limits));
        assert!(matches!(r.unwrap_err(), SourceRefusal::TooLarge { .. }));
        assert!(
            peak <= b.len() as i64,
            "peak {peak} above the source's {} bytes",
            b.len()
        );
    }
}

#[test]
fn expansion_reservation_is_upper_bound() {
    for (groups, comments, per) in [
        (1, 1, 1),
        (2, 3, 2),
        (4, 500, 3),
        (64, 300, 1),
        (5, 4_000, 40),
    ] {
        let b = worst(groups, comments, per);
        let p = Projection::parse(&b, row(), &SourceLimits::default()).unwrap();
        for needs in [
            FrameNeeds::all(),
            FrameNeeds::default(),
            FrameNeeds {
                groups: true,
                ..FrameNeeds::default()
            },
            FrameNeeds {
                stored_weights: true,
                ..FrameNeeds::default()
            },
            FrameNeeds {
                extremity: true,
                meta: true,
                ..FrameNeeds::default()
            },
        ] {
            let reserved = p.reservation(needs).unwrap();
            let (f, requested, _) = counted(|| p.frames(needs));
            let f = f.unwrap();
            assert!(
                requested <= reserved,
                "{groups} groups, {comments} comments, {needs:?}: {requested} requested, {reserved} reserved"
            );
            drop(f);
        }
    }
}

#[test]
fn positional_memberships_cannot_exceed_reservation() {
    let members = (0..10_000)
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let b = format!(
        r#"{{"group-votes":{{"0":{{"n-members":10000,"votes":{{}}}}}},"group-clusters":[{{"id":0,"members":[100]}}],"base-clusters":[[100],[[{members}]] ]}}"#
    );
    let p = Projection::parse(b.as_bytes(), row(), &SourceLimits::default()).unwrap();
    let needs = FrameNeeds {
        groups: true,
        ..FrameNeeds::default()
    };
    let reserved = p.reservation(needs).unwrap();
    let (result, requested, peak) = counted(|| p.frames(needs));
    eprintln!(
        "positional membership: reservation={reserved} requested={requested} peak={peak}, refused={}",
        result.is_err()
    );
    assert!(requested <= reserved, "allocation exceeded reservation");
    assert!(result.is_err(), "non-object base-clusters was accepted");
}

/// Runs `f` and gives back the peak of live bytes above the start and the
/// live bytes still held when it returned.
fn measured<T>(f: impl FnOnce() -> T) -> (T, i64, i64) {
    let (out, _, peak) = counted(f);
    (out, peak, LIVE.with(Cell::get))
}

/// Parses `b` under `limits` and checks that it is refused as `expected`
/// having held no more than the charge known before it was called.
fn refused_within_charge(name: &str, b: &[u8], limits: SourceLimits, expected: SourceRefusal) {
    let charge = Projection::parse_reservation(b.len(), &limits).unwrap();
    let r = row();
    let (result, peak, _) = measured(|| Projection::parse(b, r, &limits));
    eprintln!(
        "{name}: source {} bytes, peak {peak}, charged {charge}",
        b.len()
    );
    assert_eq!(result.unwrap_err(), expected, "{name}");
    assert!(
        peak as u64 <= charge,
        "{name}: peak {peak} above the {charge} charged"
    );
}

#[test]
fn refused_parse_holds_no_more_than_was_charged() {
    let wide: String = (0..10_000).map(|i| format!("\"{i}\":0,")).collect();
    // Wide numeric keys, refused at the first comment over the limit.
    refused_within_charge(
        "wide priorities",
        format!(
            "{{\"comment-priorities\":{{{}}}}}",
            wide.trim_end_matches(',')
        )
        .as_bytes(),
        SourceLimits {
            max_comments: 9_999,
            ..SourceLimits::default()
        },
        SourceRefusal::TooLarge {
            what: Limit::Comments,
        },
    );
    // An unread object with every key spilled, refused at its end for a
    // repeated key.
    refused_within_charge(
        "spilled repeat",
        format!("{{\"other\":{{{wide}\"9999\":1}}}}").as_bytes(),
        SourceLimits::default(),
        SourceRefusal::DuplicateKey {
            key: Key::Projection,
        },
    );
    // One long escaped string, then bytes that are not JSON.
    let long = "\\u0061".repeat(20_000);
    refused_within_charge(
        "escaped string",
        format!("{{\"other\":\"{long}\",]").as_bytes(),
        SourceLimits::default(),
        SourceRefusal::Malformed {
            key: Key::Projection,
        },
    );
    // Eight long escaped keys kept decoded in one open object, then bytes
    // that are not JSON.
    let keys: String = (0..8)
        .map(|k| format!("\"{}{k}\":0,", "\\u0062".repeat(2_000)))
        .collect();
    refused_within_charge(
        "escaped keys",
        format!("{{\"other\":{{{keys}]").as_bytes(),
        SourceLimits::default(),
        SourceRefusal::Malformed {
            key: Key::Projection,
        },
    );
    // Nested past the depth limit.
    refused_within_charge(
        "depth",
        format!("{{\"other\":{}0{}}}", "[".repeat(40), "]".repeat(40)).as_bytes(),
        SourceLimits::default(),
        SourceRefusal::TooLarge { what: Limit::Depth },
    );
}

#[test]
fn union_refused_at_parse_within_its_charge() {
    // Five thousand tids and five thousand other meta comments, each within
    // the limit, their union over it: refused at parse, before any frame.
    let tids: Vec<String> = (0..5_000).map(|i| i.to_string()).collect();
    let meta: Vec<String> = (5_000..10_000).map(|i| i.to_string()).collect();
    let b = format!(
        "{{\"tids\":[{}],\"meta-tids\":[{}]}}",
        tids.join(","),
        meta.join(",")
    );
    refused_within_charge(
        "union",
        b.as_bytes(),
        SourceLimits {
            max_comments: 9_999,
            ..SourceLimits::default()
        },
        SourceRefusal::TooLarge {
            what: Limit::Comments,
        },
    );
}

#[test]
fn accepted_parse_within_its_charge_and_keeps_no_more_than_held() {
    for (groups, comments, per) in [(1, 1, 1), (4, 500, 3), (64, 300, 1), (5, 4_000, 40)] {
        let b = worst(groups, comments, per);
        let limits = SourceLimits::default();
        let charge = Projection::parse_reservation(b.len(), &limits).unwrap();
        let r = row();
        let (p, peak, live) = measured(|| Projection::parse(&b, r, &limits));
        let p = p.unwrap();
        assert!(
            peak as u64 <= charge,
            "{groups}x{comments}: peak {peak}, charged {charge}"
        );
        assert!(
            live as u64 <= p.held(),
            "{groups}x{comments}: kept {live}, held {}",
            p.held()
        );
    }
}

#[test]
fn parse_reservation_overflow_refused() {
    assert_eq!(
        Projection::parse_reservation(usize::MAX, &SourceLimits::default()).unwrap_err(),
        SourceRefusal::TooLarge {
            what: Limit::Reservation
        }
    );
}
