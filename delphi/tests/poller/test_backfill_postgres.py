"""The pre-switch backfill (P-070) against a real Postgres.

Same database resolution as the other poller integration tests
(``require_polis_postgres``: the CI service, else a throwaway postgres:17 on an
ephemeral port). Every test uses its own source/target labels and its own zid
range, so the module can share a long-lived database.

Covered here: selection SQL (missing, incomplete including a missing
``math_ticks`` row, stale, coherent, target-only) and keyset order; the
running poller backfilling dormant, zero-vote and incomplete conversations
without touching its cache; the tie rule with two real transactions; a
failure inside the publication leaving nothing behind; live catch-up after a
backfill; and the aggregate verification SQL shipped in
``delphi/polismath/poller/backfill_verification.sql``.
"""

import threading
import time
import uuid
from pathlib import Path

import psycopg2
import pytest

from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration

DAY_MS = 24 * 60 * 60 * 1000
VERIFY_SQL = (Path(__file__).resolve().parents[2] / "polismath" / "poller"
              / "backfill_verification.sql")


@pytest.fixture(scope="module")
def pg_url():
    with require_polis_postgres() as url:
        yield url


@pytest.fixture
def labels():
    tag = uuid.uuid4().hex[:8]
    return f"bfsrc_{tag}", f"bftgt_{tag}"


@pytest.fixture
def db(pg_url):
    conn = psycopg2.connect(pg_url)
    conn.autocommit = True
    yield conn
    conn.close()


_zid_base = [8000 + (uuid.uuid4().int % 500) * 100]
_used_zids = []
_TABLES = ("votes", "votes_latest_unique", "comments", "participants", "math_main",
           "math_bidtopid", "math_ptptstats", "math_ticks", "conversations")


def fresh_zids(n):
    base = _zid_base[0]
    _zid_base[0] += 100
    zids = list(range(base, base + n))
    _used_zids.extend(zids)
    return zids


@pytest.fixture(autouse=True)
def _cleanup(db, labels):
    """Remove every row these tests wrote, so a shared database (the CI
    service) is left as found: a leftover recent vote would make other
    modules' pollers compute these zids."""
    yield
    for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks"):
        q(db, f"DELETE FROM {table} WHERE math_env = ANY(%s)", (list(labels),))
    zids = list(_used_zids)
    _used_zids.clear()
    if zids:
        q(db, "SET session_replication_role = replica")
        for table in _TABLES:
            q(db, f"DELETE FROM {table} WHERE zid = ANY(%s)", (zids,))
        q(db, "SET session_replication_role = DEFAULT")


