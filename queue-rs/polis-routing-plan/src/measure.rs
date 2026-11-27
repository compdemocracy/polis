//! The measuring pass: one walk over the bytes a parse will read, before it
//! reads them, that allocates nothing and counts what the parse charge is
//! made from. It accepts exactly the JSON serde_json accepts (its grammar,
//! its string escapes and surrogate pairs, its UTF-8 check, its recursion
//! limit), except that it does not convert numbers, so a number serde_json
//! then refuses as out of range is measured and accepted here; anything it
//! cannot tokenize it refuses, so the parse only ever runs on bytes whose
//! tokens were measured. Its counts are upper bounds on what the parse can
//! meet in those bytes, whether the parse then accepts them or not; the
//! parse checks them as it goes and refuses where they disagree.

use crate::identity::ContentId;
use crate::limits::{Limit, SourceLimits};
use crate::refusal::{Key, SourceRefusal};
use crate::scan::SMALL;

/// The deepest nesting serde_json reads: its recursion limit refuses the
/// 128th array or object open at once.
pub(crate) const SERDE_DEPTH: usize = 127;

/// What the measuring pass counted in one source. Every count is of the
/// source as written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Measure {
    len: u64,
    content: ContentId,
    longest_string: u64,
    longest_number: u64,
    depth: u64,
    escaped_keys: u64,
    spill: u64,
    tids: u64,
    meta: u64,
    read_text: u64,
}

impl Measure {
    /// The source's length in bytes.
    pub fn len(&self) -> u64 {
        self.len
    }
    /// Whether the source is empty (never, for a measured source).
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    /// The content id of the bytes measured.
    pub fn content(&self) -> &ContentId {
        &self.content
    }
    /// The longest string or object key, in bytes as written between its
    /// quotes: no decoded string or key is longer.
    pub fn longest_string(&self) -> u64 {
        self.longest_string
    }
    /// The longest number, in bytes as written.
    pub fn longest_number(&self) -> u64 {
        self.longest_number
    }
    /// The deepest nesting of arrays and objects; the outer value is 1.
    pub fn depth(&self) -> u64 {
        self.depth
    }
    /// The bytes, as written between their quotes, of every object key
    /// written with an escape, summed.
    pub fn escaped_keys(&self) -> u64 {
        self.escaped_keys
    }
    /// The most completed pairs held at once in the open objects that have
    /// completed more than eight (the walk's spill holds each such object's
    /// every key, the first eight with them).
    pub fn spill(&self) -> u64 {
        self.spill
    }
    /// The entries of the outer object's `tids` value (elements of an
    /// array, pairs of an object), summed over every `tids` key.
    pub fn tids(&self) -> u64 {
        self.tids
    }
    /// The entries of the outer object's `meta-tids` value, likewise.
    pub fn meta(&self) -> u64 {
        self.meta
    }
    /// The bytes of the values (as written, without the whitespace around
    /// them) of the outer object's keys the crate reads, `null` values
    /// excepted: what the parse copies out as the read keys' text.
    pub fn read_text(&self) -> u64 {
        self.read_text
    }
    /// The longest token a reader's scratch can hold: a decoded string, a
    /// number's digits, or a skipped value's open brackets.
    pub fn token(&self) -> u64 {
        self.longest_string.max(self.longest_number).max(self.depth)
    }
}

/// Which outer key a value is under.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Name {
    Other,
    Read,
    Tids,
    Meta,
}

/// The read keys' names, as the parse's `Raw` names them.
const READ: [&[u8]; 7] = [
    b"group-votes",
    b"pca",
    b"tids",
    b"meta-tids",
    b"comment-priorities",
    b"group-clusters",
    b"base-clusters",
];

/// One open array or object.
#[derive(Clone, Copy)]
struct Open {
    object: bool,
    entries: u64,
    counts: Name,
}

const CLOSED: Open = Open {
    object: false,
    entries: 0,
    counts: Name::Other,
};

/// Refusals the pass gives: none carries anything from the source.
fn malformed() -> SourceRefusal {
    SourceRefusal::Malformed {
        key: Key::Projection,
    }
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\n' | b'\t' | b'\r')
}

fn ws(b: &[u8], mut i: usize) -> usize {
    while b.get(i).is_some_and(|&c| is_ws(c)) {
        i += 1;
    }
    i
}

fn hex4(b: &[u8], i: usize) -> Option<u16> {
    let mut n: u16 = 0;
    for k in 0..4 {
        let d = (*b.get(i + k)? as char).to_digit(16)?;
        n = (n << 4) | d as u16;
    }
    Some(n)
}

