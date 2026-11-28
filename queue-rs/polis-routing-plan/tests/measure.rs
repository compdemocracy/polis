//! The measuring pass: that it allocates nothing, that its counts are the
//! ones serde_json's own parse of the same bytes gives (or both refuse),
//! and that a parse charged from them holds no more than it was charged,
//! on constructed adversarial inputs, valid and refused. Counted by a
//! counting allocator that moves every reallocation.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use polis_routing_plan::{
    FrameNeeds, Key, Limit, Measure, Projection, RowIdentity, SourceLimits, SourceRefusal,
};
use serde::de::{Deserializer as _, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::fmt;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<u64> = const { Cell::new(0) };
    static FREES: Cell<u64> = const { Cell::new(0) };
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

fn on_alloc(size: usize) {
    if ON.with(Cell::get) {
        ALLOCS.with(|a| a.set(a.get() + 1));
        LIVE.with(|l| {
            let live = l.get() + size as i64;
            l.set(live);
            PEAK.with(|p| p.set(p.get().max(live)));
        });
    }
}

fn on_free(size: usize) {
    if ON.with(Cell::get) {
        FREES.with(|f| f.set(f.get() + 1));
        LIVE.with(|l| l.set(l.get() - size as i64));
    }
}

// SAFETY: allocation and deallocation use System with matching layouts;
// reallocation explicitly allocates, copies and frees, so a move is counted
// in full. The counters are const-initialised thread locals.
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
        // SAFETY: GlobalAlloc guarantees a valid nonzero new size.
        let next_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        // SAFETY: next_layout is valid as above.
        let next = unsafe { System.alloc(next_layout) };
        if !next.is_null() {
            on_alloc(new_size);
            // SAFETY: distinct allocations of at least this many bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(ptr, next, layout.size().min(new_size));
                System.dealloc(ptr, layout);
            }
            on_free(layout.size());
        }
        next
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Runs `f`; gives back allocations, frees and the peak of live bytes above
/// the start.
fn counted<T>(f: impl FnOnce() -> T) -> (T, u64, u64, i64) {
    ALLOCS.with(|a| a.set(0));
    FREES.with(|f| f.set(0));
    LIVE.with(|l| l.set(0));
    PEAK.with(|p| p.set(0));
    ON.with(|o| o.set(true));
    let out = f();
    ON.with(|o| o.set(false));
    (
        out,
        ALLOCS.with(Cell::get),
        FREES.with(Cell::get),
        PEAK.with(Cell::get),
    )
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

// ---- serde_json's own spans of the same bytes -------------------------

/// What the measuring pass counts, taken from serde_json's own token spans
/// (`RawValue`) instead of the pass's tokenizer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Spans {
    longest_string: u64,
    longest_number: u64,
    depth: u64,
    escaped_keys: u64,
    spill: u64,
    tids: u64,
    meta: u64,
    read_text: u64,
}

fn of(m: &Measure) -> Spans {
    Spans {
        longest_string: m.longest_string(),
        longest_number: m.longest_number(),
        depth: m.depth(),
        escaped_keys: m.escaped_keys(),
        spill: m.spill(),
        tids: m.tids(),
        meta: m.meta(),
        read_text: m.read_text(),
    }
}

/// The walk keeps this many keys of an object before the rest spill; the
/// same constant as the crate's.
const SMALL: u64 = 8;

const READ: [&str; 7] = [
    "group-votes",
    "pca",
    "tids",
    "meta-tids",
    "comment-priorities",
    "group-clusters",
    "base-clusters",
];

struct Pairs;
impl<'de> Visitor<'de> for Pairs {
    type Value = Vec<(&'de RawValue, &'de RawValue)>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let mut v = Vec::new();
        while let Some(k) = a.next_key::<&'de RawValue>()? {
            v.push((k, a.next_value::<&'de RawValue>()?));
        }
        Ok(v)
    }
}

