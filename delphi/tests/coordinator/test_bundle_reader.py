"""CO08 / O1 witness: the immutable whole-Bundle read serves one generation exactly.

The server reader that exists today reads each math table separately — `getPca`
reads `math_main`, `getBidIndexToPidMapping` reads `math_bidtopid`, and
`getPidsForGid` joins them by calling both (via `Promise.all`, so concurrently)
(server/src/utils/pca.ts, participants.ts). Nothing binds the two reads to one
generation, so a publication that commits between them is served as an OLD main
with a NEW mapping. This is O1's "old-main/new-mapping" hazard.

`coordinator-rs/tools/bundle_reader.cjs` is a candidate `loadBundle`: it reads
main + bidtopid + ptptstats + the math_ticks checkpoint inside one
`REPEATABLE READ READ ONLY` snapshot, derives the mapping purely from the
Bundle's own rows, and refuses admission when a companion is missing or at a
different generation. The tests below assert the reader returns the snapshot
generation's **exact** participant mapping — not merely a non-empty one — using an
independent Python re-derivation over the published blobs as the oracle, so a
reader that fabricates pids (e.g. returns a public-fixture pid for every group) fails.

Attribution, stated honestly:
- The "torn baseline" here is a copied SQL-shaped autocommit model on one client
  (`bundle_reader.cjs` mode "torn"), NOT a call through the real `getPca` /
  `getBidIndexToPidMapping`. The real `getPidsForGid` dispatches its two reads via
  `Promise.all`; independent statement snapshots still permit the race, so the
  model demonstrates the hazard but is not the real reader. The retained
  real-module byte-equality witness lives in `test_node_reader.py`, run separately.
- This candidate reader is not the production `server/src` rewrite. The production
  `loadBundle`, its bounded whole-Bundle cache, request-context propagation through
  getPidsForGid/doFamousQuery/report.ts, and the comment-owned empty presentation
  are the remaining, still-open S2 obligations (dispatched separately); only the
  combined full-app and private campaigns are S5. O1 stays PARTIAL/open.
"""
import json
import os
import subprocess
import time

from coordinator.conftest import ROOT, connect, rows, seed
from coordinator._node_gate import require_node

HARNESS = ROOT / "coordinator-rs/tools/bundle_reader.cjs"
EVIDENCE = ROOT / "coordinator-rs/evidence"
GIDS = (0, 1)
GKEYS = [str(g) for g in GIDS]


def bundle_run(db, mode="bundle", zid=1, env="rustproto", gids=GIDS):
    spec = {"mode": mode, "zid": zid, "env": env, "gids": list(gids)}
    result = subprocess.run(
        ["node", str(HARNESS), json.dumps(spec)],
        env=dict(os.environ, DATABASE_URL=db, MATH_ENV=env, NODE_ENV="test"),
        cwd=ROOT / "server", capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, (result.stdout, result.stderr)
    return json.loads(result.stdout)


def expected_pids_for_gid(db, env="rustproto", gids=GIDS):
    """Independent oracle: re-derive per-group pids in Python from the published
    math_main and math_bidtopid blobs. A reader that fabricates pids disagrees
    with this, so an exact comparison against it is discriminating."""
    t = rows(db, env=env)
    main, bid = t["math_main"]["data"], t["math_bidtopid"]["data"]
    index_to_bid = main["base-clusters"]["id"]
    bid_to_index = {b: i for i, b in enumerate(index_to_bid)}
    index_to_pids = bid["bidToPid"]
    clusters = main["group-clusters"]
    out = {}
    for gid in gids:
        acc = []
        if gid < len(clusters):
            for member_bid in clusters[gid]["members"]:
                more = index_to_pids[bid_to_index[member_bid]] if index_to_pids else None
                if more:
                    acc.extend(more)
        out[str(gid)] = sorted(int(x) for x in acc)
    return out


def add_vote(db, created, pid=0, tid=0, vote=1):
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,%s,%s,%s,%s)",
                    (pid, tid, vote, created))
    c.close()


