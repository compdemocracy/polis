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

from polismath.poller.worker_pool import REBUILD, CoalescedBatch
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
    from polismath.poller.admission import MemoryAdmission
    from polismath.poller.backfill import BackfillConfig
    from polismath.poller.service import MathPollerService, PollerConfig

    pg = PostgresClient(PostgresConfig(url=url, math_env=target, ssl_mode="disable"))
    pg.initialize()
    cfg = PollerConfig(database_url=url, math_env=target, poll_from_days_ago=1,
                       worker_pool_size=2, vote_interval_ms=200, mod_interval_ms=200,
                       reconcile_interval_ms=600000, memory_limit_mb=65536)
    bf = dict(enabled=True, source_env=source, min_interval_s=0.0, large_sleep_s=0.0,
              duty_cycle=1.0, gate_after_largest=0, resweep_s=0.2, page_size=2)
    bf.update(bf_overrides)
    admission = MemoryAdmission(65536 * 1024 * 1024)
    return MathPollerService(pg, cfg, backfill_config=BackfillConfig(**bf),
                             admission=admission), pg


def publish_real(svc, zid):
    """A real engine publication of zid under the service's label."""
    svc._writer.write_conv_updates(zid, svc._load_or_init(zid))


def healthy(svc):
    svc._vote_poll_ms.append(5.0)
    svc._vote_poll_ok_at = time.monotonic()


# --------------------------------------------------------------------------- #
class TestSelection:
    def test_page_classes_and_largest_first_keyset(self, pg_url, db, labels):
        src, tgt = labels
        z = fresh_zids(7)
        sizes = [5, 40, 30, 20, 10, 50, 15]
        for zid, p in zip(z, sizes):
            seed_conversation(db, zid, participants=p, comments=3, votes=False)
        svc, pg = make_service(pg_url, src, tgt)
        store = svc.backfill._store
        try:
            for zid in z[:5] + [z[6]]:
                put_main(db, zid, src, lvt=0)
            publish_real(svc, z[2])                           # valid: not a target
            publish_real(svc, z[3])                           # no math_ticks row
            q(db, "DELETE FROM math_ticks WHERE zid=%s AND math_env=%s", (z[3], tgt))
            q(db, "UPDATE math_main SET last_vote_timestamp=1000 WHERE zid=%s AND math_env=%s",
              (z[4], src))
            publish_real(svc, z[4])                           # behind an old source
            put_main(db, z[5], tgt, lvt=1_000)                # target only: not a target
            publish_real(svc, z[6])                           # invalid payload
            q(db, "UPDATE math_bidtopid SET data='[]'::jsonb WHERE zid=%s AND math_env=%s",
              (z[6], tgt))
            cutoff = int(time.time() * 1000)
            seen, after = [], None
            while True:
                page, after, _ = store.page(after, 2, cutoff)
                seen += [(t.zid, t.klass, t.participants) for t, _ in page]
                if after is None:
                    break
            assert seen == [(z[1], "missing", 40), (z[3], "incomplete", 20),
                            (z[6], "invalid", 15), (z[4], "stale", 10), (z[0], "missing", 5)]
            assert store.sizes(z[1]) == (0, 0, 3)
            counts = store.label_counts(cutoff)
            assert counts["source_rows"] == 6 and counts["missing"] == 2
            # z[4] has no votes at all while its source claims 1000: the
            # aggregate counts it as source-ahead ([1447] C), not stale; the
            # page still selects it (old) so a rebuild confirms it.
            assert counts["incomplete"] == 1 and counts["stale"] == 0
            assert counts["source_ahead"] == 1 and counts["live_lag"] == 0
        finally:
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

        svc, pg = make_service(pg_url, src, tgt)
        assert svc.backfill is not None
        publish_real(svc, z[4])                               # valid already
        before = q(db, "SELECT math_tick, caching_tick FROM math_main "
                       "WHERE zid=%s AND math_env=%s", (z[4], tgt))[0]
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
        assert q(db, "SELECT math_tick, caching_tick FROM math_main "
                     "WHERE zid=%s AND math_env=%s", (z[4], tgt))[0] == before  # untouched
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
        assert_switch_ready(results, 5)
        assert results[2][0]["target_only_main"] == target_rows - 5
        diag = results[3][0]
        assert diag["checked"] == 5 and diag["empty_shape"] == 1
        assert all(diag[k] == 0 for k in diag if k not in ("checked", "empty_shape"))

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