struct Elements;
impl<'de> Visitor<'de> for Elements {
    type Value = Vec<&'de RawValue>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let mut v = Vec::new();
        while let Some(e) = a.next_element::<&'de RawValue>()? {
            v.push(e);
        }
        Ok(v)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Counts {
    No,
    Tids,
    Meta,
}

fn visit(text: &str, depth: u64, counts: Counts, s: &mut Spans, held: &mut u64) {
    let first = text.as_bytes()[0];
    match first {
        b'{' => {
            s.depth = s.depth.max(depth);
            let mut de = serde_json::Deserializer::from_str(text);
            let pairs = de.deserialize_map(Pairs).unwrap();
            let mut n = 0u64;
            for (k, v) in pairs {
                let kt = k.get();
                let inner = kt.len() as u64 - 2;
                s.longest_string = s.longest_string.max(inner);
                if kt.contains('\\') {
                    s.escaped_keys += inner;
                }
                let name: String = serde_json::from_str(kt).unwrap();
                let child = match (depth, name.as_str()) {
                    (1, "tids") => Counts::Tids,
                    (1, "meta-tids") => Counts::Meta,
                    _ => Counts::No,
                };
                visit(v.get(), depth + 1, child, s, held);
                n += 1;
                if n == SMALL + 1 {
                    *held += SMALL + 1;
                } else if n > SMALL + 1 {
                    *held += 1;
                }
                s.spill = s.spill.max(*held);
                if depth == 1 && READ.contains(&name.as_str()) && v.get() != "null" {
                    s.read_text += v.get().len() as u64;
                }
                count(counts, s);
            }
            if n > SMALL {
                *held -= n;
            }
        }
        b'[' => {
            s.depth = s.depth.max(depth);
            let mut de = serde_json::Deserializer::from_str(text);
            for e in de.deserialize_seq(Elements).unwrap() {
                visit(e.get(), depth + 1, Counts::No, s, held);
                count(counts, s);
            }
        }
        b'"' => s.longest_string = s.longest_string.max(text.len() as u64 - 2),
        b'-' | b'0'..=b'9' => s.longest_number = s.longest_number.max(text.len() as u64),
        _ => {}
    }
}

fn count(counts: Counts, s: &mut Spans) {
    match counts {
        Counts::Tids => s.tids += 1,
        Counts::Meta => s.meta += 1,
        Counts::No => {}
    }
}

/// serde_json's verdict on `b` (its full parse, recursion limit included)
/// and, when it accepts, the counts from its own spans.
fn spans(b: &[u8]) -> Result<Spans, serde_json::Error> {
    serde_json::from_slice::<serde_json::Value>(b)?;
    let root: &RawValue = serde_json::from_slice(b)?;
    let mut s = Spans::default();
    let mut held = 0;
    visit(root.get(), 1, Counts::No, &mut s, &mut held);
    Ok(s)
}

// ---- constructed documents ---------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

const WS: [&str; 6] = ["", "", " ", "\n", "\t", "\r\n "];
const KEYS: [&str; 22] = [
    "\"tids\"",
    "\"meta-tids\"",
    "\"pca\"",
    "\"group-votes\"",
    "\"comment-priorities\"",
    "\"group-clusters\"",
    "\"base-clusters\"",
    "\"t\\u0069ds\"",
    "\"meta\\u002dtids\"",
    "\"\\u0070ca\"",
    "\"a\"",
    "\"\"",
    "\"votes\"",
    "\"members\"",
    "\"id\"",
    "\"\\u00e9t\\u00e9\"",
    "\"\\ud83d\\ude00\"",
    "\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"",
    "\"\u{e9}\u{20ac}\u{1f600}\"",
    "\"\u{7f}\"",
    "\"17\"",
    "\"comment-extremity\"",
];
const STRINGS: [&str; 12] = [
    "\"\"",
    "\"x\"",
    "\"\\n\\u0041\"",
    "\"\\ud800\\udc00\"",
    "\"\\uDBFF\\uDFFF\"",
    "\"\u{e9}\u{20ac}\u{1f600}\"",
    "\"\u{7f}\u{85}\u{200b}\"",
    "\"a\\\\b\\\"c\"",
    "\"\\/\\b\\f\\r\\t\"",
    "\"\\u20ac\\u00e9\"",
    "\"tids\"",
    "\"null\"",
];
const NUMBERS: [&str; 14] = [
    "0",
    "-0",
    "7",
    "-12",
    "3.25",
    "-0.5e+10",
    "1E-5",
    "6.02e23",
    "18446744073709551616",
    "-9223372036854775809",
    "1e308",
    "5e-324",
    "123456789012345678901234567890",
    "0.1e1",
];

