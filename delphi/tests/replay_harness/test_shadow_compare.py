"""Unit tests for the live shadow-soak comparer (cutover Step #1 —
CUTOVER_RUNBOOK.md "Step 1 — shadow in prod").

NO live Postgres required: every test is pure-Python or drives
:func:`polismath.replay.shadow_compare.run` against a fake connection double
(the ``_FakeConn``/``_SequenceConn`` pattern from
``test_poller_equiv_seed.py`` / ``test_poller_equiv_compare.py``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from polismath.replay import shadow_compare as sc


# --------------------------------------------------------------------------- #
# Fixtures / doubles.
# --------------------------------------------------------------------------- #
def _blob(
    *, n: int = 2, n_cmts: int = 2, votes: dict[str, int] | None = None,
    comp0: float = 1.0, last_vote_ts: int = 1000,
) -> dict[str, Any]:
    """A minimal math_main-shaped blob (prep-main key spelling — mirrors
    ``test_poller_equiv_compare.py``'s ``_math_main_blob`` helper) carrying
    the keys the shadow comparer reads: ``n``/``n-cmts`` (Q10 large-conv
    cutoffs) and ``user-vote-counts`` (sync detection)."""
    return {
        "zid": 1,
        "n": n,
        "n-cmts": n_cmts,
        "in-conv": [1, 2],
        "tids": [0, 1],
        "pca": {"center": [0.1, 0.2], "comps": [[comp0, 0.0], [0.0, 1.0]]},
        "base-clusters": {
            "id": [0, 1], "x": [0.1, -0.1], "y": [0.2, -0.2],
            "count": [1, 2], "members": [[1], [2, 3]],
        },
        "repness": {},
        "lastVoteTimestamp": last_vote_ts,
        "user-vote-counts": votes if votes is not None else {"1": 3},
    }


def _row(data: dict[str, Any], *, env: str = "e", tick: int = 1) -> dict[str, Any]:
    """A math-table row shape (what :func:`pe.fetch_math_row` returns)."""
    return {
        "zid": 1, "math_env": env, "data": data,
        "last_vote_timestamp": data.get("lastVoteTimestamp", 1000),
        "caching_tick": tick, "math_tick": tick, "modified": 123,
    }


def _bidtopid(groups: list[list[int]] | None = None) -> dict[str, Any]:
    return {"zid": 1, "bidToPid": groups if groups is not None else [[1], [2, 3]]}


def _ptptstats(centricness: list[float] | None = None) -> dict[str, Any]:
    return {
        "zid": 1,
        "ptptstats": {
            "pid": [1, 2],
            "centricness": centricness if centricness is not None else [0.5, 0.6],
        },
        "lastVoteTimestamp": 1000,
    }


def _pair(
    blob_a: dict[str, Any] | None,
    blob_b: dict[str, Any] | None,
    *,
    bid_a: dict[str, Any] | None = None,
    bid_b: dict[str, Any] | None = None,
    ppt_a: dict[str, Any] | None = None,
    ppt_b: dict[str, Any] | None = None,
    tick_a: int = 1,
    tick_b: int = 1,
) -> dict[str, tuple[dict[str, Any] | None, dict[str, Any] | None]]:
    """Build the ``{table: (row_a, row_b)}`` mapping ``classify_pair`` takes.
    ``None`` for any blob/side-table argument means "row absent in that
    env". Side tables share their env's main ``math_tick`` (one tick per
    write cycle — the coherent, non-torn state)."""
    return {
        "math_main": (
            _row(blob_a, env="prod", tick=tick_a) if blob_a is not None else None,
            _row(blob_b, env="python", tick=tick_b) if blob_b is not None else None,
        ),
        "math_bidtopid": (
            _row(bid_a, env="prod", tick=tick_a) if bid_a is not None else None,
            _row(bid_b, env="python", tick=tick_b) if bid_b is not None else None,
        ),
        "math_ptptstats": (
            _row(ppt_a, env="prod", tick=tick_a) if ppt_a is not None else None,
            _row(ppt_b, env="python", tick=tick_b) if ppt_b is not None else None,
        ),
    }


def _matching_pair(**kwargs: Any) -> dict[str, Any]:
    """An in-sync, fully matching three-table pair."""
    return _pair(
        _blob(), _blob(),
        bid_a=_bidtopid(), bid_b=_bidtopid(),
        ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        **kwargs,
    )


class _FakeResult:
    def __init__(self, rows):
        self._rows = [r for r in (rows or []) if r is not None]

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)


class _PairConn:
    """Serves :func:`pe.fetch_math_row` queries from a
    ``{(table, zid, math_env): row}`` mapping, and zid-discovery queries
    (recognized by their GROUP BY) from a canned row list."""

    def __init__(self, rows, discover_rows=None):
        self.rows = dict(rows)
        self.discover_rows = list(discover_rows or [])
        self.calls: list[tuple[str, dict]] = []

    def execute(self, stmt, params=None):
        text = str(stmt)
        params = dict(params or {})
        self.calls.append((text, params))
        if "GROUP BY" in text:
            return _FakeResult(self.discover_rows)
        table = text.split("FROM ", 1)[1].split()[0]
        return _FakeResult([self.rows.get((table, params["zid"], params["math_env"]))])


# --------------------------------------------------------------------------- #
# is_large_conv — the Q10 cutoffs are STRICTLY-GREATER (conversation.clj:
# 784-815 dispatches to large-conv-update when n-ptpts > 10000 OR
# n-cmts > 5000).
# --------------------------------------------------------------------------- #
class TestIsLargeConv:
    def test_small_conv(self):
        assert sc.is_large_conv(_blob(n=100, n_cmts=50)) is False

    def test_exactly_at_cutoffs_is_not_large(self):
        assert sc.is_large_conv(_blob(n=10_000, n_cmts=5_000)) is False

    def test_ptpt_cutoff_exceeded(self):
        assert sc.is_large_conv(_blob(n=10_001, n_cmts=50)) is True

    def test_cmt_cutoff_exceeded(self):
        assert sc.is_large_conv(_blob(n=100, n_cmts=5_001)) is True

    def test_missing_size_keys_is_not_large(self):
        assert sc.is_large_conv({}) is False


# --------------------------------------------------------------------------- #
# sync_state — live rows are only judged when both engines have processed
# the same cumulative vote set (blob_total_votes equality).
# --------------------------------------------------------------------------- #
class TestSyncState:
    def test_equal_vote_totals_in_sync(self):
        a = _blob(votes={"1": 5, "2": 3})
        b = _blob(votes={"1": 4, "2": 4})  # same TOTAL (8), split differently
        assert sc.sync_state(a, b) == sc.SYNC_IN_SYNC

    def test_different_totals_out_of_sync(self):
        assert (
            sc.sync_state(_blob(votes={"1": 5}), _blob(votes={"1": 4}))
            == sc.SYNC_OUT_OF_SYNC
        )

    def test_missing_counts_not_ready(self):
        blob = _blob()
        del blob["user-vote-counts"]
        assert sc.sync_state(blob, _blob()) == sc.SYNC_NOT_READY

    def test_equal_totals_different_last_vote_ts_out_of_sync(self):
        """Revote-only watermark delta: totals equal (revotes overwrite
        cells), lastVoteTimestamp differs — must NOT be judged in-sync."""
        assert (
            sc.sync_state(_blob(last_vote_ts=1000), _blob(last_vote_ts=2000))
            == sc.SYNC_OUT_OF_SYNC
        )

    def test_missing_last_vote_ts_falls_back_to_totals(self):
        blob = _blob()
        del blob["lastVoteTimestamp"]
        assert sc.sync_state(blob, _blob()) == sc.SYNC_IN_SYNC


# --------------------------------------------------------------------------- #
# classify_pair — one zid's three-table verdict.
# --------------------------------------------------------------------------- #
class TestClassifyPair:
    ENVS = ("prod", "python")

    def test_identical_in_sync_pair_matches(self):
        v = sc.classify_pair(1, _matching_pair(), self.ENVS)
        assert v["verdict"] == sc.VERDICT_MATCH
        assert v["tables"]["math_main"]["match"] is True
        assert v["tables"]["math_bidtopid"]["match"] is True
        assert v["tables"]["math_ptptstats"]["match"] is True

    def test_in_sync_math_main_divergence(self):
        pair = _pair(
            _blob(comp0=1.0), _blob(comp0=5.0),
            bid_a=_bidtopid(), bid_b=_bidtopid(),
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_DIVERGE
        assert v["tables"]["math_main"]["match"] is False
        assert v["tables"]["math_main"]["n_divergences"] > 0

    def test_large_conv_divergence_is_expected_q10(self):
        pair = _pair(
            _blob(n=20_000, comp0=1.0), _blob(n=20_000, comp0=5.0),
            bid_a=_bidtopid(), bid_b=_bidtopid(),
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_LARGE_CONV_Q10
        assert v["large_conv"] is True

    def test_large_conv_match_is_still_match(self):
        pair = _pair(
            _blob(n=20_000), _blob(n=20_000),
            bid_a=_bidtopid(), bid_b=_bidtopid(),
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_MATCH

    def test_bidtopid_divergence_diverges(self):
        pair = _pair(
            _blob(), _blob(),
            bid_a=_bidtopid([[1], [2, 3]]), bid_b=_bidtopid([[1, 2], [3]]),
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_DIVERGE
        assert v["tables"]["math_bidtopid"]["match"] is False

    def test_bidtopid_pid_str_int_normalization_still_matches(self):
        pair = _pair(
            _blob(), _blob(),
            bid_a=_bidtopid([[1], [2, 3]]),
            bid_b={"zid": 1, "bidToPid": [["1"], ["3", "2"]]},
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_MATCH

    def test_missing_python_math_main_row(self):
        v = sc.classify_pair(1, _pair(_blob(), None), self.ENVS)
        assert v["verdict"] == sc.VERDICT_MISSING
        assert v["missing"] == ["python"]

    def test_out_of_sync_pair_skips_table_compare(self):
        pair = _pair(_blob(votes={"1": 9}), _blob(votes={"1": 5}))
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_OUT_OF_SYNC
        assert "tables" not in v
        assert v["votes"] == {"prod": 9, "python": 5}

    def test_not_ready_pair(self):
        blob = _blob()
        del blob["user-vote-counts"]
        v = sc.classify_pair(1, _pair(blob, _blob()), self.ENVS)
        assert v["verdict"] == sc.VERDICT_NOT_READY

    def test_missing_side_table_is_partial_not_diverge(self):
        pair = _pair(
            _blob(), _blob(),
            bid_a=_bidtopid(), bid_b=None,
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_PARTIAL
        assert v["tables"]["math_bidtopid"]["match"] is None
        assert v["tables"]["math_bidtopid"]["missing"] == ["python"]

    def test_ticks_and_votes_reported_on_judged_pairs(self):
        v = sc.classify_pair(1, _matching_pair(tick_a=45, tick_b=44), self.ENVS)
        assert v["ticks"]["prod"]["caching_tick"] == 45
        assert v["ticks"]["python"]["caching_tick"] == 44
        assert v["votes"] == {"prod": 3, "python": 3}

    def test_both_math_main_rows_missing(self):
        v = sc.classify_pair(1, _pair(None, None), self.ENVS)
        assert v["verdict"] == sc.VERDICT_MISSING
        assert v["missing"] == ["prod", "python"]

    def test_malformed_data_column_is_not_ready_not_crash(self):
        pair = _pair(_blob(), _blob())
        main_a, main_b = pair["math_main"]
        main_b = dict(main_b)
        main_b["data"] = None  # NULL jsonb / dirty live data
        pair["math_main"] = (main_a, main_b)
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_NOT_READY
        assert v["reason"] == "malformed-data"
        assert v["malformed"] == ["python"]

    def test_torn_side_table_is_not_ready(self):
        """A side table one write-cycle behind its own env's math_main
        (independent SELECTs, no snapshot) must retry, not false-diverge."""
        pair = _matching_pair(tick_a=2, tick_b=2)
        bid_a, bid_b = pair["math_bidtopid"]
        stale = dict(bid_b)
        stale["math_tick"] = 1
        pair["math_bidtopid"] = (bid_a, stale)
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_NOT_READY
        assert v["reason"] == "torn-read"
        assert v["torn"] == [
            {"env": "python", "table": "math_bidtopid", "math_tick": 1, "main_tick": 2}
        ]

    def test_ptptstats_divergence_diverges(self):
        pair = _pair(
            _blob(), _blob(),
            bid_a=_bidtopid(), bid_b=_bidtopid(),
            ppt_a=_ptptstats([0.5, 0.6]), ppt_b=_ptptstats([0.9, 0.1]),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_DIVERGE
        assert v["tables"]["math_ptptstats"]["match"] is False

    def test_large_conv_side_table_only_divergence_is_not_excused(self):
        """Q10 can only explain a math_main divergence — a side-table-only
        divergence on a large conv is a genuine defect."""
        pair = _pair(
            _blob(n=20_000), _blob(n=20_000),
            bid_a=_bidtopid([[1], [2, 3]]), bid_b=_bidtopid([[1, 2], [3]]),
            ppt_a=_ptptstats(), ppt_b=_ptptstats(),
        )
        v = sc.classify_pair(1, pair, self.ENVS)
        assert v["verdict"] == sc.VERDICT_DIVERGE


# --------------------------------------------------------------------------- #
# aggregate — exit-code semantics gate Step #2 (runbook: shadow exit
# checklist). Only UNEXPECTED divergence fails; out-of-sync / not-ready /
# large-conv-Q10 never do; --min-matches makes the "spot-compare N active
# zids" checklist item mechanically checkable.
# --------------------------------------------------------------------------- #
class TestAggregate:
    def _verdict(self, verdict: str, zid: int = 1) -> dict[str, Any]:
        return {"zid": zid, "verdict": verdict}

    def test_all_match_exits_zero(self):
        summary = sc.aggregate([self._verdict(sc.VERDICT_MATCH)])
        assert summary["exit_code"] == 0
        assert summary["counts"] == {sc.VERDICT_MATCH: 1}

    def test_any_diverge_exits_one(self):
        summary = sc.aggregate(
            [self._verdict(sc.VERDICT_MATCH), self._verdict(sc.VERDICT_DIVERGE, 2)]
        )
        assert summary["exit_code"] == 1

    def test_expected_families_do_not_fail(self):
        summary = sc.aggregate([
            self._verdict(sc.VERDICT_MATCH),
            self._verdict(sc.VERDICT_LARGE_CONV_Q10, 2),
            self._verdict(sc.VERDICT_OUT_OF_SYNC, 3),
            self._verdict(sc.VERDICT_NOT_READY, 4),
            self._verdict(sc.VERDICT_PARTIAL, 5),
            self._verdict(sc.VERDICT_MISSING, 6),
        ])
        assert summary["exit_code"] == 0

    def test_min_matches_unmet_exits_two(self):
        summary = sc.aggregate(
            [self._verdict(sc.VERDICT_MATCH), self._verdict(sc.VERDICT_OUT_OF_SYNC, 2)],
            min_matches=2,
        )
        assert summary["exit_code"] == 2

    def test_diverge_beats_min_matches(self):
        summary = sc.aggregate(
            [self._verdict(sc.VERDICT_DIVERGE)], min_matches=5,
        )
        assert summary["exit_code"] == 1

    def test_no_zids_with_min_matches_exits_two(self):
        """Day-zero soak state: nothing to compare yet is NOT a pass."""
        summary = sc.aggregate([], min_matches=1)
        assert summary["exit_code"] == 2
        assert summary["n_zids"] == 0


# --------------------------------------------------------------------------- #
# run — orchestration over a live connection (faked here).
# --------------------------------------------------------------------------- #
class TestRun:
    def _conn_for(self, zid: int) -> _PairConn:
        rows = {}
        for table, data in (
            ("math_main", _blob()),
            ("math_bidtopid", _bidtopid()),
            ("math_ptptstats", _ptptstats()),
        ):
            for env in ("prod", "python"):
                row = _row(data, env=env)
                row["zid"] = zid
                rows[(table, zid, env)] = row
        return _PairConn(rows, discover_rows=[{"zid": zid}])

    def test_run_with_explicit_zids(self):
        report = sc.run(self._conn_for(7), zids=[7])
        assert [v["zid"] for v in report["verdicts"]] == [7]
        assert report["verdicts"][0]["verdict"] == sc.VERDICT_MATCH
        assert report["summary"]["exit_code"] == 0
        assert report["math_envs"] == ["prod", "python"]

    def test_run_discovers_zids_when_not_given(self):
        report = sc.run(self._conn_for(7))
        assert [v["zid"] for v in report["verdicts"]] == [7]

    def test_run_missing_pair_row(self):
        conn = self._conn_for(7)
        del conn.rows[("math_main", 7, "python")]
        report = sc.run(conn, zids=[7])
        assert report["verdicts"][0]["verdict"] == sc.VERDICT_MISSING
        assert report["summary"]["exit_code"] == 0  # missing != diverge

    def test_run_custom_envs(self):
        rows = {}
        for table, data in (
            ("math_main", _blob()),
            ("math_bidtopid", _bidtopid()),
            ("math_ptptstats", _ptptstats()),
        ):
            for env in ("clj-ref", "py-shadow"):
                rows[(table, 3, env)] = _row(data, env=env)
        report = sc.run(
            _PairConn(rows), zids=[3], math_envs=("clj-ref", "py-shadow"),
        )
        assert report["verdicts"][0]["verdict"] == sc.VERDICT_MATCH


# --------------------------------------------------------------------------- #
# discover_zids — most-recently-modified first, either env qualifies.
# --------------------------------------------------------------------------- #
class TestDiscoverZids:
    def test_returns_zids_in_query_order(self):
        conn = _PairConn({}, discover_rows=[{"zid": 5}, {"zid": 3}])
        assert sc.discover_zids(conn, ("prod", "python")) == [5, 3]

    def test_limit_is_forwarded(self):
        conn = _PairConn({}, discover_rows=[{"zid": 5}])
        sc.discover_zids(conn, ("prod", "python"), limit=10)
        text, params = conn.calls[-1]
        assert "LIMIT" in text.upper()
        assert params.get("limit") == 10


# --------------------------------------------------------------------------- #
# render_lines — human-readable soak report.
# --------------------------------------------------------------------------- #
class TestRenderLines:
    def test_lines_carry_verdicts_and_summary(self):
        report = sc.run(TestRun()._conn_for(7), zids=[7])
        lines = sc.render_lines(report)
        joined = "\n".join(lines)
        assert "zid 7" in joined
        assert "MATCH" in joined.upper()
        assert "exit 0" in joined

    def test_diverge_and_q10_lines(self):
        envs = ("prod", "python")
        diverge = sc.classify_pair(
            1,
            _pair(_blob(comp0=1.0), _blob(comp0=5.0),
                  bid_a=_bidtopid(), bid_b=_bidtopid(),
                  ppt_a=_ptptstats(), ppt_b=_ptptstats()),
            envs,
        )
        q10 = sc.classify_pair(
            2,
            _pair(_blob(n=20_000, comp0=1.0), _blob(n=20_000, comp0=5.0),
                  bid_a=_bidtopid(), bid_b=_bidtopid(),
                  ppt_a=_ptptstats(), ppt_b=_ptptstats()),
            envs,
        )
        report = {
            "math_envs": list(envs),
            "verdicts": [diverge, q10],
            "summary": sc.aggregate([diverge, q10]),
        }
        joined = "\n".join(sc.render_lines(report))
        assert "divergences" in joined
        assert "EXPECTED" in joined  # the Q10 suffix
        assert "exit 1" in joined

    def test_max_lines_truncation(self):
        verdicts = [{"zid": z, "verdict": sc.VERDICT_MISSING, "missing": ["python"]}
                    for z in range(5)]
        report = {
            "math_envs": ["prod", "python"],
            "verdicts": verdicts,
            "summary": sc.aggregate(verdicts),
        }
        lines = sc.render_lines(report, max_lines=2)
        joined = "\n".join(lines)
        assert "3 more zids" in joined


class TestCli:
    def _load_cli(self):
        import importlib.util

        path = Path(__file__).resolve().parents[2] / "scripts" / "shadow_compare.py"
        spec = importlib.util.spec_from_file_location("shadow_compare_cli", path)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_bad_zids_is_a_usage_error(self):
        from click.testing import CliRunner

        mod = self._load_cli()
        res = CliRunner().invoke(
            mod.main, ["--database-url", "postgresql://x/y", "--zids", "1,abc"]
        )
        assert res.exit_code == 2
        assert "--zids" in res.output

    def test_cli_passes_options_through_and_writes_json(self, monkeypatch, tmp_path):
        from click.testing import CliRunner

        mod = self._load_cli()

        class _Eng:
            def connect(self):
                return self

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        seen: dict[str, Any] = {}

        def fake_run(conn, **kwargs):
            seen.update(kwargs)
            return {
                "math_envs": ["prod", "python"],
                "verdicts": [],
                "summary": {"counts": {}, "n_zids": 0, "n_matches": 0,
                            "min_matches": 0, "exit_code": 0},
            }

        monkeypatch.setattr(mod.sa, "create_engine", lambda url: _Eng())
        monkeypatch.setattr(mod.sc, "run", fake_run)
        out = tmp_path / "report.json"
        res = CliRunner().invoke(
            mod.main,
            ["--database-url", "postgresql://x/y", "--zids", "5,7",
             "--min-matches", "3", "--json-out", str(out)],
        )
        assert res.exit_code == 0
        assert seen["zids"] == [5, 7]
        assert seen["min_matches"] == 3
        assert out.exists()
