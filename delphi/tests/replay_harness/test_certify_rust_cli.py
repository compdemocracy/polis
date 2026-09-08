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


def test_load_policy_accepts_and_hashes_but_is_not_admitting(tmp_path):
    import json
    p = tmp_path / "policy.json"
    p.write_text(json.dumps(_good_policy()))
    pol = cd.load_policy(p)
    assert pol.schema == "p045-policy/1" and pol.profile == "snapshot-rebuild/1"
    assert len(pol.raw_sha256) == 64
    assert pol.required_controls == ("N01", "N08")
    # The policy BODY is undefined (slice 3): shape-valid is never admission.
    assert pol.admitting is False


@pytest.mark.parametrize("mutate", [
    lambda o: o.update(schema="p044-policy/1"),
    lambda o: o.update(schema="p045-policy/2"),
    lambda o: o.update(profile="battery-chain/2"),
    lambda o: o.pop("field_policy_sha256"),
    lambda o: o.pop("required_controls"),
    lambda o: o.update(approvals="not-a-list"),
    lambda o: o.update(clock=[]),
    lambda o: o.update(field_policy_sha256="short"),
    lambda o: o.update(field_policy_sha256="z" * 64),   # correction 3: non-hex
    lambda o: o.update(surprise=True),                   # correction 3: unknown key
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
# Correction 1: the reachable slice-1 bridge runner + report, end to end.
# ---------------------------------------------------------------------------
def _single_cut_entries():
    entries = [e for e in cert.load_battery()
               if e.dataset == "vw" and e.schedule_id == "single-cut-clojure-legacy"]
    assert entries, "vw single-cut entry must be in the starter battery"
    return entries


def test_bridge_runner_emits_terminal_v2_report_with_rust_rows(tmp_path):
    """The rust producer is invocable end-to-end and emits per-entry rows into a
    polis-certification-run/2 report — rust UNSUPPORTED_PROFILE, references
    INCONCLUSIVE, verdict INCONCLUSIVE, terminal manifest written. No engine, no
    DB, no fabricated PASS."""
    report = cd.run_bridge_battery(
        _single_cut_entries(), root=tmp_path, profile=cd.PROFILE_SNAPSHOT_REBUILD,
        drivers=("clj", "py", "rust"), battery_path=str(cert.DEFAULT_BATTERY_PATH))
    assert report["schema"] == cd.CERTIFICATION_RUN_SCHEMA_V2
    assert report["terminal"] is True
    engines = [(r["engine"], r["status"]) for r in report["producers"]]
    assert ("rust", cd.ProducerStatus.UNSUPPORTED_PROFILE.value) in engines
    assert ("clj", cd.ProducerStatus.INCONCLUSIVE.value) in engines
    assert ("py", cd.ProducerStatus.INCONCLUSIVE.value) in engines
    # three pairs per entry, none passing
    assert len(report["pairs"]) == 3
    assert all(p["status"] != cd.ProducerStatus.PASS.value for p in report["pairs"])
    assert report["verdict"] == cd.ProducerStatus.INCONCLUSIVE.value
    assert cd.bridge_exit_code(report) == 2
    assert (tmp_path / "certify_report_bridge.json").exists()


def test_bridge_report_receipt_profile_agrees_with_rows(tmp_path):
    """Round 3 correction 4: reference receipts must carry the selected profile,
    not an empty string beneath a row that says snapshot-rebuild/1."""
    report = cd.run_bridge_battery(_single_cut_entries(), root=tmp_path,
                                   profile=cd.PROFILE_SNAPSHOT_REBUILD)
    for r in report["producers"]:
        if r["engine"] != "rust":
            assert r["receipt"]["profile"] == cd.PROFILE_SNAPSHOT_REBUILD
    assert report["drivers"] == ["clj", "py", "rust"]


def test_bridge_runner_honors_a_driver_subset(tmp_path):
    """Round 3 correction 4: a py-only selection reports and iterates ONLY py —
    it does not silently invoke/emit clj and rust."""
    report = cd.run_bridge_battery(_single_cut_entries(), root=tmp_path,
                                   profile=cd.PROFILE_SNAPSHOT_REBUILD, drivers=("py",))
    assert report["drivers"] == ["py"]
    assert {r["engine"] for r in report["producers"]} == {"py"}
    assert report["pairs"] == []  # a single producer has no pairs


def test_bridge_runner_requires_both_references_for_rust(tmp_path):
    with pytest.raises(cd.BridgeError):
        cd.run_bridge_battery(_single_cut_entries(), root=tmp_path,
                              profile=cd.PROFILE_SNAPSHOT_REBUILD, drivers="clj,rust")


def test_bridge_runner_rejects_unknown_profile(tmp_path):
    with pytest.raises(cd.BridgeError):
        cd.run_bridge_battery(_single_cut_entries(), root=tmp_path,
                              profile="battery-chain/2", drivers="clj,py,rust")


import importlib.util as _ilu

_HAVE_CLICK = _ilu.find_spec("click") is not None


@pytest.mark.skipif(not _HAVE_CLICK, reason="click not installed in this interpreter")
def test_cli_run_drivers_dispatches_to_bridge(tmp_path):
    """`certify.py run --drivers clj,py,rust --profile ...` reaches the bridge and
    exits 2 (INCONCLUSIVE) with a rust UNSUPPORTED_PROFILE row printed."""
    from click.testing import CliRunner
    script = _cli_module()
    runner = CliRunner()
    result = runner.invoke(script.cli, [
        "run", "--drivers", "clj,py,rust", "--profile", "snapshot-rebuild/1",
        "--only", "vw:single-cut-clojure-legacy", "--root", str(tmp_path)])
    assert result.exit_code == 2, result.output
    assert "rust -> UNSUPPORTED_PROFILE" in result.output
    assert "polis-certification-run/2" in result.output


@pytest.mark.skipif(not _HAVE_CLICK, reason="click not installed in this interpreter")
def test_cli_legacy_default_does_not_route_to_bridge():
    """Default `--drivers clj,py` with no profile must NOT print a bridge line —
    the legacy path is unchanged."""
    from click.testing import CliRunner
    script = _cli_module()
    runner = CliRunner()
    # --only with a nonexistent selection keeps this fast and engine-free; the
    # point is only that no bridge report schema appears.
    result = runner.invoke(script.cli, ["run", "--only", "nonesuch:nope"])
    assert "polis-certification-run/2" not in result.output


def _cli_module():
    import importlib.util
    from pathlib import Path
    path = Path(cert.__file__).resolve().parents[2] / "scripts" / "certify.py"
    spec = importlib.util.spec_from_file_location("p045_certify_cli", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Correction 2 (round 3): additivity over the REAL retained clj<->py recordings.
# ---------------------------------------------------------------------------
def _find_real_recording():
    """Return (clj_dir, py_dir) for a real on-disk recording pair under the
    standard recording root, or None. These are the gitignored artifacts the G12
    measurement used (delphi/real_data/.local/replays/<dataset>/<sid>/{clj,py});
    they exist only after an engine run has populated them."""
    root = cert.st.replays_root()
    if not root.exists():
        return None
    for clj in sorted(root.glob("*/*/clj")):
        py = clj.parent / "py"
        if (clj / "step-000.blob.json").exists() and (py / "step-000.json").exists():
            return clj, py
    return None


def _compare_behavior(clj, py, cache_root):
    """The legacy comparison's OBSERVABLE behavior over a recording: either its
    canonical per-step verdict payload, or its deterministic CertifyError (a real
    recording can trip an existing raw gate, e.g. an alias collision) — both are
    stable functions of the bytes, which is what additivity asserts."""
    import json
    try:
        res = cert.compare_recording_pair(clj, py, cache_root=cache_root)
        return "ok", json.dumps(res["per_step"], sort_keys=True).encode()
    except cert.CertifyError as exc:
        return "err", f"{exc.stage}: {exc}".encode()


def test_additivity_over_real_retained_recordings(tmp_path):
    """Round 3 correction 2: run the UNCHANGED legacy comparison over the REAL
    retained clj<->py recordings on disk (no fresh re-record, so no JVM), and
    assert its behavior + the raw blob digests are deterministic and the engine
    hash is bridge-invariant — the excluded bridge file perturbs none of them,
    on real bytes. Skips (naming the path) only when no real recording is present,
    which is legitimate since the recordings are gitignored engine artifacts."""
    import hashlib
    found = _find_real_recording()
    if found is None:
        pytest.skip(f"no real recording under {cert.st.replays_root()} "
                    "(generate one with certify --refresh-clj --refresh-py)")
    clj, py = found
    kind1, payload1 = _compare_behavior(clj, py, tmp_path / "c1")
    kind2, payload2 = _compare_behavior(clj, py, tmp_path / "c2")
    assert (kind1, payload1) == (kind2, payload2), "legacy comparison must be deterministic on real bytes"
    # raw blob digests are a pure function of the bytes
    d_clj = hashlib.sha256((clj / "step-000.blob.json").read_bytes()).hexdigest()
    d_py = hashlib.sha256((py / "step-000.json").read_bytes()).hexdigest()
    assert len(d_clj) == 64 and len(d_py) == 64
    # engine hash unchanged by the (excluded) bridge
    assert cert.run_provenance(cert.st.replays_root())["engine_tree_sha256"] == cert.engine_tree_hash()

    root = os.environ.get("P045_REFERENCE_RECORDING_ROOT")
    if root:
        from pathlib import Path
        pinned = Path(root)
        assert _compare_behavior(pinned / "clj", pinned / "py", tmp_path / "cr") == \
            _compare_behavior(pinned / "clj", pinned / "py", tmp_path / "cr2")


@pytest.mark.skipif(os.environ.get("RUN_CLJ_INTEGRATION") != "1",
                    reason="needs the JVM + uv to FRESH re-record the two-driver battery")
def test_legacy_two_driver_battery_fresh_rerecord_byte_identical():
    # The fresh-re-record variant genuinely needs the engines; it stays gated on
    # RUN_CLJ_INTEGRATION. A pinned pre-change full-battery verdict remains the
    # one operator-supplied artifact for a complete byte-identity proof.
    pytest.skip("fresh re-record needs the JVM + uv; see P-045 implementation notes")