fn long_number(r: &mut Rng) -> String {
    let n = 20 + r.below(900) as usize;
    let mut s = String::from(if r.below(2) == 0 { "" } else { "-" });
    s.push('1');
    for _ in 0..n {
        s.push(char::from(b'0' + r.below(10) as u8));
    }
    if r.below(2) == 0 {
        s.push('.');
        s.push_str(&"0".repeat(r.below(40) as usize));
        s.push('5');
    }
    if r.below(2) == 0 {
        s.push_str(&format!("e-{}", r.below(300) + n as u64));
    }
    s
}

fn value(r: &mut Rng, depth: u32, out: &mut String) {
    let w = *r.pick(&WS);
    out.push_str(w);
    let kind = if depth >= 6 {
        2 + r.below(4)
    } else {
        r.below(7)
    };
    match kind {
        0 | 6 => {
            out.push('{');
            let n = if r.below(5) == 0 {
                9 + r.below(20)
            } else {
                r.below(5)
            };
            for i in 0..n {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(r.pick(&WS));
                if r.below(3) == 0 {
                    out.push_str(&format!("\"k{}\"", r.below(12)));
                } else {
                    out.push_str(r.pick(&KEYS));
                }
                out.push_str(r.pick(&WS));
                out.push(':');
                value(r, depth + 1, out);
            }
            out.push_str(r.pick(&WS));
            out.push('}');
        }
        1 => {
            out.push('[');
            let n = r.below(6);
            for i in 0..n {
                if i > 0 {
                    out.push(',');
                }
                value(r, depth + 1, out);
            }
            out.push_str(r.pick(&WS));
            out.push(']');
        }
        2 => out.push_str(r.pick(&STRINGS)),
        3 => out.push_str(r.pick(&NUMBERS)),
        4 => {
            if r.below(4) == 0 {
                out.push_str(&long_number(r));
            } else {
                out.push_str(&r.below(50_000).to_string());
            }
        }
        _ => out.push_str(r.pick(&["true", "false", "null"])),
    }
    out.push_str(r.pick(&WS));
}

/// A constructed source: an object most of the time (the top-level keys the
/// crate reads among its keys), sometimes any other value.
fn document(r: &mut Rng) -> Vec<u8> {
    let mut s = String::new();
    if r.below(8) == 0 {
        value(r, 1, &mut s);
    } else {
        s.push('{');
        let n = 1 + r.below(10);
        for i in 0..n {
            if i > 0 {
                s.push(',');
            }
            s.push_str(r.pick(&KEYS[..10]));
            s.push(':');
            value(r, 1, &mut s);
        }
        s.push('}');
    }
    s.into_bytes()
}