SWITCH_ZERO = ("missing_main", "missing_bidtopid", "missing_ptptstats", "missing_ticks",
               "unequal_generation", "uninitialized_generation", "invalid_payload",
               "behind_source_stale", "source_ahead")


def assert_switch_ready(results, n):
    """The documented switch condition over these labels."""
    q2, q3, q5 = results[1][0], results[2][0], results[4][0]
    assert q2["source_conversations"] == n and q2["complete"] == n, q2
    assert all(q2[k] == 0 for k in SWITCH_ZERO), q2
    assert all(q3[k] == 0 for k in ("orphan_bidtopid", "orphan_ptptstats", "orphan_ticks")), q3
    assert q5["behind_input_at_cutoff"] == 0 and q5["source_ahead_of_input"] == 0, q5


# --------------------------------------------------------------------------- #
# Review [1443] acceptance cases
# --------------------------------------------------------------------------- #
def backfill_once(svc):
    """Admit one backfill job and wait for the pool to finish it."""
    svc._ensure_runtime()
    healthy(svc)
    status = svc.backfill.step()[0]
    assert status == "admitted", status
    assert svc._pool.join(timeout=60)


class TestSharedAdmission:
    def test_large_backfill_and_new_live_rebuild_do_not_overlap(self, pg_url, db, labels):
        """R1: the reviewer's witness with the real service, pool and scheduler.
        A large backfill job is blocked inside its first-touch rebuild; a
        different live REBUILD must not enter _load_or_init until it ends."""
        src, tgt = labels
        background, live = fresh_zids(2)
        for zid in (background, live):
            lvt = seed_conversation(db, zid, participants=6, comments=4)
            if zid == background:
                put_main(db, zid, src, lvt)
        svc, pg = make_service(pg_url, src, tgt, large_threshold=2)
        svc._ensure_runtime()
        healthy(svc)
        background_started = threading.Event()
        live_started = threading.Event()
        release = threading.Event()
        real_load = svc._load_or_init

        def load(zid):
            if zid == background:
                background_started.set()
                assert release.wait(20)
            elif zid == live:
                live_started.set()
            return real_load(zid)

        svc._load_or_init = load
        try:
            assert svc.backfill.step()[0] == "admitted"
            assert background_started.wait(10)
            assert svc.backfill._in_flight[background].large
            assert svc._pool.submit(live, REBUILD, [])
            assert not live_started.wait(2), "live work computed beside a large backfill job"
            assert svc.admission.snapshot()["waiting"] == 1
            release.set()
            assert live_started.wait(20)
            assert svc._pool.join(timeout=60)
            assert coherent(db, background, tgt) and coherent(db, live, tgt)
            assert svc.admission.granted() == []
            assert svc.backfill._state.totals == {"published": 1}
        finally:
            release.set()
            svc._pool.join(timeout=30)
            svc._pool.shutdown()
            pg.shutdown()


