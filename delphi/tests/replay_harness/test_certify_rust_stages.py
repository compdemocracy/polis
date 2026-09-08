"""P-045 slice 2 (half): same-invocation stage sibling and stage-context binding.

Pure controls — no Postgres, no Rust binary. They pin the bridge's stage
discipline: ONE immutable operation directory per snapshot (never the
write_stage_documents singleton-into-a-shared-dir data-loss path), the py
stage-engine label, the closed p045-stage-binding/1 sibling manifest, and
foreign/mismatched stage-context rejection.
"""

from __future__ import annotations

import json

import pytest

from polismath.replay import coordinator_driver as cd
from polismath.replay import stages


def test_capture_writes_immutable_per_operation_dirs(tmp_path, monkeypatch):
    """Two cuts written under DIFFERENT operation directories both survive — the
    opposite of write_stage_documents, which deletes older step-*.stages.json in
    a shared directory before writing its supplied sequence."""
    seen = {}

    def fake_doc(conv, *, step_index, digest, tick=None, blob=None, engine=stages.PY_STAGE_ENGINE):
        seen["engine"] = engine
        return {"schema": stages.STAGE_DUMP_SCHEMA, "engine": engine, "step": step_index,
                "input_digest": digest, "tick": tick, "stages": {}}

    monkeypatch.setattr(stages, "stage_document", fake_doc)
    p0 = cd.capture_rust_stage_sibling(object(), {"m": 1}, step_index=0,
                                       semantic_input_digest="sha256:aa", out_dir=tmp_path / "op-000")
    p1 = cd.capture_rust_stage_sibling(object(), {"m": 2}, step_index=1,
                                       semantic_input_digest="sha256:bb", out_dir=tmp_path / "op-001")
    assert p0.exists() and p1.exists()
    assert p0 != p1
    # The py stage-engine label is preserved (never relabelled rust).
    assert seen["engine"] == "py"
    assert json.loads(p0.read_text())["input_digest"] == "sha256:aa"


def test_capture_does_not_call_the_deleting_writer(tmp_path, monkeypatch):
    """capture_rust_stage_sibling must not reach write_stage_documents (deletes
    older steps) or run_stage_dump (a second, unrelated replay)."""
    monkeypatch.setattr(stages, "stage_document",
                        lambda *a, **k: {"step": k["step_index"], "input_digest": k["digest"]})
    monkeypatch.setattr(stages, "write_stage_documents",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not delete siblings")))
    monkeypatch.setattr(stages, "run_stage_dump",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not re-replay")))
    cd.capture_rust_stage_sibling(object(), None, step_index=0,
                                  semantic_input_digest="sha256:aa", out_dir=tmp_path / "op-000")


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


def _ctx_file(tmp_path, entries, schema=cd.STAGE_CONTEXT_SCHEMA):
    p = tmp_path / "ctx.json"
    p.write_text(json.dumps({"schema": schema, "entries": entries}))
    return p


def test_load_stage_context_rejects_wrong_schema(tmp_path):
    p = _ctx_file(tmp_path, [], schema="p045-stage-context/2")
    with pytest.raises(cd.BridgeError):
        cd.load_stage_context(p)


def test_stage_context_foreign_and_mismatch_rejected(tmp_path):
    p = _ctx_file(tmp_path, [{"compute_id": "c0", "checkpoint_id": "k0",
                              "global_cut_index": 0, "semantic_input_digest": "sha256:aa",
                              "profile": cd.PROFILE_SNAPSHOT_REBUILD}])
    ctx = cd.load_stage_context(p)
    assert cd.check_stage_context(ctx, compute_id="c0", checkpoint_id="k0",
                                  derived_semantic_digest="sha256:aa") == []
    assert cd.check_stage_context(ctx, compute_id="cX", checkpoint_id="k0",
                                  derived_semantic_digest="sha256:aa"), "foreign must reject"
    assert cd.check_stage_context(ctx, compute_id="c0", checkpoint_id="k0",
                                  derived_semantic_digest="sha256:ZZ"), "mismatch must reject"
