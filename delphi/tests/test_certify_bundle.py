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
from polismath.replay import fixture_extract as fx
from polismath.replay import fixture_generate as fg
from polismath.replay import prodclone as pc


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


def _satisfying_metrics(rule) -> dict[str, float]:
    """Measured metrics that satisfy EVERY predicate of ``rule``.

    Derived from the rule itself rather than hand-written, so this helper stays
    correct when the shipped thresholds move; it asserts the result really does
    satisfy the rule before handing it back.
    """
    bounds: dict[str, dict[str, float]] = {}
    for pred in rule["predicates"]:
        b = bounds.setdefault(pred["metric"], {})
        integral = isinstance(pred["value"], int)
        step = 1 if integral else 1e-6
        value = pred["value"]
        if pred["op"] == "ge":
            b["lo"] = max(b.get("lo", value), value)
        elif pred["op"] == "gt":
            b["lo"] = max(b.get("lo", value + step), value + step)
        elif pred["op"] == "le":
            b["hi"] = min(b.get("hi", value), value)
        elif pred["op"] == "lt":
            b["hi"] = min(b.get("hi", value - step), value - step)
        elif pred["op"] == "eq":
            b["lo"] = b["hi"] = value
        elif pred["op"] == "ne":
            b["not"] = value
    metrics: dict[str, float] = {}
    for metric, b in bounds.items():
        value = b.get("lo", b.get("hi", 1))
        if "hi" in b and value > b["hi"]:
            value = b["hi"]
        if b.get("not") == value:
            value = value + 1
        metrics[metric] = value
    assert fc.evaluate_predicates(metrics, rule["predicates"]), (rule["slug"], metrics)
    return metrics


def _selections(config, payload: Path) -> list[dict]:
    """One materialised production role per CONFIG role.

    Admission requires every configured role to be present, measured inside its
    own rule, and backed by a directory that actually holds bytes — so the
    fixture materialises a stub directory per role rather than naming one.
    """
    selections = []
    for rule in config["roles"]:
        dir_name = f"aaaaaaaaaaaaaaaa-{rule['slug']}"
        target = payload / dir_name
        target.mkdir(parents=True, exist_ok=True)
        (target / "events.jsonl").write_text(
            '{"ord":0,"kind":"vote","created":1,"pid":1,"tid":1,"vote":-1,'
            '"weight_x_32767":null}\n')
        selections.append({
            "slug": rule["slug"], "role": rule["role"], "dir": dir_name,
            "source": "production", "group": rule["group"], "rank": rule["rank"],
            "measured_metrics": _satisfying_metrics(rule),
            "ordering_guarantee": "frozen-extract-order",
            "compat": {"null_vote_policy": "drop-counted", "null_votes_dropped": 0,
                       "vote_rows_written": 1, "certifying": True},
        })
    return selections


def _manifest(config, payload, bundle_id="pcb-test-0001", generated_summaries=(),
              **overrides):
    kwargs = dict(
        bundle_id=bundle_id, payload_root=payload, config=config,
        config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes(),
        selections=_selections(config, payload),
        generated_summaries=list(generated_summaries),
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
        extraction_commit="0" * 40,
        source_commit="0" * 40,
    )
    kwargs.update(overrides)
    return fb.build_manifest(**kwargs)


@pytest.fixture
def bundle(config, tmp_path):
    payload, summaries = _generate(config, tmp_path)
    manifest = _manifest(config, payload, generated_summaries=summaries)
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
                     with_provenance=True,
                     provenance_role="polis-certification-provenance-reader")
    assert result["provenance_pulled"]
    assert result["provenance_role"] == "polis-certification-provenance-reader"
    assert json.loads((dest / fb.PROVENANCE_KEY).read_text())["role_to_zid"]


def test_provenance_pull_requires_its_own_named_permission(bundle, tmp_path):
    """Payload read access is NOT provenance read access: the caller has to name
    the distinct IAM principal it is exercising, and asking for identities
    without one fetches nothing."""
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    dest = tmp_path / "no-role"
    with pytest.raises(fb.BundleError, match="requires an explicit provenance_role"):
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest,
                with_provenance=True)
    assert not (dest / fb.PROVENANCE_KEY).exists()
    with pytest.raises(fb.BundleError, match="without with_provenance"):
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=tmp_path / "d2",
                provenance_role="some-role")


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_pulled_provenance_is_owner_only(bundle, tmp_path):
    """The extractor writes identities 0600; the pull path must not undo that by
    falling back to whatever the ambient umask allows."""
    payload, manifest, provenance, store = bundle
    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    dest = tmp_path / "modes"
    old = os.umask(0o022)
    try:
        fb.pull(store, bundle_id=manifest["bundle_id"], dest=dest,
                with_provenance=True, provenance_role="provenance-reader")
    finally:
        os.umask(old)
    assert (dest / fb.PROVENANCE_KEY).stat().st_mode & 0o777 == 0o600


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


# ---------------------------------------------------------------------------
# Post-review corrections. Each block below is a defect an independent review
# reproduced against this branch; the test is the thing that stops it coming
# back. Everything here is synthetic and offline.
# ---------------------------------------------------------------------------

# --- P1(2): NULL weight and NULL vote survive extraction -------------------


def test_null_weight_survives_extraction_as_null():
    """``weight_x_32767`` is nullable and NULL is a distinct storage fact.

    The old ``int(row["weight_x_32767"] or 0)`` collapsed NULL into 0 — and,
    because 0 is falsy, collapsed a real zero weight through the same branch.
    """
    events = fx.build_events(
        [{"created": 1000, "pid": 7, "tid": 9, "vote": -1, "weight_x_32767": None},
         {"created": 1001, "pid": 7, "tid": 10, "vote": 1, "weight_x_32767": 0},
         {"created": 1002, "pid": 7, "tid": 11, "vote": 0, "weight_x_32767": 32767}],
        [])
    assert [e["weight_x_32767"] for e in events] == [None, 0, 32767]


def test_null_vote_survives_the_event_stream():
    events = fx.build_events(
        [{"created": 1000, "pid": 7, "tid": 9, "vote": None, "weight_x_32767": None}],
        [])
    assert events[0]["vote"] is None


def test_null_vote_is_dropped_from_the_compat_csv_and_counted():
    """The compatibility CSV's readers parse the column as an integer
    (``real_data.load_export_votes`` does ``int(row["vote"])``), so a NULL has
    no representation there. It is omitted and COUNTED — never turned into 0,
    which would mean 'pass'."""
    events = fx.build_events([
        {"created": 1000, "pid": 7, "tid": 9, "vote": None, "weight_x_32767": None},
        {"created": 1001, "pid": 7, "tid": 9, "vote": -1, "weight_x_32767": 1},
    ], [])
    votes_rows, _, census = fx.compat_rows_from_events(events)
    assert len(votes_rows) == 1 and votes_rows[0]["vote"] == "1"
    assert census["null_votes_dropped"] == 1
    assert census["null_vote_policy"] == "drop-counted"
    assert census["certifying"] is False
    assert census["null_vote_ordinals"] == [0]


def test_compat_rows_do_not_raise_on_a_null_vote():
    """The reviewer's reproduction: a NULL vote reached unary negation in
    ``prodclone.format_votes_rows`` and raised TypeError AFTER half the
    extraction had been written."""
    events = fx.build_events(
        [{"created": 1000, "pid": 7, "tid": 9, "vote": None, "weight_x_32767": None}],
        [])
    votes_rows, comments_rows, census = fx.compat_rows_from_events(events)
    assert votes_rows == [] and comments_rows == []
    assert census["null_votes_dropped"] == 1


def test_format_votes_rows_refuses_a_null_vote_with_a_typed_error():
    """Callers without a declared policy get a typed refusal, not a TypeError
    from unary negation."""
    with pytest.raises(pc.NullVoteError, match="NULL"):
        pc.format_votes_rows([{"tid": 1, "pid": 2, "vote": None, "created": 1000}])


