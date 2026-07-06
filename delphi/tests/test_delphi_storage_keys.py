"""Unit tests for delphi_storage.keys — claim order, timestamps, scopes, key builders."""

import pytest

from delphi_storage.keys import (
    CHUNK_MARKER,
    GENERIC_ENTITIES,
    artifact_key,
    claim_order,
    log_sk,
    scope_for_rid,
    scope_for_zid,
    scopes_for_run,
    ts_add_seconds,
    validate_ts,
)
from delphi_storage.models import JobType, RunManifest

T0 = "2026-07-06T10:00:00.000Z"
T1 = "2026-07-06T10:00:01.000Z"


class TestClaimOrder:
    def test_format(self):
        assert claim_order(5, T1, "jobB") == f"9994#{T1}#jobB"
        assert claim_order(0, T0, "jobA") == f"9999#{T0}#jobA"

    def test_higher_priority_sorts_first(self):
        assert claim_order(5, T1, "b") < claim_order(0, T0, "a")

    def test_fifo_within_priority(self):
        assert claim_order(0, T0, "a") < claim_order(0, T1, "b")

    def test_job_id_tiebreak(self):
        assert claim_order(0, T0, "a") < claim_order(0, T0, "b")

    def test_clamping(self):
        assert claim_order(-3, T0, "x").startswith("9999#")
        assert claim_order(20000, T0, "x").startswith("0000#")


class TestTimestamps:
    def test_valid(self):
        assert validate_ts(T0) == T0

    @pytest.mark.parametrize(
        "bad",
        [
            "2026-07-06 10:00:00",
            "2026-07-06T10:00:00Z",
            "2026-07-06T10:00:00.000+00:00",
            "2026-07-06T10:00:00.000",
            "not a ts",
            "",
        ],
    )
    def test_invalid(self, bad):
        with pytest.raises(ValueError):
            validate_ts(bad)

    def test_add_seconds(self):
        assert ts_add_seconds("2026-07-06T10:01:00.000Z", 300) == "2026-07-06T10:06:00.000Z"

    def test_add_seconds_rolls_over_midnight(self):
        assert ts_add_seconds("2026-07-06T23:59:30.500Z", 60) == "2026-07-07T00:00:30.500Z"


class TestScopes:
    def test_scope_builders(self):
        assert scope_for_zid(7, JobType.FULL_PIPELINE) == "zid#7#FULL_PIPELINE"
        assert scope_for_rid(42, JobType.NARRATIVE_BATCH) == "rid#42#NARRATIVE_BATCH"

    def _run(self, **kw):
        base = dict(job_id="j", job_type=JobType.FULL_PIPELINE, enqueued_at=T0)
        base.update(kw)
        return RunManifest(**base)

    def test_full_pipeline_scope(self):
        assert scopes_for_run(self._run(zid=7)) == ["zid#7#FULL_PIPELINE"]

    def test_narrative_batch_scope(self):
        run = self._run(job_type=JobType.NARRATIVE_BATCH, zid=7, rid=42)
        assert scopes_for_run(run) == ["rid#42#NARRATIVE_BATCH"]

    def test_server_narrative_scope(self):
        run = self._run(job_type=JobType.SERVER_NARRATIVE, rid=42)
        assert scopes_for_run(run) == ["rid#42#SERVER_NARRATIVE"]

    def test_imported_never_autoflips(self):
        run = self._run(job_type=JobType.IMPORTED, zid=7, rid=42)
        assert scopes_for_run(run) == []

    def test_missing_zid_raises(self):
        with pytest.raises(ValueError):
            scopes_for_run(self._run(zid=None))

    def test_missing_rid_raises(self):
        with pytest.raises(ValueError):
            scopes_for_run(self._run(job_type=JobType.NARRATIVE_BATCH, zid=7, rid=None))


class TestKeys:
    def test_log_sk_zero_padded(self):
        assert log_sk(1) == "log#00000001"
        assert log_sk(12345678) == "log#12345678"

    def test_log_sks_sort_numerically(self):
        assert sorted([log_sk(2), log_sk(10), log_sk(1)]) == [log_sk(1), log_sk(2), log_sk(10)]

    def test_artifact_key(self):
        assert artifact_key("math", "pca") == "math#pca"
        assert artifact_key("umap", "topic", 0, 3) == "umap#topic#0#3"

    def test_artifact_key_rejects_chunk_marker(self):
        with pytest.raises(ValueError):
            artifact_key("math", f"bad{CHUNK_MARKER}part")

    def test_generic_entities_exclude_runs_and_latest(self):
        assert "runs" not in GENERIC_ENTITIES
        assert "latest" not in GENERIC_ENTITIES
        assert {"run_inputs", "artifacts", "topic_moderation", "collective_statements"} == set(
            GENERIC_ENTITIES
        )