CORRUPTIONS = {
    "main_values_null": "UPDATE math_main SET data = (SELECT jsonb_object_agg(k, 'null'::jsonb) "
                        "FROM unnest(ARRAY['zid','n','tids','pca','base-clusters','group-clusters',"
                        "'repness','in-conv','lastVoteTimestamp']) k) "
                        "WHERE zid=%s AND math_env=%s",
    "bid_array": "UPDATE math_bidtopid SET data='[]'::jsonb WHERE zid=%s AND math_env=%s",
    "stats_string": "UPDATE math_ptptstats SET data='\"invalid\"'::jsonb "
                    "WHERE zid=%s AND math_env=%s",
    "wrong_zid": "UPDATE math_main SET data=jsonb_set(data,'{zid}','-999'::jsonb) "
                 "WHERE zid=%s AND math_env=%s",
    "blob_timestamp": "UPDATE math_main SET data=jsonb_set(data,'{lastVoteTimestamp}','0'::jsonb) "
                      "WHERE zid=%s AND math_env=%s",
    "false_empty": "UPDATE math_main SET data=jsonb_set(data,'{n}','0'::jsonb) "
                   "WHERE zid=%s AND math_env=%s",
}
# Review [1447] B: the seven nested corruptions that passed every switch
# condition of the previous rule (the reviewer's exact expressions).
NESTED = [
    ("group_null", "math_main", "jsonb_set(data, '{group-clusters}', '[null]'::jsonb)"),
    ("pca_components", "math_main",
     "jsonb_set(data, '{pca}', '{\"center\":null,\"comps\":\"broken\"}'::jsonb)"),
    ("base_members", "math_main",
     "jsonb_set(data, '{base-clusters,members}', (SELECT jsonb_agg(null::text) "
     "FROM jsonb_array_elements(data->'base-clusters'->'members')))"),
    ("bid_members", "math_bidtopid",
     "jsonb_set(data, '{bidToPid}', (SELECT jsonb_agg(null::text) "
     "FROM jsonb_array_elements(data->'bidToPid')))"),
    ("stats_values", "math_ptptstats",
     "jsonb_set(data, '{ptptstats}', '{\"0\":\"broken\"}'::jsonb)"),
    ("bid_timestamp", "math_bidtopid", "jsonb_set(data, '{lastVoteTimestamp}', '-99'::jsonb)"),
    ("stats_timestamp", "math_ptptstats", "jsonb_set(data, '{lastVoteTimestamp}', '-99'::jsonb)"),
]
for _name, _table, _expr in NESTED:
    CORRUPTIONS["nested_" + _name] = (
        f"UPDATE {_table} SET data={_expr} WHERE zid=%s AND math_env=%s")


class TestValidity:
    def test_verifier_contains_the_selection_predicate_verbatim(self):
        from polismath.poller.backfill import VALID_BUNDLE_SQL

        norm = lambda t: " ".join(t.split())  # noqa: E731
        body = norm(VERIFY_SQL.read_text())
        assert body.count(norm(VALID_BUNDLE_SQL)) == 2  # queries 2 and 4

    @pytest.mark.parametrize("corruption", sorted(CORRUPTIONS))
    def test_malformed_publication_is_selected_repaired_and_verified(
            self, pg_url, db, labels, corruption):
        """R2: each corruption of a real engine publication fails the shipped
        verifier, is selected for repair, and a backfill run repairs it."""
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=12, comments=6)
        put_main(db, zid, src, lvt)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            cutoff = int(time.time() * 1000)
            assert_switch_ready(run_verification(db, src, tgt, cutoff), 1)  # control
            assert q(db, "SELECT jsonb_array_length(data->'group-clusters') FROM math_main "
                         "WHERE zid=%s AND math_env=%s", (zid, tgt))[0][0] > 0
            q(db, CORRUPTIONS[corruption], (zid, tgt))
            assert q(db, "SELECT count(*) FROM math_main WHERE zid=%s AND math_env=%s "
                         "AND data IS NOT NULL", (zid, tgt))[0][0] == 1
            v = run_verification(db, src, tgt, cutoff)
            assert v[1][0]["invalid_payload"] == 1 and v[1][0]["complete"] == 0, v[1][0]
            assert v[3][0]["invalid_payload"] == 1
            page, _, _ = svc.backfill._store.page(None, 50, cutoff)
            assert [(t.zid, t.klass) for t, _ in page] == [(zid, "invalid")]
            assert svc.backfill._store.coherent(zid)[0] is False
            backfill_once(svc)
            assert svc.backfill._state.totals == {"published": 1}
            assert_switch_ready(run_verification(db, src, tgt, int(time.time() * 1000)), 1)
        finally:
            svc._pool and svc._pool.shutdown()
            pg.shutdown()

    @pytest.mark.parametrize("table", ["math_main", "math_bidtopid", "math_ptptstats",
                                       "math_ticks"])
    def test_missing_row_positive_control(self, pg_url, db, labels, table):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=6, comments=4)
        put_main(db, zid, src, lvt)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            q(db, f"DELETE FROM {table} WHERE zid=%s AND math_env=%s", (zid, tgt))
            v = run_verification(db, src, tgt, int(time.time() * 1000))[1][0]
            assert v["missing_" + table.split("_")[1]] == 1
            assert v["complete"] == 0
            page, _, _ = svc.backfill._store.page(None, 50, int(time.time() * 1000))
            assert [t.zid for t, _ in page] == [zid]
        finally:
            pg.shutdown()


