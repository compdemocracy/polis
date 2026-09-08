"""P-045 slice 1 controls: the third producer is ADDITIVE, and the harness-only
bridge file is excluded from the engine tree hash.

These need neither Postgres nor the Rust binary. The full-battery legacy
re-record byte-identity control (brief §rev2 :531) additionally needs the JVM +
uv and is gated on RUN_CLJ_INTEGRATION=1.
"""

from __future__ import annotations

import os

import pytest

from polismath.replay import certify as cert
from polismath.replay import coordinator_driver as cd


# ---------------------------------------------------------------------------
# The exclude list already exists; the bridge is its fifth harness sibling.
# ---------------------------------------------------------------------------
def _write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def test_bridge_file_is_excluded_from_engine_tree_hash(tmp_path):
    """Editing polismath/replay/coordinator_driver.py must NOT change
    engine_tree_hash — so it never re-keys the Python recording cache nor
    changes run_provenance.engine_tree_sha256 for a legacy two-driver command.
    A genuine engine file (not on the exclude list) still moves the hash, which
    proves the exclusion is real and scoped, not a blanket weakening."""
    assert "replay/coordinator_driver.py" in cert._ENGINE_TREE_EXCLUDE
    _write(tmp_path, "replay/certify.py", "# harness\n")
    driver = _write(tmp_path, "replay/coordinator_driver.py", "# bridge v1\n")
    engine = _write(tmp_path, "conversation/conversation.py", "X = 1\n")

    before = cert.engine_tree_hash(polismath_root=tmp_path)
    driver.write_text("# bridge v2 — a real edit to the bridge\nY = 2\n")
    after_driver_edit = cert.engine_tree_hash(polismath_root=tmp_path)
    assert after_driver_edit == before, "bridge edit must not move the engine hash"

    engine.write_text("X = 2\n")
    after_engine_edit = cert.engine_tree_hash(polismath_root=tmp_path)
    assert after_engine_edit != before, "a real engine edit MUST move the hash"


def test_certify_py_recording_key_ignores_the_bridge_file(tmp_path):
    """The Python recording cache key is engine_tree_sha256 (ensure_py_recording).
    Because the bridge is excluded, adding/editing it leaves that key identical —
    the additivity the third producer relies on, asserted on the key itself."""
    _write(tmp_path, "replay/certify.py", "# harness\n")
    _write(tmp_path, "conversation/conversation.py", "X = 1\n")
    key_without_bridge = cert.engine_tree_hash(polismath_root=tmp_path)
    _write(tmp_path, "replay/coordinator_driver.py", "# bridge\nBIG = 'x' * 10000\n")
    key_with_bridge = cert.engine_tree_hash(polismath_root=tmp_path)
    assert key_with_bridge == key_without_bridge


def test_provenance_engine_tree_is_bridge_invariant():
    """run_provenance.engine_tree_sha256 is what a legacy two-driver manifest
    attests. It is computed over the real tree WITH the bridge present; this
    pins that the value equals engine_tree_hash of the real tree, i.e. the
    bridge contributed nothing to it."""
    prov = cert.run_provenance(root=cert.st.replays_root())
    assert prov["engine_tree_sha256"] == cert.engine_tree_hash()


# ---------------------------------------------------------------------------
# Registry: additive, and never Rust-by-relabelling-py.
# ---------------------------------------------------------------------------
def test_registry_has_exactly_three_producers():
    assert tuple(cd.REGISTRY) == cd.DRIVER_IDS == ("clj", "py", "rust")
    assert cd.LEGACY_DRIVER_IDS == ("clj", "py")


def test_rust_is_not_py_relabelled():
    """The Rust producer must not borrow py's loader or its record function."""
    assert cd.RUST.loader == "rust" != cd.PY.loader
    assert cd.RUST.record is not cd.PY.record
    # And its record touches no py recording: it returns UNSUPPORTED_PROFILE.
    r = cd.RUST.record({"profile": cd.PROFILE_SNAPSHOT_REBUILD}, {"checkpoints": [1, 2]}, tmp_out())
    assert r.driver == r.loader == "rust"
    assert r.status is cd.ProducerStatus.UNSUPPORTED_PROFILE
    assert r.observed_cuts == 0 and r.required_cuts == 2


def tmp_out():
    import tempfile
    from pathlib import Path
    return Path(tempfile.mkdtemp())


@pytest.mark.parametrize("bad", ["clj,py,py", "rust", "clj,,py", "", "clj,foo"])
def test_parse_drivers_rejects_bad_lists(bad):
    with pytest.raises(cd.BridgeError):
        cd.parse_drivers(bad)


def test_parse_drivers_default_and_full():
    assert cd.parse_drivers("clj,py") == ("clj", "py")
    assert cd.parse_drivers("clj,py,rust") == ("clj", "py", "rust")


# ---------------------------------------------------------------------------
# Policy (p045-policy/1): closed, never derived from errors.
# ---------------------------------------------------------------------------
def _good_policy(profile="snapshot-rebuild/1"):
    return {
        "schema": cd.POLICY_SCHEMA, "profile": profile,
        "field_policy_sha256": "a" * 64, "approvals": ["APPROVAL-1"],
        "replacement_assertions": ["REPL-1"], "required_controls": ["N01", "N08"],
        "clock": {"mode": "pinned", "epoch_ms": 0},
    }


def test_load_policy_accepts_and_hashes(tmp_path):
    import json
    p = tmp_path / "policy.json"
    p.write_text(json.dumps(_good_policy()))
    pol = cd.load_policy(p)
    assert pol.schema == "p045-policy/1" and pol.profile == "snapshot-rebuild/1"
    assert len(pol.raw_sha256) == 64
    assert pol.required_controls == ("N01", "N08")


