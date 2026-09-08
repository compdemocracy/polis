"""P-045 slice 2 (half): same-invocation stage sibling and stage-context binding.

Pure controls — no Postgres, no Rust binary. They pin the bridge's stage
discipline: ONE IMMUTABLE stage sibling per operation (never truncate-and-replace,
never the write_stage_documents singleton-into-a-shared-dir data-loss path), the
py stage-engine label, the closed p045-stage-binding/1 sibling manifest, and a
plan/session-scoped stage context that rejects duplicates and foreign/mismatched
identities. Round 2 (board [398]) corrections 6 and 7 are pinned here.
"""

from __future__ import annotations

import json

import pytest

from polismath.replay import coordinator_driver as cd
from polismath.replay import stages


def test_capture_writes_immutable_per_operation_dirs(tmp_path, monkeypatch):
    seen = {}

    def fake_doc(conv, *, step_index, digest, tick=None, blob=None, engine=stages.PY_STAGE_ENGINE):
        seen["engine"] = engine
        return {"schema": stages.STAGE_DUMP_SCHEMA, "engine": engine, "step": step_index,
                "input_digest": digest, "tick": tick, "stages": {}}

    monkeypatch.setattr(stages, "stage_document", fake_doc)
    p0 = cd.capture_rust_stage_sibling(object(), {"m": 1}, step_index=0,
                                       semantic_input_digest="sha256:aa",
                                       out_dir=tmp_path / "op-000", run_root=tmp_path)
    p1 = cd.capture_rust_stage_sibling(object(), {"m": 2}, step_index=1,
                                       semantic_input_digest="sha256:bb",
                                       out_dir=tmp_path / "op-001", run_root=tmp_path)
    assert p0.exists() and p1.exists() and p0 != p1
    assert seen["engine"] == "py"
    assert json.loads(p0.read_text())["input_digest"] == "sha256:aa"


def test_capture_refuses_to_overwrite_immutable_evidence(tmp_path, monkeypatch):
    """Correction 7: a second snapshot for the SAME operation/cut with different
    content must be refused, not silently truncate-and-replace the first. An
    identical retry is idempotent."""
    monkeypatch.setattr(stages, "stage_document",
                        lambda *a, **k: {"step": k["step_index"], "input_digest": k["digest"]})
    op = tmp_path / "op"
    first = cd.capture_rust_stage_sibling(None, {}, step_index=0,
                                          semantic_input_digest="a" * 64, out_dir=op, run_root=tmp_path)
    original = first.read_bytes()
    # Identical retry: idempotent, bytes preserved.
    again = cd.capture_rust_stage_sibling(None, {}, step_index=0,
                                          semantic_input_digest="a" * 64, out_dir=op, run_root=tmp_path)
    assert again == first and first.read_bytes() == original
    # Differing content for the same operation/cut: refused.
    with pytest.raises(cd.BridgeError):
        cd.capture_rust_stage_sibling(None, {}, step_index=0,
                                      semantic_input_digest="b" * 64, out_dir=op, run_root=tmp_path)
    assert first.read_bytes() == original, "existing evidence must be untouched"


def test_capture_confines_to_run_root(tmp_path, monkeypatch):
    monkeypatch.setattr(stages, "stage_document", lambda *a, **k: {"step": k["step_index"]})
    with pytest.raises(cd.BridgeError):
        cd.capture_rust_stage_sibling(None, {}, step_index=0, semantic_input_digest="a" * 64,
                                      out_dir=tmp_path / "escape", run_root=tmp_path / "root")