class TestCatchUp:
    def test_recent_source_does_not_hide_an_old_target(self, pg_url, db, labels):
        """R3: the reviewer's witness. An old valid target behind a source
        stamped now is stale in the verifier and in selection; the rebuild
        proves every vote is in, so it is source_ahead, not complete."""
        src, tgt = labels
        (zid,) = fresh_zids(1)
        old_lvt = seed_conversation(db, zid, participants=6, comments=4)
        now = int(time.time() * 1000)
        put_main(db, zid, src, now)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            assert generations(db, zid, tgt)[4] == old_lvt
            cutoff = now - 3600 * 1000
            v = run_verification(db, src, tgt, cutoff)
            # [1447] C: it reflects every vote, so it is source-ahead, not
            # stale and not complete; the switch condition is not met.
            assert (v[1][0]["behind_source_stale"], v[1][0]["source_ahead"],
                    v[1][0]["complete"], v[1][0]["live_lag"]) == (0, 1, 0, 0)
            assert v[4][0] == {"behind_input_at_cutoff": 0, "source_ahead_of_input": 1,
                               "live_tail_after_cutoff": 0}
            page, _, _ = svc.backfill._store.page(None, 50, cutoff)
            assert [(t.zid, t.klass) for t, _ in page] == [(zid, "stale")]
            backfill_once(svc)
            assert svc.backfill._state.failures[str(zid)]["reason"] == "source_ahead"
        finally:
            svc._pool and svc._pool.shutdown()
            pg.shutdown()

    def test_live_lag_is_reported_and_the_cutoff_proof_decides(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        seed_conversation(db, zid, participants=6, comments=4)
        now = int(time.time() * 1000)
        q(db, "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 1, 0, -1, %s)",
          (zid, now - 10_000))
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            assert generations(db, zid, tgt)[4] == now - 10_000
            # A later vote the target has not consumed yet; the source saw it.
            q(db, "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 2, 0, 1, %s)",
              (zid, now - 5_000))
            put_main(db, zid, src, now - 5_000)
            v = run_verification(db, src, tgt, now - 60_000)
            assert (v[1][0]["live_lag"], v[1][0]["behind_source_stale"],
                    v[1][0]["complete"]) == (1, 0, 1)
            assert v[4][0]["behind_input_at_cutoff"] == 0
            assert (v[4][0]["source_ahead_of_input"], v[4][0]["live_tail_after_cutoff"]) == (0, 1)
            page, _, lagging = svc.backfill._store.page(None, 50, now - 60_000)
            assert page == [] and lagging == 1
            # A cutoff after that vote: the target has not caught up with it.
            v = run_verification(db, src, tgt, now)
            assert v[4][0]["behind_input_at_cutoff"] == 1
            assert v[1][0]["behind_source_stale"] == 1 and v[1][0]["complete"] == 0
        finally:
            pg.shutdown()


class TestUninitializedGenerations:
    def test_all_four_negative_ticks_are_selected_repaired_and_verified(
            self, pg_url, db, labels):
        """R4: selection, postcondition and verifier agree."""
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=6, comments=4)
        put_main(db, zid, src, lvt)
        put_main(db, zid, tgt, lvt, tick=-1)
        put_companions(db, zid, tgt, -1)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            cutoff = int(time.time() * 1000)
            page, _, _ = svc.backfill._store.page(None, 50, cutoff)
            assert [(t.zid, t.klass) for t, _ in page] == [(zid, "incomplete")]
            assert svc.backfill._store.coherent(zid)[0] is False
            v = run_verification(db, src, tgt, cutoff)[1][0]
            assert v["uninitialized_generation"] == 1 and v["complete"] == 0
            backfill_once(svc)
            assert svc.backfill._state.totals == {"published": 1}
            assert generations(db, zid, tgt)[:4] == (0, 0, 0, 0)
            assert svc.backfill._store.coherent(zid)[0] is True
            assert_switch_ready(run_verification(db, src, tgt, int(time.time() * 1000)), 1)
        finally:
            svc._pool and svc._pool.shutdown()
            pg.shutdown()