/// A malformed variant of `b`: cut short, a byte replaced, a byte removed,
/// bytes after it, or a lone surrogate or bad escape inside it.
fn mutate(r: &mut Rng, b: &[u8]) -> Vec<u8> {
    let mut v = b.to_vec();
    let at = r.below(v.len().max(1) as u64) as usize;
    match r.below(6) {
        0 => v.truncate(at),
        1 => {
            let bad = *r.pick(&[b'"', b'\\', b',', b'}', b']', 0x01, 0xff, b'x', b'0', b':']);
            if let Some(c) = v.get_mut(at) {
                *c = bad;
            }
        }
        2 => {
            if at < v.len() {
                v.remove(at);
            }
        }
        3 => v.extend_from_slice(r.pick(&[&b"x"[..], b"{}", b" ,", b"0", b"\0"])),
        4 => {
            let ins: &[u8] = r.pick(&[
                &b"\"\\ud800\""[..],
                b"\"\\udc00\"",
                b"\"\\x\"",
                b"\"\\u12\"",
            ]);
            let at = v.iter().position(|&c| c == b':').map_or(0, |p| p + 1);
            v.splice(at..at, ins.iter().copied()).for_each(drop);
        }
        _ => {
            let at = v.iter().position(|&c| c == b'[' || c == b'{').unwrap_or(0);
            v.insert(at, b'0');
        }
    }
    v
}

/// Edge cases written out by hand, valid and not.
fn corpus() -> Vec<Vec<u8>> {
    let mut c: Vec<Vec<u8>> = [
        "{}",
        " {} ",
        "{\"tids\":[]}",
        "{\"tids\":[1,2,3],\"meta-tids\":[3,4]}",
        "{\"tids\":{\"a\":1,\"b\":2}}",
        "{\"tids\":null,\"pca\":null}",
        "{\"tids\":7}",
        "{\"t\\u0069ds\":[1,2]}",
        "{\"tids\":[1],\"tids\":[2,3]}",
        "{\"a\":1,\"a\":2}",
        "[]",
        "\"x\"",
        "0",
        "{\"a\":01}",
        "{\"a\":1.}",
        "{\"a\":.5}",
        "{\"a\":-}",
        "{\"a\":+1}",
        "{\"a\":1e}",
        "{\"a\":1e+}",
        "{\"a\":[1,]}",
        "{\"a\":1,}",
        "{,}",
        "{\"a\" 1}",
        "{\"a\":tru}",
        "{\"a\":nul}",
        "{\"a\":\"\\ud800\"}",
        "{\"a\":\"\\udc00\"}",
        "{\"a\":\"\\ud800\\u0041\"}",
        "{\"a\":\"\\ud800x\"}",
        "{\"a\":\"\\u00g0\"}",
        "{\"a\":\"\\q\"}",
        "{\"a\":\"\u{1}\"}",
        "{\"a\":\"",
        "{\"a\":1",
        "{\"a\":1}x",
        "{\"a\":1} {}",
        "{1:2}",
        "",
        "   ",
        "\u{feff}{}",
        "{\"a\":1e400}",
        "{\"a\":-1e400}",
        "{\"a\":1e-400}",
    ]
    .iter()
    .map(|s| s.as_bytes().to_vec())
    .collect();
    c.push(b"{\"a\":\"\xff\"}".to_vec());
    c.push(b"{\"a\":\"\xe2\x82\"}".to_vec());
    c.push(b"{\"\xc3\x28\":1}".to_vec());
    c.push(format!("{{\"a\":{}}}", "9".repeat(400)).into_bytes());
    for d in [31usize, 32, 33, 126, 127, 128, 129] {
        c.push(format!("{{\"a\":{}0{}}}", "[".repeat(d - 1), "]".repeat(d - 1)).into_bytes());
        c.push(format!("{}{}", "{\"a\":".repeat(d), "}".repeat(d)).into_bytes());
    }
    c
}

fn family(seed: u64, n: usize) -> Vec<Vec<u8>> {
    let mut r = Rng(seed);
    let mut out = corpus();
    for _ in 0..n {
        let d = document(&mut r);
        out.push(mutate(&mut r, &d));
        out.push(d);
    }
    out
}

fn deep() -> SourceLimits {
    SourceLimits {
        max_depth: 200,
        ..SourceLimits::default()
    }
}