def test_a_null_vote_drop_is_not_admissible_without_an_explicit_acceptance(
        config, tmp_path):
    payload, summaries = _generate(config, tmp_path)
    manifest = _manifest(config, payload, generated_summaries=summaries)
    victim = manifest["roles"][0]
    victim["compat"] = {"null_vote_policy": "drop-counted", "null_votes_dropped": 3,
                        "vote_rows_written": 10, "certifying": False}
    with pytest.raises(fb.AdmissionError, match="NON-CERTIFYING"):
        fb.admit_manifest(manifest, config=config)
    manifest["admission"]["accepted_null_vote_drops"] = True
    fb.admit_manifest(manifest, config=config)


def test_the_equal_time_census_does_not_count_a_null_as_an_opposite_vote():
    events = fx.build_events([
        {"created": 1000, "pid": 1, "tid": 1, "vote": None, "weight_x_32767": None},
        {"created": 1000, "pid": 1, "tid": 1, "vote": -1, "weight_x_32767": None},
        {"created": 2000, "pid": 2, "tid": 1, "vote": -1, "weight_x_32767": None},
        {"created": 2000, "pid": 2, "tid": 1, "vote": 1, "weight_x_32767": None},
    ], [])
    census = fx.equal_time_census(events)
    assert census["opposite_votes"] == 1, "only the (2, 1, 2000) cell is opposing"
    assert census["null_votes"] == 1 and census["cells_with_null_vote"] == 1
    assert "GROUPS" in census["unit"]


# --- P1(4): semantic admission --------------------------------------------


def test_verify_refuses_an_empty_unversioned_manifest(tmp_path):
    """The reviewer's reproduction: an empty directory plus
    ``{files: [], root_digest: sha256(empty)}`` passed verification, with no
    schema version, identity, roles or coverage anywhere."""
    empty = tmp_path / "nothing"
    empty.mkdir()
    with pytest.raises(fb.VerificationError, match="schema_version"):
        fb.verify(empty, {"files": [], "root_digest": fb.root_digest([])})
    with pytest.raises(fb.VerificationError, match="lists NO files"):
        fb.verify(empty, {"schema_version": fb.MANIFEST_SCHEMA_VERSION,
                          "bundle_id": "pcb-empty", "files": [],
                          "root_digest": fb.root_digest([])})


def test_admission_accepts_the_reference_manifest(bundle, config):
    _, manifest, _, _ = bundle
    fb.admit_manifest(manifest, config=config,
                      config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes())


@pytest.mark.parametrize("mutate,needle", [
    (lambda m: m.update(schema_version="certify-fixture-manifest/1"),
     "schema_version"),
    (lambda m: m.update(surprise="unreviewed"), "unknown manifest field"),
    (lambda m: m.pop("polarity"), "missing required manifest field: polarity"),
    (lambda m: m["polarity"].update(storage_agree_value=1),
     "polarity.storage_agree_value"),
    (lambda m: m["roles"].pop(0), "is not in the manifest"),
    (lambda m: m["roles"][0].update(dir=None), "dir:null"),
    (lambda m: m["roles"][0].update(dir="never-materialised"),
     "not materialised"),
    (lambda m: m["roles"][0].update(measured_metrics={}),
     "records no measured metrics"),
    (lambda m: m["roles"][0]["measured_metrics"].update(V=-1),
     "do NOT satisfy the config predicates"),
    (lambda m: m["schedules"][0].update(expected_checkpoints=99),
     "expected checkpoint"),
    (lambda m: m["schedules"].clear(), "no schedules are pinned"),
    (lambda m: m["ordering"].update(guarantee="vibes"), "ordering.guarantee"),
    (lambda m: m["admission"].update(null_weight_policy="coerce-to-zero"),
     "nullable-preserved"),
    (lambda m: m.update(commits=dict(m["commits"], extraction_commit=None)),
     "extraction_commit"),
])
def test_admission_rejects(bundle, config, mutate, needle):
    _, manifest, _, _ = bundle
    broken = copy.deepcopy(manifest)
    mutate(broken)
    with pytest.raises(fb.AdmissionError, match=needle):
        fb.admit_manifest(broken, config=config)


def test_the_compat_census_policy_token_has_one_definition(config, tmp_path):
    """Admission must not import the extractor, so the policy string is
    restated in ``fixture_bundle``; this is the check that keeps the two
    copies from drifting into two different policies."""
    assert fb.REQUIRED_COMPAT_NULL_VOTE_POLICY == fx.COMPAT_NULL_VOTE_POLICY


def test_admission_rejects_a_tie_policy_that_contradicts_the_extract(bundle, config):
    """Reviewer's r2 finding 2a: the admission policies only had to be TRUTHY,
    so a manifest declaring ``frozen-extract-order`` in its ordering block and
    "same-input ties may differ arbitrarily" as its tie policy was admitted."""
    _, manifest, _, _ = bundle
    assert manifest["ordering"]["guarantee"] == "frozen-extract-order"
    assert manifest["admission"]["tie_order_policy"] == \
        fb.TIE_ORDER_POLICIES["frozen-extract-order"]

    prose = copy.deepcopy(manifest)
    prose["admission"]["tie_order_policy"] = \
        "same-input ties may differ arbitrarily"
    with pytest.raises(fb.AdmissionError, match="not a checkable declaration"):
        fb.admit_manifest(prose, config=config)

    # A token that IS in the enum, but is the other guarantee's token.
    swapped = copy.deepcopy(manifest)
    swapped["admission"]["tie_order_policy"] = \
        fb.TIE_ORDER_POLICIES["stable-tie-key"]
    with pytest.raises(fb.AdmissionError, match="CONTRADICTS ordering.guarantee"):
        fb.admit_manifest(swapped, config=config)

    # ... and the ordering block cannot claim a tie key it also says is absent.
    both = copy.deepcopy(manifest)
    both["ordering"]["guarantee"] = "stable-tie-key"
    both["admission"]["tie_order_policy"] = fb.TIE_ORDER_POLICIES["stable-tie-key"]
    with pytest.raises(fb.AdmissionError, match="names no available tie key"):
        fb.admit_manifest(both, config=config)


def test_admission_rejects_a_role_whose_extract_disagrees_with_the_manifest(
        bundle, config):
    _, manifest, _, _ = bundle
    broken = copy.deepcopy(manifest)
    broken["roles"][0]["ordering_guarantee"] = "stable-tie-key"
    with pytest.raises(fb.AdmissionError,
                       match="the extract and the declaration disagree"):
        fb.admit_manifest(broken, config=config)


def test_admission_requires_a_null_vote_census_under_the_drop_counted_policy(
        bundle, config):
    """Reviewer's r2 finding 2b: a MISSING compatibility census defaulted to
    zero drops and passed, so a role could lose NULL-vote rows silently."""
    _, manifest, _, _ = bundle
    assert manifest["admission"]["null_vote_policy"] == \
        fb.COMPAT_DROP_COUNTED_POLICY

    missing = copy.deepcopy(manifest)
    missing["roles"][0].pop("compat")
    with pytest.raises(fb.AdmissionError, match="not a census of zero"):
        fb.admit_manifest(missing, config=config)

    empty = copy.deepcopy(manifest)
    empty["roles"][0]["compat"] = {}
    with pytest.raises(fb.AdmissionError, match="not a census of zero"):
        fb.admit_manifest(empty, config=config)

    untyped = copy.deepcopy(manifest)
    untyped["roles"][0]["compat"]["null_votes_dropped"] = "none"
    with pytest.raises(fb.AdmissionError, match="integer null_votes_dropped"):
        fb.admit_manifest(untyped, config=config)

    # A census that counts drops AND calls itself certifying is a contradiction
    # even when the operator accepted the drops.
    lying = copy.deepcopy(manifest)
    lying["roles"][0]["compat"].update(null_votes_dropped=3, certifying=True)
    lying["admission"]["accepted_null_vote_drops"] = True
    with pytest.raises(fb.AdmissionError, match="is NOT certifying"):
        fb.admit_manifest(lying, config=config)


def test_admission_rejects_a_config_that_is_not_the_one_the_bundle_was_built_from(
        bundle, config):
    _, manifest, _, _ = bundle
    other = json.dumps(dict(config, config_version="v-elsewhere")).encode()
    with pytest.raises(fb.AdmissionError, match="different revision"):
        fb.admit_manifest(manifest, config_bytes=other)
    # Bytes that are not a config at all cannot admit anything either.
    with pytest.raises(fb.AdmissionError, match="not a valid selection config"):
        fb.admit_manifest(manifest, config=config, config_bytes=b"{}")


