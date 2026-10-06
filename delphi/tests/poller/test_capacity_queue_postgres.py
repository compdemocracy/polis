"""Oversized conversations are jobs, against a real Postgres (P-073 r2).

Same database resolution as the other poller integration tests
(``require_polis_postgres``), and then the queue contract on top of it:
000019 is expected (the service image bakes it); 000023 (the Delphi job
table, pull request #2968) is applied from the fixture copy under
``fixtures/queue/`` when the database lacks it; and the ``polis-queue/3``
functions the poller calls come from ``fixtures/queue/polis_queue_3_standin.sql``,
a TEST STAND-IN for the /3 migration that is a separate pull request (see
that file's header). When the real migration lands, ``STANDIN`` below points
at it and the stand-in file goes.

Generated fixtures only: every conversation is made up here, each test uses
its own queue env namespace and labels, and removes what it wrote.

Covered: the enqueue through the closed contract as an executor-member login
(and the refusal of a broad login); idempotence under the one-active-job-
per-scope guard (the same job while active, a new job after the previous one
finished); ``pq_class_depth`` before and after a claim; the child
(``scripts/math_poller.py --job``, a subprocess under a generated daemon
environment) computing exactly one conversation, staging it under the staged
label only and writing its manifest; and the small poller's unchanged
promotion of that staged bundle.
"""

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg2
import pytest

from polismath.poller import capacity_queue as cq
from tests.conftest import require_polis_postgres
from tests.poller.test_backfill_postgres import _TABLES, coherent, q, seed_conversation

pytestmark = pytest.mark.integration

MB = 1024 * 1024
HERE = Path(__file__).resolve().parent
DELPHI_DIR = HERE.parents[1]
FIXTURES = HERE / "fixtures" / "queue"
FOUNDATION = FIXTURES / "000023_create_delphi_foundation.sql"
STANDIN = FIXTURES / "polis_queue_3_standin.sql"
LOGIN, PASSWORD = "math_queue_test", "generated-queue-test-secret"
HEARTBEAT_PHRASE = "math_poller readiness/1 role=primary progress=ok"
STALE_PHRASES = ("math_poller discovery_stale/1", "math_poller readiness_test/1")


def _executor_url(url):
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    host = parts.hostname or "localhost"
    netloc = f"{LOGIN}:{PASSWORD}@{host}" + (f":{parts.port}" if parts.port else "")
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


@pytest.fixture(scope="module")
def queue_db():
    with require_polis_postgres() as url:
        conn = psycopg2.connect(url)
        conn.autocommit = True
        try:
            if q(conn, "SELECT to_regclass('public.polis_queue_jobs')")[0][0] is None:
                pytest.skip("the queue tables (migration 000019) are not applied here")
            if q(conn, "SELECT to_regclass('public.delphi_foundation_install')")[0][0] is None:
                with conn.cursor() as cur:
                    cur.execute(FOUNDATION.read_text())
            if q(conn, "SELECT to_regprocedure('public.pq_class_depth(text,text)')")[0][0] is None:
                with conn.cursor() as cur:
                    cur.execute(STANDIN.read_text())
            q(conn, f"""DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{LOGIN}') THEN
                  CREATE ROLE {LOGIN} LOGIN PASSWORD '{PASSWORD}' IN ROLE polis_queue_executor;
                END IF; END $$""")
            yield url, _executor_url(url)
        finally:
            conn.close()


@pytest.fixture
def db(queue_db):
    conn = psycopg2.connect(queue_db[0])
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def env():
    return f"test-{uuid.uuid4().hex[:10]}"


@pytest.fixture
def labels():
    tag = uuid.uuid4().hex[:8]
    return f"qsmall_{tag}", f"qlarge_{tag}"


_zid_base = [30000 + (uuid.uuid4().int % 500) * 100]
_used = []


def fresh_zids(n):
    base = _zid_base[0]
    _zid_base[0] += 100
    zids = list(range(base, base + n))
    _used.extend(zids)
    return zids