#[test]
fn measure_allocates_nothing() {
    let docs = family(0x9e37_79b9_7f4a_7c15, 1_500);
    for limits in [SourceLimits::default(), deep()] {
        let (refused, allocs, frees, peak) = counted(|| {
            docs.iter()
                .filter(|d| Projection::measure(d, &limits).is_err())
                .count()
        });
        assert_eq!((allocs, frees, peak), (0, 0, 0), "the measure allocated");
        assert!(refused > 0 && refused < docs.len());
    }
}

#[test]
fn measure_agrees_with_serde_on_the_same_bytes() {
    let docs = family(0x2545_f491_4f6c_dd1d, 4_000);
    let (mut agree, mut both_refuse, mut out_of_range) = (0, 0, 0);
    for d in &docs {
        match (Projection::measure(d, &deep()), spans(d)) {
            (Ok(m), Ok(s)) => {
                assert_eq!(of(&m), s, "{}", String::from_utf8_lossy(d));
                assert_eq!(m.len(), d.len() as u64);
                agree += 1;
            }
            (Err(r), Err(_)) => {
                assert!(
                    matches!(
                        r,
                        SourceRefusal::Malformed {
                            key: Key::Projection
                        }
                    ),
                    "{r:?}"
                );
                both_refuse += 1;
            }
            (Ok(_), Err(e)) => {
                // serde_json converts numbers; the measure does not.
                assert!(
                    e.to_string().starts_with("number out of range"),
                    "measured what serde refuses ({e}): {}",
                    String::from_utf8_lossy(d)
                );
                out_of_range += 1;
            }
            (Err(r), Ok(_)) => panic!(
                "refused what serde accepts ({r:?}): {}",
                String::from_utf8_lossy(d)
            ),
        }
    }
    println!(
        "differential: {} documents; counts equal {agree}; both refuse {both_refuse}; \
         number out of range (measured, serde refuses) {out_of_range}",
        docs.len()
    );
    assert!(agree > 2_000 && both_refuse > 1_000 && out_of_range > 0);
}

#[test]
fn measured_parse_is_the_parse() {
    let docs = family(0x5851_f42d_4c95_7f2d, 3_000);
    let limits = SourceLimits::default();
    let (mut accepted, mut refused, mut unmeasured) = (0, 0, 0);
    for d in &docs {
        let parsed = Projection::parse(d, row(), &limits);
        assert_ne!(
            parsed.as_ref().err(),
            Some(&SourceRefusal::TooLarge {
                what: Limit::Reservation
            }),
            "a measured disagreement: {}",
            String::from_utf8_lossy(d)
        );
        let Ok(m) = Projection::measure(d, &limits) else {
            assert!(parsed.is_err(), "{}", String::from_utf8_lossy(d));
            unmeasured += 1;
            continue;
        };
        let again = Projection::parse_measured(d, row(), &limits, &m);
        match (&parsed, &again) {
            (Ok(p), Ok(q)) => {
                assert_eq!(p.tally(), q.tally());
                assert_eq!(p.raw_len(), q.raw_len());
                assert_eq!(p.source(), q.source());
                assert_eq!(p.measured(), &m);
                assert_eq!((p.tally().tids, p.tally().meta), (m.tids(), m.meta()));
                assert_eq!(p.raw_len(), m.read_text());
                assert!(p.tally().longest_string <= m.longest_string());
                accepted += 1;
            }
            (Err(a), Err(b)) => {
                assert_eq!(a, b);
                refused += 1;
            }
            _ => panic!("parse and measured parse differ"),
        }
    }
    println!("measured parse: accepted {accepted}, refused {refused}, unmeasured {unmeasured}");
    assert!(accepted > 300 && refused > 300 && unmeasured > 300);
}

