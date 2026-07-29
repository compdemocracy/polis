"""Smoke tests for the committed cut-cadence experiment suite.

Tiny configs only (n ~ 120 votes, N = 5, one seed) so the whole file stays
well under 30 s. The full grid runs offline via the CLI — see
polismath/replay/experiments/RESULTS.md for the committed results and
exact reproduce commands.
"""

import dataclasses
import json

import numpy as np
import pytest

from polismath.replay.experiments import cadence
from polismath.replay.experiments.run_cadence import main as cli_main
from polismath.replay.physics import forced_slots

TINY_N_VOTES = 120

RUN_KEYS = {
    "family", "era", "N", "seed", "n_votes", "n_cuts", "n_samples",
    "loc_med_votes", "loc_p90_votes", "loc_med_s", "loc_p90_s",
    "cov_3votes", "cov_10s",
    "disp_map_votes", "disp_map_s",
    "disp_median_votes", "disp_median_s",
    "disp_sample1_votes", "disp_sample1_s",
    "median_sort_needed", "map_mass", "distinct_schedules", "config",
}


class TestGeneratorsSound:
    @pytest.mark.parametrize("family", cadence.FAMILIES)
    def test_truth_is_sound_and_nonempty(self, family):
        case = cadence.build_case(family, "B", 5, 0, n_votes=TINY_N_VOTES)
        assert len(case.truth) >= 1
        assert list(case.truth) == sorted(set(case.truth))
        assert case.ds.n == TINY_N_VOTES
        cadence.check_truth_sound(case)  # must not raise

    def test_bursty_truth_contains_forced_slots(self):
        case = cadence.build_case("bursty", "B", None, 0, n_votes=150)
        forced = forced_slots(
            case.ds,
            poll_interval_ms=case.infer_kwargs["poll_interval_ms"],
            compute_ms=case.infer_kwargs["compute_ms"],
        )
        assert forced, "bursty lull gaps must force cuts"
        assert forced <= set(case.truth)

    def test_soundness_check_rejects_missing_forced_slot(self):
        case = cadence.build_case("bursty", "B", None, 0, n_votes=150)
        forced = forced_slots(
            case.ds,
            poll_interval_ms=case.infer_kwargs["poll_interval_ms"],
            compute_ms=case.infer_kwargs["compute_ms"],
        )
        broken = tuple(s for s in case.truth if s != min(forced))
        bad = dataclasses.replace(case, truth=broken)
        with pytest.raises(cadence.SoundnessError, match="forced"):
            cadence.check_truth_sound(bad)

    def test_soundness_check_rejects_spacing_violation(self):
        case = cadence.build_case("fixed", "B", 5, 0, n_votes=TINY_N_VOTES)
        # two adjacent slots cannot both be cuts under the fixed-family
        # min-spacing (which exceeds a couple of vote gaps)
        bad = dataclasses.replace(case, truth=(5, 6))
        with pytest.raises(cadence.SoundnessError, match="min_spacing"):
            cadence.check_truth_sound(bad)


class TestMetricHelpers:
    def test_per_index_median_monotone_no_sort(self):
        med, needed = cadence.per_index_median([(1, 5, 9), (3, 7, 11)])
        assert not needed
        assert np.allclose(med, [2.0, 6.0, 10.0])

    def test_per_index_median_sorts_defensively(self):
        med, needed = cadence.per_index_median([(9, 1), (10, 2)])
        assert needed
        assert np.all(np.diff(med) >= 0)

    def test_per_index_median_rejects_ragged(self):
        with pytest.raises(ValueError, match="equal-length"):
            cadence.per_index_median([(1,), (1, 2)])

    def test_matched_displacement_identity_is_zero(self):
        t_arr = np.arange(1, 11, dtype=float) * 1000.0
        v, s = cadence.matched_displacement((2, 5, 8), (2, 5, 8), t_arr)
        assert v == 0.0 and s == 0.0

    def test_matched_displacement_known_offset(self):
        t_arr = np.arange(1, 11, dtype=float) * 1000.0  # 1 s per vote
        v, s = cadence.matched_displacement((3, 6), (2, 5), t_arr)
        assert v == 1.0
        assert s == pytest.approx(1.0)


class TestRunnerContract:
    def test_run_case_produces_expected_keys(self):
        case = cadence.build_case("fixed", "B", 5, 0, n_votes=TINY_N_VOTES)
        out = cadence.run_case(case)
        assert RUN_KEYS <= set(out)
        assert out["n_cuts"] == len(case.truth)
        assert 0.0 <= out["cov_3votes"] <= 1.0
        assert 0.0 <= out["cov_10s"] <= 1.0
        assert 0.0 < out["map_mass"] <= 1.0 + 1e-9
        assert 1 <= out["distinct_schedules"] <= out["n_samples"]
        json.dumps(out)  # JSON-serializable end to end

    def test_cli_writes_json_and_markdown(self, tmp_path):
        out = tmp_path / "res.json"
        md = tmp_path / "res.md"
        rc = cli_main([
            "--exp", "fixed", "--seeds", "0", "--Ns", "5",
            "--n-votes", str(TINY_N_VOTES),
            "--out", str(out), "--md", str(md),
        ])
        assert rc == 0
        data = json.loads(out.read_text())
        assert set(data) == {"meta", "runs", "aggregates"}
        assert len(data["runs"]) == 2  # eras B and A
        assert {r["era"] for r in data["runs"]} == {"B", "A"}
        assert len(data["aggregates"]) == 2
        assert RUN_KEYS <= set(data["runs"][0])
        text = md.read_text()
        assert "Reproduce" in text
        assert "| family | era | N |" in text