@pytest.fixture(autouse=True)
def _cleanup(db, env, labels):
    yield
    for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks"):
        q(db, f"DELETE FROM {table} WHERE math_env = ANY(%s)", (list(labels),))
    # Heads reference runs (deferred), jobs reference runs: heads and jobs go
    # before runs.
    for table in ("delphi_job_guards", "polis_queue_requests", "polis_queue_logs",
                  "polis_queue_attempts", "delphi_jobs", "polis_queue_jobs", "polis_queue_heads",
                  "polis_queue_runs"):
        q(db, f"DELETE FROM {table} WHERE env = %s", (env,))
    zids = list(_used)
    _used.clear()
    if zids:
        q(db, "SET session_replication_role = replica")
        for table in _TABLES:
            q(db, f"DELETE FROM {table} WHERE zid = ANY(%s)", (zids,))
        q(db, "SET session_replication_role = DEFAULT")


def client(queue_db, env):
    return cq.QueueClient(cq.QueueSettings(dsn=queue_db[1], env=env))


def config_for(zid, small, large, *, input_ms=None, commit=None):
    return {"staged_label": large, "target_label": small, "need_bytes": 850 * MB,
            "input_through_ms": input_ms, "binding": "0" * 16, "source_commit": commit}


def job_row(db, env, job_id):
    return q(db, """SELECT q.state, q.stage, q.worker_class, d.kind, d.status, q.mgmt_version
                    FROM polis_queue_jobs q JOIN delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
                    WHERE q.env=%s AND q.job_id=%s""", (env, job_id))[0]


def fp(db, zid, label):
    from polismath.database.postgres import PostgresClient, PostgresConfig

    pg = PostgresClient(PostgresConfig(url=db, math_env=label, ssl_mode="disable"))
    pg.initialize()
    try:
        return pg.math_fingerprints([zid], [label]).get((zid, label))
    finally:
        pg.shutdown()


class TestTheContract:
    def test_enqueue_as_the_executor_login_and_the_row_it_makes(self, queue_db, db, env, labels):
        small, large = labels
        (zid,) = fresh_zids(1)
        seed_conversation(db, zid, participants=3, comments=3)
        outcome, job_id = client(queue_db, env).enqueue_math_rebuild(
            zid, config=config_for(zid, small, large, input_ms=5), staged_label=large,
            target_label=small)
        assert outcome == "enqueued"
        state, stage, klass, kind, status, _ = job_row(db, env, job_id)
        assert (state, stage, klass, kind, status) == ("queued", "math_rebuild", "large",
                                                       "math_rebuild", "queued")
        guard = q(db, "SELECT scope_key, zid, root_job_id::text FROM delphi_job_guards WHERE env=%s",
                  (env,))
        assert guard == [(f"math:{small}:{zid}", zid, job_id)]
        # The run's input is the admission frame the daemon decodes for the child.
        uri, sha = q(db, """SELECT r.input_uri, r.input_sha256 FROM polis_queue_runs r
                            JOIN polis_queue_jobs j ON j.env=r.env AND j.run_id=r.run_id
                            WHERE j.env=%s AND j.job_id=%s""", (env, job_id))[0]
        body = cq.decode_frame_uri(uri)
        assert cq.sha256_hex(body) == sha
        frame = json.loads(body)
        assert frame["zid"] == zid and frame["inputs"]["math_env"] == large
        assert frame["config"]["target_label"] == small and frame["config"]["need_bytes"] == 850 * MB

    def test_a_broad_login_is_refused_before_any_call(self, queue_db, env):
        broad = cq.QueueClient(cq.QueueSettings(dsn=queue_db[0], env=env))
        with pytest.raises(cq.QueueRefused):
            broad.class_depth()

    def test_idempotent_under_the_scope_guard(self, queue_db, db, env, labels):
        small, large = labels
        (zid,) = fresh_zids(1)
        seed_conversation(db, zid, participants=3, comments=3)
        c = client(queue_db, env)
        cfg = config_for(zid, small, large, input_ms=5)
        first = c.enqueue_math_rebuild(zid, config=cfg, staged_label=large, target_label=small)
        again = c.enqueue_math_rebuild(zid, config=cfg, staged_label=large, target_label=small)
        assert first[0] == "enqueued" and again == ("existing", first[1])
        # New input while the job is active: the active job, not a second one.
        newer = c.enqueue_math_rebuild(zid, config=config_for(zid, small, large, input_ms=9),
                                       staged_label=large, target_label=small)
        assert newer == ("conflict", first[1])
        assert q(db, "SELECT count(*) FROM polis_queue_jobs WHERE env=%s", (env,))[0][0] == 1
        # The job finishes (cancelled here, the daemon's job in production):
        # the scope is released and a fresh job is admitted.
        mgmt = job_row(db, env, first[1])[5]
        assert c.cancel(first[1], mgmt)["outcome"] == "cancelled"
        third = c.enqueue_math_rebuild(zid, config=config_for(zid, small, large, input_ms=9),
                                       staged_label=large, target_label=small)
        assert third[0] == "enqueued" and third[1] != first[1]
        assert q(db, "SELECT count(*) FROM polis_queue_jobs WHERE env=%s", (env,))[0][0] == 2
        assert c.job_status(first[1])["state"] == "cancelled"

    def test_class_depth_counts_queued_then_leased(self, queue_db, db, env, labels):
        small, large = labels
        zids = fresh_zids(2)
        for zid in zids:
            seed_conversation(db, zid, participants=3, comments=3)
        c = client(queue_db, env)
        assert {k: c.class_depth()[k] for k in ("queued", "running", "dead")} == {
            "queued": 0, "running": 0, "dead": 0}
        for zid in zids:
            c.enqueue_math_rebuild(zid, config=config_for(zid, small, large), staged_label=large,
                                   target_label=small)
        depth = c.class_depth()
        assert (depth["queued"], depth["running"], depth["dead"]) == (2, 0, 0)
        assert depth["oldest_created_at"] is not None and depth["worker_class"] == "large"
        assert (c.class_depth("delphi")["queued"], c.class_depth("delphi")["running"]) == (0, 0)
        # The daemon (stood in for here) claims one as worker class large.
        ex = psycopg2.connect(queue_db[1])
        ex.autocommit = True
        try:
            owned = q(ex, "SELECT pq_claim(%s, 1::smallint, %s::uuid, %s::uuid, 60, 'large')",
                      (env, str(uuid.uuid4()), str(uuid.uuid4())))[0][0]
        finally:
            ex.close()
        assert owned["outcome"] == "owned" and owned["stage"] == "math_rebuild"
        depth = c.class_depth()
        assert (depth["queued"], depth["running"]) == (1, 1)