#[test]
fn other_bytes_than_measured_are_refused() {
    let limits = SourceLimits::default();
    let a = b"{\"tids\":[1,2]}";
    let b = b"{\"tids\":[1,3]}";
    let m = Projection::measure(a, &limits).unwrap();
    let r0 = row();
    let (r, allocs, _, _) = counted(|| Projection::parse_measured(b, r0, &limits, &m));
    let short = Projection::parse_measured(b"{}", row(), &limits, &m);
    let disagrees = SourceRefusal::TooLarge {
        what: Limit::Reservation,
    };
    assert_eq!(r.unwrap_err(), disagrees);
    assert_eq!(allocs, 0, "allocated before refusing other bytes");
    assert_eq!(short.unwrap_err(), disagrees);
    assert!(Projection::parse_measured(a, row(), &limits, &m).is_ok());
}

#[test]
fn other_limits_than_measured_are_refused() {
    // The union runs only past `max_comments`, so a charge taken under
    // wider limits does not cover a parse under narrower ones.
    let wide = SourceLimits {
        max_comments: 40_000,
        ..SourceLimits::default()
    };
    let narrow = SourceLimits {
        max_comments: 9_999,
        ..SourceLimits::default()
    };
    let tids: Vec<String> = (0..5_000).map(|i| i.to_string()).collect();
    let meta: Vec<String> = (5_000..10_000).map(|i| i.to_string()).collect();
    let b = format!(
        "{{\"tids\":[{}],\"meta-tids\":[{}]}}",
        tids.join(","),
        meta.join(",")
    )
    .into_bytes();
    let m = Projection::measure(&b, &wide).unwrap();
    let disagrees = SourceRefusal::TooLarge {
        what: Limit::Reservation,
    };
    assert_eq!(
        Projection::measured_parse_reservation(&m, &narrow).unwrap_err(),
        disagrees
    );
    let r0 = row();
    let (r, allocs, _, _) = counted(|| Projection::parse_measured(&b, r0, &narrow, &m));
    assert_eq!(r.unwrap_err(), disagrees);
    assert_eq!(allocs, 0, "allocated before refusing other limits");
    assert!(Projection::parse_measured(&b, row(), &wide, &m).is_ok());
}

/// Parses `b` charged from its measure, and checks it held no more than
/// that; gives the peak and the charge.
fn within_measured(
    name: &str,
    b: &[u8],
    limits: &SourceLimits,
) -> (Result<Projection, SourceRefusal>, i64, u64) {
    let m = Projection::measure(b, limits).unwrap();
    let charge = Projection::measured_parse_reservation(&m, limits).unwrap();
    let unmeasured = Projection::parse_reservation(b.len(), limits).unwrap();
    let (p, _, _, peak) = counted(|| Projection::parse_measured(b, row(), limits, &m));
    println!(
        "{name}: {} bytes, token {}, peak {peak}, measured charge {charge} ({:.2} of it), \
         unmeasured charge {unmeasured}{}; {:?}",
        b.len(),
        m.token(),
        peak as f64 / charge as f64,
        if peak as u64 > unmeasured {
            " EXCEEDED"
        } else {
            ""
        },
        p.as_ref().err()
    );
    assert!(
        peak >= 0 && peak as u64 <= charge,
        "{name}: peak {peak}, charged {charge}"
    );
    (p, peak, charge)
}

fn ids_with(text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"tids":[1],"meta-tids":[text]})).unwrap()
}

/// The 769-digit-and-more halfway case below the smallest subnormal: the
/// float conversion's slowest path.
fn halfway() -> String {
    format!(
        "2.{}e-324",
        "4703282292062327208828439643411068618252990130716238221279284125033775363510437593264991818081799618989828234772285886546332835517796989819938739800539093906315035659515570226392290858392449105184435931802849936536152500319370457678249219365623669863658480757001585769269903706311928279558551332927834338409351978015531246597263579574622766465272827220056374006485499977096599470454020828166226237857393450736339007967761930577506740176324673600968951340535537458516661134223766678604162159680461914467291840300530057530849048765391711386591646239524912623653881879636239373280423891018672348497668235089863388587925628302755995657524455507255189313690836254779186948667994968324049705821028513185451396213837722826145437693412532098591327667236328125"
    )
}

