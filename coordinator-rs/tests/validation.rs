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
