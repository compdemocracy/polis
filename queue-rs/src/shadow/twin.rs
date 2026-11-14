//! Twin runs: the same comment set run twice, and how far apart the two
//! clusterings came out.
//!
//! Both run records carry each family's `content_sha256`, so whether a family
//! repeated byte for byte is read from the records themselves; the twin's
//! record also names the run it repeats (`config_effective.shadow.twin_of`).
//! The scheduler adds what the digests cannot say: for the cluster
//! assignments, per layer, the adjusted Rand index between the two runs (1.0
//! when they are the same partition, whatever the cluster numbers), the
//! number of clusters in each, and how many comments' co-membership changed.
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Layer {
    pub layer: usize,
    pub clusters_first: usize,
    pub clusters_twin: usize,
    pub adjusted_rand: f64,
    /// Comments whose cluster in the twin is not the cluster most of their
    /// first-run cluster went to: a count of moved comments under the best
    /// one-to-one reading of the two labelings.
    pub moved: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Comparison {
    pub comments_first: usize,
    pub comments_twin: usize,
    pub comments_compared: usize,
    pub layers_first: usize,
    pub layers_twin: usize,
    pub layers: Vec<Layer>,
    /// Family → whether the two records' `content_sha256` are equal.
    pub families: BTreeMap<String, bool>,
    pub identical: bool,
}

fn choose2(n: u64) -> f64 {
    (n as f64) * (n.saturating_sub(1) as f64) / 2.0
}

/// The adjusted Rand index of two labelings of the same items (Hubert and
/// Arabie). Unclustered items (-1) are one label like any other. Two
/// labelings that each put everything in one cluster, or that both have one
/// item, agree: 1.0.
pub fn adjusted_rand(a: &[i64], b: &[i64]) -> f64 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len() as u64;
    if n < 2 {
        return 1.0;
    }
    let mut table: HashMap<(i64, i64), u64> = HashMap::new();
    let mut rows: HashMap<i64, u64> = HashMap::new();
    let mut cols: HashMap<i64, u64> = HashMap::new();
    for (x, y) in a.iter().zip(b) {
        *table.entry((*x, *y)).or_default() += 1;
        *rows.entry(*x).or_default() += 1;
        *cols.entry(*y).or_default() += 1;
    }
    let index: f64 = table.values().map(|&v| choose2(v)).sum();
    let sum_a: f64 = rows.values().map(|&v| choose2(v)).sum();
    let sum_b: f64 = cols.values().map(|&v| choose2(v)).sum();
    let expected = sum_a * sum_b / choose2(n);
    let max = (sum_a + sum_b) / 2.0;
    if (max - expected).abs() < f64::EPSILON {
        return 1.0;
    }
    (index - expected) / (max - expected)
}

/// Comments moved between two labelings: the items not on the diagonal of the
/// best greedy one-to-one matching of first-run clusters to twin clusters.
pub fn moved(a: &[i64], b: &[i64]) -> usize {
    let mut table: Vec<((i64, i64), usize)> = {
        let mut t: HashMap<(i64, i64), usize> = HashMap::new();
        for (x, y) in a.iter().zip(b) {
            *t.entry((*x, *y)).or_default() += 1;
        }
        t.into_iter().collect()
    };
    table.sort_by(|p, q| q.1.cmp(&p.1).then(p.0.cmp(&q.0)));
    let (mut used_a, mut used_b) = (BTreeSet::new(), BTreeSet::new());
    let mut kept = 0;
    for ((x, y), count) in table {
        if !used_a.contains(&x) && !used_b.contains(&y) {
            used_a.insert(x);
            used_b.insert(y);
            kept += count;
        }
    }
    a.len() - kept
}

fn clusters(labels: &[i64]) -> usize {
    labels
        .iter()
        .filter(|l| **l >= 0)
        .collect::<BTreeSet<_>>()
        .len()
}

