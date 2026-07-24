"""Unit tests for the poller-equivalence harness — Stage D (self-jitter
envelope + full-run orchestration), MATH_POLLER_EQUIV_SPEC.md §2-3.

NO live Postgres/containers/subprocesses required: every test here is either
pure-Python or drives the on-disk snapshot store against ``tmp_path`` (same
convention as ``test_poller_equiv_compare.py``'s Stage C tests). The one live
prerequisite this Stage introduces — ``run_full_equiv_protocol`` needing a
real Postgres + the ``clojure`` CLI — is NOT exercised here; only its
fail-fast :func:`~polismath.replay.poller_equiv.preflight_check` gate is
(itself designed to fail in well under a second, no live service needed to
observe the failure path).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from polismath.replay import poller_equiv as pe
from polismath.replay import real_data


# --------------------------------------------------------------------------- #
# Shared fixtures / doubles — mirrors test_poller_equiv_compare.py's helpers.
# --------------------------------------------------------------------------- #
def _blob(
    *, repness_val: float = 0.0,
    in_conv: list[int] | None = None, user_vote_counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    """A minimal math_main-shaped blob (prep-main key spelling). ``repness``
    carries a SINGLE controllable scalar float leaf at a NON-PCA-related path
    (``repness.<pid>.repness-test``) — deliberately NOT under ``.pca.comps``/
    ``.proj.``/``.center`` (``_is_pca_related_path``, comparer.py:917-947),
    because those paths get an automatic LOOSE tolerance (1000x abs / 10x
    rel) for any PCA list shorter than 10 elements whenever
    ``outlier_fraction > 0`` (comparer.py:761-771) — real behavior, but it
    would swallow the tiny (1e-5-scale) deltas these tests need to observe
    surviving the DEFAULT tolerance so envelope acceptance has something to
    act on."""
    return {
        "zid": 1, "n": 2, "n-cmts": 2,
        "in-conv": in_conv if in_conv is not None else [1, 2],
        "tids": [0, 1],
        "pca": {"center": [0.1, 0.2], "comps": [[1.0, 0.0], [0.0, 1.0]]},
        "base-clusters": {
            "id": [0, 1], "x": [0.1, -0.1], "y": [0.2, -0.2],
            "count": [1, 2], "members": [[1], [2, 3]],
        },
        "repness": {"1": {"repness-test": repness_val}},
        "lastVoteTimestamp": 1000,
        "user-vote-counts": user_vote_counts if user_vote_counts is not None else {"1": 3},
    }


def _ptptstats_blob(*, val: float = 0.0) -> dict[str, Any]:
    return {"zid": 1, "ptptstats": {"1": {"n-votes": val}}, "lastVoteTimestamp": 1000}


def _row(data: dict[str, Any], *, math_env: str = "e", last_vote_timestamp: int = 1000,
         caching_tick: int = 1, math_tick: int = 1) -> dict[str, Any]:
    return {
        "zid": 1, "math_env": math_env, "data": data,
        "last_vote_timestamp": last_vote_timestamp,
        "caching_tick": caching_tick, "math_tick": math_tick, "modified": 123,
    }


def _write_paired_batch(
    tmp_path: Path, envs: tuple[str, str], index: int, *, main_a, main_b,
    bid_a=None, bid_b=None, pt_a=None, pt_b=None,
) -> None:
    env_a, env_b = envs
    pe.write_snapshot(tmp_path, env_a, index, "math_main", main_a)
    pe.write_snapshot(tmp_path, env_b, index, "math_main", main_b)
    pe.write_snapshot(
        tmp_path, env_a, index, "math_bidtopid",
        bid_a or _row({"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": 1000}),
    )
    pe.write_snapshot(
        tmp_path, env_b, index, "math_bidtopid",
        bid_b or _row({"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": 1000}),
    )
    pe.write_snapshot(tmp_path, env_a, index, "math_ptptstats", pt_a or _row(_ptptstats_blob()))
    pe.write_snapshot(tmp_path, env_b, index, "math_ptptstats", pt_b or _row(_ptptstats_blob()))


# --------------------------------------------------------------------------- #
# compute_self_jitter_envelope — spec §2 item 1 / Stage D item 1.
# --------------------------------------------------------------------------- #
class TestComputeSelfJitterEnvelope:
    ENV = "clj-ref"

    def test_identical_stores_yield_an_empty_all_zero_envelope(self, tmp_path):
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        blob = _blob(repness_val=1.2345)
        for run in (run1, run2):
            pe.write_snapshot(run, self.ENV, 0, "math_main", _row(blob))
            pe.write_snapshot(run, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob()))

        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        assert report["envelope"] == {}
        assert report["n_leaf_diffs"] == 0
        assert report["structural_divergences"] == []
        assert report["n_batches_aligned"] == 1
        # "all-zero" is a CONVENTION (missing key => 0 via envelope_threshold),
        # never a literal zero-valued entry — nothing should be recorded.
        assert pe.envelope_threshold(report["envelope"], "math_main.repness.N.repness-test") == pytest.approx(1e-9)

    def test_jittered_floats_recorded_with_correct_max_delta(self, tmp_path):
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        pe.write_snapshot(run1, self.ENV, 0, "math_main", _row(_blob(repness_val=1.0)))
        pe.write_snapshot(run2, self.ENV, 0, "math_main", _row(_blob(repness_val=1.0 + 3e-5)))
        for run in (run1, run2):
            pe.write_snapshot(run, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob()))

        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        key = "math_main.repness.N.repness-test"
        assert report["envelope"][key] == pytest.approx(3e-5, abs=1e-12)
        assert report["n_leaf_diffs"] == 1

    def test_path_normalization_collapses_across_batches_and_takes_the_max(self, tmp_path):
        """Two DIFFERENT batches jitter the SAME normalized path pattern by
        different amounts — the envelope must record the MAX, not the last
        or first observed (spec: "record the max cross-run delta")."""
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        # Batch 0: small jitter (1e-6). Batch 1: larger jitter (7e-5), same
        # normalized path ("repness.N.repness-test" — the numeric dict key
        # '1' collapses to 'N' regardless of batch index).
        pe.write_snapshot(run1, self.ENV, 0, "math_main", _row(_blob(repness_val=1.0)))
        pe.write_snapshot(run2, self.ENV, 0, "math_main", _row(_blob(repness_val=1.0 + 1e-6 + 1e-6)))
        pe.write_snapshot(run1, self.ENV, 1, "math_main", _row(_blob(repness_val=2.0)))
        pe.write_snapshot(run2, self.ENV, 1, "math_main", _row(_blob(repness_val=2.0 + 7e-5)))
        for run in (run1, run2):
            for i in (0, 1):
                pe.write_snapshot(run, self.ENV, i, "math_ptptstats", _row(_ptptstats_blob()))

        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        key = "math_main.repness.N.repness-test"
        assert report["envelope"][key] == pytest.approx(7e-5, abs=1e-9)

    def test_structural_divergence_is_reported_separately_never_in_envelope(self, tmp_path):
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        pe.write_snapshot(run1, self.ENV, 0, "math_main", _row(_blob(in_conv=[1, 2])))
        pe.write_snapshot(run2, self.ENV, 0, "math_main", _row(_blob(in_conv=[1, 2, 3])))
        for run in (run1, run2):
            pe.write_snapshot(run, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob()))

        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        assert report["envelope"] == {}
        assert len(report["structural_divergences"]) == 1
        assert report["structural_divergences"][0]["path"] == "step_0.in-conv"
        assert report["n_leaf_diffs"] == 0

    def test_ptptstats_jitter_is_keyed_under_its_own_table_prefix(self, tmp_path):
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        for run in (run1, run2):
            pe.write_snapshot(run, self.ENV, 0, "math_main", _row(_blob()))
        pe.write_snapshot(run1, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob(val=0.0)))
        pe.write_snapshot(run2, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob(val=2e-5)))

        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        assert any(k.startswith("math_ptptstats.") for k in report["envelope"])
        assert not any(k.startswith("math_main.") for k in report["envelope"])

    def test_batches_only_in_one_store_are_reported(self, tmp_path):
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        pe.write_snapshot(run1, self.ENV, 0, "math_main", _row(_blob()))
        pe.write_snapshot(run1, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob()))
        # run2 never got batch 0 at all.
        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        assert report["batches_only_in"]["run1"] == [0]
        assert report["batches_only_in"]["run2"] == []
        assert report["n_batches_aligned"] == 0

    def test_missing_table_snapshot_on_one_side_is_reported_not_raised(self, tmp_path):
        run1, run2 = tmp_path / "run1", tmp_path / "run2"
        for run in (run1, run2):
            pe.write_snapshot(run, self.ENV, 0, "math_main", _row(_blob()))
        pe.write_snapshot(run1, self.ENV, 0, "math_ptptstats", _row(_ptptstats_blob()))
        # run2's math_ptptstats snapshot for batch 0 was never written.
        report = pe.compute_self_jitter_envelope(run1, run2, math_env=self.ENV)

        assert len(report["missing_snapshots"]) == 1
        entry = report["missing_snapshots"][0]
        assert entry["table"] == "math_ptptstats"
        assert entry["missing_in"] == ["run2"]


# --------------------------------------------------------------------------- #
# write_envelope / load_envelope — disk round-trip.
# --------------------------------------------------------------------------- #
class TestEnvelopeStore:
    def test_write_then_load_round_trips(self, tmp_path):
        report = {"envelope": {"math_main.pca.comps[][]": 1e-5}, "n_leaf_diffs": 1}
        path = pe.write_envelope(report, tmp_path)
        assert path == tmp_path / "self_jitter_envelope.json"
        assert pe.load_envelope(tmp_path) == report

    def test_load_missing_is_none(self, tmp_path):
        assert pe.load_envelope(tmp_path) is None


# --------------------------------------------------------------------------- #
# envelope_threshold — pure formula (spec §2 item 2: envelope x 2, floor 1e-9).
# --------------------------------------------------------------------------- #
class TestEnvelopeThreshold:
    def test_none_envelope_is_the_floor(self):
        assert pe.envelope_threshold(None, "x") == pytest.approx(1e-9)

    def test_missing_key_is_the_floor(self):
        assert pe.envelope_threshold({"y": 1.0}, "x") == pytest.approx(1e-9)

    def test_safety_factor_is_exactly_two(self):
        assert pe.envelope_threshold({"x": 1e-6}, "x") == pytest.approx(2e-6)

    def test_floor_wins_over_a_tiny_envelope_value(self):
        # 1e-12 * 2 = 2e-12 < the 1e-9 floor -> floor wins.
        assert pe.envelope_threshold({"x": 1e-12}, "x") == pytest.approx(1e-9)

    def test_floor_applies_even_with_an_explicit_zero_entry(self):
        assert pe.envelope_threshold({"x": 0.0}, "x") == pytest.approx(1e-9)


# --------------------------------------------------------------------------- #
# envelope_path_key — pure, reuses certify.normalize_path (never reimplements).
# --------------------------------------------------------------------------- #
class TestEnvelopePathKey:
    def test_strips_step_prefix_and_collapses_indices(self):
        assert (
            pe.envelope_path_key("math_main", "step_3.pca.comps[0][1]")
            == "math_main.pca.comps[][]"
        )

    def test_collapses_numeric_dict_keys(self):
        assert pe.envelope_path_key("math_main", "step_0.repness.42.score") == "math_main.repness.N.score"

    def test_table_prefix_disambiguates_identical_leaf_names(self):
        a = pe.envelope_path_key("math_main", "step_0.foo")
        b = pe.envelope_path_key("math_ptptstats", "step_0.foo")
        assert a != b


# --------------------------------------------------------------------------- #
# Envelope-aware acceptance — compare_batch/compare_snapshots (Stage D item 2).
# --------------------------------------------------------------------------- #
class TestEnvelopeAwareCompareBatch:
    ENVS = ("clj-ref", "py-shadow")

    def test_default_no_envelope_is_byte_identical_to_pre_stage_d_shape(self, tmp_path):
        """Regression guard for the task's explicit 'keep the default ...
        byte-identical' requirement: no ``within_envelope`` family key, no
        ``n_within_envelope`` key, at all — not even an empty one."""
        blob_a = _blob(repness_val=1.0)
        blob_b = _blob(repness_val=1.0 + 1e-9)  # well within the OWN default tolerance
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        result = pe.compare_batch(tmp_path, 0, self.ENVS)

        main = result["tables"]["math_main"]
        assert set(main.keys()) == {"match", "n_divergences", "families"}
        assert set(main["families"].keys()) == {"exact", "tolerant"}
        ptpt = result["tables"]["math_ptptstats"]
        assert set(ptpt.keys()) == {"match", "n_divergences", "families"}

    def test_within_envelope_divergence_is_accepted_and_counted(self, tmp_path):
        blob_a = _blob(repness_val=0.0)
        blob_b = _blob(repness_val=5e-6)  # exceeds the comparer's OWN 1e-6 atol
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        # Sanity: WITHOUT an envelope this is a real (tolerant-family) divergence.
        no_env = pe.compare_batch(tmp_path, 0, self.ENVS)
        assert no_env["tables"]["math_main"]["match"] is False

        envelope = {"math_main.repness.N.repness-test": 3e-6}  # threshold = 6e-6 >= delta 5e-6
        result = pe.compare_batch(tmp_path, 0, self.ENVS, envelope=envelope)

        main = result["tables"]["math_main"]
        assert main["match"] is True
        assert main["n_divergences"] == 0
        assert main["n_within_envelope"] == 1
        assert len(main["families"]["within_envelope"]) == 1
        assert main["families"]["within_envelope"][0]["path"] == "step_0.repness.1.repness-test"
        assert main["families"]["tolerant"] == []

    def test_beyond_envelope_divergence_is_rejected(self, tmp_path):
        blob_a = _blob(repness_val=0.0)
        blob_b = _blob(repness_val=5e-6)
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        envelope = {"math_main.repness.N.repness-test": 1e-7}  # threshold = 2e-7 < delta 5e-6
        result = pe.compare_batch(tmp_path, 0, self.ENVS, envelope=envelope)

        main = result["tables"]["math_main"]
        assert main["match"] is False
        assert main["n_divergences"] == 1
        assert main["n_within_envelope"] == 0
        assert len(main["families"]["tolerant"]) == 1

    def test_structural_divergence_is_never_excused_by_a_huge_envelope(self, tmp_path):
        blob_a = _blob(in_conv=[1, 2])
        blob_b = _blob(in_conv=[1, 2, 3])
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        huge_envelope = {"math_main.repness.N.repness-test": 1e6, "math_main.in-conv": 1e6}
        result = pe.compare_batch(tmp_path, 0, self.ENVS, envelope=huge_envelope)

        main = result["tables"]["math_main"]
        assert main["match"] is False
        assert len(main["families"]["exact"]) == 1
        assert main["families"]["exact"][0]["path"] == "step_0.in-conv"

    def test_floor_rejects_a_delta_above_1e_minus_9_with_no_observed_jitter(self, tmp_path):
        """Regression for the floor itself (not just the formula): an EMPTY
        envelope (no observed self-jitter at all) must not silently accept
        every tiny divergence — only ones at or below the 1e-9 floor."""
        blob_a = _blob(repness_val=0.0)
        blob_b = _blob(repness_val=5e-6)
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        result = pe.compare_batch(tmp_path, 0, self.ENVS, envelope={})
        assert result["tables"]["math_main"]["match"] is False


class TestEnvelopeAwareCompareSnapshots:
    ENVS = ("clj-ref", "py-shadow")

    def test_default_no_envelope_report_has_no_extra_keys(self, tmp_path):
        blob = _blob(user_vote_counts={"1": 3})
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob), main_b=_row(blob))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert "envelope_applied" not in report
        assert "n_within_envelope_total" not in report

    def test_envelope_applied_flag_and_total_count_are_reported(self, tmp_path):
        blob_a = _blob(repness_val=0.0, user_vote_counts={"1": 3})
        blob_b = _blob(repness_val=5e-6, user_vote_counts={"1": 3})
        _write_paired_batch(tmp_path, self.ENVS, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})

        envelope = {"math_main.repness.N.repness-test": 3e-6}
        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS, envelope=envelope)

        assert report["envelope_applied"] is True
        assert report["n_within_envelope_total"] == 1
        assert report["overall_match"] is True


class TestRenderCompareLinesEnvelopeFooter:
    def _report(self, **overrides) -> dict[str, Any]:
        base = {
            "n_batches_aligned": 1, "math_envs": ["clj-ref", "py-shadow"],
            "batches_only_in": {"clj-ref": [], "py-shadow": []},
            "per_batch": [{"batch": 0, "tables": {
                "math_main": {"match": True}, "math_bidtopid": {"match": True},
                "math_ptptstats": {"match": True},
            }, "watermark": {"ok": True}}],
            "ticks": {
                "clj-ref": {"caching_tick": {"strictly_increasing": True},
                            "math_tick": {"strictly_increasing": True}},
                "py-shadow": {"caching_tick": {"strictly_increasing": True},
                              "math_tick": {"strictly_increasing": True}},
            },
            "overall_match": True,
        }
        base.update(overrides)
        return base

    def test_no_envelope_key_means_no_extra_footer_line(self):
        lines = pe.render_compare_lines(self._report())
        assert not any("envelope" in line for line in lines)
        assert lines[-1].startswith("verdict: MATCH")

    def test_envelope_applied_adds_a_reported_count_line(self):
        report = self._report(envelope_applied=True, n_within_envelope_total=3)
        lines = pe.render_compare_lines(report)
        assert any("3 divergence(s)" in line and "envelope" in line for line in lines)
        assert len(lines) <= 40


# --------------------------------------------------------------------------- #
# assemble_full_run_verdict — the PURE decision logic (Stage D item 3),
# exercised entirely against canned snapshot dirs.
# --------------------------------------------------------------------------- #
class TestAssembleFullRunVerdict:
    CLJ, PY = "clj-ref", "py-shadow"

    def _write_self_jitter_pair(self, tmp_path, *, jitter: float = 0.0):
        run1, run2 = tmp_path / "self-jitter-1", tmp_path / "self-jitter-2"
        pe.write_snapshot(run1, self.CLJ, 0, "math_main", _row(_blob(repness_val=1.0)))
        pe.write_snapshot(run2, self.CLJ, 0, "math_main", _row(_blob(repness_val=1.0 + jitter)))
        for run in (run1, run2):
            pe.write_snapshot(run, self.CLJ, 0, "math_ptptstats", _row(_ptptstats_blob()))
            pe.write_manifest(run, {"batches": [
                {"index": 0, "envs": {self.CLJ: {"ready": True}}},
            ]})
        return run1, run2

    def _write_main(self, tmp_path, *, py_delta: float = 0.0, structural_break: bool = False):
        main = tmp_path / "main"
        in_conv_b = [1, 2, 3] if structural_break else [1, 2]
        # Base value 0.0 (not e.g. 1.0): the underlying ConversationComparer's
        # OWN default tolerance is |a-b| <= 1e-6 + 0.01*|b| — at base=1.0 a
        # 5e-5 delta is already comfortably inside that 1% relative band and
        # would never even reach the envelope-acceptance step. At base=0.0
        # only the absolute floor (1e-6) applies, so these deltas (1e-7..1e-4
        # scale) genuinely exercise envelope acceptance rather than being
        # silently absorbed one layer down.
        blob_a = _blob(repness_val=0.0, user_vote_counts={"1": 3})
        blob_b = _blob(repness_val=py_delta, user_vote_counts={"1": 3}, in_conv=in_conv_b)
        _write_paired_batch(
            main, (self.CLJ, self.PY), 0,
            main_a=_row(blob_a, math_env=self.CLJ), main_b=_row(blob_b, math_env=self.PY),
        )
        pe.write_manifest(main, {"batches": [{"expected_vote_count": 3}]})
        return main

    def test_clean_run_passes(self, tmp_path):
        # cuts matches the ONE batch the fixture stores actually hold — the
        # original version of this test passed cuts=[100, 200] against a
        # 1-batch store and asserted True, which was exactly the
        # completeness hole #2657's review flagged (finding 2).
        run1, run2 = self._write_self_jitter_pair(tmp_path, jitter=0.0)
        main = self._write_main(tmp_path, py_delta=0.0)

        verdict = pe.assemble_full_run_verdict(
            run1, run2, main, dataset="vw", cuts=[100], seam_after=None,
            clj_env=self.CLJ, py_env=self.PY,
        )

        assert verdict["overall_pass"] is True
        assert verdict["self_jitter_envelope"]["envelope"] == {}
        assert verdict["dataset"] == "vw"
        assert verdict["cuts"] == [100]

    def test_partial_main_store_fails_completeness(self, tmp_path):
        """#2657 review finding 2: a feeder killed cleanly BETWEEN batches
        (SIGTERM/OOM outside the fail-fast paths) leaves a store whose later
        batches simply never appear — no ready:false marker — so
        n_batches_aligned > 0 alone reads as a pass. The verdict must
        compare aligned batches against the PLANNED count (len(cuts))."""
        run1, run2 = self._write_self_jitter_pair(tmp_path, jitter=0.0)
        main = self._write_main(tmp_path, py_delta=0.0)  # ONE batch on disk

        verdict = pe.assemble_full_run_verdict(
            run1, run2, main, dataset="vw", cuts=[100, 200], seam_after=1,
            clj_env=self.CLJ, py_env=self.PY,
        )

        assert verdict["overall_pass"] is False
        assert verdict["compare"]["expected_batches"] == 2
        assert verdict["compare"]["overall_match"] is False

    def test_compare_snapshots_expected_batches_guard(self, tmp_path):
        # Direct compare_snapshots-level check of the same rule, both sides.
        main = self._write_main(tmp_path, py_delta=0.0)
        short = pe.compare_snapshots(
            main, math_envs=(self.CLJ, self.PY), expected_batches=2)
        assert short["overall_match"] is False
        assert short["expected_batches"] == 2
        exact = pe.compare_snapshots(
            main, math_envs=(self.CLJ, self.PY), expected_batches=1)
        assert exact["overall_match"] is True
        # Default (None) keeps the pre-existing report shape: no new key.
        default = pe.compare_snapshots(main, math_envs=(self.CLJ, self.PY))
        assert "expected_batches" not in default

    def test_py_divergence_within_measured_self_jitter_is_accepted(self, tmp_path):
        # Self-jitter runs show clj disagreeing with itself by up to 4e-5;
        # the paired run's py value sits within 2x that envelope of clj.
        run1, run2 = self._write_self_jitter_pair(tmp_path, jitter=4e-5)
        main = self._write_main(tmp_path, py_delta=5e-5)  # <= 2 * 4e-5 = 8e-5

        verdict = pe.assemble_full_run_verdict(run1, run2, main, clj_env=self.CLJ, py_env=self.PY)

        assert verdict["self_jitter_envelope"]["envelope"]
        assert verdict["compare"]["envelope_applied"] is True
        assert verdict["overall_pass"] is True

    def test_py_divergence_beyond_the_envelope_still_fails(self, tmp_path):
        run1, run2 = self._write_self_jitter_pair(tmp_path, jitter=1e-7)
        main = self._write_main(tmp_path, py_delta=5e-5)  # >> 2 * 1e-7

        verdict = pe.assemble_full_run_verdict(run1, run2, main, clj_env=self.CLJ, py_env=self.PY)

        assert verdict["overall_pass"] is False

    def test_structural_divergence_fails_regardless_of_envelope(self, tmp_path):
        run1, run2 = self._write_self_jitter_pair(tmp_path, jitter=1e6)  # absurdly huge envelope
        main = self._write_main(tmp_path, py_delta=0.0, structural_break=True)

        verdict = pe.assemble_full_run_verdict(run1, run2, main, clj_env=self.CLJ, py_env=self.PY)

        assert verdict["overall_pass"] is False

    # ------------------------------------------------------------- #
    # NO-COVERAGE GUARD — REQUIRED FIX #1 (2026-07-24 live-debug task):
    # a vacuous self-jitter measurement (0 batches from either/both clj-only
    # runs) must fail the WHOLE full-run verdict, not just silently report
    # an empty envelope. This is EXACTLY the shape of the real 2026-07-24
    # live-run bug: "self-jitter envelope: 0 path(s) jittered... (none
    # observed — identical self-jitter runs)" printed as if it were a clean
    # signal, when in fact NOTHING was ever measured.
    # ------------------------------------------------------------- #
    def test_empty_self_jitter_streams_fail_the_full_run_even_if_main_is_clean(self, tmp_path):
        main = self._write_main(tmp_path, py_delta=0.0)
        run1, run2 = tmp_path / "self-jitter-1", tmp_path / "self-jitter-2"
        # NEITHER self-jitter store ever got a single snapshot (both clj-ref
        # containers crashed at startup, say) — no write_snapshot call at all.

        verdict = pe.assemble_full_run_verdict(run1, run2, main, clj_env=self.CLJ, py_env=self.PY)

        assert verdict["self_jitter_envelope"]["n_batches_aligned"] == 0
        assert verdict["overall_pass"] is False

    def test_self_jitter_manifest_ready_false_fails_the_full_run(self, tmp_path):
        main = self._write_main(tmp_path, py_delta=0.0)
        run1, run2 = tmp_path / "self-jitter-1", tmp_path / "self-jitter-2"
        pe.write_snapshot(run1, self.CLJ, 0, "math_main", _row(_blob(repness_val=1.0)))
        pe.write_snapshot(run2, self.CLJ, 0, "math_main", _row(_blob(repness_val=1.0)))
        for run in (run1, run2):
            pe.write_snapshot(run, self.CLJ, 0, "math_ptptstats", _row(_ptptstats_blob()))
        # run1's manifest HONESTLY records that batch 1 (a second, never-fed
        # batch) never became ready — batch 0 (aligned, clean) would ALONE
        # report a passing envelope under the pre-guard logic.
        pe.write_manifest(run1, {"batches": [
            {"index": 0, "envs": {self.CLJ: {"ready": True}}},
            {"index": 1, "envs": {self.CLJ: {"ready": False}}},
        ]})
        pe.write_manifest(run2, {"batches": [
            {"index": 0, "envs": {self.CLJ: {"ready": True}}},
        ]})

        verdict = pe.assemble_full_run_verdict(run1, run2, main, clj_env=self.CLJ, py_env=self.PY)

        assert verdict["overall_pass"] is False
        assert verdict["self_jitter_coverage"]["run1"]["ok"] is False


class TestWriteFullRunVerdict:
    def test_writes_json_at_the_expected_path(self, tmp_path):
        verdict = {"overall_pass": True, "dataset": "vw"}
        path = pe.write_full_run_verdict(verdict, tmp_path)
        assert path == tmp_path / "full_run_verdict.json"
        assert json.loads(path.read_text()) == verdict


class TestRenderFullRunLines:
    def _verdict(self, *, overall_pass=True, envelope=None, n_batches=1) -> dict[str, Any]:
        per_batch = [
            {"batch": i, "tables": {"math_main": {"match": True}, "math_bidtopid": {"match": True},
                                     "math_ptptstats": {"match": True}},
             "watermark": {"ok": True}}
            for i in range(n_batches)
        ]
        compare = {
            "n_batches_aligned": n_batches, "math_envs": ["clj-ref", "py-shadow"],
            "batches_only_in": {"clj-ref": [], "py-shadow": []},
            "per_batch": per_batch,
            "ticks": {
                "clj-ref": {"caching_tick": {"strictly_increasing": True},
                            "math_tick": {"strictly_increasing": True}},
                "py-shadow": {"caching_tick": {"strictly_increasing": True},
                              "math_tick": {"strictly_increasing": True}},
            },
            "overall_match": overall_pass,
        }
        return {
            "dataset": "vw", "seam_after": 4, "overall_pass": overall_pass,
            "compare": compare,
            "self_jitter_envelope": {"envelope": envelope or {}},
        }

    def test_pass_verdict_renders_within_line_budget(self):
        lines = pe.render_full_run_lines(self._verdict(overall_pass=True))
        assert len(lines) <= 40
        assert any("PASS" in line for line in lines)
        assert any("vw" in line for line in lines)

    def test_fail_verdict_is_labeled_fail(self):
        lines = pe.render_full_run_lines(self._verdict(overall_pass=False))
        assert any("FAIL" in line for line in lines)

    def test_empty_envelope_says_none_observed(self):
        lines = pe.render_full_run_lines(self._verdict(envelope={}))
        assert any("none observed" in line for line in lines)

    def test_worst_envelope_paths_are_shown(self):
        envelope = {f"math_main.k{i}": 10.0 ** (-i) for i in range(1, 8)}
        lines = pe.render_full_run_lines(self._verdict(envelope=envelope))
        # The single largest delta (k1 -> 1e-1) must be visible.
        assert any("k1" in line for line in lines)
        assert len(lines) <= 40

    def test_large_batch_count_still_respects_the_line_budget(self):
        envelope = {f"math_main.k{i}": 10.0 ** (-i) for i in range(1, 8)}
        lines = pe.render_full_run_lines(self._verdict(n_batches=200, envelope=envelope))
        assert len(lines) <= 40


# --------------------------------------------------------------------------- #
# default_full_run_schedule — reads real schedule files / dataset CSVs, no
# live services (pure file I/O against the committed repo + real_data/).
# --------------------------------------------------------------------------- #
class TestDefaultFullRunSchedule:
    def test_vw_reads_the_committed_uniform8_restart4_schedule_verbatim(self):
        cuts, seam_after = pe.default_full_run_schedule("vw")
        assert cuts == [585, 1171, 1756, 2342, 2927, 3512, 4098, 4683]
        assert seam_after == 4

    def test_other_dataset_derives_uniform8_from_its_own_vote_count(self):
        if real_data.dataset_dir("biodiversity") is None:
            pytest.skip("biodiversity dataset not present in this checkout")
        cuts, seam_after = pe.default_full_run_schedule("biodiversity")
        assert len(cuts) == 8
        assert all(b > a for a, b in zip(cuts, cuts[1:]))  # strictly increasing
        assert seam_after == 4  # mid-schedule for 8 cuts, 0-based


# --------------------------------------------------------------------------- #
# preflight_check — fail-fast gate (Stage D item 3). No live service reached:
# the clojure-missing path is a pure shutil.which stub, and the unreachable-DB
# path targets a definitely-closed local port (immediate ECONNREFUSED).
# --------------------------------------------------------------------------- #
class TestPreflightCheck:
    def test_missing_clojure_cli_raises_a_clear_message(self, monkeypatch):
        monkeypatch.setattr(pe.shutil, "which", lambda name: None)
        with pytest.raises(RuntimeError, match="clojure"):
            pe.preflight_check("postgresql://u:p@127.0.0.1:1/nonexistent")

    def test_unreachable_postgres_raises_a_clear_message_fast(self, monkeypatch):
        monkeypatch.setattr(pe.shutil, "which", lambda name: "/usr/bin/clojure")
        with pytest.raises(RuntimeError, match="cannot reach Postgres"):
            pe.preflight_check("postgresql://u:p@127.0.0.1:1/nonexistent", connect_timeout=1.0)

    def test_reachable_prerequisites_do_not_raise(self, monkeypatch):
        """No real DB is touched: a fake sqlalchemy engine/connection double
        stands in so this stays a pure/offline test."""
        monkeypatch.setattr(pe.shutil, "which", lambda name: "/usr/bin/clojure")

        class _FakeConnCtx:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        class _FakeEngine:
            def connect(self):
                return _FakeConnCtx()

            def dispose(self):
                pass

        monkeypatch.setattr(pe.sa, "create_engine", lambda *a, **k: _FakeEngine())
        pe.preflight_check("postgresql://u:p@127.0.0.1:1/nonexistent")  # must not raise


# --------------------------------------------------------------------------- #
# FullRunConfig — defaults.
# --------------------------------------------------------------------------- #
class TestFullRunConfig:
    def test_restart_clj_at_seam_defaults_true(self):
        config = pe.FullRunConfig(
            dataset="vw", admin_url="postgresql://x", out_root="/tmp/x",
            cuts=(1, 2), seam_after=0,
        )
        assert config.restart_clj_at_seam is True

    def test_is_frozen(self):
        config = pe.FullRunConfig(
            dataset="vw", admin_url="postgresql://x", out_root="/tmp/x",
            cuts=(1, 2), seam_after=0,
        )
        with pytest.raises(Exception):
            config.dataset = "biodiversity"


# --------------------------------------------------------------------------- #
# CLI wiring — the full-run subcommand exists and accepts its flags.
# --------------------------------------------------------------------------- #
def _cli_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "poller_equiv_cli_stage_d", Path(__file__).resolve().parents[2] / "scripts" / "poller_equiv.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestFullRunCli:
    def test_full_run_subcommand_is_registered(self):
        from click.testing import CliRunner

        mod = _cli_module()
        result = CliRunner().invoke(mod.cli, ["--help"])
        assert result.exit_code == 0
        assert "full-run" in result.output

    def test_full_run_help_lists_its_flags(self):
        from click.testing import CliRunner

        mod = _cli_module()
        result = CliRunner().invoke(mod.cli, ["full-run", "--help"])
        assert result.exit_code == 0
        assert "--seam-after" in result.output
        assert "--restart-clj-at-seam" in result.output
