"""Unit tests for the certification bundle and the seeded boundary generator.

No database, no network, no real S3: the object store is the filesystem
stand-in (``fixture_bundle.LocalStore``), with an optional moto-backed
``S3Store`` pass when moto is installed. All data is SYNTHETIC and generated
here or by ``polismath.replay.fixture_generate``.

What the negative controls prove:

* corrupted, truncated, missing and extra files each fail ``verify``;
* republishing a bundle id with different bytes is REFUSED;
* a manifest carrying ``../`` (or an absolute path, or a symlink in the
  destination tree) is rejected before anything is written;
* the public pin carries no planted identifier.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest

from polismath.replay import fixture_bundle as fb
from polismath.replay import fixture_config as fc
from polismath.replay import fixture_generate as fg


# ---------------------------------------------------------------------------
# Generator: determinism, coverage, identity.
# ---------------------------------------------------------------------------

# A cheap subset of the shipped cases; the boundary sizes themselves are
# asserted from the config, not re-materialised here.
_CHEAP_CASES = (
    "gen-v1-one-voter", "gen-v1-two-voters", "gen-v1-too-few-voters",
    "gen-v1-all-pass", "gen-v1-constant-column", "gen-v1-no-eligible-comments",
    "gen-v1-repeated-timestamps", "gen-v1-out-of-order-commits", "gen-v1-dormant",
)


@pytest.fixture(scope="module")
def config():
    return fc.load_config()


def _generate(config, root: Path, only=_CHEAP_CASES):
    payload = root / ".local" / "payload"
    payload.mkdir(parents=True)
    summaries = fg.write_all(config["generated"], payload, root, only=list(only))
    return payload, summaries


def test_generator_is_byte_deterministic(config, tmp_path):
    a, sa = _generate(config, tmp_path / "a")
    b, sb = _generate(config, tmp_path / "b")
    assert fb.root_digest(fb.scan_files(a)) == fb.root_digest(fb.scan_files(b))
    assert [s["logical_digest_sha256"] for s in sa] \
        == [s["logical_digest_sha256"] for s in sb]


def test_generated_cases_declare_their_own_identity(config, tmp_path):
    _, summaries = _generate(config, tmp_path)
    for s in summaries:
        ident = s["generated"]
        assert ident["generator_id"] == config["generated"]["generator_id"]
        assert ident["seed"] == config["generated"]["seed"]
        assert "SYNTHETIC" in ident["provenance"]


def test_all_pass_case_has_only_pass_votes(config, tmp_path):
    payload, _ = _generate(config, tmp_path, only=["gen-v1-all-pass"])
    events = [json.loads(line) for line
              in (payload / "gen-v1-all-pass" / "events.jsonl").read_text().splitlines()]
    votes = [e for e in events if e["kind"] == "vote"]
    assert votes and all(e["vote"] == 0 for e in votes)


def test_repeated_timestamps_case_plants_equal_time_opposite_votes(config, tmp_path):
    payload, summaries = _generate(config, tmp_path, only=["gen-v1-repeated-timestamps"])
    census = summaries[0]["equal_time_census"]
    assert census["opposite_votes"] > 0, \
        "the ambiguity contract needs a fixture that actually contains the ambiguity"
    assert census["created_values_with_ties"] > 0


def test_out_of_order_case_has_later_ordinals_with_earlier_created(config, tmp_path):
    payload, _ = _generate(config, tmp_path, only=["gen-v1-out-of-order-commits"])
    events = [json.loads(line) for line in
              (payload / "gen-v1-out-of-order-commits" / "events.jsonl")
              .read_text().splitlines()]
    votes = [e for e in events if e["kind"] == "vote"]
    assert any(votes[i + 1]["created"] < votes[i]["created"] for i in range(len(votes) - 1))


def test_no_eligible_comments_case_moderates_every_comment(config, tmp_path):
    payload, _ = _generate(config, tmp_path, only=["gen-v1-no-eligible-comments"])
    events = [json.loads(line) for line in
              (payload / "gen-v1-no-eligible-comments" / "events.jsonl")
              .read_text().splitlines()]
    comments = [e for e in events if e["kind"] == "comment"]
    assert comments and all(e["mod"] == -1 for e in comments)


def test_dormant_case_sits_outside_the_boot_lookback(config, tmp_path):
    payload, _ = _generate(config, tmp_path, only=["gen-v1-dormant"])
    events = [json.loads(line) for line in
              (payload / "gen-v1-dormant" / "events.jsonl").read_text().splitlines()]
    case = next(c for c in config["generated"]["cases"] if c["id"] == "gen-v1-dormant")
    assert max(e["created"] for e in events) \
        < fg.BASE_MS - (case["dormant_age_days"] - 1) * fg.DAY_MS


def test_lru_cohort_expands_to_cache_cap_plus_one_distinct_fixtures(config):
    case = next(c for c in config["generated"]["cases"] if c["shape"] == "lru-cohort")
    dirs = fg.generate_case_dirs(case)
    assert len(dirs) == case["cohort_size"] == len(set(dirs))


def test_heavy_case_is_declared_but_not_materialised(config, tmp_path):
    payload = tmp_path / ".local" / "payload"
    payload.mkdir(parents=True)
    summaries = fg.write_all(config["generated"], payload, tmp_path,
                             only=["gen-v1-scale-33422x783"])
    assert summaries[0]["materialised"] is False
    assert not any(payload.iterdir())


def test_generator_cannot_write_outside_local(config, tmp_path):
    escape = tmp_path / "not-local"
    escape.mkdir()
    with pytest.raises(ValueError, match=r"\.local"):
        fg.write_all(config["generated"], escape, tmp_path, only=["gen-v1-one-voter"])


def test_compat_csv_negates_the_storage_sign(config, tmp_path):
    payload, _ = _generate(config, tmp_path, only=["gen-v1-constant-column"])
    d = payload / "gen-v1-constant-column"
    events = [json.loads(line) for line in (d / "events.jsonl").read_text().splitlines()]
    first_vote = next(e for e in events if e["kind"] == "vote")
    csv_rows = (d / "gen-v1-constant-column-votes.csv").read_text().splitlines()
    assert csv_rows[1].split(",")[-1] == str(-first_vote["vote"])


def test_comment_body_is_always_blank(config, tmp_path):
    payload, _ = _generate(config, tmp_path, only=["gen-v1-one-voter"])
    import csv as _csv

    with open(payload / "gen-v1-one-voter" / "gen-v1-one-voter-comments.csv") as fh:
        rows = list(_csv.DictReader(fh))
    assert rows and all(r["comment-body"] == "" for r in rows)


# ---------------------------------------------------------------------------
# Path safety.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", [
    "../escape", "/etc/passwd", "a/../../b", "C:/win", "a\\b", "", "  a", "./a",
    "a/./b", "a//b",
])
def test_unsafe_relpaths_are_rejected(bad):
    with pytest.raises(fb.UnsafePathError):
        fb.assert_safe_relpath(bad)


def test_scan_files_refuses_a_symlink(tmp_path):
    (tmp_path / "real.txt").write_text("x")
    os.symlink(tmp_path / "real.txt", tmp_path / "link.txt")
    with pytest.raises(fb.UnsafePathError, match="symlink"):
        fb.scan_files(tmp_path)


def test_safe_join_refuses_to_write_through_a_symlink(tmp_path):
    dest = tmp_path / "dest"
    (dest / "sub").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, dest / "evil")
    with pytest.raises(fb.UnsafePathError, match="symlink"):
        fb.safe_join(dest, "evil/file.txt")


# ---------------------------------------------------------------------------
# Manifest, push, pull, verify.
# ---------------------------------------------------------------------------


def _manifest(config, payload, bundle_id="pcb-test-0001"):
    return fb.build_manifest(
        bundle_id=bundle_id, payload_root=payload, config=config,
        config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes(),
        selections=[{"slug": "pc-v1-one", "role": "one", "dir": "gen-v1-one-voter",
                     "source": "production", "measured_metrics": {"V": 5}}],
        generated_summaries=[{"slug": "gen-v1-one-voter"}],
        snapshot={"identifier": "snap-test", "created_at": "2026-09-07T00:00:00Z",
                  "schema_migration_version": "000018"},
        transaction_guarantee={"isolation_level": "repeatable read",
                               "access_mode": "read only", "single_transaction": True},
        tie_key={"available": False, "columns": [], "method": "physical-ctid",
                 "order_by": "created ASC, ctid ASC",
                 "guarantee": "frozen-extract-order", "note": "frozen"},
        schedules=fb.collect_schedule_hashes(
            fc.SCRIPTS_DIR / "schedules"),
        owner="test-owner",
    )


@pytest.fixture
def bundle(config, tmp_path):
    payload, _ = _generate(config, tmp_path)
    manifest = _manifest(config, payload)
    provenance = fb.build_provenance(
        bundle_id=manifest["bundle_id"], root_digest_value=manifest["root_digest"],
        selections=[{"role": "one", "slug": "pc-v1-one", "dir": "gen-v1-one-voter",
                     "zid": 987654321}],
        owner="test-owner")
    store = fb.LocalStore(tmp_path / "store")
    return payload, manifest, provenance, store


def test_manifest_records_every_required_field(bundle):
    _, manifest, _, _ = bundle
    for key in ("schema_version", "bundle_id", "created_at", "owner", "commits",
                "snapshot", "transaction_guarantee", "ordering",
                "timestamp_precision", "polarity", "roles", "generated",
                "schedules", "files", "root_digest", "redactions", "retention"):
        assert key in manifest, key
    assert all({"path", "size", "rows", "sha256"} <= set(f) for f in manifest["files"])
    assert manifest["schedules"], "schedule hashes must be pinned"


def test_manifest_holds_no_zid(bundle):
    _, manifest, _, _ = bundle
    assert not fb.scan_for_identifiers(json.dumps(manifest), ["987654321"])


def test_provenance_is_the_only_place_identities_live(bundle):
    _, _, provenance, _ = bundle
    assert provenance["role_to_zid"][0]["zid"] == 987654321
    assert "RESTRICTED" in provenance["access"]


def test_push_pull_verify_roundtrip(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    pins = fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                   manifest=manifest, provenance=provenance)
    assert pins["root_digest"] == manifest["root_digest"]
    assert len(pins["objects"]) == len(manifest["files"]) + 2  # + manifest + provenance

    dest = tmp_path / "pulled"
    result = fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest)
    assert result["n_files"] == len(manifest["files"])
    assert fb.root_digest(fb.scan_files(dest / "payload")) == manifest["root_digest"]
    assert not (dest / fb.PROVENANCE_KEY).exists(), \
        "ordinary pulls must not fetch identities"


def test_two_independent_pulls_produce_identical_bytes(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    digests = []
    for i in range(2):
        dest = tmp_path / f"pull{i}"
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest)
        digests.append(fb.root_digest(fb.scan_files(dest / "payload")))
    assert digests[0] == digests[1] == manifest["root_digest"]


def test_pull_can_fetch_the_restricted_provenance_on_request(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    dest = tmp_path / "pulled"
    result = fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest,
                     with_provenance=True)
    assert result["provenance_pulled"]
    assert json.loads((dest / fb.PROVENANCE_KEY).read_text())["role_to_zid"]


def test_pull_refuses_a_non_empty_destination(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    dest = tmp_path / "dirty"
    dest.mkdir()
    (dest / "leftover").write_text("x")
    with pytest.raises(fb.BundleError, match="not empty"):
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest)


def test_republishing_identical_bytes_is_allowed(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    a = fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                manifest=manifest, provenance=provenance)
    b = fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                manifest=manifest, provenance=provenance)
    assert a["objects"] == b["objects"]


def test_republishing_a_bundle_id_with_different_bytes_is_refused(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    changed = copy.deepcopy(manifest)
    changed["owner"] = "someone-else"
    with pytest.raises(fb.ImmutabilityError, match="refusing to republish"):
        fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                manifest=changed, provenance=provenance)


def test_push_refuses_a_payload_that_changed_under_it(bundle):
    payload, manifest, provenance, store = bundle
    victim = payload / manifest["files"][0]["path"]
    victim.write_bytes(victim.read_bytes() + b"tamper")
    with pytest.raises(fb.VerificationError, match="payload changed under us"):
        fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                manifest=manifest, provenance=provenance)


@pytest.mark.parametrize("damage,needle", [
    ("corrupt", "hash mismatch"),
    ("truncate", "size mismatch"),
    ("missing", "missing file"),
    ("extra", "extra file not in manifest"),
])
def test_verify_fails_on_each_damage_class(bundle, damage, needle):
    payload, manifest, _, _ = bundle
    target = payload / manifest["files"][0]["path"]
    if damage == "corrupt":
        data = bytearray(target.read_bytes())
        data[0] ^= 0xFF
        target.write_bytes(bytes(data))
    elif damage == "truncate":
        target.write_bytes(target.read_bytes()[:-5])
    elif damage == "missing":
        target.unlink()
    else:
        (target.parent / "unexpected.csv").write_text("a,b\n1,2\n")
    with pytest.raises(fb.VerificationError, match=needle):
        fb.verify(payload, manifest)


def test_verify_reports_the_root_digest_mismatch_too(bundle):
    payload, manifest, _, _ = bundle
    (payload / manifest["files"][0]["path"]).unlink()
    with pytest.raises(fb.VerificationError, match="root digest mismatch"):
        fb.verify(payload, manifest)


def test_pull_rejects_a_traversal_path_in_the_manifest(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    # Forge a manifest with a traversal path and republish it under a NEW id.
    evil = copy.deepcopy(manifest)
    evil["bundle_id"] = "pcb-test-evil"
    evil["files"] = [dict(evil["files"][0], path="../../escaped.csv")]
    evil["root_digest"] = fb.root_digest(evil["files"])
    store.put(f"{evil['bundle_id']}/{fb.MANIFEST_KEY}", fb.canonical_json(evil))
    store.put(f"{evil['bundle_id']}/{fb.PINS_KEY}", fb.canonical_json({
        "schema_version": fb.PINS_SCHEMA_VERSION, "bundle_id": evil["bundle_id"],
        "root_digest": evil["root_digest"],
        "manifest_sha256": fb.sha256_bytes(fb.canonical_json(evil)),
        "provenance_sha256": "0" * 64, "objects": {},
    }))
    with pytest.raises(fb.UnsafePathError):
        fb.pull(store, bundle_id="pcb-test-evil", dest=tmp_path / "evil-dest")


def test_pull_rejects_a_bundle_id_that_disagrees_with_its_pins(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    pins = fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                   manifest=manifest, provenance=provenance)
    lying = dict(pins, bundle_id="pcb-somebody-else")
    with pytest.raises(fb.VerificationError, match="pins name bundle"):
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=tmp_path / "d", pins=lying)


def test_pull_rejects_a_store_object_that_no_longer_matches_its_pin(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    key = f"{manifest['bundle_id']}/{fb.DATA_PREFIX}{manifest['files'][0]['path']}"
    store._path(key).write_bytes(b"substituted")
    with pytest.raises(fb.VerificationError, match="version mismatch|hash mismatch"):
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=tmp_path / "d")


# ---------------------------------------------------------------------------
# Public pin.
# ---------------------------------------------------------------------------


def test_public_pin_carries_only_allowed_facts(bundle):
    _, manifest, _, _ = bundle
    pin = fb.public_pin(manifest)
    assert set(pin) <= set(fb.PUBLIC_PIN_KEYS)
    text = json.dumps(pin) + fb.render_public_pin_markdown(pin)
    planted = ["987654321", "snap-test", "test-owner", '"V": 5']
    assert not fb.scan_for_identifiers(text, planted)


def test_public_pin_markdown_has_bundle_id_and_root_digest(bundle):
    _, manifest, _, _ = bundle
    md = fb.render_public_pin_markdown(fb.public_pin(manifest))
    assert manifest["bundle_id"] in md and manifest["root_digest"] in md
    assert "BEGIN certification-bundle-pin" in md


# ---------------------------------------------------------------------------
# moto-backed S3 (optional).
# ---------------------------------------------------------------------------


def test_s3_store_roundtrip_under_moto(bundle, tmp_path, monkeypatch):
    moto = pytest.importorskip("moto", reason="moto not installed (dev extra)")
    import boto3

    payload, manifest, provenance, _ = bundle
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with moto.mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=fb.DEFAULT_BUCKET)
        client.put_bucket_versioning(
            Bucket=fb.DEFAULT_BUCKET,
            VersioningConfiguration={"Status": "Enabled"})
        store = fb.S3Store(bucket=fb.DEFAULT_BUCKET, client=client)
        pins = fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                       manifest=manifest, provenance=provenance)
        assert all(v["version_id"] != "null" for v in pins["objects"].values()), \
            "every object must be pinned to a real S3 VersionId"
        dest = tmp_path / "s3-pull"
        result = fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest)
        assert result["root_digest"] == manifest["root_digest"]
        with pytest.raises(fb.ImmutabilityError):
            fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                    manifest=dict(manifest, owner="other"), provenance=provenance)