def test_the_hashed_config_bytes_are_the_only_rules_evaluated(bundle, config, tmp_path):
    """Reviewer's r3 finding: the digest and the rules actually evaluated had
    separate authorities. ``admit_manifest`` hashed ``config_bytes`` (or the
    committed default) but evaluated the independently supplied ``config``, or
    separately re-loaded ``config_path``. A caller could therefore keep the
    committed file's digest on the certificate while admitting under a
    schema-valid config whose predicate thresholds were weakened to ``>= 0``,
    and the two bypass paths below are exactly the ones reproduced."""
    _, manifest, _, _ = bundle

    loose = copy.deepcopy(config)
    for rule in loose["roles"]:
        for pred in rule["predicates"]:
            pred.update(op="ge", value=0)
    fc.validate_config(loose)                    # the weakened rules ARE valid

    zeroed = copy.deepcopy(manifest)
    for role in zeroed["roles"]:
        role["measured_metrics"] = {m: 0 for m in role["measured_metrics"]}

    # Control: under the committed rules the all-zero metrics are rejected.
    with pytest.raises(fb.AdmissionError):
        fb.admit_manifest(zeroed)

    # Bypass 1 — original bytes/digest, weakened PARSED config.
    with pytest.raises(fb.AdmissionError, match="not the config whose bytes are hashed"):
        fb.admit_manifest(zeroed, config=loose)

    # Bypass 2 — original bytes/digest, weakened config_path.
    loose_path = tmp_path / "loose.json"
    loose_path.write_text(json.dumps(loose))
    with pytest.raises(fb.AdmissionError, match="does not contain the config_bytes"):
        fb.admit_manifest(zeroed, config_path=loose_path,
                          config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes())

    # ...and the same two shapes are refused through push, which delegates.
    store = fb.LocalStore(tmp_path / "push-store")
    for kwargs in ({"config": loose},
                   {"config_path": loose_path,
                    "config_bytes": fc.DEFAULT_CONFIG_PATH.read_bytes()}):
        with pytest.raises(fb.AdmissionError):
            fb.push(store, bundle_id=zeroed["bundle_id"], payload_root=tmp_path,
                    manifest=zeroed,
                    provenance={"bundle_id": zeroed["bundle_id"]}, **kwargs)

    # A parsed config that IS the parse of the hashed bytes stays a valid
    # convenience argument, key order and whitespace notwithstanding.
    fb.admit_manifest(manifest, config=json.loads(
        json.dumps(config, sort_keys=True)))
    fb.admit_manifest(manifest, config_path=fc.DEFAULT_CONFIG_PATH,
                      config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes())


def test_the_config_digest_is_bound_on_the_library_default_path(bundle, config):
    """Reviewer's r2 finding 4: the digest was checked only when the caller
    supplied ``config_bytes``, so the LIBRARY default — which loads the
    committed config and passes no bytes — admitted a manifest built from a
    different revision of the selection rules."""
    _, manifest, _, _ = bundle
    forged = copy.deepcopy(manifest)
    forged["commits"]["config_sha256"] = "f" * 64

    with pytest.raises(fb.AdmissionError, match="different revision"):
        fb.admit_manifest(forged)                       # no config, no bytes
    with pytest.raises(fb.AdmissionError, match="different revision"):
        fb.admit_manifest(forged, config=config)        # parsed config, no bytes

    # The default path is the committed config, so the honest manifest still
    # passes with no arguments at all.
    fb.admit_manifest(manifest)


def test_push_and_pull_reject_a_foreign_config_digest_by_default(bundle, tmp_path):
    """The omission propagated through the push/pull library defaults."""
    payload, manifest, provenance, store = bundle
    forged = copy.deepcopy(manifest)
    forged["commits"]["config_sha256"] = "f" * 64
    with pytest.raises(fb.AdmissionError, match="different revision"):
        fb.push(store, bundle_id=forged["bundle_id"], payload_root=payload,
                manifest=forged, provenance=provenance)
    assert not store.exists(f"{manifest['bundle_id']}/{fb.MANIFEST_KEY}")

    # Get the forged manifest into the store the only way it can get there —
    # a construction-time push that skipped admission — then pull it with the
    # library defaults.
    fb.push(store, bundle_id=forged["bundle_id"], payload_root=payload,
            manifest=forged, provenance=provenance, admit=False)
    with pytest.raises(fb.AdmissionError, match="different revision"):
        fb.pull(store, bundle_id=forged["bundle_id"], dest=tmp_path / "d")


def test_verify_admit_cli_rejects_a_foreign_config_digest(bundle, tmp_path):
    """``certify_data.py verify --admit`` on a manifest built with a different
    config digest must exit nonzero and say so."""
    import importlib.util

    from click.testing import CliRunner

    payload, manifest, _, _ = bundle
    cli_path = Path(__file__).resolve().parents[1] / "scripts" / "certify_data.py"
    spec = importlib.util.spec_from_file_location("certify_data_cli", cli_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    forged = copy.deepcopy(manifest)
    forged["commits"]["config_sha256"] = "f" * 64
    manifest_path = tmp_path / "forged-manifest.json"
    manifest_path.write_text(json.dumps(forged))

    runner = CliRunner()
    bad = runner.invoke(mod.cli, ["verify", "--payload", str(payload),
                                  "--manifest", str(manifest_path)])
    assert bad.exit_code == 1, bad.output
    assert "different revision of the selection rules" in bad.output

    ok_path = tmp_path / "manifest.json"
    ok_path.write_text(json.dumps(manifest))
    good = runner.invoke(mod.cli, ["verify", "--payload", str(payload),
                                   "--manifest", str(ok_path)])
    assert good.exit_code == 0, good.output
    assert "ADMITTED" in good.output


def test_push_and_pull_both_run_admission(bundle, tmp_path):
    payload, manifest, provenance, store = bundle
    broken = copy.deepcopy(manifest)
    broken["roles"][0]["dir"] = None
    with pytest.raises(fb.AdmissionError):
        fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                manifest=broken, provenance=provenance)
    assert not store.exists(f"{manifest['bundle_id']}/{fb.MANIFEST_KEY}"), \
        "an inadmissible bundle must not occupy the logical id"

    fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
            manifest=manifest, provenance=provenance)
    # Substitute an inadmissible manifest into the store and pull it.
    evil = copy.deepcopy(manifest)
    evil["bundle_id"] = "pcb-test-inadmissible"
    evil["roles"] = []
    evil_bytes = fb.canonical_json(evil)
    store.put(f"{evil['bundle_id']}/{fb.MANIFEST_KEY}", evil_bytes)
    store.put(f"{evil['bundle_id']}/{fb.PINS_KEY}", fb.canonical_json({
        "schema_version": fb.PINS_SCHEMA_VERSION, "bundle_id": evil["bundle_id"],
        "root_digest": evil["root_digest"],
        "manifest_sha256": fb.sha256_bytes(evil_bytes),
        "provenance_sha256": "0" * 64, "objects": {},
    }))
    dest = tmp_path / "inadmissible"
    with pytest.raises(fb.AdmissionError):
        fb.pull(store, bundle_id=evil["bundle_id"], dest=dest)
    assert not (dest / "payload").exists(), \
        "nothing may be written before the manifest is admitted"


def test_schedule_checkpoints_are_derived_from_the_resolved_cuts():
    schedules = fb.collect_schedule_hashes(fc.SCRIPTS_DIR / "schedules")
    assert schedules
    for entry in schedules:
        assert entry["n_cuts"] >= 1
        assert entry["expected_checkpoints"] == entry["n_cuts"]
        assert entry["restart_index_base"] == fb.RESTART_INDEX_BASE
        if entry["restart_after"] is not None:
            # Zero-based step index with at least one step after the seam.
            assert 0 <= entry["restart_after"] <= entry["n_cuts"] - 2


