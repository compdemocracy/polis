"""Bundle promotion and the large-class loop against a real Postgres (P-073 PR3/r2).

Same database resolution as the other poller integration tests
(``require_polis_postgres``). Generated fixtures only: every conversation is
made up here; each test uses its own labels and zid range and removes what it
wrote. Every test runs against both payload column types (json, as
production has it, and jsonb, as the migrations declare it).

Covered: ``PostgresClient.promote_bundle`` (copy, tick, caching_tick, every
refusal rolling back the target tick, the FOR SHARE fence in both directions,
never an older input over a newer one, the equal-vote moderation/restage
case, invalid and incomplete staged bundles); ``math_fingerprints``; and the
whole loop: routing on first touch and the job it asks the queue for (a
recording fake of the contract; the real contract is in
test_capacity_queue_postgres.py), the queue child (``math_poller.py --job``,
a subprocess) staging under its own label, promotion, a warm update, the
restage nonce, a small-poller restart with no compute for routed
conversations, the backfill skipping them, and a re-size after a binding
change handing a conversation back.
"""

import os
import threading
import time
import uuid

import psycopg2
import pytest

from tests.conftest import require_polis_postgres
from tests.poller.test_backfill_postgres import (
    _TABLES,
    coherent,
    q,
    seed_conversation,
    set_payload_type,
)
from tests.vote_fixtures import AGREE, DISAGREE, seed_vote

pytestmark = pytest.mark.integration

MB = 1024 * 1024


@pytest.fixture(scope="module", params=["json", "jsonb"])
def pg_url(request):
    with require_polis_postgres() as url:
        set_payload_type(url, request.param)
        try:
            yield url
        finally:
            set_payload_type(url, "jsonb")


@pytest.fixture
def db(pg_url):
    conn = psycopg2.connect(pg_url)
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def labels():
    tag = uuid.uuid4().hex[:8]
    return f"prsmall_{tag}", f"prlarge_{tag}"


_zid_base = [20000 + (uuid.uuid4().int % 500) * 100]
_used = []


def fresh_zids(n):
    base = _zid_base[0]
    _zid_base[0] += 100
    zids = list(range(base, base + n))
    _used.extend(zids)
    return zids


@pytest.fixture(autouse=True)
def _cleanup(db, labels):
    yield
    for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks"):
        q(db, f"DELETE FROM {table} WHERE math_env = ANY(%s)", (list(labels),))
    zids = list(_used)
    _used.clear()
    if zids:
        q(db, "SET session_replication_role = replica")
        for table in _TABLES:
            q(db, f"DELETE FROM {table} WHERE zid = ANY(%s)", (zids,))
        q(db, "SET session_replication_role = DEFAULT")


def client(url, env):
    from polismath.database.postgres import PostgresClient, PostgresConfig

    pg = PostgresClient(PostgresConfig(url=url, math_env=env, ssl_mode="disable"))
    pg.initialize()
    return pg


def publisher(url, env):
    """A plain service for real engine publications under ``env``."""
    from polismath.poller.admission import MemoryAdmission
    from polismath.poller.capacity import CapacityRouter, CapacitySettings
    from polismath.poller.service import MathPollerService, PollerConfig

    pg = client(url, env)
    adm = MemoryAdmission(65536 * MB)
    cfg = PollerConfig(database_url=url, math_env=env, poll_from_days_ago=1,
                       worker_pool_size=1, memory_limit_mb=65536)
    return MathPollerService(pg, cfg, admission=adm,
                             capacity=CapacityRouter(adm, CapacitySettings())), pg


def publish(svc, zid):
    return svc._writer.write_conv_updates(zid, svc._load_or_init(zid))


def fp(pg, zid, env):
    return pg.math_fingerprints([zid], [env]).get((zid, env))


def rows(db, zid, env):
    return q(db, """SELECT m.data::text, m.last_vote_timestamp, b.data::text, p.data::text
                    FROM math_main m
                    JOIN math_bidtopid b ON b.zid = m.zid AND b.math_env = m.math_env
                    JOIN math_ptptstats p ON p.zid = m.zid AND p.math_env = m.math_env
                    WHERE m.zid = %s AND m.math_env = %s""", (zid, env))