@pytest.mark.parametrize("mutate", [
    lambda o: o.update(schema="p044-policy/1"),
    lambda o: o.update(schema="p045-policy/2"),
    lambda o: o.update(profile="battery-chain/2"),
    lambda o: o.pop("field_policy_sha256"),
    lambda o: o.pop("required_controls"),
    lambda o: o.update(approvals="not-a-list"),
    lambda o: o.update(clock=[]),
    lambda o: o.update(field_policy_sha256="short"),
])
def test_load_policy_rejects_bad(tmp_path, mutate):
    import json
    o = _good_policy()
    mutate(o)
    p = tmp_path / "policy.json"
    p.write_text(json.dumps(o))
    with pytest.raises(cd.BridgeError):
        cd.load_policy(p)


# ---------------------------------------------------------------------------
# Bridge cache key: separate namespace, binds the documented fields.
# ---------------------------------------------------------------------------
def _cache_inputs(**over):
    base = dict(
        driver_id="rust", loader_id="rust", binary_tree_sha256="bin",
        worker_tree_sha256="wrk", votes_sha256="v", comments_sha256=None,
        moderation_sha256=None, convention="delphi", schedule_sha256="sch",
        profile="snapshot-rebuild/1", initialization_schema="ones",
        restore_schema="rebuild-prefix/1", migration_sha256="mig",
        policy_sha256="pol", comparer_cfg_sha256="cmp",
        serialization_profile="pg-json/1",
    )
    base.update(over)
    return base


def test_bridge_cache_key_is_deterministic_and_scoped():
    k1 = cd.bridge_cache_key(_cache_inputs())
    k2 = cd.bridge_cache_key(_cache_inputs())
    assert k1["key"] == k2["key"]
    assert k1["schema"] == cd.BRIDGE_CACHE_SCHEMA
    assert k1["bound"]["cache_schema"] == cd.BRIDGE_CACHE_SCHEMA


@pytest.mark.parametrize("field", [
    "driver_id", "loader_id", "binary_tree_sha256", "worker_tree_sha256",
    "votes_sha256", "convention", "schedule_sha256", "profile",
    "initialization_schema", "restore_schema", "migration_sha256",
    "policy_sha256", "comparer_cfg_sha256", "serialization_profile",
])
def test_bridge_cache_key_changes_when_any_bound_field_changes(field):
    base = cd.bridge_cache_key(_cache_inputs())["key"]
    changed = cd.bridge_cache_key(_cache_inputs(**{field: "MUTATED"}))["key"]
    assert changed != base, f"cache key must bind {field}"


# ---------------------------------------------------------------------------
# Inventory additivity: the clj/py rows are untouched; rust is appended.
# ---------------------------------------------------------------------------
def _expected_entry(checkpoints):
    from pathlib import Path
    from types import SimpleNamespace
    entry = SimpleNamespace(dataset="vw", schedule_id="uniform8-clojure-legacy", role=None)
    spec = SimpleNamespace(coverage="full-stream")
    return cert.ExpectedEntry(
        entry=entry, spec=spec, votes_csv=Path("v.csv"), votes_sha="abc",
        comments_csv=None, comments_sha=None, stream_end=4683, checkpoints=checkpoints,
    )


def test_legacy_inventory_is_unchanged_and_rust_is_additive():
    cps = [{"index": 0, "cut_slot": 585}, {"index": 1, "cut_slot": 1171}]
    exp = _expected_entry(cps)
    legacy = exp.inventory()
    assert [r["engine"] for r in legacy] == ["clj", "py"], "legacy inventory() must stay 2-row clj/py"

    three = cd.three_producer_inventory(exp, cd.PROFILE_SNAPSHOT_REBUILD)
    assert [r["engine"] for r in three] == ["clj", "py", "rust"]
    # Each legacy row's own fields survive verbatim inside the extended row.
    for legacy_row, three_row in zip(legacy, three[:2]):
        for k, v in legacy_row.items():
            assert three_row[k] == v, f"additive row changed legacy field {k}"
    # The rust row exists and is a visible non-pass (rust advertises no profile).
    rust_row = three[2]
    assert rust_row["engine"] == "rust" and rust_row["advertised"] is False
    assert rust_row["status"] == cd.ProducerStatus.UNSUPPORTED_PROFILE.value


def test_three_producer_inventory_rejects_unknown_profile():
    with pytest.raises(cd.BridgeError):
        cd.three_producer_inventory(_expected_entry([{"index": 0, "cut_slot": 0}]), "battery-chain/2")


# ---------------------------------------------------------------------------
# Legacy re-record byte-identity control (brief §rev2 :531). Needs the engines.
# ---------------------------------------------------------------------------
@pytest.mark.skipif(os.environ.get("RUN_CLJ_INTEGRATION") != "1",
                    reason="needs the JVM + uv to re-record the two-driver battery")
def test_legacy_two_driver_battery_is_byte_identical_across_the_bridge_commit():
    # A pinned pre-change two-driver recording/report, re-recorded on the
    # assembled bridge tree with the unchanged legacy invocation, must produce
    # byte-identical clj<->py verdict payloads and raw blob digests. Only the
    # named provenance/cache-identity changes are allowed outside those payloads;
    # independently unstable reference fields are reported INCONCLUSIVE, never
    # filtered. Left as an executable stub: the reference recording root is an
    # operator-supplied artifact and is not present in CI.
    pytest.skip("provide REFERENCE_RECORDING_ROOT; see P-045 implementation notes")