def q(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchall() if cur.description else None


def seed_conversation(conn, zid, *, participants, comments, voters=None, votes=True,
                      created_ms=None):
    """A dormant conversation: rows are 30 days old (outside the poll window)."""
    created_ms = created_ms or int(time.time() * 1000) - 30 * DAY_MS
    voters = participants if voters is None else voters
    q(conn, "SET session_replication_role = replica")
    for table in _TABLES:
        q(conn, f"DELETE FROM {table} WHERE zid = %s", (zid,))
    q(conn, "INSERT INTO conversations (zid, participant_count) VALUES (%s, %s)",
      (zid, participants))
    for p in range(participants):
        q(conn, "INSERT INTO participants (pid, uid, zid, created, mod) "
                "VALUES (%s, %s, %s, %s, 0)", (p, 100000 + p, zid, created_ms))
    for t in range(comments):
        q(conn, "INSERT INTO comments (tid, zid, pid, uid, txt, mod, is_meta, created, "
                "modified) VALUES (%s, %s, 0, 100000, %s, 0, false, %s, %s)",
          (t, zid, f"c{t}", created_ms, created_ms))
    last = 0
    if votes:
        ts = created_ms
        for p in range(voters):
            for t in range(comments):
                if (p + t) % 3 == 0:
                    continue
                ts += 1
                raw = -1 if (p % 2 == 0) == (t % 2 == 0) else 1
                q(conn, "INSERT INTO votes (zid, pid, tid, vote, created) "
                        "VALUES (%s, %s, %s, %s, %s)", (zid, p, t, raw, ts))
        last = ts
    q(conn, "SET session_replication_role = DEFAULT")
    return last


def put_main(conn, zid, env, lvt, tick=0, data='{"marker": "seed"}'):
    q(conn, "INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, math_tick, "
            "caching_tick) VALUES (%s, %s, %s::jsonb, %s, %s, 1)",
      (zid, env, data, lvt, tick))


def put_companions(conn, zid, env, tick, *, ticks=True):
    q(conn, "INSERT INTO math_bidtopid (zid, math_env, math_tick, data) "
            "VALUES (%s, %s, %s, '{}'::jsonb)", (zid, env, tick))
    q(conn, "INSERT INTO math_ptptstats (zid, math_env, math_tick, data) "
            "VALUES (%s, %s, %s, '{}'::jsonb)", (zid, env, tick))
    if ticks:
        q(conn, "INSERT INTO math_ticks (zid, math_env, math_tick) VALUES (%s, %s, %s)",
          (zid, env, tick))


def generations(conn, zid, env):
    row = q(conn, """
        SELECT m.math_tick, b.math_tick, p.math_tick, k.math_tick, m.last_vote_timestamp
        FROM (SELECT %s::int AS zid) z
        LEFT JOIN math_main m ON m.zid = z.zid AND m.math_env = %s
        LEFT JOIN math_bidtopid b ON b.zid = z.zid AND b.math_env = %s
        LEFT JOIN math_ptptstats p ON p.zid = z.zid AND p.math_env = %s
        LEFT JOIN math_ticks k ON k.zid = z.zid AND k.math_env = %s""",
            (zid, env, env, env, env))[0]
    return row


def coherent(conn, zid, env):
    main, bid, stats, ticks, _ = generations(conn, zid, env)
    return None not in (main, bid, stats, ticks) and main == bid == stats == ticks


def make_service(url, source, target, **bf_overrides):
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller.backfill import BackfillConfig
    from polismath.poller.service import MathPollerService, PollerConfig

    pg = PostgresClient(PostgresConfig(url=url, math_env=target, ssl_mode="disable"))
    pg.initialize()
    cfg = PollerConfig(database_url=url, math_env=target, poll_from_days_ago=1,
                       worker_pool_size=2, vote_interval_ms=200, mod_interval_ms=200,
                       reconcile_interval_ms=600000)
    bf = dict(enabled=True, source_env=source, min_interval_s=0.0, large_sleep_s=0.0,
              duty_cycle=1.0, gate_after_largest=0, memory_ceiling_mb=100000.0,
              resweep_s=0.2, page_size=2)
    bf.update(bf_overrides)
    return MathPollerService(pg, cfg, backfill_config=BackfillConfig(**bf)), pg


def healthy(svc):
    svc._vote_poll_ms.append(5.0)
    svc._vote_poll_ok_at = time.monotonic()


# --------------------------------------------------------------------------- #
class TestSelection:
    def test_page_classes_and_largest_first_keyset(self, pg_url, db, labels):
        from polismath.poller.backfill import BackfillStore

        src, tgt = labels
        z = fresh_zids(6)
        sizes = [5, 40, 30, 20, 10, 50]
        lvts = {zid: seed_conversation(db, zid, participants=p, comments=3, votes=False)
                for zid, p in zip(z, sizes)}
        for zid in z[:5]:
            put_main(db, zid, src, lvt=1_000)
        put_main(db, z[2], tgt, lvt=1_000, tick=4)          # coherent: not a target
        put_companions(db, z[2], tgt, 4)
        put_main(db, z[3], tgt, lvt=1_000, tick=2)          # no math_ticks row
        put_companions(db, z[3], tgt, 2, ticks=False)
        put_main(db, z[4], tgt, lvt=500, tick=1)            # behind the source
        put_companions(db, z[4], tgt, 1)
        put_main(db, z[5], tgt, lvt=1_000)                  # target only: not a target
        assert lvts

        from polismath.database.postgres import PostgresClient, PostgresConfig
        pg = PostgresClient(PostgresConfig(url=pg_url, math_env=tgt, ssl_mode="disable"))
        store = BackfillStore(pg, src, tgt, 30000)
        cutoff = int(time.time() * 1000)
        seen, after = [], None
        while True:
            page = store.page(after, 2, cutoff)
            if not page:
                break
            seen += [(t.zid, t.klass, t.participants) for t, _ in page]
            after = (page[-1][0].participants, page[-1][0].zid)
        assert seen == [(z[1], "missing", 40), (z[3], "incomplete", 20),
                        (z[4], "stale", 10), (z[0], "missing", 5)]
        assert store.sizes(z[1]) == (0, 0, 3)
        counts = store.label_counts(cutoff)
        assert counts["source_rows"] == 5 and counts["missing"] == 2
        assert counts["incomplete"] == 1 and counts["stale"] == 1
        pg.shutdown()


class TestRunningPoller:
    def test_backfills_every_target_and_never_grows_the_cache(self, pg_url, db, labels):
        src, tgt = labels
        z = fresh_zids(5)
        lvt = {}
        lvt[z[0]] = seed_conversation(db, z[0], participants=12, comments=6)
        lvt[z[1]] = seed_conversation(db, z[1], participants=8, comments=5)
        lvt[z[2]] = seed_conversation(db, z[2], participants=3, comments=2, votes=False)
        lvt[z[3]] = seed_conversation(db, z[3], participants=6, comments=4)
        lvt[z[4]] = seed_conversation(db, z[4], participants=5, comments=4)
        for zid in z:
            put_main(db, zid, src, lvt=lvt[zid])
        put_main(db, z[3], tgt, lvt=lvt[z[3]], tick=2)       # incomplete: no ticks row
        put_companions(db, z[3], tgt, 2, ticks=False)
        put_main(db, z[4], tgt, lvt=lvt[z[4]], tick=7)       # coherent already
        put_companions(db, z[4], tgt, 7)

        svc, pg = make_service(pg_url, src, tgt)
        assert svc.backfill is not None
        svc.start()
        try:
            deadline = time.time() + 90
            while time.time() < deadline:
                if all(coherent(db, zid, tgt) for zid in z[:4]):
                    break
                time.sleep(0.2)
            # let the in-flight bookkeeping settle
            time.sleep(0.5)
        finally:
            svc.stop()
            pg.shutdown()

        for zid in z[:4]:
            assert coherent(db, zid, tgt), zid
            assert generations(db, zid, tgt)[4] == lvt[zid]
        assert generations(db, z[4], tgt)[0] == 7            # untouched no-op
        assert q(db, "SELECT data->>'marker' FROM math_main WHERE zid=%s AND math_env=%s",
                 (z[4], tgt))[0][0] == "seed"
        # The zero-vote conversation carries the named empty shape.
        n, keys = q(db, "SELECT data->>'n', data ?& ARRAY['zid','n','tids','pca',"
                        "'base-clusters','group-clusters','repness','in-conv',"
                        "'lastVoteTimestamp'] FROM math_main "
                        "WHERE zid=%s AND math_env=%s", (z[2], tgt))[0]
        assert n == "0" and keys
        assert not set(z) & set(svc._convs)                   # cache untouched
        totals = svc.backfill._state.totals
        assert totals.get("published") == 4
        assert not svc.backfill._state.failures

        # The aggregate verification SQL agrees, over these labels.
        results = run_verification(db, src, tgt, cutoff_ms=int(time.time() * 1000))
        by_label = {(t, e): n for t, e, n in results[0]}
        # The live loop may also publish other zids with recent votes in a
        # shared test database; those are target-only rows (query 3).
        target_rows = by_label[("math_main", tgt)]
        assert target_rows >= 5 and by_label[("math_main", src)] == 5
        for table in ("math_bidtopid", "math_ptptstats", "math_ticks"):
            assert by_label[(table, tgt)] == target_rows
        (source, m_main, m_bid, m_stats, m_ticks, unequal, uninit, behind_cut,
         behind_any, complete) = results[1][0]
        assert (source, complete) == (5, 5)
        assert (m_main, m_bid, m_stats, m_ticks, unequal, uninit, behind_cut) == (0,) * 7
        assert results[2][0] == (target_rows - 5, 0, 0, 0)
        checked, not_object, missing_keys, empty = results[3][0]
        # z[4] is a seeded stand-in blob without the real keys; the rest are real.
        assert (checked, not_object, missing_keys, empty) == (5, 0, 1, 1)

    def test_live_vote_after_backfill_catches_up(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=6, comments=4)
        put_main(db, zid, src, lvt=lvt)
        svc, pg = make_service(pg_url, src, tgt)
        svc._ensure_runtime()
        healthy(svc)
        try:
            assert svc.backfill.step()[0] == "admitted"
            assert svc._pool.join(timeout=30)
            first = generations(db, zid, tgt)
            assert coherent(db, zid, tgt) and first[4] == lvt
            now = int(time.time() * 1000)
            q(db, "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 0, 3, -1, %s)",
              (zid, now))
            svc.poll_once()
            after = generations(db, zid, tgt)
            assert coherent(db, zid, tgt)
            assert after[0] == first[0] + 1 and after[4] == now
        finally:
            svc._pool.shutdown()
            pg.shutdown()


class TestTieRule:
    def test_live_publication_holding_the_tick_lock_wins(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=6, comments=4)
        put_main(db, zid, src, lvt=lvt)
        svc, pg = make_service(pg_url, src, tgt)
        svc._ensure_runtime()
        healthy(svc)
        submitted = []
        svc.backfill._host.submit = lambda z: submitted.append(z) or True
        svc.backfill._host.is_pending = lambda z: True
        assert svc.backfill.step()[0] == "admitted"

        # A live writer mid-publication: tick upserted (row lock held), main
        # written, not yet committed.
        live = psycopg2.connect(pg_url)
        cur = live.cursor()
        cur.execute("INSERT INTO math_ticks (zid, math_env) VALUES (%s, %s) "
                    "ON CONFLICT (zid, math_env) DO UPDATE SET math_tick = math_ticks.math_tick + 1",
                    (zid, tgt))
        for table in ("math_bidtopid", "math_ptptstats"):
            cur.execute(f"INSERT INTO {table} (zid, math_env, math_tick, data) "
                        "VALUES (%s, %s, 0, '{}'::jsonb)", (zid, tgt))
        cur.execute("INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, "
                    "math_tick, caching_tick) VALUES (%s, %s, '{\"marker\": \"live\"}'::jsonb, "
                    "%s, 0, 1)", (zid, tgt, lvt))

        job = threading.Thread(target=svc.backfill.run_job, args=(zid,))
        job.start()
        job.join(timeout=3)
        assert job.is_alive(), "the backfill publication must wait on the live tick lock"
        live.commit()
        live.close()
        job.join(timeout=30)
        assert not job.is_alive()
        try:
            assert svc.backfill._state.totals == {"superseded_live": 1}
            assert q(db, "SELECT data->>'marker', math_tick FROM math_main "
                         "WHERE zid=%s AND math_env=%s", (zid, tgt))[0] == ("live", 0)
            assert generations(db, zid, tgt)[3] == 0      # the backfill's tick rolled back
        finally:
            svc._pool.shutdown()
            pg.shutdown()

    def test_failure_inside_the_publication_leaves_nothing(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=6, comments=4)
        put_main(db, zid, src, lvt=lvt)
        svc, pg = make_service(pg_url, src, tgt)
        svc._ensure_runtime()
        healthy(svc)
        svc.backfill._host.submit = lambda z: True
        svc.backfill._host.is_pending = lambda z: True

        def boom(*a, **k):
            raise RuntimeError("stats write failed")

        pg.write_participant_stats = boom
        try:
            assert svc.backfill.step()[0] == "admitted"
            svc.backfill.run_job(zid)
            assert svc.backfill._state.failures[str(zid)]["reason"] == "failed_write"
            assert generations(db, zid, tgt) == (None, None, None, None, None)
        finally:
            svc._pool.shutdown()
            pg.shutdown()


def run_verification(conn, source, target, cutoff_ms):
    """Execute the shipped psql script with its variables substituted."""
    sql = VERIFY_SQL.read_text()
    sql = (sql.replace(":'source'", f"'{source}'").replace(":'target'", f"'{target}'")
              .replace(":cutoff_ms", str(int(cutoff_ms))))
    body = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    statements = [s.strip() for s in body.split(";") if s.strip()]
    assert statements[0].upper().startswith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    assert statements[-1].upper() == "COMMIT"
    results = []
    with conn.cursor() as cur:  # autocommit: the script's own BEGIN/COMMIT apply
        cur.execute(statements[0])
        try:
            for stmt in statements[1:-1]:
                assert stmt.lstrip().upper().startswith("SELECT"), stmt[:40]
                cur.execute(stmt)
                results.append(cur.fetchall())
            cur.execute("SHOW transaction_isolation")
            assert cur.fetchone()[0] == "repeatable read"
            cur.execute("SHOW transaction_read_only")
            assert cur.fetchone()[0] == "on"
        finally:
            cur.execute("COMMIT")
    return results


# Runs the real math_poller.main() (lock admission included) with only the
# service construction replaced by a stand-in whose backfill records the
# operator signals.
SIGNAL_RUNNER = """
import sys, threading
from scripts import math_poller

class Backfill:
    def approve_gate(self):
        print("GATE_APPROVED", flush=True)
    def toggle_pause(self):
        print("PAUSE_TOGGLED", flush=True)

class Stand:
    def __init__(self):
        self._stop = threading.Event()
        self.backfill = Backfill()
    def run_forever(self):
        print("ADMITTED", flush=True)
        self._stop.wait()
    def stop(self):
        pass

math_poller._build_service = lambda config: Stand()
raise SystemExit(math_poller.main([]))
"""


class TestOperatorSignals:
    def test_sigusr1_approves_the_gate_and_sigusr2_toggles_pause(self, pg_url, labels):
        import os
        import signal
        import subprocess
        import sys

        root = Path(__file__).resolve().parents[2]
        env = dict(os.environ, DATABASE_URL=pg_url, DATABASE_SSL_MODE="disable",
                   MATH_ENV=labels[1], PYTHONUNBUFFERED="1",
                   MATH_POLLER_LOCK_RETRY_S="1", MATH_POLLER_LOCK_LIVENESS_S="1",
                   PYTHONPATH=os.pathsep.join(filter(None, [str(root), os.environ.get("PYTHONPATH")])))
        env.pop("MATH_POLLER_ALLOW_SERVED_ENV", None)
        proc = subprocess.Popen([sys.executable, "-c", SIGNAL_RUNNER], cwd=root, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        seen = []
        try:
            def wait_for(needle):
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    line = proc.stdout.readline()
                    if not line:
                        break
                    seen.append(line.strip())
                    if needle in line:
                        return True
                return False

            assert wait_for("ADMITTED"), seen
            proc.send_signal(signal.SIGUSR1)
            assert wait_for("GATE_APPROVED"), seen
            proc.send_signal(signal.SIGUSR2)
            assert wait_for("PAUSE_TOGGLED"), seen
            assert proc.poll() is None  # neither signal stops the poller
        finally:
            proc.kill()
            proc.wait(timeout=10)
