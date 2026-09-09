"""CO08 / O1 witness: the immutable whole-Bundle read closes the torn read.

The server reader that exists today reads each math table separately — `getPca`
reads `math_main`, `getBidIndexToPidMapping` reads `math_bidtopid`, and
`getPidsForGid` joins them by calling both in turn (server/src/utils/pca.ts,
participants.ts). Nothing binds the two reads to one generation, so a publication
that commits between them is served as an OLD main with a NEW mapping. This is
O1's "old-main/new-mapping" hazard.

`coordinator-rs/tools/bundle_reader.cjs` is a candidate `loadBundle`: it reads
main + bidtopid + ptptstats + the math_ticks checkpoint inside one
`REPEATABLE READ READ ONLY` snapshot, derives the mapping purely from the
Bundle's own rows, and refuses admission when a companion is missing or at a
different generation. Both readers run in the real Node runtime against the same
test PostgreSQL, one publish interleaved between the reader's first and later
reads, so the property is demonstrated rather than asserted.

Scope, stated honestly: this candidate reader is not the production
`server/src` rewrite. Threading a request-scoped Bundle through
getPidsForGid/doFamousQuery/report.ts, a bounded whole-Bundle cache in the
server, and full application boot remain O1/S5 obligations. This is the witness
that the Bundle contract closes the torn read the existing reader allows.
"""
import json
import os
import subprocess
import time

import pytest

from coordinator.conftest import ROOT, connect, rows, seed
from coordinator._node_gate import require_node

HARNESS = ROOT / "coordinator-rs/tools/bundle_reader.cjs"
EVIDENCE = ROOT / "coordinator-rs/evidence"


def bundle_run(db, mode="bundle", zid=1, env="rustproto", gids=(0, 1)):
    """One reader invocation with no pause."""
    spec = {"mode": mode, "zid": zid, "env": env, "gids": list(gids)}
    result = subprocess.run(
        ["node", str(HARNESS), json.dumps(spec)],
        env=dict(os.environ, DATABASE_URL=db, MATH_ENV=env, NODE_ENV="test"),
        cwd=ROOT / "server", capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, (result.stdout, result.stderr)
    return json.loads(result.stdout)


def _add_vote(db, created):
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,%s)", (created,))
    c.close()


def interleaved(db, launch, tmp_path, mode, created, env="rustproto", gids=(0, 1)):
    """Start the reader, let it read main and pause, publish the next generation
    while it is paused, then release it. Returns the reader's result."""
    reached = tmp_path / f"{mode}.reached"
    release = tmp_path / f"{mode}.release"
    for p in (reached, release):
        if p.exists():
            p.unlink()
    spec = {"mode": mode, "zid": 1, "env": env, "gids": list(gids),
            "pause": {"reached": str(reached), "release": str(release), "timeout_ms": 150000}}
    proc = subprocess.Popen(
        ["node", str(HARNESS), json.dumps(spec)],
        env=dict(os.environ, DATABASE_URL=db, MATH_ENV=env, NODE_ENV="test"),
        cwd=ROOT / "server", stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and not reached.exists():
        assert proc.poll() is None, proc.communicate()
        time.sleep(0.02)
    assert reached.exists(), "the reader never paused after reading main"
    # A real publication lands while the reader is paused between its reads.
    _add_vote(db, created)
    launch(db).done()
    release.write_text("go")
    out, err = proc.communicate(timeout=150)
    assert proc.returncode == 0, (out, err)
    return json.loads(out)


def test_loadbundle_closes_the_torn_read_the_server_reader_allows(db, launch, tmp_path):
    require_node()
    seed(db)
    launch(db).done()  # generation published to rustproto

    evidence = {"profile": "real Node runtime, bundle_reader.cjs, one publish interleaved "
                           "between the reader's first and later reads, one test PostgreSQL"}

    # (1) The separate-read path tears: main is read at generation N, a publish
    # commits generation N+1, and the mapping read then observes N+1.
    before_torn = rows(db)["math_main"]["math_tick"]
    torn = interleaved(db, launch, tmp_path, mode="torn", created=2000)
    assert torn["present"] and torn["torn"] is True, torn
    assert torn["main_tick"] == before_torn
    assert torn["bidtopid_tick"] == before_torn + 1
    evidence["separate_read_path"] = torn

    # (2) loadBundle under the SAME interleave stays coherent: every field is the
    # generation open when the snapshot began, and the concurrent publish is not
    # mixed in. A later read sees that newer generation.
    before_bundle = rows(db)["math_main"]["math_tick"]
    bundle = interleaved(db, launch, tmp_path, mode="bundle", created=3000)
    assert bundle["admission"] == "ok" and bundle["coherent"] is True, bundle
    assert bundle["math_tick"] == before_bundle, (bundle, before_bundle)
    assert len({bundle["main_tick"], bundle["bidtopid_tick"],
                bundle["ptptstats_tick"], bundle["ticks_tick"]}) == 1, bundle
    assert rows(db)["math_main"]["math_tick"] == before_bundle + 1
    # The mapping accessor is pure and non-empty: at least one group maps to pids.
    assert any(v for v in bundle["pids_for_gid"].values()), bundle["pids_for_gid"]
    evidence["load_bundle"] = bundle

    # (3) Missing companion fails admission, and a valid replacement is observed
    # once the coordinator republishes from source (no new input required).
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("DELETE FROM math_bidtopid WHERE zid=1 AND math_env='rustproto'")
    c.close()
    missing = bundle_run(db)
    assert missing["present"] and missing["admission"] == "REFUSED", missing
    assert "math_bidtopid" in missing["reason"], missing
    launch(db, extra={"P026_INCREMENTAL": "0"}).done()  # repair from the full source prefix
    repaired = bundle_run(db)
    assert repaired["admission"] == "ok" and repaired["coherent"] is True, repaired
    evidence["missing_companion_refused"] = missing
    evidence["repaired_after_republish"] = {k: repaired[k] for k in ("admission", "coherent", "math_tick")}

    # (4) A tick-mismatched companion fails admission — the Bundle is never served
    # torn even from persisted rows.
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("UPDATE math_ptptstats SET math_tick=math_tick+7 WHERE zid=1 AND math_env='rustproto'")
    c.close()
    mismatched = bundle_run(db)
    assert mismatched["admission"] == "REFUSED" and "math_ptptstats" in mismatched["reason"], mismatched
    evidence["mismatched_companion_refused"] = mismatched

    (EVIDENCE / "d4-bundle-reader.json").write_text(json.dumps(evidence, indent=2, sort_keys=True))


def test_loadbundle_is_scoped_by_math_env(db, launch):
    require_node()
    seed(db)
    launch(db).done()  # rustproto only
    # A namespace with no rows for this zid returns nothing rather than another
    # env's Bundle: the reads are scoped by math_env.
    assert bundle_run(db, env="reader")["present"] is False
    served = bundle_run(db, env="rustproto")
    assert served["present"] and served["admission"] == "ok" and served["coherent"] is True, served
