use anyhow::Result;
use polis_coordinator::store::{Payloads, digest};
use serde_json::json;
fn payload() -> Payloads {
    Payloads {
        main: json!({"zid":1,"lastVoteTimestamp":0,"base-clusters":{"id":[10,20],"members":[[1],[2]]}}),
        bidtopid: json!({"zid":1,"lastVoteTimestamp":0,"bidToPid":[[1],[2]]}),
        ptptstats: json!({"zid":1,"lastVoteTimestamp":0,"ptptstats":{"pid":[1,2],"gid":[0,1]}}),
    }
}
#[test]
fn valid_mapping() -> Result<()> {
    payload().validate(1)
}
#[test]
fn reject_swapped_buckets() {
    let mut p = payload();
    p.bidtopid["bidToPid"] = json!([[2], [1]]);
    assert!(p.validate(1).is_err());
}
#[test]
fn reject_foreign_namespace_identity() {
    assert!(payload().validate(2).is_err());
}
#[test]
fn reject_duplicate_base_ids() {
    let mut p = payload();
    p.main["base-clusters"]["id"] = json!([10, 10]);
    assert!(p.validate(1).is_err());
}
#[test]
fn reject_different_timestamps() {
    let mut p = payload();
    p.ptptstats["lastVoteTimestamp"] = json!(1);
    assert!(p.validate(1).is_err());
}
#[test]
fn reject_unequal_stat_columns() {
    let mut p = payload();
    p.ptptstats["ptptstats"]["gid"] = json!([0]);
    assert!(p.validate(1).is_err());
}
#[test]
fn hashes_cover_companions() -> Result<()> {
    let p = payload();
    let mut other = payload();
    other.ptptstats["ptptstats"]["gid"] = json!([1, 0]);
    assert_ne!(p.hashes()?, other.hashes()?);
    Ok(())
}
#[test]
fn ordinary_empty_prefix_hash() {
    assert_eq!(
        digest(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}
#[test]
fn jsonb_digest_ignores_numeric_spelling_only() -> Result<()> {
    use polis_coordinator::store::storage_digest;
    assert_eq!(
        storage_digest(&json!([-0.0, 1.0, 1e19]))?,
        storage_digest(&serde_json::from_str("[0,1,10000000000000000000]")?)?
    );
    assert_ne!(storage_digest(&json!([1]))?, storage_digest(&json!(["1"]))?);
    Ok(())
}
#[test]
fn strict_wire_rejects_duplicate_keys_and_nonfinite() {
    for bytes in [
        br#"{"ok":false,"ok":true}"#.as_slice(),
        br#"{"nested":{"a":1,"a":2}}"#,
        b"[NaN]",
    ] {
        assert!(polis_coordinator::wire::parse(bytes).is_err());
    }
}

// The declared source normalization (`polis-order/1`), Rev5 item 1: the live
// tie key is over the SEMANTIC vote, and that is a contract term, not a literal.
#[test]
fn declared_tie_key_is_over_the_semantic_vote() -> Result<()> {
    use polis_coordinator::ordering;
    let names: Vec<_> = ordering::TERMS.iter().map(|t| t.name).collect();
    assert_eq!(
        names,
        ["tid", "pid", "created_ms", "semantic_vote", "weight_x_32767"]
    );
    let sql = ordering::order_by();
    // The polarity constant is bound, and the raw sign is never ordered on.
    assert!(sql.contains(&format!("vote::bigint*{}::bigint", ordering::PARAMETER_BINDING)));
    assert!(!sql.split(',').any(|term| term.trim() == "vote"));
    assert!(sql.ends_with("weight_x_32767 NULLS FIRST"));
    let census = json!({"tied_groups":0});
    let manifest = ordering::manifest(-1, census.clone())?;
    assert_eq!(manifest["semantic_vote"], "raw_vote * storage_agree_value");
    assert_eq!(manifest["parameter"], ordering::PARAMETER);
    assert_eq!(manifest["storage_agree_value"], -1);
    assert_eq!(manifest["order_by"], sql);
    assert_eq!(manifest["equal_time_census"], census);
    // The declaration is polarity-bound: the agree convention is part of the
    // pinned ordering algorithm, so the two conventions cannot share a digest.
    assert_ne!(
        ordering::algorithm_digest(-1)?,
        ordering::algorithm_digest(1)?
    );
    Ok(())
}

#[test]
fn census_records_only_ambiguous_tied_groups() {
    use polis_coordinator::ordering::census;
    let row = |tid: i64, pid: i64, created: i64| json!({"tid":tid,"pid":pid,"created":created});
    let none = census(&[row(1, 1, 10), row(1, 2, 10), row(2, 1, 10)]);
    assert_eq!(none["tied_groups"], 0);
    assert_eq!(none["tied_rows"], 0);
    let tied = census(&[row(1, 1, 10), row(1, 1, 10), row(1, 2, 11), row(1, 2, 11)]);
    assert_eq!(tied["tied_groups"], 2);
    assert_eq!(tied["tied_rows"], 4);
    assert_eq!(tied["key"], json!(["tid", "pid", "created_ms"]));
    assert_eq!(tied["resolved_by"], json!(["semantic_vote", "weight_x_32767"]));
}

fn bundle(tick: i64) -> Box<polis_coordinator::store::Bundle> {
    Box::new(polis_coordinator::store::Bundle {
        payloads: payload(),
        math_tick: tick,
        caching_tick: tick,
        checkpoint: json!({"source_fingerprint": "synthetic"}),
    })
}

#[test]
fn warm_cache_never_returns_a_stale_generation() -> Result<()> {
    use polis_coordinator::{cache::WarmCache, fault::Fault};
    let fault = Fault::default();
    let mut cache = WarmCache::new(2);
    cache.insert(&fault, 7, bundle(4))?;
    // Another writer advanced the generation: the entry is a miss, not a
    // silently reused prior, and it is dropped rather than kept.
    assert!(cache.take(7, Some(5)).is_none());
    assert!(!cache.contains(7));
    cache.insert(&fault, 7, bundle(4))?;
    assert!(cache.take(7, None).is_none());
    cache.insert(&fault, 7, bundle(4))?;
    assert!(cache.take(7, Some(4)).is_some());
    assert!(cache.is_empty());
    Ok(())
}

#[test]
fn warm_cache_evicts_least_recently_used_within_capacity() -> Result<()> {
    use polis_coordinator::{cache::WarmCache, fault::Fault};
    let fault = Fault::default();
    let mut cache = WarmCache::new(2);
    for zid in [1, 2] {
        cache.insert(&fault, zid, bundle(0))?;
    }
    // Re-inserting 1 makes it most recent, so 2 is the victim.
    cache.insert(&fault, 1, bundle(0))?;
    cache.insert(&fault, 3, bundle(0))?;
    assert_eq!(cache.len(), 2);
    assert!(cache.contains(1) && cache.contains(3) && !cache.contains(2));
    let mut disabled = WarmCache::new(0);
    disabled.insert(&fault, 1, bundle(0))?;
    assert!(disabled.is_empty());
    Ok(())
}