def test_capture_does_not_call_the_deleting_writer(tmp_path, monkeypatch):
    monkeypatch.setattr(stages, "stage_document",
                        lambda *a, **k: {"step": k["step_index"], "input_digest": k["digest"]})
    monkeypatch.setattr(stages, "write_stage_documents",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not delete siblings")))
    monkeypatch.setattr(stages, "run_stage_dump",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not re-replay")))
    cd.capture_rust_stage_sibling(None, {}, step_index=0,
                                  semantic_input_digest="sha256:aa", out_dir=tmp_path / "op", run_root=tmp_path)


def test_stage_binding_manifest_shape():
    m = cd.stage_binding_manifest(
        run_id="r", session_id="s", compute_id="c", checkpoint_id="k",
        operation_id="op", input_digest="i", schedule_digest="sd",
        semantic_input_digest="sha256:aa", stage_file_sha256="f",
        output_file_sha256s={"main": "m", "bidtopid": "b", "ptptstats": "p"},
        binary_sha256="bin", worker_tree_sha256="wrk", profile=cd.PROFILE_SNAPSHOT_REBUILD)
    assert m["schema"] == "p045-stage-binding/1"
    assert m["producer"] == "rust" and m["stage_engine"] == "py"
    assert m["profile"] == "snapshot-rebuild/1"


# ---------------------------------------------------------------------------
# Stage context (correction 6): full-identity keys, duplicate rejection.
# ---------------------------------------------------------------------------
def _entry(**over):
    e = dict(plan_sha256="plan-1", run_id="r", session_id="sess-1",
             compute_id="compute-0", checkpoint_id="checkpoint-0",
             global_cut_index=0, semantic_input_digest="a" * 64,
             profile=cd.PROFILE_SNAPSHOT_REBUILD)
    e.update(over)
    return e


def _ctx_file(tmp_path, entries, schema=cd.STAGE_CONTEXT_SCHEMA):
    p = tmp_path / "ctx.json"
    p.write_text(json.dumps({"schema": schema, "entries": entries}))
    return p


def test_load_stage_context_rejects_wrong_schema(tmp_path):
    with pytest.raises(cd.BridgeError):
        cd.load_stage_context(_ctx_file(tmp_path, [], schema="p045-stage-context/2"))


def test_load_stage_context_rejects_duplicate_local_identity(tmp_path):
    """Correction 6: two fresh S1 sessions reuse compute-0/checkpoint-0; keyed on
    the FULL identity a duplicate is rejected, never last-writer-wins."""
    dup = _ctx_file(tmp_path, [_entry(global_cut_index=0), _entry(global_cut_index=1)])
    with pytest.raises(cd.BridgeError):
        cd.load_stage_context(dup)


def test_load_stage_context_distinct_sessions_coexist(tmp_path):
    two = _ctx_file(tmp_path, [_entry(session_id="sess-1", global_cut_index=0),
                               _entry(session_id="sess-2", global_cut_index=1)])
    ctx = cd.load_stage_context(two)
    assert len(ctx) == 2


@pytest.mark.parametrize("bad", [
    {"global_cut_index": -1},
    {"global_cut_index": True},
    {"profile": "battery-chain/2"},
    {"semantic_input_digest": ""},
])
def test_load_stage_context_rejects_bad_entry(tmp_path, bad):
    with pytest.raises(cd.BridgeError):
        cd.load_stage_context(_ctx_file(tmp_path, [_entry(**bad)]))


def test_load_stage_context_requires_full_identity(tmp_path):
    partial = {"compute_id": "compute-0", "checkpoint_id": "checkpoint-0",
               "global_cut_index": 0, "semantic_input_digest": "a" * 64,
               "profile": cd.PROFILE_SNAPSHOT_REBUILD}  # no plan/run/session
    with pytest.raises(cd.BridgeError):
        cd.load_stage_context(_ctx_file(tmp_path, [partial]))


def test_check_stage_context_ok_foreign_and_mismatch(tmp_path):
    ctx = cd.load_stage_context(_ctx_file(tmp_path, [_entry()]))
    common = dict(plan_sha256="plan-1", session_id="sess-1", compute_id="compute-0",
                  checkpoint_id="checkpoint-0")
    assert cd.check_stage_context(ctx, derived_semantic_digest="a" * 64,
                                  expected_profile=cd.PROFILE_SNAPSHOT_REBUILD,
                                  expected_cut_index=0, **common) == []
    # foreign session
    assert cd.check_stage_context(ctx, derived_semantic_digest="a" * 64,
                                  **dict(common, session_id="sess-X"))
    # digest mismatch
    assert cd.check_stage_context(ctx, derived_semantic_digest="b" * 64, **common)
    # wrong profile / cut
    assert cd.check_stage_context(ctx, derived_semantic_digest="a" * 64,
                                  expected_profile=cd.PROFILE_BATTERY_CHAIN, **common)
    assert cd.check_stage_context(ctx, derived_semantic_digest="a" * 64,
                                  expected_cut_index=7, **common)