/// A string from its opening quote at `i`: the index after its closing
/// quote, its length as written between the quotes, and whether it has an
/// escape. Refuses what serde_json refuses in a string it decodes: a
/// control byte, an unknown escape, a bad hex escape, a lone or unpaired
/// surrogate, bytes that are not UTF-8, or no closing quote.
fn string(b: &[u8], i: usize) -> Option<(usize, u64, bool)> {
    let mut j = i + 1;
    let mut run = j;
    let mut escaped = false;
    loop {
        match *b.get(j)? {
            b'"' => {
                std::str::from_utf8(b.get(run..j)?).ok()?;
                return Some((j + 1, (j - i - 1) as u64, escaped));
            }
            b'\\' => {
                std::str::from_utf8(b.get(run..j)?).ok()?;
                escaped = true;
                match *b.get(j + 1)? {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => j += 2,
                    b'u' => {
                        let n = hex4(b, j + 2)?;
                        if (0xDC00..=0xDFFF).contains(&n) {
                            return None;
                        }
                        if (0xD800..=0xDBFF).contains(&n) {
                            if b.get(j + 6) != Some(&b'\\') || b.get(j + 7) != Some(&b'u') {
                                return None;
                            }
                            let n2 = hex4(b, j + 8)?;
                            if !(0xDC00..=0xDFFF).contains(&n2) {
                                return None;
                            }
                            j += 12;
                        } else {
                            j += 6;
                        }
                    }
                    _ => return None,
                }
                run = j;
            }
            c if c < 0x20 => return None,
            _ => j += 1,
        }
    }
}

/// Whether the key written at `b` (between its quotes, already checked by
/// `string`) decodes to `name`. No read key's name has a byte past ASCII,
/// so an escape that decodes past ASCII never matches.
fn decodes_to(b: &[u8], name: &[u8]) -> bool {
    let (mut i, mut k) = (0usize, 0usize);
    while let Some(&c) = b.get(i) {
        let d = if c == b'\\' {
            let (d, step) = match b.get(i + 1) {
                Some(b'u') => match hex4(b, i + 2) {
                    Some(n) if n < 0x80 => (n as u8, 6),
                    _ => return false,
                },
                Some(b'"') => (b'"', 2),
                Some(b'\\') => (b'\\', 2),
                Some(b'/') => (b'/', 2),
                Some(b'b') => (0x08, 2),
                Some(b'f') => (0x0c, 2),
                Some(b'n') => (b'\n', 2),
                Some(b'r') => (b'\r', 2),
                Some(b't') => (b'\t', 2),
                _ => return false,
            };
            i += step;
            d
        } else {
            i += 1;
            c
        };
        if name.get(k) != Some(&d) {
            return false;
        }
        k += 1;
    }
    k == name.len()
}

fn name_of(key: &[u8]) -> Name {
    if decodes_to(key, b"tids") {
        Name::Tids
    } else if decodes_to(key, b"meta-tids") {
        Name::Meta
    } else if READ.iter().any(|n| decodes_to(key, n)) {
        Name::Read
    } else {
        Name::Other
    }
}

/// A number from its first byte at `i`: the index after it. serde_json's
/// grammar: an optional minus, one zero or a digit run not starting with
/// zero, an optional fraction of at least one digit, an optional exponent
/// of at least one digit.
fn number(b: &[u8], i: usize) -> Option<usize> {
    let digit = |j: usize| b.get(j).is_some_and(u8::is_ascii_digit);
    let digits = |mut j: usize| {
        while digit(j) {
            j += 1;
        }
        j
    };
    let mut j = i;
    if b.get(j) == Some(&b'-') {
        j += 1;
    }
    match b.get(j) {
        Some(b'0') => {
            j += 1;
            if digit(j) {
                return None;
            }
        }
        Some(b'1'..=b'9') => j = digits(j),
        _ => return None,
    }
    if b.get(j) == Some(&b'.') {
        if !digit(j + 1) {
            return None;
        }
        j = digits(j + 1);
    }
    if matches!(b.get(j), Some(b'e' | b'E')) {
        j += 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        if !digit(j) {
            return None;
        }
        j = digits(j);
    }
    Some(j)
}

/// Measures `bytes` under `limits`: their length against `max_bytes`, their
/// nesting against `max_depth` and serde_json's own limit, and every count
/// `Measure` names. Allocation free; linear in the length (one pass to
/// tokenize, one to hash).
pub(crate) fn measure(bytes: &[u8], limits: &SourceLimits) -> Result<Measure, SourceRefusal> {
    let len =
        u64::try_from(bytes.len()).map_err(|_| SourceRefusal::TooLarge { what: Limit::Bytes })?;
    if len > limits.max_bytes {
        return Err(SourceRefusal::TooLarge { what: Limit::Bytes });
    }
    let mut m = Measure {
        len,
        content: ContentId::of(bytes),
        longest_string: 0,
        longest_number: 0,
        depth: 0,
        escaped_keys: 0,
        spill: 0,
        tids: 0,
        meta: 0,
        read_text: 0,
    };
    tokens(bytes, limits, &mut m)
        .ok_or_else(malformed)?
        .map(|()| m)
}

