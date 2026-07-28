"""Live shadow-soak comparer for the Clojure→Python math cutover (Step #1).

Compares math rows between two live math_envs in the SAME database — the
Clojure engine's rows (``math_env='prod'``) vs the Python poller's shadow
rows (``math_env='python'``) — using the same acceptance surface as the
certify battery and the poller-equivalence harness:

- ``math_main``      → certify's acceptance-projecting comparer
  (:func:`polismath.replay.certify._acceptance_projecting_comparer` —
  subgroup-* excluded per Q7, structural identity + declared float
  tolerances);
- ``math_bidtopid``  → EXACT (:func:`polismath.replay.poller_equiv.compare_bidtopid`,
  modulo the documented pid int/str normalization);
- ``math_ptptstats`` → structural + tolerant
  (:func:`polismath.replay.poller_equiv._ptptstats_comparer`).

Unlike the replay harness there is NO batch gating: the two engines poll the
live vote stream independently, so at any instant a zid's row pair may
reflect different vote watermarks. Pairs are only judged when IN SYNC (equal
:func:`polismath.replay.poller_equiv.blob_total_votes`); out-of-sync pairs
are reported and retried on the next run, never counted as divergence.

Large conversations — ``n`` > 10000 participants OR ``n-cmts`` > 5000
comments, the Clojure large-conv dispatch cutoffs (conversation.clj:784-815)
— are EXPECTED to diverge: Clojure's mini-batch PCA path is unseeded-random
there (Q10, CLOJURE_QUIRKS.md — not even self-consistent between two Clojure
runs), while Python runs deterministic full PCA at every size (documented
improvement, same blob shape). Their divergences classify as
``large-conv-q10`` and never fail the run (CUTOVER_RUNBOOK.md risk #2).

Exit-code semantics (this is the Step 2 gate — runbook "Shadow exit
checklist"): 0 = no unexpected divergence (and ``--min-matches`` satisfied);
1 = at least one UNEXPECTED divergence; 2 = clean but fewer full MATCH zids
than ``--min-matches`` demands (coverage not yet demonstrated — keep
soaking / re-run once engines sync). NOTE: click also exits 2 on a CLI
usage error — gate scripts must require exit 0, never distinguish 1 vs 2.

CLI wrapper: ``delphi/scripts/shadow_compare.py``.
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Mapping, Sequence

import sqlalchemy as sa

from polismath.replay import poller_equiv as pe
from polismath.replay.certify import _acceptance_projecting_comparer
from polismath.replay.stepcompare import StepComparer

# Clojure's large-conv dispatch cutoffs — STRICTLY-GREATER comparisons
# (conversation.clj:784-815: n-ptpts > 10000 OR n-cmts > 5000).
LARGE_CONV_PTPT_CUTOFF = 10_000
LARGE_CONV_CMT_CUTOFF = 5_000

TABLES = ("math_main", "math_bidtopid", "math_ptptstats")

SYNC_IN_SYNC = "in-sync"
SYNC_OUT_OF_SYNC = "out-of-sync"
SYNC_NOT_READY = "not-ready"

VERDICT_MATCH = "match"
VERDICT_DIVERGE = "diverge"
VERDICT_LARGE_CONV_Q10 = "large-conv-q10"
VERDICT_OUT_OF_SYNC = "out-of-sync"
VERDICT_NOT_READY = "not-ready"
VERDICT_MISSING = "missing"
VERDICT_PARTIAL = "partial"

# Verdicts that MAY fail a run (see aggregate); everything else is
# expected/transient and only ever reported.
_FAILING_VERDICTS = (VERDICT_DIVERGE,)

PairMap = Mapping[str, tuple[dict[str, Any] | None, dict[str, Any] | None]]


def is_large_conv(blob: Mapping[str, Any]) -> bool:
    """Q10 classification from the blob's own ``n``/``n-cmts`` keys.
    Missing/malformed keys count as small — a blob too degenerate to carry
    its size cannot be excused as a large conv."""
    n = blob.get("n")
    n_cmts = blob.get("n-cmts")
    return (isinstance(n, (int, float)) and n > LARGE_CONV_PTPT_CUTOFF) or (
        isinstance(n_cmts, (int, float)) and n_cmts > LARGE_CONV_CMT_CUTOFF
    )


def sync_state(blob_a: Mapping[str, Any], blob_b: Mapping[str, Any]) -> str:
    """Whether the two engines have processed the same cumulative vote set.
    ``blob_total_votes`` returns None when a blob can't be judged yet —
    treated as not-ready, never as zero (see its docstring).

    Equal totals alone can hide a REVOTE-only watermark delta (a revote
    overwrites its (pid, tid) cell, never inflating the total), which would
    surface as a false small-conv divergence. When BOTH blobs carry
    ``lastVoteTimestamp`` it must match too; if either omits it, vote-total
    equality remains the only (best-effort) signal."""
    va = pe.blob_total_votes(dict(blob_a))
    vb = pe.blob_total_votes(dict(blob_b))
    if va is None or vb is None:
        return SYNC_NOT_READY
    if va != vb:
        return SYNC_OUT_OF_SYNC
    la = blob_a.get("lastVoteTimestamp")
    lb = blob_b.get("lastVoteTimestamp")
    if la is not None and lb is not None and la != lb:
        return SYNC_OUT_OF_SYNC
    return SYNC_IN_SYNC


def _tick_summary(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "caching_tick": row.get("caching_tick"),
        "math_tick": row.get("math_tick"),
        "last_vote_timestamp": row.get("last_vote_timestamp"),
        "modified": row.get("modified"),
    }


def classify_pair(
    zid: int,
    pair: PairMap,
    math_envs: tuple[str, str],
    *,
    math_main_comparer: StepComparer | None = None,
    ptptstats_comparer: StepComparer | None = None,
) -> dict[str, Any]:
    """One zid's verdict over the three math tables (same table semantics as
    :func:`polismath.replay.poller_equiv.compare_batch`, applied to live row
    pairs instead of snapshot stores)."""
    env_a, env_b = math_envs
    main_a, main_b = pair.get("math_main", (None, None))
    if main_a is None or main_b is None:
        return {
            "zid": zid,
            "verdict": VERDICT_MISSING,
            "missing": [e for e, r in ((env_a, main_a), (env_b, main_b)) if r is None],
        }

    blob_a, blob_b = main_a.get("data"), main_b.get("data")
    if not isinstance(blob_a, Mapping) or not isinstance(blob_b, Mapping):
        # Dirty live data (NULL / non-JSON-object column) must be survivable
        # — report and retry, never crash the soak tool.
        return {
            "zid": zid,
            "verdict": VERDICT_NOT_READY,
            "reason": "malformed-data",
            "malformed": [
                e for e, b in ((env_a, blob_a), (env_b, blob_b))
                if not isinstance(b, Mapping)
            ],
        }

    torn = _torn_tables(pair, math_envs)
    if torn:
        # Each engine mints ONE math_tick per write cycle shared across the
        # three tables (math_writer.py write cycle; mirrors conv_man.clj) —
        # a side table on a different tick than its own env's math_main is
        # a torn read (the six SELECTs are not one snapshot): retry, don't
        # false-diverge.
        return {
            "zid": zid,
            "verdict": VERDICT_NOT_READY,
            "reason": "torn-read",
            "torn": torn,
        }

    base = {
        "zid": zid,
        "ticks": {env_a: _tick_summary(main_a), env_b: _tick_summary(main_b)},
        "votes": {
            env_a: pe.blob_total_votes(blob_a),
            env_b: pe.blob_total_votes(blob_b),
        },
    }

    state = sync_state(blob_a, blob_b)
    if state == SYNC_NOT_READY:
        return {**base, "verdict": VERDICT_NOT_READY}
    if state == SYNC_OUT_OF_SYNC:
        return {**base, "verdict": VERDICT_OUT_OF_SYNC}

    large = is_large_conv(blob_a) or is_large_conv(blob_b)
    tables: dict[str, Any] = {}

    main_cmp = math_main_comparer or _acceptance_projecting_comparer()
    step = main_cmp.compare_step(blob_a, blob_b, zid)
    tables["math_main"] = {
        "match": step["match"],
        "n_divergences": step["n_divergences"],
        "families": step["families"],
    }

    bid_a, bid_b = pair.get("math_bidtopid", (None, None))
    if bid_a is None or bid_b is None:
        tables["math_bidtopid"] = {
            "match": None,
            "reason": "missing-row",
            "missing": [e for e, r in ((env_a, bid_a), (env_b, bid_b)) if r is None],
        }
    else:
        cmp_bid = pe.compare_bidtopid(bid_a["data"], bid_b["data"])
        # Drop the (potentially huge) normalized payloads from the verdict;
        # a diverging soak run re-fetches them for debugging anyway.
        tables["math_bidtopid"] = {"match": cmp_bid["match"]}

    ppt_a, ppt_b = pair.get("math_ptptstats", (None, None))
    if ppt_a is None or ppt_b is None:
        tables["math_ptptstats"] = {
            "match": None,
            "reason": "missing-row",
            "missing": [e for e, r in ((env_a, ppt_a), (env_b, ppt_b)) if r is None],
        }
    else:
        cmp_ppt = ptptstats_comparer or pe._ptptstats_comparer()
        step_ppt = cmp_ppt.compare_step(ppt_a["data"], ppt_b["data"], zid)
        tables["math_ptptstats"] = {
            "match": step_ppt["match"],
            "n_divergences": step_ppt["n_divergences"],
            "families": step_ppt["families"],
        }

    diverged = any(t.get("match") is False for t in tables.values())
    partial = any(t.get("match") is None for t in tables.values())
    if diverged:
        # Q10 (unseeded-random clj mini-batch PCA) can only be the cause
        # when math_main ITSELF diverges — a side-table-only divergence on
        # a large conv is a genuine defect, never excused.
        main_diverged = tables["math_main"].get("match") is False
        verdict = VERDICT_LARGE_CONV_Q10 if (large and main_diverged) else VERDICT_DIVERGE
    elif partial:
        verdict = VERDICT_PARTIAL
    else:
        verdict = VERDICT_MATCH
    return {**base, "verdict": verdict, "large_conv": large, "tables": tables}


def _torn_tables(pair: PairMap, math_envs: tuple[str, str]) -> list[dict[str, Any]]:
    """Side tables whose ``math_tick`` disagrees with their own env's
    math_main row (both rows present and both ticks known)."""
    torn: list[dict[str, Any]] = []
    mains = pair.get("math_main", (None, None))
    for idx, env in enumerate(math_envs):
        main_row = mains[idx]
        main_tick = main_row.get("math_tick") if main_row is not None else None
        if main_tick is None:
            continue
        for table in ("math_bidtopid", "math_ptptstats"):
            row = pair.get(table, (None, None))[idx]
            tick = row.get("math_tick") if row is not None else None
            if tick is not None and tick != main_tick:
                torn.append(
                    {"env": env, "table": table, "math_tick": tick, "main_tick": main_tick}
                )
    return torn


def aggregate(
    verdicts: Sequence[Mapping[str, Any]], *, min_matches: int = 0
) -> dict[str, Any]:
    """Run summary + exit code. Only UNEXPECTED divergence (``diverge``)
    fails outright (exit 1). ``min_matches`` unmet — with no divergence —
    exits 2: the soak hasn't yet DEMONSTRATED coverage, which is different
    from having demonstrated a defect."""
    counts = Counter(v["verdict"] for v in verdicts)
    n_matches = counts.get(VERDICT_MATCH, 0)
    if any(counts.get(v) for v in _FAILING_VERDICTS):
        exit_code = 1
    elif n_matches < min_matches:
        exit_code = 2
    else:
        exit_code = 0
    return {
        "counts": dict(counts),
        "n_zids": len(verdicts),
        "n_matches": n_matches,
        "min_matches": min_matches,
        "exit_code": exit_code,
    }


def discover_zids(
    conn: Any, math_envs: tuple[str, str], *, limit: int | None = None
) -> list[int]:
    """zids carrying a math_main row in EITHER env (a row missing on one
    side is itself a finding — see ``classify_pair``'s missing verdict),
    most recently modified first."""
    text = (
        "SELECT zid, MAX(modified) AS last_modified FROM math_main "
        "WHERE math_env IN (:env_a, :env_b) "
        "GROUP BY zid ORDER BY last_modified DESC"
    )
    params: dict[str, Any] = {"env_a": math_envs[0], "env_b": math_envs[1]}
    if limit is not None:
        text += " LIMIT :limit"
        params["limit"] = limit
    result = conn.execute(sa.text(text), params)
    return [int(row["zid"]) for row in result.mappings().all()]


def fetch_pair(conn: Any, zid: int, math_envs: tuple[str, str]) -> dict[str, Any]:
    """The ``{table: (row_a, row_b)}`` mapping for one zid."""
    env_a, env_b = math_envs
    return {
        table: (
            pe.fetch_math_row(conn, table, zid, env_a),
            pe.fetch_math_row(conn, table, zid, env_b),
        )
        for table in TABLES
    }


def run(
    conn: Any,
    *,
    math_envs: tuple[str, str] = ("prod", "python"),
    zids: Sequence[int] | None = None,
    limit: int | None = 50,
    min_matches: int = 0,
) -> dict[str, Any]:
    """One soak-compare pass: discover (or take) zids, fetch each pair,
    classify, aggregate. Read-only — never writes to the database."""
    if zids is None:
        zids = discover_zids(conn, math_envs, limit=limit)
    verdicts = [
        classify_pair(zid, fetch_pair(conn, zid, math_envs), math_envs)
        for zid in zids
    ]
    return {
        "math_envs": list(math_envs),
        "verdicts": verdicts,
        "summary": aggregate(verdicts, min_matches=min_matches),
    }


def render_lines(report: Mapping[str, Any], *, max_lines: int = 200) -> list[str]:
    """Human-readable soak report (one line per zid + a summary line)."""
    env_a, env_b = report["math_envs"]
    lines: list[str] = []
    for v in report["verdicts"][:max_lines]:
        zid = v["zid"]
        verdict = v["verdict"].upper()
        if v["verdict"] == VERDICT_MISSING:
            lines.append(f"zid {zid}: {verdict} (no row for: {', '.join(v['missing'])})")
            continue
        votes = v.get("votes", {})
        ticks = v.get("ticks", {})
        detail = (
            f"votes {env_a}={votes.get(env_a)} {env_b}={votes.get(env_b)}, "
            f"caching_tick {env_a}={ticks.get(env_a, {}).get('caching_tick')} "
            f"{env_b}={ticks.get(env_b, {}).get('caching_tick')}"
        )
        if v["verdict"] in (VERDICT_DIVERGE, VERDICT_LARGE_CONV_Q10):
            n_div = sum(
                t.get("n_divergences", 0) or 0 for t in v.get("tables", {}).values()
            )
            suffix = " — EXPECTED (Q10 unseeded-random clj large-conv path)" if (
                v["verdict"] == VERDICT_LARGE_CONV_Q10
            ) else ""
            lines.append(f"zid {zid}: {verdict} ({n_div} divergences; {detail}){suffix}")
        else:
            lines.append(f"zid {zid}: {verdict} ({detail})")
    n_hidden = len(report["verdicts"]) - min(len(report["verdicts"]), max_lines)
    if n_hidden:
        lines.append(f"... {n_hidden} more zids (see --json-out for the full report)")
    s = report["summary"]
    counts = ", ".join(f"{k}={n}" for k, n in sorted(s["counts"].items())) or "no zids"
    lines.append(
        f"summary: {counts}; matches {s['n_matches']}/{s['min_matches']} required"
        f" -> exit {s['exit_code']}"
    )
    return lines