def daemon_env(tmp_path, *, zid, label, config, env, commit=None):
    """A generated attempt directory, frame and environment, as the daemon
    makes them for a math_rebuild job."""
    job_id, run_id, attempt_id = (str(uuid.uuid4()) for _ in range(3))
    attempt = tmp_path / f"attempt-{attempt_id}"
    attempt.mkdir()
    frame = {"schema": "polis-jobs.frame/1", "env": env, "zid": zid, "report_id": None,
             "job_id": job_id, "run_id": run_id, "attempt_id": attempt_id, "lease_epoch": "1",
             "stage": "math_rebuild", "phase": "run", "config": config,
             "inputs": {"math_env": label, "requested_math_tick": None},
             "provider": {"batch_id": None}}
    (attempt / "frame.json").write_text(json.dumps(frame))
    manifest = attempt / "output-manifest.json"
    return {"DELPHI_JOB_ID": job_id, "DELPHI_RUN_ID": run_id, "DELPHI_ATTEMPT_ID": attempt_id,
            "DELPHI_LEASE_EPOCH": "1", "DELPHI_STAGE": "math_rebuild",
            "DELPHI_OUTPUT_MANIFEST": str(manifest), "DELPHI_FRAME": str(attempt / "frame.json")}, manifest


def run_child(pg_url, label, daemon, *, extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("MATH_", "DELPHI_", "POLL_", "DATABASE_"))}
    env.update({
        "DATABASE_URL": pg_url, "DATABASE_SSL_MODE": "disable", "MATH_ENV": label,
        "MATH_POLLER_MEMORY_LIMIT_MB": "4096", "POSTGRES_CONNECT_TIMEOUT": "10",
        "MATH_POLLER_LOCK_LIVENESS_S": "1", "LOG_LEVEL": "INFO",
        "PYTHONPATH": str(DELPHI_DIR) + os.pathsep + env.get("PYTHONPATH", ""),
    })
    env.update(daemon)
    env.update(extra or {})
    return subprocess.run([sys.executable, str(DELPHI_DIR / "scripts" / "math_poller.py"), "--job"],
                          cwd=str(DELPHI_DIR), env=env, capture_output=True, text=True,
                          timeout=600)