def add_participant_like(db, new_pid, model_pid, n_cmts=4):
    """Add a participant whose votes copy an existing one, so it clusters with it
    and the published mapping genuinely changes."""
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("SET session_replication_role=replica")
        cur.execute("INSERT INTO participants(zid,pid,uid,mod) VALUES(1,%s,%s,0)",
                    (new_pid, 100000 + new_pid))
        for tid in range(n_cmts):
            value = [-1, 1, 0][(model_pid + tid) % 3]
            cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,%s,%s,%s,%s)",
                        (new_pid, tid, value, 5000 + new_pid * n_cmts + tid))
    c.close()


def fabricate_foreign_mapping(db, env, zid=1):
    """Write a bidtopid row for the same zid in a DIFFERENT env whose mapping is
    all-999, so a wrong-namespace leak would show up as fabricated pids."""
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("SELECT data, math_tick FROM math_bidtopid WHERE zid=%s AND math_env='rustproto'", (zid,))
        data, tick = cur.fetchone()
        data = dict(data)
        data["bidToPid"] = [[999] for _ in data["bidToPid"]]
        cur.execute(
            "INSERT INTO math_bidtopid(zid,math_env,data,math_tick) VALUES(%s,%s,%s,%s) "
            "ON CONFLICT(zid,math_env) DO UPDATE SET data=EXCLUDED.data, math_tick=EXCLUDED.math_tick",
            (zid, env, json.dumps(data), tick))
    c.close()