class TestReconcile:
    def test_live_repair_clears_a_saved_failure_and_keeps_real_ones(self, pg_url, db, labels):
        """R5: a failure repaired by live ingestion is cleared from the
        database's evidence; one still missing is kept."""
        src, tgt = labels
        repaired, still = fresh_zids(2)
        for zid in (repaired, still):
            put_main(db, zid, src, seed_conversation(db, zid, participants=6, comments=4))
        svc, pg = make_service(pg_url, src, tgt)
        try:
            state = svc.backfill._state
            for zid in (repaired, still):
                state.failures[str(zid)] = {"attempts": 5, "next_at": 0, "reason": "exhausted"}
            publish_real(svc, repaired)  # live ingestion
            cleared = svc.backfill._reconcile_failures(time.time())
            assert cleared == {"exhausted": 1}
            assert svc.backfill._unresolved() == {"exhausted": 1}
            assert str(still) in state.failures and str(repaired) not in state.failures
        finally:
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
                names = [d[0] for d in cur.description]
                rows = cur.fetchall()
                results.append(rows if names == ["tbl", "math_env", "n"]
                               else [dict(zip(names, r)) for r in rows])
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
        """Every wait is bounded by a real deadline (selectors + os.read, never
        a blocking readline), and a stalled child prints its thread stacks
        into the captured output, which a failure reports."""
        import os
        import selectors
        import signal
        import subprocess
        import sys

        root = Path(__file__).resolve().parents[2]
        env = dict(os.environ, DATABASE_URL=pg_url, DATABASE_SSL_MODE="disable",
                   MATH_ENV=labels[1], PYTHONUNBUFFERED="1",
                   MATH_POLLER_LOCK_RETRY_S="1", MATH_POLLER_LOCK_LIVENESS_S="1",
                   PYTHONPATH=os.pathsep.join(filter(None, [str(root), os.environ.get("PYTHONPATH")])))
        env.pop("MATH_POLLER_ALLOW_SERVED_ENV", None)
        script = ("import faulthandler\nfaulthandler.dump_traceback_later(20, repeat=True)\n"
                  + SIGNAL_RUNNER)
        proc = subprocess.Popen([sys.executable, "-c", script], cwd=root, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                start_new_session=True)
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)
        captured = bytearray()

        def wait_for(needle, timeout=30.0):
            deadline = time.monotonic() + timeout
            while needle not in captured:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                if not sel.select(timeout=min(0.25, left)):
                    continue
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    return needle in captured  # child exited
                captured.extend(chunk)
            return True

        def output():
            return captured.decode(errors="replace")[-4000:]

        try:
            assert wait_for(b"ADMITTED"), output()
            proc.send_signal(signal.SIGUSR1)
            assert wait_for(b"GATE_APPROVED"), output()
            proc.send_signal(signal.SIGUSR2)
            assert wait_for(b"PAUSE_TOGGLED"), output()
            assert proc.poll() is None, output()  # neither signal stops the poller
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=10)
            sel.close()
            proc.stdout.close()