class TestTheChild:
    def test_computes_one_conversation_stages_it_and_the_small_poller_promotes(
            self, queue_db, db, env, labels, tmp_path):
        from polismath.database.postgres import PostgresClient, PostgresConfig
        from polismath.poller.admission import MemoryAdmission, MemoryModel
        from polismath.poller.capacity import CapacityRouter, CapacitySettings
        from polismath.poller.promotion import SmallCapacityLoop
        from polismath.poller.service import MathPollerService, PollerConfig

        small, large = labels
        big, other = fresh_zids(2)
        seed_conversation(db, big, participants=6, comments=6)
        seed_conversation(db, other, participants=4, comments=4)
        pg_url = queue_db[0]
        daemon, manifest = daemon_env(tmp_path, zid=big, label=large, env=env,
                                      config=config_for(big, small, large, input_ms=1))
        result = run_child(pg_url, large, daemon)
        assert result.returncode == 0, result.stderr[-3000:]
        # Exactly the one conversation, under the staged label only.
        assert coherent(db, big, large)
        assert fp(pg_url, other, large) is None and fp(pg_url, big, small) is None
        staged = fp(pg_url, big, large)
        assert staged is not None and staged.complete
        m = json.loads(manifest.read_text())
        assert (m["stage"], m["outcome"], m["job_id"]) == ("math_rebuild", "succeeded",
                                                             daemon["DELPHI_JOB_ID"])
        assert m["inputs"]["math_env"] == large and m["inputs"]["math_tick"] == staged.math_tick
        assert m["inputs"]["vote_hwm"] == staged.lvt and m["outputs"] == []
        assert not any(p in result.stderr for p in (HEARTBEAT_PHRASE,) + STALE_PHRASES)
        assert f"staged zid={big} under {large}" in result.stderr

        # The small poller's promotion (unchanged path): the staged bundle
        # becomes the small label's publication.
        pg = PostgresClient(PostgresConfig(url=pg_url, math_env=small, ssl_mode="disable"))
        pg.initialize()
        try:
            model = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                                job_floor_mb=0)
            adm = MemoryAdmission(1000 * MB, model, headroom=0.0, base_bytes=100 * MB)
            settings = CapacitySettings(routing=True, promote=True, staged_label=large)
            router = CapacityRouter(adm, settings)
            assert router.observe(big, need=850 * MB, input_ms=1) == "large"
            svc = MathPollerService(pg, PollerConfig(database_url=pg_url, math_env=small,
                                                     memory_limit_mb=1000),
                                    admission=adm, capacity=router)
            loop = SmallCapacityLoop(svc, router, settings, queue=None)
            loop.tick()
            assert coherent(db, big, small)
            target = fp(pg_url, big, small)
            assert target.lvt == staged.lvt
            c = router.counts()
            assert (c["large_demand"], c["pending_promotion"], c["promoted_total"]) == (0, 0, 1)
        finally:
            pg.shutdown()

    def test_refuses_skew_and_a_served_label_without_touching_the_database(
            self, queue_db, db, env, labels, tmp_path):
        small, large = labels
        (big,) = fresh_zids(1)
        seed_conversation(db, big, participants=3, comments=3)
        daemon, manifest = daemon_env(tmp_path, zid=big, label=large, env=env,
                                      config=config_for(big, small, large, commit="b" * 40))
        result = run_child(queue_db[0], large, daemon)
        assert result.returncode == 2 and "version skew" in result.stderr
        assert fp(queue_db[0], big, large) is None and not manifest.exists()
        daemon, manifest = daemon_env(tmp_path, zid=big, label="python", env=env,
                                      config=config_for(big, small, "python"))
        result = run_child(queue_db[0], "python", daemon)
        assert result.returncode == 2 and not manifest.exists()
        assert fp(queue_db[0], big, "python") is None

    def test_another_writer_of_the_label_is_a_failed_attempt(self, queue_db, db, env, labels,
                                                              tmp_path):
        small, large = labels
        (big,) = fresh_zids(1)
        seed_conversation(db, big, participants=3, comments=3)
        holder = psycopg2.connect(queue_db[0])
        holder.autocommit = True
        try:
            q(holder, "SELECT pg_advisory_lock(hashtext(%s))", (f"polis-math-python:{large}",))
            daemon, manifest = daemon_env(tmp_path, zid=big, label=large, env=env,
                                          config=config_for(big, small, large))
            started = time.monotonic()
            result = run_child(queue_db[0], large, daemon)
            assert result.returncode == 1 and "is held by" in result.stderr
            assert time.monotonic() - started < 120
            assert fp(queue_db[0], big, large) is None and not manifest.exists()
        finally:
            holder.close()