def interleaved_bundle(db, launch, tmp_path, publish, mode="bundle", env="rustproto", gids=GIDS):
    """Start the reader, let it read main and pause, run `publish()` while it is
    paused, then release it. Returns the reader's result."""
    reached, release = tmp_path / f"{mode}.reached", tmp_path / f"{mode}.release"
    for p in (reached, release):
        if p.exists():
            p.unlink()
    spec = {"mode": mode, "zid": 1, "env": env, "gids": list(gids),
            "pause": {"reached": str(reached), "release": str(release), "timeout_ms": 150000}}
    proc = subprocess.Popen(
        ["node", str(HARNESS), json.dumps(spec)],
        env=dict(os.environ, DATABASE_URL=db, MATH_ENV=env, NODE_ENV="test"),
        cwd=ROOT / "server", stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and not reached.exists():
        assert proc.poll() is None, proc.communicate()
        time.sleep(0.02)
    assert reached.exists(), "the reader never paused after reading main"
    publish()  # a real publication lands while the reader is paused between reads
    release.write_text("go")
    out, err = proc.communicate(timeout=150)
    assert proc.returncode == 0, (out, err)
    return json.loads(out)


def test_loadbundle_serves_the_exact_snapshot_generation(db, launch, tmp_path):
    require_node()
    seed(db)
    launch(db).done()  # generation A on rustproto
    a_tick = rows(db)["math_main"]["math_tick"]
    expected_a = expected_pids_for_gid(db)
    a_reader = bundle_run(db)
    a_map_sha = a_reader["mapping_sha256"]

    # A's mapping is the fixture's real participants (0..5), never fabricated, and
    # the reader returns EXACTLY it (a reader that returned [999] would fail here).
    a_pids = sorted({p for v in expected_a.values() for p in v})
    assert a_pids and set(a_pids) <= set(range(6)), expected_a
    assert a_reader["pids_for_gid"] == expected_a, (a_reader["pids_for_gid"], expected_a)

    # Make B genuinely different from A: a seventh participant that clusters in.
    add_participant_like(db, new_pid=6, model_pid=0)

    # Snapshot A, publish B while the reader is paused, resume: the whole Bundle
    # must be exactly A — same generation across all four rows, and A's exact
    # mapping, not the B the interleave committed.
    bundle = interleaved_bundle(db, launch, tmp_path, publish=lambda: launch(db).done())
    assert bundle["admission"] == "ok" and bundle["coherent"] is True, bundle
    assert bundle["math_tick"] == a_tick, (bundle, a_tick)
    assert len({bundle["main_tick"], bundle["bidtopid_tick"],
                bundle["ptptstats_tick"], bundle["ticks_tick"]}) == 1, bundle
    assert bundle["pids_for_gid"] == expected_a, (bundle["pids_for_gid"], expected_a)
    assert bundle["mapping_sha256"] == a_map_sha, bundle

    # B is now current and is genuinely different from A; the reader returns B's
    # exact mapping on a fresh read, and B includes participant 6, A does not.
    b_tick = rows(db)["math_main"]["math_tick"]
    assert b_tick == a_tick + 1
    expected_b = expected_pids_for_gid(db)
    b_reader = bundle_run(db)
    assert b_reader["pids_for_gid"] == expected_b, (b_reader["pids_for_gid"], expected_b)
    assert b_reader["mapping_sha256"] != a_map_sha, "A and B must be distinguishable"
    assert expected_b != expected_a, "the new participant must change the published mapping"
    b_pids = sorted({p for v in expected_b.values() for p in v})
    assert 6 in b_pids and 6 not in a_pids, (a_pids, b_pids)

    # Wrong-namespace companion: an all-999 bidtopid for the same zid in another
    # env must never leak into a rustproto read.
    fabricate_foreign_mapping(db, env="negative")
    scoped = bundle_run(db, env="rustproto")
    assert scoped["pids_for_gid"] == expected_b, scoped

    (EVIDENCE / "d4-bundle-reader.json").write_text(json.dumps({
        "profile": "real Node runtime, bundle_reader.cjs loadBundle, one publish interleaved "
                   "between the reader's first and later reads, one test PostgreSQL",
        "generation_a_tick": a_tick, "generation_b_tick": b_tick,
        "expected_pids_for_gid_a": expected_a, "expected_pids_for_gid_b": expected_b,
        "snapshot_under_interleave_returned": bundle["pids_for_gid"],
        "snapshot_equals_a_exactly": bundle["pids_for_gid"] == expected_a,
        "snapshot_mapping_sha256_equals_a": bundle["mapping_sha256"] == a_map_sha,
        "later_read_returned": b_reader["pids_for_gid"],
        "later_read_equals_b_exactly": b_reader["pids_for_gid"] == expected_b,
        "a_and_b_distinguishable": b_reader["mapping_sha256"] != a_map_sha and expected_b != expected_a,
        "wrong_namespace_rustproto_unaffected": scoped["pids_for_gid"] == expected_b,
    }, indent=2, sort_keys=True))


def test_loadbundle_torn_baseline_and_admission(db, launch, tmp_path):
    """The copied-SQL torn model (not the real reader), and the admission refusals.

    `bundle_reader.cjs` mode "torn" is a copied SQL-shaped autocommit model on one
    client, shown here only to reproduce the old-main/new-mapping race; the real
    reader equality is in test_node_reader.py.
    """
    require_node()
    seed(db)
    launch(db).done()

    # The separate-read model tears: main at N, a publish commits N+1, and the
    # mapping read then observes N+1.
    before = rows(db)["math_main"]["math_tick"]

    def publish_next():
        add_vote(db, created=2000)
        launch(db).done()

    torn = interleaved_bundle(db, launch, tmp_path, mode="torn", publish=publish_next)
    assert torn["present"] and torn["torn"] is True, torn
    assert torn["main_tick"] == before and torn["bidtopid_tick"] == before + 1, torn

    # Missing companion fails admission; a valid replacement is observed once the
    # coordinator republishes from source (no new input required).
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("DELETE FROM math_bidtopid WHERE zid=1 AND math_env='rustproto'")
    c.close()
    missing = bundle_run(db)
    assert missing["present"] and missing["admission"] == "REFUSED", missing
    assert "math_bidtopid" in missing["reason"], missing
    launch(db, extra={"P026_INCREMENTAL": "0"}).done()
    repaired = bundle_run(db)
    assert repaired["admission"] == "ok" and repaired["coherent"] is True, repaired

    # A tick-mismatched companion fails admission: never served torn from the store.
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("UPDATE math_ptptstats SET math_tick=math_tick+7 WHERE zid=1 AND math_env='rustproto'")
    c.close()
    mismatched = bundle_run(db)
    assert mismatched["admission"] == "REFUSED" and "math_ptptstats" in mismatched["reason"], mismatched


def test_loadbundle_is_scoped_by_math_env(db, launch):
    require_node()
    seed(db)
    launch(db).done()  # rustproto only
    assert bundle_run(db, env="reader")["present"] is False
    served = bundle_run(db, env="rustproto")
    assert served["present"] and served["admission"] == "ok" and served["coherent"] is True, served