def target_tick(db, zid, env):
    r = q(db, "SELECT math_tick FROM math_ticks WHERE zid=%s AND math_env=%s", (zid, env))
    return r[0][0] if r else None


def valid(db, zid, env):
    from polismath.poller.backfill import VALID_BUNDLE_SQL

    return q(db, "SELECT " + VALID_BUNDLE_SQL + """ FROM math_main m
        LEFT JOIN math_bidtopid b ON b.zid = m.zid AND b.math_env = m.math_env
        LEFT JOIN math_ptptstats p ON p.zid = m.zid AND p.math_env = m.math_env
        LEFT JOIN math_ticks k ON k.zid = m.zid AND k.math_env = m.math_env
        WHERE m.zid = %s AND m.math_env = %s""", (zid, env))[0][0]


# --------------------------------------------------------------------------- #
# promote_bundle
# --------------------------------------------------------------------------- #
class TestPromoteBundle:
    def test_copies_a_valid_staged_bundle_as_one_new_publication(self, pg_url, db, labels):
        small, large = labels
        z, other = fresh_zids(2)
        seed_conversation(db, z, participants=6, comments=4)
        seed_conversation(db, other, participants=4, comments=3)
        stage, spg = publisher(pg_url, large)
        mine, tpg = publisher(pg_url, small)
        try:
            publish(stage, z)
            publish(mine, other)          # another conversation under the target label
            staged = fp(tpg, z, large)
            assert staged.complete and fp(tpg, z, small) is None
            caching_before = q(db, "SELECT max(caching_tick) FROM math_main WHERE math_env=%s",
                               (small,))[0][0]
            tick = tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=None,
                                      expected_staged=staged)
            assert coherent(db, z, small) and target_tick(db, z, small) == tick
            assert valid(db, z, small) is True
            assert rows(db, z, small) == rows(db, z, large)          # bytes identical
            caching = q(db, "SELECT caching_tick FROM math_main WHERE zid=%s AND math_env=%s",
                        (z, small))[0][0]
            assert caching == caching_before + 1                     # within the label
            assert fp(tpg, z, large) == staged                       # staged untouched
        finally:
            spg.shutdown()
            tpg.shutdown()

    def test_every_refusal_rolls_back_the_target_tick(self, pg_url, db, labels):
        from polismath.database.postgres import Fingerprint, PromotionRefused

        small, large = labels
        (z,) = fresh_zids(1)
        seed_conversation(db, z, participants=5, comments=3)
        stage, spg = publisher(pg_url, large)
        mine, tpg = publisher(pg_url, small)
        try:
            publish(stage, z)
            staged = fp(tpg, z, large)
            # Missing staged bundle under another label.
            with pytest.raises(PromotionRefused) as e:
                tpg.promote_bundle(z, from_env=large + "x", to_env=small, expected_target=None,
                                   expected_staged=staged)
            assert e.value.reason == "missing_staged"
            # The caller saw an older staged bundle.
            stale = Fingerprint(staged.math_tick - 1, staged.lvt, staged.modified)
            with pytest.raises(PromotionRefused) as e:
                tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=None,
                                   expected_staged=stale)
            assert e.value.reason == "superseded"
            # The target changed since the caller looked.
            publish(mine, z)
            with pytest.raises(PromotionRefused) as e:
                tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=None,
                                   expected_staged=staged)
            assert e.value.reason == "superseded"
            tick_after_publish = target_tick(db, z, small)
            # The target (published after the staged bundle, same votes) is
            # not older: refused, never replaced.
            target = fp(tpg, z, small)
            with pytest.raises(PromotionRefused) as e:
                tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=target,
                                   expected_staged=staged)
            assert e.value.reason == "not_newer"
            assert target_tick(db, z, small) == tick_after_publish   # no tick left behind
            assert fp(tpg, z, small) == target
        finally:
            spg.shutdown()
            tpg.shutdown()

    def test_never_an_older_input_over_a_newer_one(self, pg_url, db, labels):
        from polismath.database.postgres import PromotionRefused

        small, large = labels
        (z,) = fresh_zids(1)
        seed_conversation(db, z, participants=5, comments=3)
        stage, spg = publisher(pg_url, large)
        mine, tpg = publisher(pg_url, small)
        try:
            publish(stage, z)                                 # staged at the old votes
            q(db, "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 0, 0, %s, %s)",
              (z, seed_vote(DISAGREE), int(time.time() * 1000)))
            publish(mine, z)                                  # target has a newer vote
            staged, target = fp(tpg, z, large), fp(tpg, z, small)
            assert staged.lvt < target.lvt
            q(db, "UPDATE math_main SET modified = %s WHERE zid=%s AND math_env=%s",
              (target.modified + 10_000, z, large))           # a later write does not help
            staged = fp(tpg, z, large)
            with pytest.raises(PromotionRefused) as e:
                tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=target,
                                   expected_staged=staged)
            assert e.value.reason == "not_newer"
        finally:
            spg.shutdown()
            tpg.shutdown()

    def test_equal_votes_with_a_later_write_is_promoted(self, pg_url, db, labels):
        """The moderation update and the restage case: same newest vote, a
        newer staged write."""
        small, large = labels
        (z,) = fresh_zids(1)
        seed_conversation(db, z, participants=5, comments=3)
        stage, spg = publisher(pg_url, large)
        mine, tpg = publisher(pg_url, small)
        try:
            publish(mine, z)
            time.sleep(0.01)
            publish(stage, z)
            staged, target = fp(tpg, z, large), fp(tpg, z, small)
            assert staged.lvt == target.lvt and staged.modified > target.modified
            tick = tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=target,
                                      expected_staged=staged)
            assert target_tick(db, z, small) == tick and coherent(db, z, small)
        finally:
            spg.shutdown()
            tpg.shutdown()

    @pytest.mark.parametrize("damage", ["invalid", "incomplete"])
    def test_a_bad_staged_bundle_is_refused(self, pg_url, db, labels, damage):
        from polismath.database.postgres import PromotionRefused

        small, large = labels
        (z,) = fresh_zids(1)
        seed_conversation(db, z, participants=5, comments=3)
        stage, spg = publisher(pg_url, large)
        _, tpg = publisher(pg_url, small)
        try:
            publish(stage, z)
            if damage == "invalid":
                q(db, "UPDATE math_bidtopid SET data = '[]' WHERE zid=%s AND math_env=%s",
                  (z, large))
            else:
                q(db, "UPDATE math_ptptstats SET math_tick = math_tick + 7 WHERE zid=%s AND "
                      "math_env=%s", (z, large))
            staged = fp(tpg, z, large)
            assert staged.complete is (damage == "invalid")
            with pytest.raises(PromotionRefused) as e:
                tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=None,
                                   expected_staged=staged)
            assert e.value.reason == "invalid_staged"
            assert target_tick(db, z, small) is None and fp(tpg, z, small) is None
        finally:
            spg.shutdown()
            tpg.shutdown()

    def test_only_into_its_own_label(self, pg_url, labels):
        small, large = labels
        _, tpg = publisher(pg_url, small)
        try:
            with pytest.raises(ValueError):
                tpg.promote_bundle(1, from_env=small, to_env=large, expected_target=None,
                                   expected_staged=None)
            with pytest.raises(ValueError):
                tpg.promote_bundle(1, from_env=small, to_env=small, expected_target=None,
                                   expected_staged=None)
        finally:
            tpg.shutdown()

    def test_a_staged_publication_in_progress_is_waited_for(self, pg_url, db, labels):
        """The staged writer holds its tick row (mid-publication): promotion
        waits on FOR SHARE, then sees the new staged bundle and refuses."""
        from polismath.database.postgres import PromotionRefused

        small, large = labels
        (z,) = fresh_zids(1)
        seed_conversation(db, z, participants=5, comments=3)
        stage, spg = publisher(pg_url, large)
        _, tpg = publisher(pg_url, small)
        writer = psycopg2.connect(pg_url)
        try:
            publish(stage, z)
            staged = fp(tpg, z, large)
            with writer.cursor() as cur:  # the staged writer's transaction begins
                cur.execute("UPDATE math_ticks SET math_tick = math_tick + 1 WHERE zid=%s AND "
                            "math_env=%s", (z, large))
                cur.execute("UPDATE math_main SET math_tick = math_tick + 1, modified = "
                            "modified + 1 WHERE zid=%s AND math_env=%s", (z, large))
                cur.execute("UPDATE math_bidtopid SET math_tick = math_tick + 1 WHERE zid=%s "
                            "AND math_env=%s", (z, large))
                cur.execute("UPDATE math_ptptstats SET math_tick = math_tick + 1 WHERE zid=%s "
                            "AND math_env=%s", (z, large))
            outcome = {}

            def promote():
                started = time.monotonic()
                try:
                    tpg.promote_bundle(z, from_env=large, to_env=small, expected_target=None,
                                       expected_staged=staged)
                    outcome["result"] = "promoted"
                except PromotionRefused as exc:
                    outcome["result"] = exc.reason
                outcome["waited"] = time.monotonic() - started

            t = threading.Thread(target=promote)
            t.start()
            time.sleep(0.6)
            assert t.is_alive()                     # blocked behind the staged writer
            writer.commit()
            t.join(10)
            assert outcome["result"] == "superseded" and outcome["waited"] >= 0.5
            assert target_tick(db, z, small) is None
        finally:
            writer.close()
            spg.shutdown()
            tpg.shutdown()

    def test_the_staged_writer_waits_for_a_promotion(self, pg_url, db, labels):
        """Promotion holds the staged tick row FOR SHARE: the staged writer's
        tick upsert cannot complete until the promotion commits."""
        small, large = labels
        (z,) = fresh_zids(1)
        seed_conversation(db, z, participants=5, comments=3)
        stage, spg = publisher(pg_url, large)
        promoting = psycopg2.connect(pg_url)
        staged_writer = psycopg2.connect(pg_url)
        try:
            publish(stage, z)
            with promoting.cursor() as cur:
                cur.execute("SELECT 1 FROM math_ticks WHERE zid=%s AND math_env=%s FOR SHARE",
                            (z, large))
            with staged_writer.cursor() as cur:
                cur.execute("SET lock_timeout = 300")
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    cur.execute("insert into math_ticks (zid, math_env) values (%s, %s) "
                                "on conflict (zid, math_env) do update set "
                                "math_tick = math_ticks.math_tick + 1", (z, large))
            staged_writer.rollback()
            promoting.commit()
        finally:
            promoting.close()
            staged_writer.close()
            spg.shutdown()

    def test_fingerprints_read_no_payload_and_flag_completeness(self, pg_url, db, labels):
        small, large = labels
        a, b = fresh_zids(2)
        for z in (a, b):
            seed_conversation(db, z, participants=4, comments=3)
        stage, spg = publisher(pg_url, large)
        try:
            publish(stage, a)
            publish(stage, b)
            q(db, "DELETE FROM math_ticks WHERE zid=%s AND math_env=%s", (b, large))
            got = spg.math_fingerprints([a, b, a], [large, small])
            assert set(got) == {(a, large), (b, large)}
            assert got[(a, large)].complete and not got[(b, large)].complete
            assert spg.math_fingerprints([], [large]) == {}
        finally:
            spg.shutdown()


