"""Unit surface for the shard-scaling benchmark (HANDOFF_PYTHON_SHARDING.md §7).

The benchmark itself needs N real processes and ~a minute of CPU, so it is an
opt-in script.  Every pure decision point it rests on is covered here with
canned numbers: the workload partition (which must go through the REAL
should_process_zid, not a reimplementation), the BLAS pinning env, and the
scaling arithmetic (throughput / speedup / efficiency / Karp-Flatt).
"""

import pytest

from polismath.replay import shard_bench as sb_mod
from polismath.poller.service import should_process_zid
from polismath.replay.shard_bench import (
    BLAS_ENV_VARS,
    ShardResult,
    best_arm,
    blas_env,
    karp_flatt,
    load_warning,
    scaling_table,
    shard_workload,
    summarize_arm,
    verdict,
)


class TestShardWorkload:
    """The benchmark must partition with the SAME function production uses --
    otherwise it measures a reimplementation and proves nothing about the
    shipped filter."""

    def test_partition_matches_the_real_filter(self):
        zids = list(range(50))
        for shard_count in (1, 2, 4, 8):
            for idx in range(shard_count):
                assert shard_workload(zids, idx, shard_count) == [
                    z for z in zids if should_process_zid(z, [], [], idx, shard_count)
                ]

    def test_partition_is_total_and_disjoint(self):
        zids = list(range(48))
        for shard_count in (1, 2, 3, 4, 8):
            owned = [shard_workload(zids, i, shard_count) for i in range(shard_count)]
            flat = [z for chunk in owned for z in chunk]
            assert sorted(flat) == zids          # total: nothing dropped
            assert len(flat) == len(set(flat))   # disjoint: nothing doubled

    def test_balanced_when_divisible(self):
        # A COST-balanced workload is the point: every zid replays the same
        # dataset, so an even COUNT split is an even WORK split. Skew is a real
        # production concern but would confound a scaling measurement.
        zids = list(range(24))
        for shard_count in (1, 2, 4, 8):
            sizes = {len(shard_workload(zids, i, shard_count)) for i in range(shard_count)}
            assert sizes == {24 // shard_count}

    def test_single_shard_owns_everything(self):
        zids = list(range(10))
        assert shard_workload(zids, 0, 1) == zids


class TestBlasEnv:
    """Unpinned numpy fans one recompute across every core (measured cpu/wall
    8.75 on r8g; on a 10-core laptop it is SLOWER in wall time and burns ~7x
    the CPU). N such shards on one box thrash, so every shard pins to 1."""

    def test_pinning_sets_every_known_blas_var_to_one(self):
        env = blas_env({"PATH": "/bin"}, pin=True)
        for var in BLAS_ENV_VARS:
            assert env[var] == "1", var
        assert env["PATH"] == "/bin"  # base env preserved

    def test_unpinned_removes_them_so_numpy_uses_its_default(self):
        # Inherited values would silently pin the "unpinned" control arm and
        # collapse the comparison the correction section is about.
        base = {"PATH": "/bin", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"}
        env = blas_env(base, pin=False)
        for var in BLAS_ENV_VARS:
            assert var not in env, var
        assert env["PATH"] == "/bin"

    def test_base_env_is_not_mutated(self):
        base = {"PATH": "/bin"}
        blas_env(base, pin=True)
        assert base == {"PATH": "/bin"}


class TestSummarizeArm:
    def test_wall_is_the_slowest_shard_not_the_sum(self):
        # Shards run concurrently: the arm finishes when the LAST one does.
        results = [
            ShardResult(shard_index=0, ticks=12, compute_seconds=4.0),
            ShardResult(shard_index=1, ticks=12, compute_seconds=5.0),
        ]
        arm = summarize_arm(2, results)
        assert arm.ticks == 24
        assert arm.wall_seconds == 5.0
        assert arm.throughput == pytest.approx(24 / 5.0)

    def test_single_shard_arm(self):
        arm = summarize_arm(1, [ShardResult(0, ticks=24, compute_seconds=20.0)])
        assert arm.throughput == pytest.approx(1.2)

    def test_cpu_seconds_sum_across_shards_and_per_tick(self):
        """CPU per tick is what separates 'sharding costs extra work' from
        'the box has no free cores'. Wall can stall for want of a core while
        CPU per tick stays flat — that is a machine limit, not a mechanism
        limit, and only this statistic can tell them apart."""
        results = [
            ShardResult(0, ticks=12, compute_seconds=5.0, cpu_seconds=4.0),
            ShardResult(1, ticks=12, compute_seconds=5.0, cpu_seconds=6.0),
        ]
        arm = summarize_arm(2, results)
        assert arm.cpu_seconds == pytest.approx(10.0)
        assert arm.cpu_per_tick == pytest.approx(10.0 / 24)

    def test_cpu_defaults_to_zero_when_unreported(self):
        arm = summarize_arm(1, [ShardResult(0, ticks=24, compute_seconds=20.0)])
        assert arm.cpu_seconds == pytest.approx(0.0)
        assert arm.cpu_per_tick == pytest.approx(0.0)

    def test_zero_wall_is_rejected_rather_than_dividing_by_zero(self):
        with pytest.raises(ValueError, match="wall"):
            summarize_arm(1, [ShardResult(0, ticks=5, compute_seconds=0.0)])

    def test_empty_results_rejected(self):
        with pytest.raises(ValueError, match="no shard results"):
            summarize_arm(2, [])


class TestKarpFlatt:
    """Karp-Flatt experimentally-determined serial fraction -- directly
    comparable to the handoff's quoted serial fractions (py-threads 0.9884,
    py-zid-shard 0.0013)."""

    def test_perfect_linear_speedup_is_zero_serial_fraction(self):
        assert karp_flatt(8.0, 8) == pytest.approx(0.0, abs=1e-12)

    def test_no_speedup_at_all_is_fully_serial(self):
        assert karp_flatt(1.0, 2) == pytest.approx(1.0)

    def test_half_speedup_is_intermediate(self):
        # S=4 at N=8 -> e = (1/4 - 1/8) / (1 - 1/8) = 0.125/0.875
        assert karp_flatt(4.0, 8) == pytest.approx(0.125 / 0.875)

    def test_undefined_for_a_single_worker(self):
        assert karp_flatt(1.0, 1) is None


class TestScalingTable:
    def _arms(self):
        # Ideal linear scaling: throughput doubles with each doubling of N.
        return [
            summarize_arm(1, [ShardResult(0, 24, 24.0)]),
            summarize_arm(2, [ShardResult(i, 12, 12.0) for i in range(2)]),
            summarize_arm(4, [ShardResult(i, 6, 6.0) for i in range(4)]),
        ]

    def test_speedup_is_relative_to_the_single_shard_arm(self):
        rows = scaling_table(self._arms())
        assert [r["shard_count"] for r in rows] == [1, 2, 4]
        assert [r["speedup"] for r in rows] == pytest.approx([1.0, 2.0, 4.0])
        assert [r["efficiency"] for r in rows] == pytest.approx([1.0, 1.0, 1.0])

    def test_serial_fraction_reported_per_arm(self):
        rows = scaling_table(self._arms())
        assert rows[0]["serial_fraction"] is None          # undefined at N=1
        assert rows[2]["serial_fraction"] == pytest.approx(0.0, abs=1e-12)

    def test_sublinear_scaling_shows_lost_efficiency(self):
        arms = [
            summarize_arm(1, [ShardResult(0, 24, 24.0)]),
            summarize_arm(4, [ShardResult(i, 6, 12.0) for i in range(4)]),  # 2x only
        ]
        rows = scaling_table(arms)
        assert rows[1]["speedup"] == pytest.approx(2.0)
        assert rows[1]["efficiency"] == pytest.approx(0.5)
        assert rows[1]["serial_fraction"] == pytest.approx((0.5 - 0.25) / 0.75)

    def test_missing_baseline_is_rejected(self):
        arms = [summarize_arm(2, [ShardResult(i, 12, 12.0) for i in range(2)])]
        with pytest.raises(ValueError, match="baseline"):
            scaling_table(arms)


class TestBestArm:
    """Timing on a shared developer machine is noisy in ONE direction only:
    background load can add wall time, never remove it. So across repeats of an
    arm the fastest run is the closest estimate of the true cost, and taking a
    mean would bake in whatever else the laptop was doing."""

    def test_picks_the_fastest_repeat(self):
        repeats = [
            summarize_arm(4, [ShardResult(i, 6, 12.0) for i in range(4)]),
            summarize_arm(4, [ShardResult(i, 6, 6.0) for i in range(4)]),   # best
            summarize_arm(4, [ShardResult(i, 6, 9.0) for i in range(4)]),
        ]
        best = best_arm(repeats)
        assert best.wall_seconds == 6.0
        assert best.throughput == pytest.approx(24 / 6.0)

    def test_single_repeat_passes_through(self):
        only = summarize_arm(2, [ShardResult(i, 12, 8.0) for i in range(2)])
        assert best_arm([only]) is only

    def test_mixed_shard_counts_rejected(self):
        with pytest.raises(ValueError, match="same shard_count"):
            best_arm([
                summarize_arm(2, [ShardResult(0, 12, 8.0), ShardResult(1, 12, 8.0)]),
                summarize_arm(4, [ShardResult(i, 6, 6.0) for i in range(4)]),
            ])

    def test_empty_rejected(self):
        with pytest.raises(ValueError, match="no arms"):
            best_arm([])


# A stand-in shard: joins the barrier, floods stderr well past the 64KB pipe
# buffer, then reports a result. With stderr on a PIPE the parent — which only
# drains sequentially, at the end — leaves every child but the first blocked on
# write, serialising the arm.
_FLOODING_CHILD = """
import sys, os, time, json
ready, go, idx = sys.argv[1], sys.argv[2], int(sys.argv[3])
open(ready, "w").write("r")
while not os.path.exists(go):
    time.sleep(0.01)
sys.stderr.write("x" * 300000)
sys.stderr.flush()
print(json.dumps({"shard_index": idx, "ticks": 4,
                  "compute_seconds": 0.5, "cpu_seconds": 0.4}))
"""


class TestChildOutputIsNotPiped:
    """Regression guard for the bug that invalidated the first four sweeps.

    conversation.py logs several KB per tick to stderr. Piping that into a
    buffer the parent only reads at the end blocks each child once 64KB fills,
    and since the parent calls communicate() shard-by-shard, shard 0 runs at
    full speed while the rest stall waiting their turn. Measured effect on an
    IDLE 16-core r8g.4xlarge: 1.05x at N=2 with cpu/tick dead flat — the shards
    were doing identical work and simply not running at the same time.
    """

    def test_arm_with_noisy_children_completes_and_collects(self, monkeypatch, tmp_path):
        import sys

        def fake_cmd(dataset, zid_count, shard_index, shard_count, n_cuts, ready, go):
            return [sys.executable, "-c", _FLOODING_CHILD,
                    str(ready), str(go), str(shard_index)]

        monkeypatch.setattr(sb_mod, "_child_cmd", fake_cmd)
        arm = sb_mod.run_arm(
            "vw", 8, 4, n_cuts=2, pin=True, work_dir=tmp_path / "wd"
        )
        # All four shards reported despite each emitting ~300KB of stderr.
        assert arm.shard_count == 4
        assert arm.ticks == 16

    def test_stdout_and_stderr_are_never_subprocess_pipe(self, monkeypatch, tmp_path):
        import subprocess as sp
        import sys

        seen = []
        real_popen = sp.Popen

        def spy(cmd, **kw):
            seen.append(kw)
            return real_popen(cmd, **kw)

        def fake_cmd(dataset, zid_count, shard_index, shard_count, n_cuts, ready, go):
            return [sys.executable, "-c", _FLOODING_CHILD,
                    str(ready), str(go), str(shard_index)]

        monkeypatch.setattr(sb_mod, "_child_cmd", fake_cmd)
        monkeypatch.setattr(sb_mod.subprocess, "Popen", spy)
        sb_mod.run_arm("vw", 4, 2, n_cuts=2, pin=True, work_dir=tmp_path / "wd")

        assert seen, "no child was spawned"
        for kw in seen:
            assert kw.get("stdout") is not sp.PIPE, "stdout must not be a pipe"
            assert kw.get("stderr") is not sp.PIPE, "stderr must not be a pipe"


class TestLoadWarning:
    """A sweep run on a busy box measures the box, not the mechanism — and the
    table alone cannot show that. Discovered the hard way: a sweep at load 9 on
    a 10-core machine reported 3.6x at N=8 with CPU/tick flat, i.e. the shards
    were starved of cores rather than contending."""

    def test_warns_when_load_leaves_too_few_free_cores(self):
        warn = load_warning(load1=9.0, cpu_count=10, shard_count=8)
        assert warn is not None
        assert "9.0" in warn and "8" in warn

    def test_silent_on_a_quiet_machine(self):
        assert load_warning(load1=0.4, cpu_count=10, shard_count=8) is None

    def test_unknown_cpu_count_does_not_crash(self):
        assert load_warning(load1=9.0, cpu_count=None, shard_count=8) is None

    def test_warns_only_when_the_arm_actually_needs_the_cores(self):
        # 1 free core is plenty for a single-shard arm.
        assert load_warning(load1=9.0, cpu_count=10, shard_count=1) is None


class TestVerdict:
    def test_quasi_linear_when_efficiency_holds_at_the_largest_arm(self):
        rows = scaling_table([
            summarize_arm(1, [ShardResult(0, 24, 24.0)]),
            summarize_arm(8, [ShardResult(i, 3, 3.3) for i in range(8)]),
        ])
        v = verdict(rows, min_efficiency=0.8)
        assert v["quasi_linear"] is True
        assert v["max_shard_count"] == 8

    def test_not_quasi_linear_when_the_largest_arm_degrades(self):
        rows = scaling_table([
            summarize_arm(1, [ShardResult(0, 24, 24.0)]),
            summarize_arm(8, [ShardResult(i, 3, 12.0) for i in range(8)]),  # 2x
        ])
        v = verdict(rows, min_efficiency=0.8)
        assert v["quasi_linear"] is False
        assert v["efficiency"] == pytest.approx(0.25)

    def test_verdict_needs_more_than_the_baseline_arm(self):
        rows = scaling_table([summarize_arm(1, [ShardResult(0, 24, 24.0)])])
        with pytest.raises(ValueError, match="at least two"):
            verdict(rows, min_efficiency=0.8)