#[test]
fn parse_within_measured_charge() {
    let default = SourceLimits::default();
    // The spill: eight distinct keys, then empty keys that repeat only in
    // the spill, stopping just past a growth of its room.
    for (entries, max_comments) in [(16_385, 0), (262_145, 40_000)] {
        let mut b = String::from("{");
        for k in 0..8 {
            b.push_str(&format!("\"{k}\":0,"));
        }
        for _ in 8..entries {
            b.push_str("\"\":0,");
        }
        b.pop();
        b.push('}');
        let limits = SourceLimits {
            max_comments,
            ..default
        };
        let (p, _, _) = within_measured(&format!("spill {entries}"), b.as_bytes(), &limits);
        assert_eq!(
            p.unwrap_err(),
            SourceRefusal::DuplicateKey {
                key: Key::Projection
            }
        );
    }
    // Spills nested: every open object past its eighth key at once.
    let mut nested = String::new();
    for _ in 0..20 {
        nested.push('{');
        for k in 0..40 {
            nested.push_str(&format!("\"{k}\":0,"));
        }
        nested.push_str("\"x\":");
    }
    nested.push('0');
    nested.push_str(&"}".repeat(20));
    within_measured("nested spills", nested.as_bytes(), &default)
        .0
        .unwrap();
    // Long strings: escaped (the reader's scratch), raw, and escaped then
    // malformed.
    let esc = "\\u0061".repeat(20_000);
    within_measured(
        "escaped string",
        format!("{{\"other\":\"{esc}\"}}").as_bytes(),
        &default,
    )
    .0
    .unwrap();
    within_measured(
        "raw string",
        format!("{{\"other\":\"{}\"}}", "a".repeat(120_000)).as_bytes(),
        &default,
    )
    .0
    .unwrap();
    let pair = "\\ud83d\\ude00".repeat(5_000);
    within_measured(
        "surrogate pairs",
        format!("{{\"other\":\"{pair}\"}}").as_bytes(),
        &default,
    )
    .0
    .unwrap();
    // Escaped keys kept decoded in one open object, nested.
    let keys: String = (0..8)
        .map(|k| format!("\"{}{k}\":0,", "\\u0062".repeat(2_000)))
        .collect();
    within_measured(
        "escaped keys",
        format!("{{\"other\":{{{keys}\"x\":{{{keys}\"y\":0}}}}}}").as_bytes(),
        &default,
    )
    .0
    .unwrap();
    // Long numbers: the significand kept in scratch, the slow conversion,
    // one out of range.
    within_measured(
        "long significand",
        format!("{{\"other\":1.{}1}}", "0".repeat(16_385)).as_bytes(),
        &default,
    )
    .0
    .unwrap();
    within_measured(
        "long integer",
        format!("{{\"other\":{}}}", "7".repeat(300)).as_bytes(),
        &default,
    )
    .0
    .unwrap();
    within_measured(
        "halfway",
        format!("{{\"other\":{}}}", halfway()).as_bytes(),
        &default,
    )
    .0
    .unwrap();
    within_measured(
        "many halfway",
        format!("{{\"other\":[{}]}}", vec![halfway(); 40].join(",")).as_bytes(),
        &default,
    )
    .0
    .unwrap();
    let out = within_measured(
        "out of range",
        format!("{{\"other\":{}}}", "9".repeat(400)).as_bytes(),
        &default,
    )
    .0;
    assert!(out.is_err());
    // Depth: at the limit, and at serde_json's own.
    within_measured(
        "depth 32",
        format!("{{\"other\":{}0{}}}", "[".repeat(31), "]".repeat(31)).as_bytes(),
        &default,
    )
    .0
    .unwrap();
    within_measured(
        "depth 127",
        format!("{{\"other\":{}0{}}}", "[".repeat(126), "]".repeat(126)).as_bytes(),
        &deep(),
    )
    .0
    .unwrap();
    // The union: run, and refused.
    let tids: Vec<String> = (0..5_000).map(|i| i.to_string()).collect();
    let meta: Vec<String> = (5_000..10_000).map(|i| i.to_string()).collect();
    let union = format!(
        "{{\"tids\":[{}],\"meta-tids\":[{}]}}",
        tids.join(","),
        meta.join(",")
    );
    let limits = SourceLimits {
        max_comments: 9_999,
        ..default
    };
    let (p, _, _) = within_measured("union", union.as_bytes(), &limits);
    assert_eq!(
        p.unwrap_err(),
        SourceRefusal::TooLarge {
            what: Limit::Comments
        }
    );
    // Malformed ids in the union: serde's error message holds the string,
    // escaped for `Debug` (six bytes for each 0x7f).
    let one = SourceLimits {
        max_comments: 1,
        ..default
    };
    for n in [256, 4_096, 16_385] {
        for ch in ['\u{7f}', '\u{1}', '\u{85}', '\u{200b}', '\n', 'x'] {
            within_measured(
                &format!("malformed ids {:?} x{n}", ch),
                &ids_with(&ch.to_string().repeat(n)),
                &one,
            )
            .0
            .unwrap();
        }
    }
}