/// The tokenizer behind `measure`: `None` for bytes it cannot tokenize,
/// `Some(Err)` for a depth refused, `Some(Ok)` when measured.
fn tokens(b: &[u8], limits: &SourceLimits, m: &mut Measure) -> Option<Result<(), SourceRefusal>> {
    let mut stack = [CLOSED; SERDE_DEPTH];
    let mut depth = 0usize;
    // The spill's live population, and the outer key whose value is open.
    let mut held = 0u64;
    let mut member = Name::Other;
    let mut member_start = 0usize;
    let mut was_null: bool;
    let mut i = ws(b, 0);
    // A value starts at `i`.
    'value: loop {
        was_null = false;
        match *b.get(i)? {
            open @ (b'{' | b'[') => {
                depth += 1;
                if depth > SERDE_DEPTH {
                    return None;
                }
                if depth as u64 > u64::from(limits.max_depth) {
                    return Some(Err(SourceRefusal::TooLarge { what: Limit::Depth }));
                }
                m.depth = m.depth.max(depth as u64);
                let counts = if depth == 2 && stack.first().is_some_and(|o| o.object) {
                    member
                } else {
                    Name::Other
                };
                *stack.get_mut(depth - 1)? = Open {
                    object: open == b'{',
                    entries: 0,
                    counts,
                };
                i = ws(b, i + 1);
                let close = if open == b'{' { b'}' } else { b']' };
                if b.get(i) == Some(&close) {
                    i += 1;
                    depth -= 1;
                } else if open == b'{' {
                    i = key(b, i, depth, m, &mut member, &mut member_start)?;
                    continue 'value;
                } else {
                    continue 'value;
                }
            }
            b'"' => {
                let (end, n, _) = string(b, i)?;
                m.longest_string = m.longest_string.max(n);
                i = end;
            }
            b'-' | b'0'..=b'9' => {
                let end = number(b, i)?;
                m.longest_number = m.longest_number.max((end - i) as u64);
                i = end;
            }
            b't' | b'f' | b'n' => {
                let word: &[u8] = match b.get(i) {
                    Some(b't') => b"true",
                    Some(b'f') => b"false",
                    _ => b"null",
                };
                if b.get(i..i + word.len())? != word {
                    return None;
                }
                was_null = word == b"null";
                i += word.len();
            }
            _ => return None,
        }
        // A value just ended at `i`, in the container at `depth`.
        loop {
            if depth == 0 {
                return (ws(b, i) == b.len()).then_some(Ok(()));
            }
            let top = stack.get_mut(depth - 1)?;
            top.entries = top.entries.saturating_add(1);
            match top.counts {
                Name::Tids => m.tids = m.tids.saturating_add(1),
                Name::Meta => m.meta = m.meta.saturating_add(1),
                _ => {}
            }
            let object = top.object;
            let entries = top.entries;
            if object {
                let small = SMALL as u64;
                if entries == small + 1 {
                    held = held.saturating_add(small + 1);
                } else if entries > small + 1 {
                    held = held.saturating_add(1);
                }
                m.spill = m.spill.max(held);
                if depth == 1 && member != Name::Other && !was_null {
                    m.read_text = m.read_text.saturating_add((i - member_start) as u64);
                }
            }
            i = ws(b, i);
            match *b.get(i)? {
                b',' => {
                    i = ws(b, i + 1);
                    if object {
                        i = key(b, i, depth, m, &mut member, &mut member_start)?;
                    }
                    continue 'value;
                }
                b'}' if object => {
                    if entries > SMALL as u64 {
                        held = held.saturating_sub(entries);
                    }
                }
                b']' if !object => {}
                _ => return None,
            }
            i += 1;
            depth -= 1;
            was_null = false;
        }
    }
}

/// An object key at `i`, its colon and the whitespace after it: the index
/// where its value starts. At the outer object, it names the member.
fn key(
    b: &[u8],
    i: usize,
    depth: usize,
    m: &mut Measure,
    member: &mut Name,
    member_start: &mut usize,
) -> Option<usize> {
    if b.get(i) != Some(&b'"') {
        return None;
    }
    let (end, n, escaped) = string(b, i)?;
    m.longest_string = m.longest_string.max(n);
    if escaped {
        m.escaped_keys = m.escaped_keys.saturating_add(n);
    }
    let j = ws(b, end);
    if b.get(j) != Some(&b':') {
        return None;
    }
    let start = ws(b, j + 1);
    if depth == 1 {
        *member = name_of(b.get(i + 1..end - 1)?);
        *member_start = start;
    }
    Some(start)
}