# --------------------------------------------------------------------------- #
# The whole loop: small poller + queue + the child, on one database
# --------------------------------------------------------------------------- #
VOTES_LARGE = 40   # rows; the model below makes this need 40 MiB
VOTES_SMALL = 4


def model():
    from polismath.poller.admission import MemoryModel

    # need = vote rows x 1 MiB, exactly.
    return MemoryModel(base_mb=10, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                       job_floor_mb=0, retained_base_mb=0, retained_per_mcell_mb=0,
                       retained_per_voter_kb=0)


def seed_recent(db, zid, voters, comments):
    """A live conversation: votes inside the poll window."""
    return seed_conversation(db, zid, participants=voters, comments=comments,
                             created_ms=int(time.time() * 1000) - 120_000)


def vote_rows(db, zid):
    return q(db, "SELECT count(*) FROM votes WHERE zid=%s", (zid,))[0][0]


def small_service(url, small, large, *, zids, limit_mb=40, restage=None, state_path=None,
                  promote=True, queue=None):
    """Small compute capacity = limit - base: every conversation above 0.9 of
    it is routed. ``queue``: the recording fake of the queue contract."""
    from polismath.poller.admission import MemoryAdmission
    from polismath.poller.capacity import CapacityRouter, CapacitySettings
    from polismath.poller.service import MathPollerService, PollerConfig
    from tests.poller.test_capacity_queue import FakeQueue

    pg = client(url, small)
    adm = MemoryAdmission(limit_mb * MB, model(), headroom=0.0)
    settings = CapacitySettings(routing=True, promote=promote, staged_label=large,
                                restage=restage, state_path=state_path)
    # A static allowlist: other modules' recent votes share this database.
    cfg = PollerConfig(database_url=url, math_env=small, poll_from_days_ago=1,
                       worker_pool_size=2, reconcile_interval_ms=600000,
                       memory_limit_mb=limit_mb, allowlist=list(zids))
    svc = MathPollerService(pg, cfg, admission=adm, capacity=CapacityRouter(adm, settings),
                            run_id="0123456789ab")
    svc.capacity_queue = queue if queue is not None else FakeQueue()
    svc.capacity_loop._queue = svc.capacity_queue
    return svc, pg


