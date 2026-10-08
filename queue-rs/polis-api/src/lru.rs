//! `lru-cache` as the Node server uses it: a bounded map whose `get` and
//! `set` both make the key most recent, evicting the least recent beyond `max`.

use std::{
    collections::{HashMap, VecDeque},
    hash::Hash,
};

pub struct Lru<K, V> {
    cap: usize,
    entries: HashMap<K, V>,
    order: VecDeque<K>,
}

impl<K: Eq + Hash + Clone, V: Clone> Lru<K, V> {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn touch(&mut self, key: &K) {
        self.order.retain(|k| k != key);
        self.order.push_back(key.clone());
    }

    pub fn get(&mut self, key: &K) -> Option<V> {
        let value = self.entries.get(key).cloned()?;
        self.touch(key);
        Some(value)
    }

    pub fn set(&mut self, key: K, value: V) {
        self.touch(&key);
        self.entries.insert(key, value);
        while self.entries.len() > self.cap {
            match self.order.pop_front() {
                Some(old) => {
                    self.entries.remove(&old);
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_refreshes_and_set_evicts_the_least_recent() {
        let mut l = Lru::new(2);
        l.set(1, "a");
        l.set(2, "b");
        assert_eq!(l.get(&1), Some("a"));
        l.set(3, "c");
        assert_eq!(l.get(&2), None);
        assert_eq!(l.get(&1), Some("a"));
        assert_eq!(l.get(&3), Some("c"));
    }
}
