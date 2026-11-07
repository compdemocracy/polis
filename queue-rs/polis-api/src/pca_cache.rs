//! One LRU per conversation, shared by the math and presentation bodies.
//! Charges are computed once when a body is built, outside the cache lock.
use super::{PcaItem, Presentation};
use crate::js::{Js, Obj};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

struct Entry {
    item: Arc<PcaItem>,
    presentation: Option<Presentation>,
}

impl Entry {
    fn bytes(&self) -> usize {
        // Reserve for map buckets, ordering, and the entry's inline metadata.
        let mut bytes = 256_usize.saturating_add(self.item.retained_bytes);
        if let Some(p) = &self.presentation
            && !Arc::ptr_eq(&self.item, &p.presented)
        {
            bytes = bytes.saturating_add(p.presented.retained_bytes);
        }
        bytes
    }
}

pub(super) struct Cache {
    max_entries: usize,
    max_bytes: usize,
    entries: HashMap<i32, Entry>,
    order: VecDeque<i32>,
    bytes: usize,
    evictions_entries: u64,
    evictions_bytes: u64,
    oversized: u64,
}

impl Cache {
    pub(super) fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            evictions_entries: 0,
            evictions_bytes: 0,
            oversized: 0,
        }
    }

    fn touch(&mut self, zid: i32) {
        self.order.retain(|k| *k != zid);
        self.order.push_back(zid);
    }

    pub(super) fn get(&mut self, zid: &i32) -> Option<Arc<PcaItem>> {
        let item = self.entries.get(zid)?.item.clone();
        self.touch(*zid);
        Some(item)
    }

    pub(super) fn presentation(&mut self, zid: &i32) -> Option<Presentation> {
        let p = self.entries.get(zid)?.presentation.clone()?;
        self.touch(*zid);
        Some(p)
    }

    fn remove(&mut self, zid: i32) {
        if let Some(old) = self.entries.remove(&zid) {
            self.bytes -= old.bytes();
        }
        self.order.retain(|k| *k != zid);
    }

    fn insert(&mut self, zid: i32, entry: Entry) {
        self.remove(zid);
        let bytes = entry.bytes();
        if bytes > self.max_bytes {
            self.oversized = self.oversized.saturating_add(1);
            return;
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.entries.insert(zid, entry);
        self.touch(zid);
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some(old) = self.order.front().copied() else {
                break;
            };
            if self.entries.len() > self.max_entries {
                self.evictions_entries = self.evictions_entries.saturating_add(1);
            } else {
                self.evictions_bytes = self.evictions_bytes.saturating_add(1);
            }
            self.remove(old);
        }
    }

    pub(super) fn set(&mut self, zid: i32, item: Arc<PcaItem>) {
        if self
            .entries
            .get(&zid)
            .is_some_and(|e| Arc::ptr_eq(&e.item, &item))
        {
            self.touch(zid);
            return;
        }
        self.insert(
            zid,
            Entry {
                item,
                presentation: None,
            },
        );
    }

    pub(super) fn set_presentation(&mut self, zid: i32, p: Presentation) {
        // An evicted/oversized or superseded source must not be retained again
        // through a presentation finishing later.
        if !self
            .entries
            .get(&zid)
            .is_some_and(|e| Arc::ptr_eq(&e.item, &p.source))
        {
            return;
        }
        self.insert(
            zid,
            Entry {
                item: p.source.clone(),
                presentation: Some(p),
            },
        );
    }

    pub(super) fn health(&self) -> Js {
        let mut out = Obj::new();
        for (key, value) in [
            ("entries", self.entries.len() as u64),
            ("bytes", self.bytes as u64),
            ("maxEntries", self.max_entries as u64),
            ("maxBytes", self.max_bytes as u64),
            ("evictionsEntries", self.evictions_entries),
            ("evictionsBytes", self.evictions_bytes),
            ("oversized", self.oversized),
        ] {
            out.set(key, Js::Num(value as f64));
        }
        Js::Obj(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(text: &str) -> Arc<PcaItem> {
        let mut obj = Obj::new();
        obj.set("body", Js::Str(text.into()));
        super::super::Pca::build(obj, false, true).unwrap()
    }
    fn present(source: &Arc<PcaItem>, presented: &Arc<PcaItem>) -> Presentation {
        Presentation {
            source: source.clone(),
            presented: presented.clone(),
            expiration: 100.0,
        }
    }
    fn consistent(c: &Cache) {
        assert_eq!(c.bytes, c.entries.values().map(Entry::bytes).sum::<usize>());
        assert_eq!(c.order.len(), c.entries.len());
        assert!(c.bytes <= c.max_bytes);
        assert!(c.entries.len() <= c.max_entries);
    }
    #[test]
    fn byte_eviction_uses_access_order_and_exact_boundary() {
        let a = item("a");
        let weight = 256 + a.retained_bytes;
        let mut c = Cache::new(300, 2 * weight);
        c.set(1, a.clone());
        c.set(2, a.clone());
        consistent(&c);
        assert_eq!(c.bytes, 2 * weight);
        c.get(&1);
        c.set(3, a);
        consistent(&c);
        assert!(c.get(&2).is_none());
        assert!(c.get(&1).is_some());
        assert_eq!(c.evictions_bytes, 1);
        assert_eq!(c.evictions_entries, 0);
    }
    #[test]
    fn entry_eviction_has_a_distinct_reason() {
        let a = item("a");
        let mut c = Cache::new(1, usize::MAX);
        c.set(1, a.clone());
        c.set(2, a);
        consistent(&c);
        assert_eq!(c.evictions_entries, 1);
        assert_eq!(c.evictions_bytes, 0);
    }
    #[test]
    fn oversized_replacement_is_served_without_caching_or_evicting_neighbors() {
        let a = item("a");
        let big = item(&"x".repeat(10000));
        let mut c = Cache::new(300, 2 * (256 + a.retained_bytes));
        c.set(1, a.clone());
        c.set(2, a);
        c.set(1, big.clone());
        consistent(&c);
        assert!(c.get(&1).is_none());
        assert!(c.get(&2).is_some());
        assert_eq!(c.oversized, 1);
        assert!(!big.gzip.is_empty());
    }
    #[test]
    fn zero_budget_does_not_retain_a_body() {
        let mut c = Cache::new(300, 0);
        c.set(1, item("a"));
        consistent(&c);
        assert!(c.get(&1).is_none());
        assert_eq!(c.oversized, 1);
    }
    #[test]
    fn presentation_and_source_share_one_budget() {
        let a = item("a");
        let b = item(&"b".repeat(1000));
        let mut c = Cache::new(300, 256 + a.retained_bytes + b.retained_bytes);
        c.set(1, a.clone());
        c.set(2, a.clone());
        c.set_presentation(1, present(&a, &b));
        consistent(&c);
        assert!(c.get(&2).is_none());
        assert_eq!(c.bytes, c.max_bytes);
        assert_eq!(c.evictions_bytes, 1);
        // A waiter reinserting the same source must preserve its presentation.
        c.set(1, a.clone());
        assert!(c.presentation(&1).is_some());
        // A new generation drops the old presentation and its charge.
        c.set(1, b.clone());
        consistent(&c);
        assert!(c.presentation(&1).is_none());
        c.set_presentation(1, present(&a, &a));
        assert!(c.presentation(&1).is_none());
    }
    #[test]
    fn oversized_presentation_drops_both_and_cannot_resurrect_an_evicted_source() {
        let a = item("a");
        let big = item(&"b".repeat(10000));
        let mut c = Cache::new(300, 256 + a.retained_bytes);
        c.set(1, a.clone());
        c.set_presentation(1, present(&a, &big));
        consistent(&c);
        assert!(c.get(&1).is_none());
        assert_eq!(c.oversized, 1);
        c.set_presentation(1, present(&a, &a));
        assert_eq!(c.bytes, 0);
    }
    #[test]
    fn shared_source_is_counted_once_and_replacement_releases_its_charge() {
        let a = item("a");
        let mut c = Cache::new(300, usize::MAX);
        c.set(1, a.clone());
        let initial = c.bytes;
        c.set_presentation(1, present(&a, &a));
        assert_eq!(c.bytes, initial);
        consistent(&c);
        c.set(1, item("b"));
        assert_eq!(c.bytes, initial);
        consistent(&c);
    }
    #[test]
    fn growing_entry_evicts_until_both_bounds_hold_and_releases_presentations() {
        let a = item("a");
        let b = item(&"b".repeat(2000));
        let limit = 256 + b.retained_bytes;
        let mut c = Cache::new(300, limit);
        let mut inserted = 0;
        while c.bytes + 256 + a.retained_bytes <= limit {
            inserted += 1;
            c.set(inserted, a.clone());
        }
        assert!(inserted > 1);
        let extra = item("p");
        let weak = Arc::downgrade(&extra);
        c.set_presentation(inserted, present(&a, &extra));
        drop(extra);
        assert!(weak.upgrade().is_some());
        c.set(100, b);
        consistent(&c);
        assert_eq!(c.entries.len(), 1);
        assert!(weak.upgrade().is_none());
        assert!(c.evictions_bytes >= inserted as u64);
    }
}

// Model-based replacement, presentation and accounting tests.
#[cfg(test)]
mod accounting_tests {
    use super::super::{Pca, PcaItem, Presentation, item_bytes};
    use super::{Cache, Entry};
    use crate::js::{Js, Obj};
    use std::{
        collections::{HashMap, HashSet},
        sync::Arc,
    };

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn sized(body: usize, list: usize) -> Arc<PcaItem> {
        let mut obj = Obj::new();
        obj.set("body", Js::Str("x".repeat(body)));
        obj.set(
            "list",
            Js::Arr((0..list).map(|i| Js::Num(i as f64)).collect()),
        );
        Pca::build(obj, false, true).unwrap()
    }

    fn random_item(rng: &mut Rng) -> Arc<PcaItem> {
        if rng.below(2) == 0 {
            sized(1 + rng.below(300) as usize, rng.below(10) as usize)
        } else {
            sized(1 + rng.below(8000) as usize, rng.below(200) as usize)
        }
    }

    fn walk(p: &Arc<PcaItem>) -> usize {
        let w = item_bytes(&p.pojo, p.gzip.len());
        assert_eq!(
            w, p.retained_bytes,
            "stored charge differs from a fresh walk"
        );
        w
    }

    fn charge(e: &Entry) -> usize {
        let mut total = 256 + walk(&e.item);
        if let Some(p) = &e.presentation {
            assert!(
                Arc::ptr_eq(&p.source, &e.item),
                "a presentation outlived its source"
            );
            if !Arc::ptr_eq(&p.presented, &e.item) {
                total += walk(&p.presented);
            }
        }
        total
    }

    fn recount(c: &Cache) {
        let total: usize = c.entries.values().map(charge).sum();
        assert_eq!(
            c.bytes, total,
            "accounted bytes drifted from a from-scratch recount"
        );
        assert!(c.bytes <= c.max_bytes, "byte bound violated");
        assert!(c.entries.len() <= c.max_entries, "entry bound violated");
        assert_eq!(c.order.len(), c.entries.len());
        let mut seen = HashSet::new();
        for zid in &c.order {
            assert!(seen.insert(*zid) && c.entries.contains_key(zid));
        }
    }

    // Independent reference LRU: the front of `order` is least recently used.
    #[derive(Default)]
    struct Model {
        max_entries: usize,
        max_bytes: usize,
        order: Vec<i32>,
        item: HashMap<i32, Arc<PcaItem>>,
        presented: HashMap<i32, Arc<PcaItem>>,
        charge: HashMap<i32, usize>,
        evictions_entries: u64,
        evictions_bytes: u64,
        oversized: u64,
    }

    impl Model {
        fn touch(&mut self, zid: i32) {
            self.order.retain(|k| *k != zid);
            self.order.push(zid);
        }
        fn remove(&mut self, zid: i32) {
            self.order.retain(|k| *k != zid);
            self.item.remove(&zid);
            self.presented.remove(&zid);
            self.charge.remove(&zid);
        }
        fn total(&self) -> usize {
            self.charge.values().sum()
        }
        fn insert(&mut self, zid: i32, item: Arc<PcaItem>, presented: Option<Arc<PcaItem>>) {
            self.remove(zid);
            let mut charge = 256 + item.retained_bytes;
            if let Some(p) = &presented
                && !Arc::ptr_eq(p, &item)
            {
                charge += p.retained_bytes;
            }
            if charge > self.max_bytes {
                self.oversized += 1;
                return;
            }
            self.item.insert(zid, item);
            if let Some(p) = presented {
                self.presented.insert(zid, p);
            }
            self.charge.insert(zid, charge);
            self.order.push(zid);
            while self.order.len() > self.max_entries || self.total() > self.max_bytes {
                let lru = self.order[0];
                if self.order.len() > self.max_entries {
                    self.evictions_entries += 1;
                } else {
                    self.evictions_bytes += 1;
                }
                self.remove(lru);
            }
        }
        fn set(&mut self, zid: i32, item: Arc<PcaItem>) {
            if self.item.get(&zid).is_some_and(|i| Arc::ptr_eq(i, &item)) {
                self.touch(zid);
            } else {
                self.insert(zid, item, None);
            }
        }
        fn set_presentation(&mut self, zid: i32, source: Arc<PcaItem>, presented: Arc<PcaItem>) {
            if self.item.get(&zid).is_some_and(|i| Arc::ptr_eq(i, &source)) {
                self.insert(zid, source, Some(presented));
            }
        }
    }

    fn agree(c: &Cache, m: &Model) {
        recount(c);
        assert_eq!(
            c.order.iter().copied().collect::<Vec<_>>(),
            m.order,
            "LRU order"
        );
        assert_eq!(c.bytes, m.total());
        assert_eq!(
            (c.evictions_entries, c.evictions_bytes, c.oversized),
            (m.evictions_entries, m.evictions_bytes, m.oversized)
        );
        for (zid, e) in &c.entries {
            assert!(Arc::ptr_eq(&e.item, &m.item[zid]));
            match (&e.presentation, m.presented.get(zid)) {
                (None, None) => {}
                (Some(p), Some(q)) => assert!(Arc::ptr_eq(&p.presented, q)),
                _ => panic!("presentation retained differently for {zid}"),
            }
        }
    }

    fn present(source: &Arc<PcaItem>, presented: &Arc<PcaItem>) -> Presentation {
        Presentation {
            source: source.clone(),
            presented: presented.clone(),
            expiration: 0.0,
        }
    }

    #[test]
    fn churn_of_replacements_and_presentations_never_drifts() {
        let mut reasons = (0_u64, 0_u64, 0_u64);
        let mut ops = 0_u64;
        for seed in 1..=8_u64 {
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
            let (max_entries, max_bytes) = (8, 40_000);
            let mut c = Cache::new(max_entries, max_bytes);
            let mut m = Model {
                max_entries,
                max_bytes,
                ..Model::default()
            };
            let mut history: HashMap<i32, Vec<Arc<PcaItem>>> = HashMap::new();
            let huge = sized(60_000, 0);
            for _ in 0..1500 {
                ops += 1;
                let zid = rng.below(12) as i32;
                let current = m.item.get(&zid).cloned();
                let stale = history.get(&zid).and_then(|h| {
                    (!h.is_empty()).then(|| h[rng.below(h.len() as u64) as usize].clone())
                });
                match rng.below(100) {
                    0..30 => {
                        let it = random_item(&mut rng);
                        history.entry(zid).or_default().push(it.clone());
                        c.set(zid, it.clone());
                        m.set(zid, it);
                    }
                    30..40 => {
                        if let Some(it) = current {
                            c.set(zid, it.clone());
                            m.set(zid, it);
                        }
                    }
                    40..48 => {
                        if let Some(it) = stale {
                            c.set(zid, it.clone());
                            m.set(zid, it);
                        }
                    }
                    48..68 => {
                        if let Some(src) = current {
                            let presented = if rng.below(2) == 0 {
                                src.clone()
                            } else {
                                random_item(&mut rng)
                            };
                            c.set_presentation(zid, present(&src, &presented));
                            m.set_presentation(zid, src, presented);
                        }
                    }
                    68..73 => {
                        if let Some(src) = stale {
                            let presented = random_item(&mut rng);
                            c.set_presentation(zid, present(&src, &presented));
                            m.set_presentation(zid, src, presented);
                        }
                    }
                    73..88 => {
                        let hit = m.item.contains_key(&zid);
                        assert_eq!(c.get(&zid).is_some(), hit);
                        if hit {
                            m.touch(zid);
                        }
                    }
                    88..95 => {
                        let hit = m.presented.contains_key(&zid);
                        assert_eq!(c.presentation(&zid).is_some(), hit);
                        if hit {
                            m.touch(zid);
                        }
                    }
                    _ => {
                        if rng.below(2) == 0 {
                            c.set(zid, huge.clone());
                            m.set(zid, huge.clone());
                        } else if let Some(src) = current {
                            c.set_presentation(zid, present(&src, &huge));
                            m.set_presentation(zid, src, huge.clone());
                        }
                    }
                }
                agree(&c, &m);
            }
            reasons.0 += c.evictions_entries;
            reasons.1 += c.evictions_bytes;
            reasons.2 += c.oversized;
            for zid in 0..12 {
                c.remove(zid);
            }
            assert_eq!(c.bytes, 0, "draining releases every charge exactly");
        }
        println!(
            "cache churn: ops={ops} evictions_entries={} evictions_bytes={} oversized={}",
            reasons.0, reasons.1, reasons.2
        );
        assert!(
            reasons.0 > 0 && reasons.1 > 0 && reasons.2 > 0,
            "every reason exercised"
        );
    }

    #[test]
    fn oversized_arrival_while_full_evicts_nothing() {
        let small: Vec<_> = (0..5).map(|_| sized(1000, 0)).collect();
        assert!(
            small
                .iter()
                .all(|s| s.retained_bytes == small[0].retained_bytes)
        );
        let each = 256 + small[0].retained_bytes;
        let mut c = Cache::new(5, 5 * each);
        for (zid, it) in small.iter().enumerate() {
            c.set(zid as i32, it.clone());
        }
        recount(&c);
        assert_eq!(
            (c.entries.len(), c.bytes),
            (5, c.max_bytes),
            "both bounds exactly full"
        );
        c.get(&0);
        let before: Vec<i32> = c.order.iter().copied().collect();
        let huge = sized(200_000, 0);
        assert!(256 + huge.retained_bytes > c.max_bytes);
        for attempt in 1..=3 {
            c.set(99, huge.clone());
            recount(&c);
            assert!(!c.entries.contains_key(&99));
            assert_eq!(
                c.order.iter().copied().collect::<Vec<_>>(),
                before,
                "neighbours and order untouched"
            );
            assert_eq!(
                (c.evictions_entries, c.evictions_bytes, c.oversized),
                (0, 0, attempt)
            );
        }
        c.set(3, huge.clone());
        recount(&c);
        assert!(c.get(&3).is_none());
        assert_eq!(c.entries.len(), 4);
        assert_eq!(
            (c.evictions_entries, c.evictions_bytes, c.oversized),
            (0, 0, 4)
        );
        c.set_presentation(1, present(&small[1], &huge));
        recount(&c);
        assert!(c.get(&1).is_none());
        assert_eq!(c.entries.len(), 3);
        assert_eq!(
            (c.evictions_entries, c.evictions_bytes, c.oversized),
            (0, 0, 5)
        );
        assert!(!huge.gzip.is_empty());
    }
}

#[cfg(test)]
mod polling_tests {
    use super::super::{DEFAULT_CACHE_BYTES, Pca, ensure_complete, process_math_object};
    use super::*;

    fn open_body(suffix: &str) -> Arc<PcaItem> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../delphi/real_data");
        let directory = std::fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap())
            .find(|e| e.file_name().to_string_lossy().ends_with(suffix))
            .unwrap()
            .path();
        let file = std::fs::read_dir(directory)
            .unwrap()
            .map(|e| e.unwrap())
            .find(|e| e.file_name().to_string_lossy().ends_with("_math_blob.json"))
            .unwrap()
            .path();
        let mut parsed = crate::js::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
        let obj = parsed.as_obj_mut().unwrap();
        obj.set("math_tick", Js::Num(0.0));
        let mut obj = std::mem::take(obj);
        process_math_object(&mut obj).unwrap();
        let mut pojo = ensure_complete(Some(obj), 0.0);
        pojo.remove("zid");
        Pca::build(pojo, false, true).unwrap()
    }

    #[test]
    fn default_budget_retains_three_hundred_mixed_conversations_on_second_poll() {
        let mut body = Obj::new();
        body.set("body", Js::Str("x".repeat(96_000)));
        let small = Pca::build(body, false, true).unwrap();
        let medium = open_body("-vw");
        let tail = open_body("-biodiversity");
        let mut cache = Cache::new(300, DEFAULT_CACHE_BYTES);
        let mut hits = [0; 2];
        for hit_count in &mut hits {
            for zid in 0..300 {
                if cache.get(&zid).is_some() {
                    *hit_count += 1;
                } else {
                    let item = match zid % 20 {
                        19 => &tail,
                        16..=18 => &medium,
                        _ => &small,
                    };
                    cache.set(zid, item.clone());
                }
            }
        }
        println!(
            "mixed poll: hits={hits:?} retained={} bytes={} budget={}",
            cache.entries.len(),
            cache.bytes,
            DEFAULT_CACHE_BYTES
        );
        assert_eq!(hits, [0, 300]);
        assert_eq!(cache.entries.len(), 300);
        assert_eq!(cache.evictions_bytes, 0);
        // Keep room for variation in the active conversation size distribution.
        assert!(cache.bytes <= DEFAULT_CACHE_BYTES * 4 / 5);
    }
}