def test_pinned_checkpoints_match_what_the_replay_driver_actually_slices(
        bundle, config, tmp_path):
    """Reviewer's r2 finding 3: the manifest validated ``restart_after`` as a
    ONE-based index (``1 <= r <= n_cuts``) while the replay driver uses a
    zero-based step index needing a following step (``0 <= r <= steps - 2``).
    Index 0 was falsely rejected; the nonexistent index ``n_cuts`` was admitted.

    The two conventions are pinned together here: the checkpoint count the
    manifest derives must equal the number of steps ``schedule.slice_schedule``
    produces, and the admission range must be the driver's range.
    """
    from polismath.replay import driver, schedule as sched
    from polismath.replay.types import ReplayDataset

    n_votes = 60
    dataset = ReplayDataset.build(
        [(1000 + i, 1 + i % 5, 1 + i % 4, 1) for i in range(n_votes)])

    spec_json = {
        "dataset": "synthetic-restart", "schedule_id": "uniform4-restart0",
        "source": "votes-csv",
        # A duplicate slot, collapsed under the explicit opt-in schedule.py now
        # requires, so the manifest's derived count has to collapse it too.
        # (A 0 slot is no longer degenerate: it is a real empty checkpoint and
        # needs its own `empty_checkpoint` opt-in, covered separately.)
        "cuts": {"mode": "vote-count", "at": [15, 15, 30, 45, n_votes],
                 "deduplicate": True},
        "moderation": "none", "clojure": {"warm_start": "chain"}, "notes": "",
        "restart_after": 0,
    }
    schedules_dir = tmp_path / "schedules"
    schedules_dir.mkdir()
    (schedules_dir / "synthetic-restart-uniform4.json").write_text(
        json.dumps(spec_json))

    entry = fb.collect_schedule_hashes(schedules_dir)[0]
    spec = sched.ScheduleSpec.from_dict(spec_json)
    steps = sched.slice_schedule(dataset, spec)

    assert entry["expected_checkpoints"] == len(steps) == 4, entry
    assert [s.index for s in steps] == [0, 1, 2, 3], "steps are zero-indexed"
    assert entry["restart_after"] == steps[0].index

    # The driver accepts exactly 0..len(steps)-2; admission must accept and
    # reject exactly the same set.
    accepted_by_driver = set()
    for candidate in range(-1, len(steps) + 1):
        try:
            driver.run_replay(dataset,
                              sched.ScheduleSpec.from_dict(
                                  dict(spec_json, restart_after=candidate)))
        except ValueError:
            continue
        except Exception:  # engine ran => the index was accepted
            pass
        accepted_by_driver.add(candidate)
    assert accepted_by_driver == {0, 1, 2}, accepted_by_driver

    # ... and real admission must accept and reject exactly the same set.
    _, manifest, _, _ = bundle
    accepted_by_admission = set()
    for candidate in range(-1, len(steps) + 1):
        probe = copy.deepcopy(manifest)
        probe["schedules"] = [dict(entry, restart_after=candidate)]
        try:
            fb.admit_manifest(probe, config=config)
        except fb.AdmissionError:
            continue
        accepted_by_admission.add(candidate)
    assert accepted_by_admission == accepted_by_driver, (
        "manifest admission and the replay driver disagree about which "
        "restart_after indices exist")

    # A SINGLE-cut schedule has no legal seam at all under this convention:
    # index 0 would be the last step, so the restart could never be observed.
    # driver.run_replay rejects it, and admission has to agree — "zero-based"
    # does not mean "0 is always valid".
    single = next(s for s in manifest["schedules"] if s["n_cuts"] == 1)
    with pytest.raises(ValueError, match="at least one step after it"):
        driver.run_replay(dataset, sched.ScheduleSpec.from_dict(
            {"dataset": "d", "schedule_id": "one", "source": "votes-csv",
             "cuts": {"mode": "vote-count", "at": [n_votes]},
             "moderation": "none", "clojure": {}, "notes": "",
             "restart_after": 0}))
    probe = copy.deepcopy(manifest)
    probe["schedules"] = [dict(single, restart_after=0)]
    with pytest.raises(fb.AdmissionError, match="legal range is 0..-1"):
        fb.admit_manifest(probe, config=config)


# --- P1(1): the publisher cannot fail open and cannot race ------------------


class _Headers(dict):
    """The two operations botocore's request headers expose to a signing hook."""

    def add_header(self, key, value):
        self[key] = value


class _EmittingClient:
    """Base test double carrying a REAL botocore event emitter.

    The conditional-create precondition is attached by a ``before-sign`` hook,
    so a double without an emitter is not a weaker double — it is a client the
    publisher must refuse (see
    ``test_conditional_put_refuses_a_client_that_cannot_carry_the_precondition``).
    Every double below therefore signs its own PutObject the way botocore does.
    """

    def __init__(self):
        from botocore.hooks import HierarchicalEmitter

        from types import SimpleNamespace

        self.meta = SimpleNamespace(events=HierarchicalEmitter())

    def _sign(self):
        """Emit ``before-sign`` and return the headers the request went out with."""
        request = type("R", (), {})()
        request.headers = _Headers()
        self.meta.events.emit("before-sign.s3.PutObject", request=request)
        return dict(request.headers)


class _DeniedHeadClient(_EmittingClient):
    """A store that answers HEAD with a permission error. Old behaviour: every
    HEAD failure was mapped to "absent", so the next put overwrote bytes the
    publisher could not even read."""

    def __init__(self, data=b"original"):
        super().__init__()
        self.data = data
        self.puts = 0

    def head_object(self, **kwargs):
        raise PermissionError("synthetic HEAD denied")

    def put_object(self, **kwargs):
        self.puts += 1
        self.headers = self._sign()
        self.data = kwargs["Body"]
        return {"VersionId": "synthetic-v2"}


def test_publisher_fails_closed_when_the_store_cannot_answer():
    client = _DeniedHeadClient()
    store = fb.S3Store("synthetic-offline-bucket", client=client)
    with pytest.raises(fb.StoreUnavailableError, match="not an absent key"):
        fb._put_immutable(store, "synthetic-bundle/manifest.json", b"replacement")
    assert client.data == b"original" and client.puts == 0


def test_a_genuinely_absent_key_is_still_absent():
    """Failing closed must not mean failing always: a real 404 is an absence."""

    class _Missing(_DeniedHeadClient):
        def head_object(self, **kwargs):
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}
            raise err

    client = _Missing()
    store = fb.S3Store("synthetic-offline-bucket", client=client)
    result = fb._put_immutable(store, "synthetic-bundle/manifest.json", b"new")
    assert client.data == b"new" and result.sha256 == fb.sha256_bytes(b"new")


def test_local_store_conditional_create_is_atomic(tmp_path):
    store = fb.LocalStore(tmp_path / "store")
    store.put_if_absent("k/a.json", b"first")
    with pytest.raises(fb.ObjectExistsError):
        store.put_if_absent("k/a.json", b"second")
    assert store.get("k/a.json")[0] == b"first"