# --------------------------------------------------------------------------- #
# Review [1447] acceptance cases
# --------------------------------------------------------------------------- #
class TestRecentSourceAhead:
    def test_recent_target_cannot_hide_a_source_ahead_of_every_vote(self, pg_url, db, labels):
        """The reviewer's real-DB witness, inverted: a recent valid target,
        its source beyond every vote in the table. Reconciliation keeps the
        exclusion, the verifier counts it, and the switch condition fails."""
        src, tgt = labels
        (zid,) = fresh_zids(1)
        now = int(time.time() * 1000)
        lvt = seed_conversation(db, zid, participants=12, comments=6, created_ms=now - 1000)
        put_main(db, zid, src, lvt + 10_000)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            state = svc.backfill._state
            state.failures[str(zid)] = {"attempts": 0, "next_at": 0, "reason": "source_ahead"}
            assert svc.backfill._reconcile_failures(now / 1000) == {}
            assert state.failures[str(zid)]["reason"] == "source_ahead"
            results = run_verification(db, src, tgt, now - 2000)
            assert results[4][0]["source_ahead_of_input"] == 1
            assert results[1][0]["source_ahead"] == 1 and results[1][0]["complete"] == 0
            with pytest.raises(AssertionError):
                assert_switch_ready(results, 1)
            counts = svc.backfill._store.label_counts(now - 3_600_000)
            assert counts["source_ahead"] == 1 and counts["live_lag"] == 0
            # A job for it (fresh state) records the exclusion, never COMPLETE.
            state.failures.clear()
            svc.backfill._in_flight[zid] = _job(zid)
            svc.backfill.run_job(zid)
            assert state.failures[str(zid)]["reason"] == "source_ahead"
        finally:
            pg.shutdown()

    def test_accept_ruling_counts_it_as_an_explicit_disposition(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        now = int(time.time() * 1000)
        lvt = seed_conversation(db, zid, participants=12, comments=6, created_ms=now - 1000)
        put_main(db, zid, src, lvt + 10_000)
        svc, pg = make_service(pg_url, src, tgt, source_ahead_ruling="accept_input")
        try:
            publish_real(svc, zid)
            state = svc.backfill._state
            state.failures[str(zid)] = {"attempts": 0, "next_at": 0, "reason": "source_ahead"}
            assert svc.backfill._reconcile_failures(now / 1000) == {"source_ahead_accepted": 1}
            assert svc.backfill._store.page(None, 50, now - 3_600_000)[0] == []
        finally:
            pg.shutdown()


def _job(zid):
    from polismath.poller import backfill as bfm
    return bfm._Job(bfm.Target(zid, 12, "", None, None), 1, 1, 1, 0, 0, False)


class TestLiveRestoreValidation:
    def test_live_rebuild_never_republishes_a_wrong_body_zid(self, pg_url, db, labels):
        """The reviewer's witness, inverted: a corrupted body zid is not
        restored by the live rebuild; the replacement is valid and names its
        own zid."""
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=12, comments=6)
        put_main(db, zid, src, lvt)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            q(db, "UPDATE math_main SET data=jsonb_set(data,'{zid}',to_jsonb(%s::int)) "
                  "WHERE zid=%s AND math_env=%s", (zid + 1, zid, tgt))
            assert pg.load_math_main(zid)["bundle_valid"] is False
            assert svc.backfill._store.state(zid, lvt + 100)[0] == "invalid"
            svc._run_engine(zid, CoalescedBatch(rebuild=True))
            assert q(db, "SELECT data->>'zid' FROM math_main WHERE zid=%s AND math_env=%s",
                     (zid, tgt))[0][0] == str(zid)
            assert svc.backfill._store.state(zid, lvt + 100)[0] is None
            assert pg.load_math_main(zid)["bundle_valid"] is True
            assert svc.backfill._host.is_cached(zid)
        finally:
            pg.shutdown()

    def test_live_first_touch_restores_only_a_valid_row(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=12, comments=6)
        put_main(db, zid, src, lvt)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            publish_real(svc, zid)
            assert pg.load_math_main(zid)["bundle_valid"] is True
            q(db, "UPDATE math_ptptstats SET data=jsonb_set(data,'{lastVoteTimestamp}',"
                  "'-99'::jsonb) WHERE zid=%s AND math_env=%s", (zid, tgt))
            svc._run_engine(zid, CoalescedBatch())  # first touch: cache miss
            assert svc.backfill._store.coherent(zid)[0] is True
        finally:
            pg.shutdown()

    def test_a_cached_live_owner_with_an_invalid_row_is_repaired(self, pg_url, db, labels):
        src, tgt = labels
        (zid,) = fresh_zids(1)
        lvt = seed_conversation(db, zid, participants=12, comments=6)
        put_main(db, zid, src, lvt)
        svc, pg = make_service(pg_url, src, tgt)
        try:
            svc._run_engine(zid, CoalescedBatch(rebuild=True))  # live owns it now
            assert svc.backfill._host.is_cached(zid)
            q(db, "UPDATE math_main SET data=jsonb_set(data,'{zid}',to_jsonb(%s::int)) "
                  "WHERE zid=%s AND math_env=%s", (zid + 1, zid, tgt))
            healthy(svc)
            svc.backfill._host.submit = lambda z: True
            svc.backfill._host.is_pending = lambda z: True
            assert svc.backfill.step()[0] == "admitted"
            svc.backfill.run_job(zid)
            assert svc.backfill._state.totals == {"published": 1}
            assert str(zid) not in svc.backfill._state.failures
            assert svc.backfill._store.coherent(zid)[0] is True
            assert q(db, "SELECT data->>'zid' FROM math_main WHERE zid=%s AND math_env=%s",
                     (zid, tgt))[0][0] == str(zid)
        finally:
            pg.shutdown()