def stage_with_the_child(url, queue, small, large, zid, tmp_path):
    """Run the queue child for the active job of ``zid`` as the daemon would:
    the frame carries the config the small poller enqueued. Marks the job
    finished afterwards."""
    from tests.poller.test_capacity_queue_postgres import daemon_env, run_child

    (job_id,) = [j for j, job in queue.jobs.items()
                 if job["scope"] == f"math:{small}:{zid}" and job["state"] == "queued"]
    config = queue.jobs[job_id]["config"]
    (tmp_path / job_id).mkdir(exist_ok=True)
    daemon, manifest = daemon_env(tmp_path / job_id, zid=zid, label=large, env="test",
                                  config=config)
    result = run_child(url, large, daemon)
    assert result.returncode == 0, result.stderr[-3000:]
    assert manifest.exists()
    queue.finish(job_id)
    return job_id


def drain(svc):
    assert svc._pool.join(timeout=60)


def cycle(svc):
    """One poll cycle, then the capacity loop once more: poll_once runs the
    loop before the pool has routed this cycle's work."""
    svc.poll_once()
    svc.capacity_loop.tick()


def counts(svc):
    """The counts as the readiness tick publishes them (the queue's depth read
    included)."""
    return svc.readiness_snapshot()["capacity"]


class TestTheLoop:
    def test_route_enqueue_stage_promote_update_restage(self, pg_url, db, labels, tmp_path):
        small, large = labels
        big, little = fresh_zids(2)
        seed_recent(db, big, voters=8, comments=8)          # ~40 vote rows
        seed_recent(db, little, voters=2, comments=3)
        assert vote_rows(db, big) > 36 > vote_rows(db, little)
        s_svc, s_pg = small_service(pg_url, small, large, zids=[big, little])
        queue = s_svc.capacity_queue
        try:
            # 1. The small poller computes the small one, routes the big one
            #    and asks the queue for one math_rebuild job.
            cycle(s_svc)
            assert coherent(db, little, small) and fp(s_pg, big, small) is None
            assert big not in s_svc.cached_zids()
            c = counts(s_svc)
            assert c["routed_total"] >= 1 and c["large_demand"] == 1 and c["large_leased"] == 0
            assert [call[0] for call in queue.calls] == [big] * len(queue.calls)
            (job_id,) = queue.jobs
            assert queue.jobs[job_id]["scope"] == f"math:{small}:{big}"
            assert queue.jobs[job_id]["config"]["target_label"] == small
            assert s_svc.capacity.record(big).job_id == job_id

            # 2. The child stages it under its own label only.
            stage_with_the_child(pg_url, queue, small, large, big, tmp_path)
            assert coherent(db, big, large) and fp(s_pg, little, large) is None
            assert fp(s_pg, big, small) is None                  # the small label untouched

            # 3. The small poller promotes it; demand clears (the queue's
            #    count once the job finished, the records' pending state).
            cycle(s_svc)
            assert rows(db, big, small) == rows(db, big, large)
            assert valid(db, big, small) is True
            c = counts(s_svc)
            assert (c["large_demand"], c["pending_promotion"], c["promoted_total"]) == (0, 0, 1)
            assert c["oldest_unresolved_age_ms"] is None
            asked = len(queue.calls)

            # 4. A new vote: the small poller does not compute it; the staged
            #    bundle is behind the input, so a new job is asked for; the
            #    child stages the newer bundle; promotion follows.
            now = int(time.time() * 1000)
            q(db, "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 1, 1, %s, %s)",
              (big, seed_vote(AGREE), now))
            cycle(s_svc)
            assert big not in s_svc.cached_zids() and len(queue.calls) > asked
            assert len(queue.jobs) == 2 and counts(s_svc)["large_demand"] == 1
            stage_with_the_child(pg_url, queue, small, large, big, tmp_path)
            assert fp(s_pg, big, large).lvt == now
            cycle(s_svc)
            assert fp(s_pg, big, small).lvt == now
            assert counts(s_svc)["large_demand"] == 0 and counts(s_svc)["promoted_total"] == 2
            asked = len(queue.calls)

            # 5. The restage nonce: a fresh build of the same votes and a
            #    promotion with an equal newest vote and a later write.
            before = fp(s_pg, big, small)
            s_svc.capacity.settings = s_svc.capacity.settings.__class__(
                **{**s_svc.capacity.settings.__dict__, "restage": "ab" * 8})
            s_svc.capacity_loop.settings = s_svc.capacity.settings
            cycle(s_svc)                                       # marks and asks for a job
            assert len(queue.jobs) == 3 and len(queue.calls) > asked
            assert s_svc.capacity.restage_applied == "ab" * 8
            stage_with_the_child(pg_url, queue, small, large, big, tmp_path)
            cycle(s_svc)
            after = fp(s_pg, big, small)
            assert after.lvt == before.lvt and after.modified > before.modified
            assert counts(s_svc)["large_demand"] == 0
            asked = len(queue.calls)
            cycle(s_svc)                                       # the same nonce never re-applies
            assert counts(s_svc)["large_demand"] == 0 and len(queue.calls) == asked
        finally:
            s_svc.stop()
            s_pg.shutdown()

    def test_restart_backfill_skip_and_resize(self, pg_url, db, labels, tmp_path):
        from polismath.poller.service import _BackfillHost

        small, large = labels
        (big,) = fresh_zids(1)
        seed_recent(db, big, voters=8, comments=8)
        dumps = tmp_path / "dumps"
        state = str(tmp_path / "capacity.json")
        s_svc, s_pg = small_service(pg_url, small, large, zids=[big], state_path=state)
        s_svc.config.dump_dir = str(dumps)
        queue = s_svc.capacity_queue
        try:
            cycle(s_svc)
            assert s_svc.capacity.is_routed(big)
            (job_id,) = queue.jobs
        finally:
            s_svc.stop()
            s_pg.shutdown()
        # A restart with the state file: the record (and its job) is back,
        # nothing is computed, dumped or parked for it, and the queue is
        # asked again for the same scope, which finds the active job.
        s2, pg2 = small_service(pg_url, small, large, zids=[big], state_path=state, queue=queue)
        s2.config.dump_dir = str(dumps)
        try:
            assert s2.capacity.record(big).job_id == job_id
            cycle(s2)
            assert s2.capacity.is_routed(big) and big not in s2.cached_zids()
            assert fp(pg2, big, small) is None and not s2._parked
            assert not dumps.exists() or not os.listdir(dumps)
            assert _BackfillHost(s2).accepts(big) is False
            assert set(queue.jobs) == {job_id}
        finally:
            s2.stop()
            pg2.shutdown()
        # A restart without the state file: the next cold touch sizes and
        # routes it again; the queue finds the same active job.
        s2b, pg2b = small_service(pg_url, small, large, zids=[big], queue=queue)
        s2b.config.dump_dir = str(dumps)
        try:
            cycle(s2b)
            assert s2b.capacity.is_routed(big) and fp(pg2b, big, small) is None
            assert set(queue.jobs) == {job_id} and s2b.capacity.record(big).job_id == job_id
        finally:
            s2b.stop()
            pg2b.shutdown()
        # The box is resized: the binding changes, the routed conversation is
        # re-sized without new input, fits, and the small poller computes it.
        s3, pg3 = small_service(pg_url, small, large, zids=[big], state_path=state, limit_mb=4096,
                                queue=queue)
        try:
            cycle(s3)                         # re-size + REBUILD submitted
            drain(s3)
            assert not s3.capacity.is_routed(big)
            assert coherent(db, big, small)
            asked = len(queue.calls)
            cycle(s3)
            assert len(queue.calls) == asked  # no longer routed: the queue is not asked
        finally:
            s3.stop()
            pg3.shutdown()