def test_two_concurrent_local_conditional_puts_produce_exactly_one_winner(tmp_path):
    """The local stand-in, hit by two threads on the same key at once.

    The filesystem's ``O_CREAT | O_EXCL`` settles it; asserted here as the
    stand-in half of the S3 precondition test below, so both object-store
    implementations are covered by a CONCURRENT case and not only a serial one.
    """
    import threading

    store = fb.LocalStore(tmp_path / "store")
    barrier = threading.Barrier(2)
    outcomes: dict[bytes, object] = {}

    def write(body):
        barrier.wait()
        try:
            outcomes[body] = store.put_if_absent("k/a.json", body)
        except fb.ObjectExistsError as exc:
            outcomes[body] = exc

    threads = [threading.Thread(target=write, args=(b,))
               for b in (b"first", b"second")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert not any(t.is_alive() for t in threads)

    winners = [k for k, v in outcomes.items() if isinstance(v, fb.PutResult)]
    assert len(winners) == 1, outcomes
    losers = [v for v in outcomes.values() if not isinstance(v, fb.PutResult)]
    assert all(isinstance(v, fb.ObjectExistsError) for v in losers)
    assert store.get("k/a.json")[0] == winners[0]


class _RacingS3Client(_EmittingClient):
    """A fake S3 transport that FORCES the two conditional puts to overlap.

    ``A`` blocks inside ``put_object`` until ``B`` has entered it, and ``B``
    blocks until ``A`` has returned — so the second write signs while the first
    call is still in flight. That is the exact interleaving in which the old
    per-call ``register``/``unregister`` pair lost the precondition: A's
    ``unregister`` ran before B signed and B's PutObject went out
    unconditionally.

    Every request's headers are recorded and asserted on, not just the first.
    """

    def __init__(self):
        import threading

        super().__init__()
        self.headers: dict[bytes, dict] = {}
        self.bodies: list[bytes] = []
        self.b_entered = threading.Event()
        self.a_done = threading.Event()

    def head_object(self, **kwargs):
        err = Exception("not found")
        err.response = {"Error": {"Code": "404"}}
        raise err

    def put_object(self, **kwargs):
        body = kwargs["Body"]
        if body == b"A":
            assert self.b_entered.wait(10)
        else:
            self.b_entered.set()
            assert self.a_done.wait(10)
        self.headers[body] = self._sign()
        self.bodies.append(body)
        return {"VersionId": body.decode()}


def test_concurrent_conditional_puts_each_carry_the_precondition():
    """Reviewer's r2 finding 1: with two overlapping ``put_if_absent`` calls on
    ONE shared botocore client, the second PutObject went out with no
    ``If-None-Match`` — an unconditional overwrite of whatever the first
    publisher had just created."""
    import threading

    client = _RacingS3Client()
    store = fb.S3Store("synthetic-bucket", client=client)
    errors: list[BaseException] = []

    def write(body):
        try:
            store.put_if_absent("synthetic-key", body)
        except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
            errors.append(exc)
        finally:
            if body == b"A":
                client.a_done.set()

    threads = [threading.Thread(target=write, args=(b,), daemon=True)
               for b in (b"A", b"B")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(15)
    assert not any(t.is_alive() for t in threads)
    assert not errors, errors

    assert set(client.headers) == {b"A", b"B"}
    for body, headers in client.headers.items():
        assert headers.get("If-None-Match") == "*", (body, headers)


def test_an_ordinary_unconditional_put_is_not_given_the_precondition():
    """The hook stays registered for the client's lifetime, so it has to be
    gated: :meth:`S3Store.put` must NOT acquire an ``If-None-Match``."""
    client = _RacingS3Client()
    client.b_entered.set()
    client.a_done.set()
    store = fb.S3Store("synthetic-bucket", client=client)
    store.put_if_absent("k", b"A")
    store.put("k", b"B")
    assert client.headers[b"A"].get("If-None-Match") == "*"
    assert "If-None-Match" not in client.headers[b"B"]


def test_conditional_put_refuses_a_client_that_cannot_carry_the_precondition():
    """No emitter means no way to attach the precondition. Falling back to an
    unconditional PutObject would be the overwrite the guard exists to stop."""

    class _NoEvents:
        def __init__(self):
            self.puts = 0

        def head_object(self, **kwargs):
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}
            raise err

        def put_object(self, **kwargs):  # pragma: no cover - must never run
            self.puts += 1
            return {"VersionId": "v"}

    client = _NoEvents()
    store = fb.S3Store("synthetic-offline-bucket", client=client)
    with pytest.raises(fb.StoreUnavailableError, match="UNCONDITIONAL"):
        store.put_if_absent("k", b"bytes")
    assert client.puts == 0


def test_two_concurrent_pushes_produce_exactly_one_winner(config, tmp_path):
    """A barrier-controlled race on the same bundle id with DIFFERENT bytes.

    Both publishers pass their own pre-flight; the conditional create on
    ``manifest.json`` is what settles it. The loser must abort with
    ImmutabilityError having published nothing at all — in particular none of
    its payload objects, which is why the manifest is claimed first.
    """
    import threading

    bundle_id = "pcb-race-0001"
    payload_a, summaries_a = _generate(config, tmp_path / "a")
    payload_b, summaries_b = _generate(config, tmp_path / "b",
                                       only=_CHEAP_CASES[:3])
    manifest_a = _manifest(config, payload_a, bundle_id=bundle_id,
                           generated_summaries=summaries_a)
    manifest_b = _manifest(config, payload_b, bundle_id=bundle_id,
                           generated_summaries=summaries_b)
    assert manifest_a["root_digest"] != manifest_b["root_digest"]
    provenance = fb.build_provenance(
        bundle_id=bundle_id, root_digest_value=manifest_a["root_digest"],
        selections=[], owner="test-owner")

    store = fb.LocalStore(tmp_path / "store")
    barrier = threading.Barrier(2)
    outcomes: dict[str, object] = {}

    def publish(name, payload, manifest):
        barrier.wait()
        try:
            fb.push(store, bundle_id=bundle_id, payload_root=payload,
                    manifest=manifest,
                    provenance=dict(provenance,
                                    root_digest=manifest["root_digest"]))
            outcomes[name] = "published"
        except fb.ImmutabilityError as exc:
            outcomes[name] = exc

    threads = [
        threading.Thread(target=publish, args=("a", payload_a, manifest_a)),
        threading.Thread(target=publish, args=("b", payload_b, manifest_b)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    winners = [k for k, v in outcomes.items() if v == "published"]
    assert len(winners) == 1, outcomes
    loser = "b" if winners == ["a"] else "a"
    assert isinstance(outcomes[loser], fb.ImmutabilityError)

    won = manifest_a if winners == ["a"] else manifest_b
    lost = manifest_b if winners == ["a"] else manifest_a
    stored_manifest, _ = store.get(f"{bundle_id}/{fb.MANIFEST_KEY}")
    assert stored_manifest == fb.canonical_json(won)
    only_loser = {f["path"] for f in lost["files"]} - {f["path"] for f in won["files"]}
    for rel in only_loser:
        assert not store.exists(f"{bundle_id}/{fb.DATA_PREFIX}{rel}"), \
            f"the losing publisher wrote payload object {rel}"


def test_a_losing_push_leaves_the_winning_bytes_intact(bundle, config, tmp_path):
    """Sequential form of the race: the second publication of a spent id is
    refused at the FIRST write, and the published bundle is untouched."""
    payload, manifest, provenance, store = bundle
    pins = fb.push(store, bundle_id=manifest["bundle_id"], payload_root=payload,
                   manifest=manifest, provenance=provenance)

    other_payload, other_summaries = _generate(config, tmp_path / "other",
                                               only=_CHEAP_CASES[:2])
    other = _manifest(config, other_payload, bundle_id=manifest["bundle_id"],
                      generated_summaries=other_summaries)
    assert other["root_digest"] != manifest["root_digest"]
    with pytest.raises(fb.ImmutabilityError):
        fb.push(store, bundle_id=manifest["bundle_id"], payload_root=other_payload,
                manifest=other, provenance=provenance)

    stored, _ = store.get(f"{manifest['bundle_id']}/{fb.MANIFEST_KEY}")
    assert stored == fb.canonical_json(manifest)
    dest = tmp_path / "after-loss"
    assert fb.pull(store, bundle_id=manifest["bundle_id"],
                   dest=dest)["root_digest"] == pins["root_digest"]


def test_pins_are_written_last_so_an_interrupted_push_is_not_admitted(
        bundle, tmp_path):
    """``pins.json`` is the commit marker. Without it a pull has nothing to
    resolve object versions from and refuses, so a half-published prefix can
    never be mistaken for an admitted bundle."""
    payload, manifest, provenance, store = bundle

    class _FailsBeforePins(fb.LocalStore):
        def put_if_absent(self, key, data):
            if key.endswith(fb.PINS_KEY):
                raise RuntimeError("synthetic interruption before the commit marker")
            return super().put_if_absent(key, data)

    interrupted = _FailsBeforePins(tmp_path / "interrupted")
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        fb.push(interrupted, bundle_id=manifest["bundle_id"], payload_root=payload,
                manifest=manifest, provenance=provenance)
    assert interrupted.exists(f"{manifest['bundle_id']}/{fb.MANIFEST_KEY}")
    assert not interrupted.exists(f"{manifest['bundle_id']}/{fb.PINS_KEY}")
    with pytest.raises(fb.VerificationError, match="not found"):
        fb.pull(interrupted, bundle_id=manifest["bundle_id"], dest=tmp_path / "d")


# --- P2: the tie key must be a real key ------------------------------------


class _FakeCursor:
    def __init__(self, results):
        self._results = list(results)
        self._current: list = []
        self.sql: list[str] = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self._current = self._results.pop(0)

    def fetchall(self):
        return self._current

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    """detect_tie_key opens ONE cursor and runs the unique-index query then the
    surrogate-column query."""

    def __init__(self, uniques, surrogates):
        self._cursor = _FakeCursor([uniques, surrogates])

    def cursor(self):
        return self._cursor


def test_tie_key_catalog_query_excludes_the_forms_that_are_not_keys():
    """A partial, invalid, expression-based or nullable unique index is not a
    key over the table, and INCLUDE columns are payload rather than key
    columns. The guards live in the SQL, so the SQL is asserted."""
    sql = fx._SQL_UNIQUE_INDEXES
    for guard in ("i.indisvalid", "i.indislive", "i.indpred IS NULL",
                  "i.indexprs IS NULL", "k.ord <= i.indnkeyatts",
                  "bool_and(a.attnotnull)", "NOT a.attisdropped"):
        assert guard in sql, guard
    assert "is_nullable = 'NO'" in fx._SQL_SURROGATE_COLUMNS


def test_a_serial_column_without_a_unique_index_is_not_a_tie_key():
    """An identity/serial DEFAULT does not forbid a duplicate value: it is not
    a uniqueness guarantee, and claiming 'stable-tie-key' from it would assign
    a stronger promise than the schema makes."""
    result = fx.detect_tie_key(_FakeConn(uniques=[], surrogates=[("id",)]))
    assert result["guarantee"] == "frozen-extract-order"
    assert result["available"] is False
    assert "not a uniqueness guarantee" in result["note"]
    assert result["order_by"] == "created ASC, ctid ASC"


def test_a_serial_column_covered_by_a_unique_index_is_a_tie_key():
    result = fx.detect_tie_key(
        _FakeConn(uniques=[(False, ["id"], True)], surrogates=[("id",)]))
    assert result["guarantee"] == "stable-tie-key"
    assert result["method"] == "identity-or-serial-column"
    assert result["order_by"] == "created ASC, id ASC"


def test_a_primary_key_is_a_tie_key():
    result = fx.detect_tie_key(
        _FakeConn(uniques=[(True, ["zid", "pid", "tid"], True)], surrogates=[]))
    assert result["method"] == "primary-key"
    assert result["order_by"] == "created ASC, zid ASC, pid ASC, tid ASC"


def test_no_key_at_all_freezes_the_extract_order():
    result = fx.detect_tie_key(_FakeConn(uniques=[], surrogates=[]))
    assert result["guarantee"] == "frozen-extract-order"
    assert "need not reproduce ctid order" in result["note"]


# --- The decision: a synthetic substitute must be MATERIALISED and pinned ---


def _dense_only_config(config):
    """A minimal config holding only the two roles that may be substituted, with
    the dense generator case shrunk so the test stays cheap and the predicates
    lowered to match the shrunken case."""
    cfg = copy.deepcopy(config)
    cfg["roles"] = [copy.deepcopy(r) for r in config["roles"]
                    if r["slug"] in ("pc-v1-dense", "pc-v1-dense-max")]
    assert len(cfg["roles"]) == 2
    for role in cfg["roles"]:
        role["predicates"] = [
            {"metric": "P", "op": "ge", "value": 20},
            {"metric": "C", "op": "ge", "value": 5},
            {"metric": "density", "op": "ge", "value": 0.25},
        ]
    case = next(c for c in config["generated"]["cases"]
                if c["id"] == "gen-v1-dense-stress")
    cfg["generated"] = dict(
        config["generated"],
        cases=[dict(case, participants=20, comments=5, votes_per_participant=5)])
    return cfg


@pytest.mark.parametrize("include_generated", [True, False])
def test_a_synthetic_substitute_is_materialised_and_pinned(
        config, tmp_path, monkeypatch, include_generated):
    """``--accept-synthetic`` is an approval, not a fulfilment.

    The substitute's generator case is force-materialised even when generation
    is otherwise switched off, its directory is pinned into the role entry so
    the manifest can never record ``dir: null``, and its measured metrics —
    density over LATEST DISTINCT cells — must satisfy the same predicate the
    missing production role was defined by.
    """
    from polismath.replay import fixture_survey as fs

    cfg = _dense_only_config(config)
    monkeypatch.setattr(fs, "open_readonly_repeatable_read",
                        lambda conn, **kw: {"isolation_level": "repeatable read",
                                            "access_mode": "read only",
                                            "single_transaction": True,
                                            "writers_disabled_on_clone": True})
    monkeypatch.setattr(fs, "fetch_metrics", lambda conn: [])
    monkeypatch.setattr(fx, "detect_tie_key", lambda conn, table="votes": {
        "available": False, "columns": [], "method": "physical-ctid",
        "order_by": "created ASC, ctid ASC",
        "guarantee": "frozen-extract-order", "note": "frozen"})

    payload = tmp_path / ".local" / "payload"
    payload.mkdir(parents=True)
    result = fx.extract_from_config(
        object(), config=cfg, payload_root=payload, guard_root=tmp_path,
        accept_synthetic=["pc-v1-dense", "pc-v1-dense-max"],
        include_generated=include_generated)

    assert result["provenance_rows"] == [], "a substitute has no zid to record"
    for role in result["roles"]:
        assert role["source"] == "synthetic-replacement"
        assert role["dir"] == "gen-v1-dense-stress", \
            "an approved substitute recorded with dir:null is not fulfilled"
        assert (payload / role["dir"] / "events.jsonl").is_file()
        assert role["generator"]["case_id"] == "gen-v1-dense-stress"
        assert role["generator"]["seed"] == cfg["generated"]["seed"]
        assert role["coverage_limits"].startswith("SYNTHETIC")
        assert role["failed_production_predicate"]
        metrics = role["measured_metrics"]
        assert metrics["P"] == 20 and metrics["C"] == 5
        assert metrics["density"] == pytest.approx(1.0)
        assert "LATEST DISTINCT" in metrics["basis"]
        rule = next(r for r in cfg["roles"] if r["slug"] == role["slug"])
        assert fc.evaluate_predicates(metrics, rule["predicates"])


def test_generated_case_metrics_use_latest_distinct_cells_not_revote_rows():
    """Revoting the same cell must not inflate density: 8 vote rows over 2
    participants x 2 comments is density 1.0, not 2.0."""
    events = fx.build_events([
        {"created": 1000 + i, "pid": pid, "tid": tid, "vote": -1,
         "weight_x_32767": None}
        for i, (pid, tid) in enumerate(
            [(1, 1), (1, 2), (2, 1), (2, 2)] * 2)
    ], [])
    metrics = fg.case_metrics(events, participants=[{"pid": 1}, {"pid": 2}])
    assert metrics["V"] == 8 and metrics["U"] == 4
    assert metrics["C"] == 0  # no comment events in this synthetic stream
    metrics = fg.case_metrics(
        events + fx.build_events([], [
            {"tid": t, "pid": 1, "created": 1, "modified": None, "mod": 0,
             "is_meta": False} for t in (1, 2)]),
        participants=[{"pid": 1}, {"pid": 2}])
    assert metrics["P"] == 2 and metrics["C"] == 2
    assert metrics["matrix_area"] == 4
    assert metrics["density"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# P-023: manifest/3 — a DECLARED +-1 storage convention, the pair/transform
# block, and the DERIVED role source that makes a flipped bundle admissible.
#
# Every test here runs the REAL admission gate end to end: no filtered problem
# list (Astra review #2730 F1 — filtering hid the fact that no role source
# existed under which a flipped bundle could be admitted at all), so an
# unrelated admission error fails the test rather than being discarded.
#
# The shared `bundle` fixture pins the committed `schedules/` directory, which
# contains an independently pre-existing zero-cut schedule that admission
# rejects. These tests therefore pin the valid subset explicitly: the defect is
# real and untouched, but it is not what they are about.
# ---------------------------------------------------------------------------

import shutil


def _valid_schedules():
    return [s for s in fb.collect_schedule_hashes(fc.SCRIPTS_DIR / "schedules")
            if s["n_cuts"] > 0]


def _admit(manifest, config):
    fb.admit_manifest(manifest, config=config,
                      config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes())


@pytest.fixture
def admitted(config, tmp_path):
    """A COMPLETELY admitted original manifest/3 bundle: -1, transform null."""
    payload, summaries = _generate(config, tmp_path)
    manifest = _manifest(config, payload, generated_summaries=summaries,
                         schedules=_valid_schedules())
    _admit(manifest, config)
    return payload, manifest


def _flip_payload(src: Path, dest: Path) -> Path:
    """The derived side's payload: every non-null RAW vote leaf negated in the
    authoritative event stream, written back through the extractor's own
    serializer, and the compatibility CSVs regenerated under the flipped
    declared convention. Identities, ordinals, timestamps and order are
    untouched."""
    shutil.copytree(src, dest)
    for events_path in sorted(dest.rglob("events.jsonl")):
        events = [json.loads(line) for line
                  in events_path.read_text().splitlines() if line.strip()]
        for event in events:
            if event.get("kind") == "vote" and event.get("vote") is not None:
                event["vote"] = -event["vote"]
        fx.write_events_jsonl(events_path, events)
        votes_rows, comments_rows, _ = fx.compat_rows_from_events(
            events, storage_agree_value=1)
        stem = events_path.parent.name
        pc.write_votes_csv(events_path.parent / f"{stem}-votes.csv", votes_rows)
        pc.write_comments_csv(
            events_path.parent / f"{stem}-comments.csv", comments_rows)
    return dest


def test_an_original_capture_declares_minus_one_and_no_transform(admitted, config):
    _, manifest = admitted
    assert manifest["schema_version"] == "certify-fixture-manifest/3"
    assert manifest["polarity"]["storage_agree_value"] == -1
    assert manifest["transform"] is None
    assert {r["source"] for r in manifest["roles"]} <= fb.ORIGINAL_ROLE_SOURCES


def test_the_flipped_side_of_a_pair_verifies_admits_pushes_and_pulls(
        admitted, config, tmp_path):
    """F1, end to end and unfiltered. The whole point of the schema bump: the
    +1 side of the compensated pair must be publishable, and it was not — 15 of
    the 17 required roles carry on_missing:fail, so they can be neither
    substituted nor (under +1) production."""
    payload, manifest = admitted
    derived_payload = _flip_payload(payload, tmp_path / "derived-payload")

    # The involution is visible in the RAW stream and invisible in the
    # compatibility export: the export is semantic, so raw x s is unchanged.
    # That is the pair's convergence, asserted on real bytes.
    for original_csv in sorted(payload.rglob("*-votes.csv")):
        mirror = derived_payload / original_csv.relative_to(payload)
        assert mirror.read_bytes() == original_csv.read_bytes()
    raw_changed = [p for p in sorted(payload.rglob("events.jsonl"))
                   if (derived_payload / p.relative_to(payload)).read_bytes()
                   != p.read_bytes()]
    assert raw_changed, "the derived payload must actually differ in raw votes"

    derived = fb.build_derived_manifest(
        manifest, bundle_id="pcb-test-0001-flipped",
        payload_root=derived_payload,
        source_manifest_sha256=fb.sha256_bytes(fb.canonical_json(manifest)),
        bijective_verified=True,
        notes="P-023 compensated pair, flipped side")

    assert derived["polarity"]["storage_agree_value"] == 1
    assert all(r["source"] == fb.DERIVED_ROLE_SOURCE for r in derived["roles"])
    assert all(r["derived_from"]["bundle_id"] == manifest["bundle_id"]
               for r in derived["roles"])
    assert derived["transform"]["source"]["root_digest"] == manifest["root_digest"]

    fb.verify(derived_payload, derived)
    _admit(derived, config)

    store = fb.LocalStore(tmp_path / "store")
    provenance = fb.build_provenance(
        bundle_id=derived["bundle_id"], root_digest_value=derived["root_digest"],
        selections=[{"role": "one", "slug": "pc-v1-one", "dir": "gen-v1-one-voter",
                     "zid": 987654321}],
        owner="test-owner")
    pins = fb.push(store, bundle_id=derived["bundle_id"],
                   payload_root=derived_payload, manifest=derived,
                   provenance=provenance, config=config,
                   config_bytes=fc.DEFAULT_CONFIG_PATH.read_bytes())
    assert pins["root_digest"] == derived["root_digest"]

    dest = tmp_path / "pulled"
    result = fb.pull(store, bundle_id=derived["bundle_id"], dest=dest)
    assert result["n_files"] == len(derived["files"])
    assert fb.root_digest(fb.scan_files(dest / "payload")) == derived["root_digest"]


def test_a_production_capture_may_not_declare_the_flipped_convention(
        admitted, config):
    _, manifest = admitted
    broken = copy.deepcopy(manifest)
    broken["polarity"]["storage_agree_value"] = 1
    with pytest.raises(fb.AdmissionError, match="production storage is still -1"):
        _admit(broken, config)


@pytest.mark.parametrize("bad", [True, False, 0, -1.0, "-1", None, 2])
def test_a_convention_that_is_not_exactly_int_pm1_is_refused(admitted, config, bad):
    _, manifest = admitted
    broken = copy.deepcopy(manifest)
    broken["polarity"]["storage_agree_value"] = bad
    with pytest.raises(fb.AdmissionError, match="exactly the integer -1 or \\+1"):
        _admit(broken, config)


def _derived_manifest(manifest, payload_root, **overrides):
    kwargs = dict(
        bundle_id="pcb-test-0001-flipped", payload_root=payload_root,
        source_manifest_sha256=fb.sha256_bytes(fb.canonical_json(manifest)),
        bijective_verified=True)
    kwargs.update(overrides)
    return fb.build_derived_manifest(manifest, **kwargs)


@pytest.fixture
def derived_pair(admitted, tmp_path):
    payload, manifest = admitted
    derived_payload = _flip_payload(payload, tmp_path / "derived-payload")
    return manifest, _derived_manifest(manifest, derived_payload)


@pytest.mark.parametrize("mutate,needle", [
    (lambda m: m["transform"].update(schema_version="unreviewed-transform/999"),
     "transform.schema_version"),
    (lambda m: m["transform"].update(transform_id="hand-edited/9"), "transform_id"),
    (lambda m: m["transform"].update(involution=False), "involution"),
    (lambda m: m["transform"].update(bijective_verified=False), "bijective_verified"),
    (lambda m: m["transform"].update(surprise="unreviewed"), "unknown transform field"),
    (lambda m: m["transform"]["source"].update(bundle_id=m["bundle_id"]),
     "non-circular"),
    (lambda m: m["transform"]["source"].update(storage_agree_value=1),
     "must be opposite"),
    (lambda m: m["transform"]["source"].update(root_digest="stale"),
     "sha256 hex digest"),
    (lambda m: m["transform"]["source"].pop("manifest_sha256"),
     "manifest_sha256 is missing"),
    (lambda m: m["transform"]["source"].update(extra="unreviewed"),
     "unknown transform.source field"),
    (lambda m: m.update(transform=None), "declares no transform block"),
    (lambda m: [r.pop("derived_from") for r in m["roles"]],
     "no derived_from binding"),
    (lambda m: [r["derived_from"].update(source="derived") for r in m["roles"]],
     "RETAIN the original"),
    (lambda m: [r["derived_from"].update(bundle_id="some-other-bundle")
                for r in m["roles"]], "derived from two different bundles"),
    (lambda m: [r["derived_from"].update(slug="pc-v1-elsewhere") for r in m["roles"]],
     "never which conversation filled a role"),
    (lambda m: [r["derived_from"].update(surprise=1) for r in m["roles"]],
     "unknown field"),
    (lambda m: [r.update(source="production") for r in m["roles"]],
     "never re-extracted from production"),
    (lambda m: [r["compat"].update(storage_agree_value=-1) for r in m["roles"]
                if isinstance(r.get("compat"), dict)],
     "counted under storage agree"),
])
def test_a_malformed_derived_manifest_is_refused(derived_pair, config, mutate, needle):
    _, derived = derived_pair
    broken = copy.deepcopy(derived)
    mutate(broken)
    with pytest.raises(fb.AdmissionError, match=needle):
        _admit(broken, config)


def test_a_derived_role_needs_its_transform_block(admitted, config, tmp_path):
    payload, manifest = admitted
    broken = copy.deepcopy(manifest)
    broken["roles"] = [fb.derived_role(r, source_bundle_id="pcb-test-0000")
                       for r in broken["roles"]]
    with pytest.raises(fb.AdmissionError, match="declares no transform block"):
        _admit(broken, config)


def test_a_transform_block_needs_derived_roles(derived_pair, config):
    _, derived = derived_pair
    broken = copy.deepcopy(derived)
    for role, original in zip(broken["roles"], derived["roles"]):
        role["source"] = original["derived_from"]["source"]
        role.pop("derived_from")
    with pytest.raises(fb.AdmissionError, match="no role declares source"):
        _admit(broken, config)


def test_a_pair_is_two_sides_not_a_chain(derived_pair, tmp_path):
    _, derived = derived_pair
    with pytest.raises(fb.BundleError, match="not a chain"):
        fb.build_derived_manifest(
            derived, bundle_id="pcb-test-0001-flipped-again",
            payload_root=tmp_path / "derived-payload",
            source_manifest_sha256="c" * 64, bijective_verified=True)


def test_bijective_verified_is_never_coerced():
    """F3: bool("false") is True, so coercion turned an unverified declaration
    into a verified one."""
    with pytest.raises(fb.BundleError, match="never coerced"):
        fb.build_transform_block(
            source_bundle_id="pcb-test-0000", source_root_digest="a" * 64,
            source_manifest_sha256="b" * 64, source_storage_agree_value=-1,
            bijective_verified="false")


# --- manifest/2 stays admissible on its original bytes ----------------------

def _as_legacy_v2(manifest):
    """Exactly what the parent implementation wrote: no transform key, and the
    /2 schema version."""
    legacy = copy.deepcopy(manifest)
    legacy.pop("transform")
    legacy["schema_version"] = fb.LEGACY_MANIFEST_SCHEMA_VERSION
    return legacy


def test_an_existing_manifest_v2_still_verifies_and_admits_unchanged(
        admitted, config):
    """Astra #2730: a /2 manifest that verified and admitted under the parent
    implementation must not be invalidated by this bump. Its absent transform
    field IS the 'original capture' declaration, and its bytes are untouched."""
    payload, manifest = admitted
    legacy = _as_legacy_v2(manifest)
    before = fb.canonical_json(legacy)

    fb.verify(payload, legacy)
    _admit(legacy, config)
    assert fb.canonical_json(legacy) == before


def test_a_v2_manifest_may_not_carry_a_v3_field(admitted, config, tmp_path):
    payload, manifest = admitted
    legacy = _as_legacy_v2(manifest)
    legacy["transform"] = _derived_manifest(
        manifest, payload)["transform"]
    with pytest.raises(fb.AdmissionError, match="unknown manifest field"):
        _admit(legacy, config)


def test_a_v3_manifest_must_state_the_transform_field(admitted, config):
    _, manifest = admitted
    broken = copy.deepcopy(manifest)
    broken.pop("transform")
    with pytest.raises(fb.AdmissionError,
                       match="missing required manifest field: transform"):
        _admit(broken, config)


# --- round 3: the origin's rules travel with the derivation -----------------
# Astra review #2730 R2-F1. A derived role RETAINED a binding naming a
# synthetic origin while skipping every rule that makes a synthetic role
# admissible — offer, approval, generator, coverage — so a manifest could claim
# an origin its own policy forbids and still verify, admit, push and pull.

def _synthetic_offer_rule(config):
    """The one config role whose rule offers a synthetic replacement."""
    return next(r for r in config["roles"]
                if r["on_missing"] == "fail_with_synthetic_replacement_offer")


def _fail_rule(config):
    """A required role whose rule offers NO synthetic replacement."""
    return next(r for r in config["roles"] if r["on_missing"] == "fail")


def _make_synthetic(manifest, rule, *, approved=True):
    """Turn one role of an ORIGINAL manifest into a valid approved synthetic
    replacement, exactly as an operator-approved substitution records it."""
    entry = next(r for r in manifest["roles"] if r["slug"] == rule["slug"])
    entry["source"] = "synthetic-replacement"
    entry["synthetic_replacement"] = rule["synthetic_replacement"]
    entry["coverage_limits"] = "synthetic: generated boundary case, no real ptpts"
    entry["generator"] = {"case_id": rule["synthetic_replacement"]}
    if approved:
        entry["approval"] = "operator: --accept-synthetic (test)"
    return entry


def test_an_approved_synthetic_role_derives_and_still_admits(
        admitted, config, tmp_path):
    """The positive: a legitimately approved synthetic origin keeps its
    approval and generator through the involution, and admits on both sides."""
    payload, manifest = admitted
    original = copy.deepcopy(manifest)
    _make_synthetic(original, _synthetic_offer_rule(config))
    _admit(original, config)

    derived_payload = _flip_payload(payload, tmp_path / "derived-payload")
    derived = _derived_manifest(original, derived_payload)
    entry = next(r for r in derived["roles"]
                 if r["slug"] == _synthetic_offer_rule(config)["slug"])
    assert entry["source"] == fb.DERIVED_ROLE_SOURCE
    assert entry["derived_from"]["source"] == "synthetic-replacement"
    assert entry["approval"] and entry["generator"]["case_id"]

    fb.verify(derived_payload, derived)
    _admit(derived, config)


@pytest.mark.parametrize("break_it,needle", [
    (lambda e: e.pop("approval"), "carries no recorded operator approval"),
    (lambda e: e.pop("generator"), "does not pin the generator"),
    (lambda e: e.pop("coverage_limits"), "does not state its coverage limits"),
    (lambda e: e.update(synthetic_replacement="gen-v1-something-else"),
     "names generator case"),
])
def test_a_derived_synthetic_origin_must_satisfy_the_origin_rules(
        admitted, config, tmp_path, break_it, needle):
    payload, manifest = admitted
    original = copy.deepcopy(manifest)
    _make_synthetic(original, _synthetic_offer_rule(config))
    _admit(original, config)

    derived = _derived_manifest(
        original, _flip_payload(payload, tmp_path / "derived-payload"))
    entry = next(r for r in derived["roles"]
                 if r["slug"] == _synthetic_offer_rule(config)["slug"])
    break_it(entry)
    with pytest.raises(fb.AdmissionError, match=needle):
        _admit(derived, config)


def test_a_derived_role_cannot_claim_an_origin_its_rule_forbids(
        derived_pair, config):
    """Astra's witness, failing closed. Relabelling only the BINDING to a
    synthetic origin, on a role whose rule offers no replacement and with no
    approval or generator anywhere, previously passed the whole
    verify/admit/push/pull path."""
    _, derived = derived_pair
    slug = _fail_rule(config)["slug"]
    broken = copy.deepcopy(derived)
    entry = next(r for r in broken["roles"] if r["slug"] == slug)
    entry["derived_from"]["source"] = "synthetic-replacement"
    assert not entry.get("approval") and not entry.get("generator")
    with pytest.raises(fb.AdmissionError, match="rule does not offer one"):
        _admit(broken, config)


@pytest.mark.parametrize("bad", [True, False, 1.0, -1.0, "1", None, 0])
def test_the_compat_census_sign_is_a_strict_integer(derived_pair, config, bad):
    """R2-F2: `True == 1` and `1.0 == 1`, so an equality test alone admitted a
    bool and a float as a declared convention."""
    _, derived = derived_pair
    broken = copy.deepcopy(derived)
    broken["roles"][0]["compat"]["storage_agree_value"] = bad
    with pytest.raises(fb.AdmissionError,
                       match="compat census storage_agree_value must be"):
        _admit(broken, config)


def test_the_transform_block_states_what_it_does_not_verify():
    """The digests are declarations. Independent source-fetch and bijection
    verification are DEFERRED and are not claimed by the round trip."""
    doc = fb.build_derived_manifest.__doc__
    assert "DEFERRED" in doc
    assert "NOT that its stated source is real" in doc
    assert "DECLARATIONS" in fb.build_transform_block.__doc__