fn families(record: &Value) -> BTreeMap<String, String> {
    record
        .get("families")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            Some((
                f.get("family")?.as_str()?.to_owned(),
                f.get("content_sha256")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// Compare the first run and its twin: their records and their assignments.
pub fn compare(
    first_record: &Value,
    twin_record: &Value,
    first: &BTreeMap<i64, Vec<i64>>,
    twin: &BTreeMap<i64, Vec<i64>>,
) -> Comparison {
    let (f1, f2) = (families(first_record), families(twin_record));
    let names: BTreeSet<&String> = f1.keys().chain(f2.keys()).collect();
    let families: BTreeMap<String, bool> = names
        .into_iter()
        .map(|n| (n.clone(), f1.contains_key(n) && f1.get(n) == f2.get(n)))
        .collect();
    let common: Vec<i64> = first
        .keys()
        .filter(|k| twin.contains_key(k))
        .copied()
        .collect();
    let layers_first = first.values().map(Vec::len).max().unwrap_or(0);
    let layers_twin = twin.values().map(Vec::len).max().unwrap_or(0);
    let label = |m: &BTreeMap<i64, Vec<i64>>, c: &i64, layer: usize| {
        m.get(c).and_then(|v| v.get(layer)).copied().unwrap_or(-1)
    };
    let layers: Vec<Layer> = (0..layers_first.max(layers_twin))
        .map(|layer| {
            let a: Vec<i64> = common.iter().map(|c| label(first, c, layer)).collect();
            let b: Vec<i64> = common.iter().map(|c| label(twin, c, layer)).collect();
            Layer {
                layer,
                clusters_first: clusters(&a),
                clusters_twin: clusters(&b),
                adjusted_rand: adjusted_rand(&a, &b),
                moved: moved(&a, &b),
            }
        })
        .collect();
    let identical = families.values().all(|same| *same)
        && layers_first == layers_twin
        && first.len() == twin.len()
        && layers.iter().all(|l| l.moved == 0);
    Comparison {
        comments_first: first.len(),
        comments_twin: twin.len(),
        comments_compared: common.len(),
        layers_first,
        layers_twin,
        layers,
        families,
        identical,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_same_partition_under_other_numbers_is_identical() {
        let a = [0, 0, 1, 1, 2, -1];
        let b = [5, 5, 3, 3, 9, -1];
        assert!((adjusted_rand(&a, &b) - 1.0).abs() < 1e-12);
        assert_eq!(moved(&a, &b), 0);
        assert!((adjusted_rand(&[1], &[2]) - 1.0).abs() < 1e-12);
        assert!((adjusted_rand(&[0, 0, 0], &[1, 1, 1]) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn a_different_partition_scores_below_one_and_counts_moves() {
        let a = [0, 0, 0, 1, 1, 1];
        let b = [0, 0, 1, 1, 1, 1];
        let ari = adjusted_rand(&a, &b);
        assert!(ari < 1.0 && ari > -1.0, "{ari}");
        assert_eq!(moved(&a, &b), 1);
        // The textbook value for these two labelings.
        let x = [0, 0, 0, 1, 1, 1];
        let y = [0, 0, 1, 1, 2, 2];
        assert!((adjusted_rand(&x, &y) - 0.242_424_242_424).abs() < 1e-9);
    }

    #[test]
    fn records_and_rows_compare_family_by_family_and_layer_by_layer() {
        let r1 = json!({"families":[{"family":"A","content_sha256":"1"},{"family":"B","content_sha256":"2"}]});
        let r2 = json!({"families":[{"family":"A","content_sha256":"1"},{"family":"B","content_sha256":"3"}]});
        let first: BTreeMap<i64, Vec<i64>> = [(1, vec![0, 0]), (2, vec![0, 0]), (3, vec![1, 0])]
            .into_iter()
            .collect();
        let same = compare(&r1, &r1, &first, &first);
        assert!(same.identical);
        assert_eq!(same.layers.len(), 2);
        assert_eq!(same.layers[0].clusters_first, 2);
        let twin: BTreeMap<i64, Vec<i64>> = [(1, vec![0, 0]), (2, vec![1, 0]), (3, vec![1, 0])]
            .into_iter()
            .collect();
        let c = compare(&r1, &r2, &first, &twin);
        assert!(!c.identical);
        assert_eq!(c.families.get("A"), Some(&true));
        assert_eq!(c.families.get("B"), Some(&false));
        assert_eq!(c.layers[0].moved, 1);
        assert_eq!(c.layers[1].moved, 0);
        assert_eq!(c.comments_compared, 3);
    }
}