#[test]
fn frames_readers_within_measured_scratch() {
    let limits = SourceLimits::default();
    let del = "\u{7f}".repeat(16_385);
    let docs: Vec<(&str, Vec<u8>, FrameNeeds)> = vec![
        (
            "meta ids not ids",
            serde_json::to_vec(&serde_json::json!({"meta-tids":[del]})).unwrap(),
            FrameNeeds { meta: true, ..FrameNeeds::default() },
        ),
        (
            "priority not a number",
            serde_json::to_vec(&serde_json::json!({"comment-priorities":{"1":del}})).unwrap(),
            FrameNeeds { stored_weights: true, ..FrameNeeds::default() },
        ),
        (
            "cell field unknown",
            format!("{{\"group-votes\":{{\"0\":{{\"n-members\":1,\"votes\":{{\"1\":{{\"A\":1,\"D\":0,\"S\":1,\"{}\":0}}}}}}}}}}", "\u{7f}".repeat(16_385)).into_bytes(),
            FrameNeeds { groups: true, ..FrameNeeds::default() },
        ),
        (
            "extremity halfway",
            format!("{{\"tids\":[1,2],\"pca\":{{\"comment-extremity\":[{},{}]}}}}", halfway(), halfway()).into_bytes(),
            FrameNeeds { extremity: true, ..FrameNeeds::default() },
        ),
        (
            "extremity escaped strings",
            format!("{{\"tids\":[1],\"pca\":{{\"comment-extremity\":[1],\"other\":\"{}\"}}}}", "\\u0061".repeat(20_000)).into_bytes(),
            FrameNeeds { extremity: true, ..FrameNeeds::default() },
        ),
    ];
    for (name, b, needs) in docs {
        let p = Projection::parse(&b, row(), &limits).unwrap();
        let bound = p.reservation(needs).unwrap();

        let (r, _, _, peak) = counted(|| p.frames(needs));
        let old_readers = 4 * p.raw_len() + 512 + 4096;
        println!(
            "{name}: raw {}, token {}, frames peak {peak}, measured bound {bound} ({:.2}); \
             the unmeasured readers' term and fixed allowance {old_readers}{}; {:?}",
            p.raw_len(),
            p.measured().token(),
            peak as f64 / bound as f64,
            if peak as u64 > old_readers {
                " EXCEEDED"
            } else {
                ""
            },
            r.as_ref().err()
        );
        assert!(
            peak >= 0 && peak as u64 <= bound,
            "{name}: {peak} over {bound}"
        );
    }
}
