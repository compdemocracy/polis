"""Oversized conversations are jobs, against a real Postgres (P-073 r2).

Same database resolution as the other poller integration tests
(``require_polis_postgres``), on the real migration chain: 000019 (the
queue), 000023 (the Delphi job table) and 000024 (the large worker class,
``polis-queue/3``) are expected, as the service image bakes them; a database
without them skips. Nothing here applies a migration and there is no
stand-in for the contract: the SQL the poller calls is the SQL the
deployment applies.

Generated fixtures only: every conversation is made up here, each test uses
its own queue env namespace and labels, and removes what it wrote.

Covered: the enqueue through the closed contract as an executor-member login
(and the refusal of a broad login); the real depth reply decoded and
published (finding 1 of the operating-surface map); idempotence under the
one-active-job-per-scope guard, the scope released after a cancel and a
fresh job admitted, a running job's scope kept until its exit is proven, and
three deaths making the scope poisoned, parked and counted (finding 2); the
child (``scripts/math_poller.py --job``, a subprocess under the frame the
daemon writes) checking the typed config whole, computing exactly one
conversation, staging it under the staged label only and writing its
manifest (finding 3); and promotion gated by the job's receipt: a staged
bundle whose job is not finalized is not served, a manifest the database
refused is no receipt, the daemon's finalize makes it servable (finding 4).
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
from polismath.poller.readiness import COMMIT_ENV
from tests.conftest import require_polis_postgres
from tests.poller.test_backfill_postgres import _TABLES, coherent, q, seed_conversation

pytestmark = pytest.mark.integration

MB = 1024 * 1024
HERE = Path(__file__).resolve().parent
DELPHI_DIR = HERE.parents[1]
GOLDEN_FRAME = HERE / "fixtures" / "queue" / "math_rebuild_frame.json"
LOGIN, PASSWORD = "math_queue_test", "generated-queue-test-secret"
HEARTBEAT_PHRASE = "math_poller readiness/1 role=primary progress=ok"
STALE_PHRASES = ("math_poller discovery_stale/1", "math_poller readiness_test/1")
COMMIT = "c" * 40


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
            for table, migration in (("polis_queue_jobs", "000019"),
                                     ("delphi_foundation_install", "000023"),
                                     ("polis_queue_large_class_install", "000024")):
                if q(conn, f"SELECT to_regclass('public.{table}')")[0][0] is None:
                    pytest.skip(f"the queue contract (migration {migration}) is not applied here")
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


def config_for(zid, small, large, *, input_ms=None, commit=COMMIT):
    return {"staged_label": large, "target_label": small, "need_bytes": 850 * MB,
            "input_through_ms": input_ms, "binding": "0" * 16, "source_commit": commit}


def job_row(db, env, job_id):
    return q(db, """SELECT q.state, q.stage, q.worker_class, d.kind, d.status, q.mgmt_version
                    FROM polis_queue_jobs q JOIN delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
                    WHERE q.env=%s AND q.job_id=%s""", (env, job_id))[0]


def guard(db, env, scope):
    rows = q(db, "SELECT root_job_id::text FROM delphi_job_guards WHERE env=%s AND scope_key=%s",
             (env, scope))
    return rows[0][0] if rows else None


def jobs(db, env):
    return q(db, "SELECT count(*) FROM polis_queue_jobs WHERE env=%s", (env,))[0][0]


def fp(db, zid, label):
    from polismath.database.postgres import PostgresClient, PostgresConfig

    pg = PostgresClient(PostgresConfig(url=db, math_env=label, ssl_mode="disable"))
    pg.initialize()
    try:
        return pg.math_fingerprints([zid], [label]).get((zid, label))
    finally:
        pg.shutdown()


def router_for(large, *, zid=None):
    from polismath.poller.admission import MemoryAdmission, MemoryModel
    from polismath.poller.capacity import CapacityRouter, CapacitySettings

    model = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                        job_floor_mb=0)
    router = CapacityRouter(MemoryAdmission(1000 * MB, model, headroom=0.0, base_bytes=100 * MB),
                            CapacitySettings(routing=True, staged_label=large))
    if zid is not None:
        assert router.observe(zid, need=850 * MB, input_ms=1) == "large"
    return router


class Daemon:
    """The daemon's SQL side, as the executor login: claim as class large,
    fail an attempt with exit proof, finalize with a manifest row, release a
    scope. The real daemon is proven in queue-rs and on the composed chain;
    these are its exact calls."""

    def __init__(self, url, env):
        self.conn = psycopg2.connect(url)
        self.conn.autocommit = True
        self.env = env
        self.seq = {}           # attempt_id -> next log row seq (the daemon numbers its rows)

    def close(self):
        self.conn.close()

    def claim(self, priority=1):
        owner, attempt = str(uuid.uuid4()), str(uuid.uuid4())
        reply = q(self.conn, "SELECT pq_claim(%s, %s::smallint, %s::uuid, %s::uuid, 60, 'large')",
                  (self.env, priority, owner, attempt))[0][0]
        if reply["outcome"] != "owned":
            return None
        return {"job_id": reply["job_id"], "owner": owner, "attempt": attempt,
                "epoch": int(reply["lease_epoch"])}

    def fail(self, claim, *, permanent=True, code="stage_failed:1"):
        return q(self.conn, "SELECT pq_fail(%s, %s::uuid, %s::uuid, %s::uuid, %s, %s, %s, true)",
                 (self.env, claim["job_id"], claim["owner"], claim["attempt"], claim["epoch"],
                  permanent, code))[0][0]

    def confirm_exit(self, claim):
        return q(self.conn, "SELECT pq_end_attempt(%s, %s::uuid, %s::uuid, %s::uuid, %s, "
                            "'confirm_exit', NULL, true)",
                 (self.env, claim["job_id"], claim["owner"], claim["attempt"],
                  claim["epoch"]))[0][0]

    def finalize(self, claim, manifest_text, *, sha=None):
        """The daemon's finalize: the manifest row, exit proof, pq_finalize."""
        seq = self.seq.get(claim["attempt"], 0)
        self.seq[claim["attempt"]] = seq + 1
        q(self.conn, "INSERT INTO polis_queue_logs(env, attempt_id, seq, stream, line) "
                     "VALUES (%s, %s::uuid, %s, 'manifest', %s)",
          (self.env, claim["attempt"], seq, manifest_text))
        assert self.confirm_exit(claim)["outcome"] == "exit_confirmed"
        return q(self.conn, "SELECT pq_finalize(%s, %s::uuid, %s::uuid, %s::uuid, %s, %s, %s)",
                 (self.env, claim["job_id"], claim["owner"], claim["attempt"], claim["epoch"],
                  "file:///work/output-manifest.json",
                  sha or cq.sha256_hex(manifest_text.encode("utf-8"))))[0][0]

    def release(self, scope):
        return q(self.conn, "SELECT pd_release_scope(%s, %s)", (self.env, scope))[0][0]


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
        assert guard(db, env, f"math:{small}:{zid}") == job_id
        # The run's input is the admission frame the daemon decodes for the child.
        uri, sha, contract = q(db, """SELECT r.input_uri, r.input_sha256, r.contract_version
                                      FROM polis_queue_runs r
                                      JOIN polis_queue_jobs j ON j.env=r.env AND j.run_id=r.run_id
                                      WHERE j.env=%s AND j.job_id=%s""", (env, job_id))[0]
        assert contract == "polis-queue/3"
        body = cq.decode_frame_uri(uri)
        assert cq.sha256_hex(body) == sha
        frame = json.loads(body)
        assert frame["zid"] == zid and frame["inputs"]["math_env"] == large
        assert set(frame["config"]) == {"staged_label", "target_label", "need_bytes",
                                        "input_through_ms", "binding", "source_commit"}
        assert frame["config"]["target_label"] == small and frame["config"]["need_bytes"] == 850 * MB
        # The job view names the scope the job holds.
        view = q(db, "SELECT pd_job_view(%s, %s::uuid)", (env, job_id))[0][0]
        assert view["scope_key"] == f"math:{small}:{zid}"

    def test_a_broad_login_is_refused_before_any_call(self, queue_db, env):
        broad = cq.QueueClient(cq.QueueSettings(dsn=queue_db[0], env=env))
        with pytest.raises(cq.QueueRefused):
            broad.class_depth()

    def test_the_real_depth_reply_is_decoded_and_published(self, queue_db, db, env, labels):
        """Finding 1: the reply 000024's pq_class_depth actually returns
        (queued, leased, parked, dead, oldest_unresolved_created_at) is
        decoded and lands on the capacity line."""
        from polismath.poller.capacity import validate_counts

        small, large = labels
        zids = fresh_zids(2)
        for zid in zids:
            seed_conversation(db, zid, participants=3, comments=3)
        c = client(queue_db, env)
        depth = c.class_depth()
        # 000024 answers /3; 000026 (when the image bakes it) answers /4 with
        # oldest_eligible_at.
        assert (set(depth), depth["schema_version"]) in (
            (cq.DEPTH_FIELDS, "polis-queue/3"), (cq.DEPTH_FIELDS_4, "polis-queue/4"))
        assert {k: depth[k] for k in cq.DEPTH_COUNTS} == {"queued": 0, "leased": 0, "parked": 0,
                                                          "dead": 0}
        assert depth["oldest_unresolved_created_at"] is None
        for zid in zids:
            c.enqueue_math_rebuild(zid, config=config_for(zid, small, large), staged_label=large,
                                   target_label=small)
        depth = c.class_depth()
        assert (depth["queued"], depth["leased"], depth["dead"]) == (2, 0, 0)
        assert depth["oldest_unresolved_created_at"] is not None and depth["worker_class"] == "large"
        if depth["schema_version"] == "polis-queue/4":
            assert depth["oldest_eligible_at"] is not None
        assert (c.class_depth("delphi")["queued"], c.class_depth("delphi")["leased"]) == (0, 0)
        # The daemon claims one as worker class large: leased.
        daemon = Daemon(queue_db[1], env)
        try:
            assert daemon.claim() is not None
        finally:
            daemon.close()
        depth = c.class_depth()
        assert (depth["queued"], depth["leased"]) == (1, 1)
        router = router_for(large)
        router.set_queue_depth(depth)
        counts = router.counts()
        validate_counts(counts)
        assert (counts["large_demand"], counts["large_leased"], counts["large_parked"]) == (1, 1, 0)

    def test_a_cancelled_job_frees_its_scope_and_a_fresh_job_is_admitted(self, queue_db, db, env,
                                                                        labels):
        """Finding 2: cancel -> re-enqueue succeeds. The cancelled job was
        never claimed, so the poller's own guarded release agrees."""
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
        assert jobs(db, env) == 1
        # Cancelled (an operator's pq_cancel): the guard stays until a safe
        # release; the next admission releases it and admits a fresh job.
        mgmt = job_row(db, env, first[1])[5]
        assert c.cancel(first[1], mgmt)["outcome"] == "cancelled"
        assert guard(db, env, f"math:{small}:{zid}") == first[1]
        third = c.enqueue_math_rebuild(zid, config=config_for(zid, small, large, input_ms=9),
                                       staged_label=large, target_label=small)
        assert third[0] == "enqueued" and third[1] != first[1]
        assert guard(db, env, f"math:{small}:{zid}") == third[1]
        assert jobs(db, env) == 2
        assert c.job_status(first[1])["state"] == "cancelled"
        assert not c.receipt(first[1]).finalized

    def test_a_running_jobs_scope_is_kept_until_its_exit_is_proven(self, queue_db, db, env,
                                                                   labels):
        """A cancelled job the daemon still runs keeps its guard: the release
        is refused (exit unproven) and the poller leaves it alone; the
        daemon's exit proof lets the next admission through."""
        small, large = labels
        (zid,) = fresh_zids(1)
        seed_conversation(db, zid, participants=3, comments=3)
        c = client(queue_db, env)
        cfg = config_for(zid, small, large)
        _, job_id = c.enqueue_math_rebuild(zid, config=cfg, staged_label=large, target_label=small)
        daemon = Daemon(queue_db[1], env)
        try:
            claim = daemon.claim()
            assert claim["job_id"] == job_id
            mgmt = job_row(db, env, job_id)[5]
            assert c.cancel(job_id, mgmt)["outcome"] == "cancelled"
            assert c.enqueue_math_rebuild(zid, config=cfg, staged_label=large,
                                          target_label=small) == ("existing", job_id)
            assert guard(db, env, f"math:{small}:{zid}") == job_id
            assert daemon.confirm_exit(claim)["outcome"] == "exit_confirmed"
        finally:
            daemon.close()
        outcome, fresh = c.enqueue_math_rebuild(zid, config=cfg, staged_label=large,
                                                target_label=small)
        assert outcome == "enqueued" and fresh != job_id

    def test_three_deaths_poison_the_scope_and_park_the_record(self, queue_db, db, env, labels):
        """Finding 2: dead x3 -> poisoned, no unlimited re-admission; a new
        source commit admits again."""
        small, large = labels
        (zid,) = fresh_zids(1)
        seed_conversation(db, zid, participants=3, comments=3)
        c = client(queue_db, env)
        router = router_for(large, zid=zid)
        daemon = Daemon(queue_db[1], env)
        dead = []
        try:
            for _ in range(3):
                job_id = cq.enqueue_routed(c, router, zid, staged_label=large, target_label=small,
                                           source_commit=COMMIT)
                assert job_id not in dead
                claim = daemon.claim()
                assert claim["job_id"] == job_id
                assert daemon.fail(claim)["state"] == "dead"
                # The daemon releases the scope after the terminal attempt.
                assert daemon.release(f"math:{small}:{zid}") is True
                dead.append(job_id)
            latest = cq.enqueue_routed(c, router, zid, staged_label=large, target_label=small,
                                       source_commit=COMMIT)
            assert latest == dead[-1]
            rec = router.record(zid)
            assert rec.poisoned_commit == COMMIT and rec.job_id == dead[-1]
            assert router.poisoned(zid, COMMIT) and router.counts()["large_poisoned"] == 1
            assert jobs(db, env) == 3 and guard(db, env, f"math:{small}:{zid}") is None
            assert c.class_depth()["dead"] == 3
            # A new deploy: another source commit admits again.
            fresh = cq.enqueue_routed(c, router, zid, staged_label=large, target_label=small,
                                      source_commit="d" * 40)
            assert fresh not in dead and router.record(zid).poisoned_commit is None
            assert jobs(db, env) == 4
        finally:
            daemon.close()


def daemon_env(tmp_path, *, zid, label, config, env, job_id=None, attempt_id=None):
    """A generated attempt directory, frame and environment, as the daemon
    makes them for a math_rebuild job: the frame is the golden one queue-rs
    pins (``fixtures/queue/math_rebuild_frame.json``) with this attempt's
    identity, conversation, label and config."""
    job_id = job_id or str(uuid.uuid4())
    attempt_id = attempt_id or str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    attempt = tmp_path / f"attempt-{attempt_id}"
    attempt.mkdir()
    frame = json.loads(GOLDEN_FRAME.read_text())
    frame.update({"env": env, "zid": zid, "job_id": job_id, "run_id": run_id,
                  "attempt_id": attempt_id, "config": config,
                  "inputs": {"math_env": label, "requested_math_tick": None}})
    (attempt / "frame.json").write_text(json.dumps(frame))
    manifest = attempt / "output-manifest.json"
    return {"DELPHI_JOB_ID": job_id, "DELPHI_RUN_ID": run_id, "DELPHI_ATTEMPT_ID": attempt_id,
            "DELPHI_LEASE_EPOCH": "1", "DELPHI_STAGE": "math_rebuild",
            "DELPHI_OUTPUT_MANIFEST": str(manifest), "DELPHI_FRAME": str(attempt / "frame.json")}, manifest


def run_child(pg_url, label, daemon, *, extra=None, commit=COMMIT):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("MATH_", "DELPHI_", "POLL_", "DATABASE_"))}
    env.update({
        "DATABASE_URL": pg_url, "DATABASE_SSL_MODE": "disable", "MATH_ENV": label,
        "MATH_POLLER_MEMORY_LIMIT_MB": "4096", "POSTGRES_CONNECT_TIMEOUT": "10",
        "MATH_POLLER_LOCK_LIVENESS_S": "1", "LOG_LEVEL": "INFO",
        "PYTHONPATH": str(DELPHI_DIR) + os.pathsep + env.get("PYTHONPATH", ""),
    })
    if commit is not None:
        env[COMMIT_ENV] = commit
    env.update(daemon)
    env.update(extra or {})
    return subprocess.run([sys.executable, str(DELPHI_DIR / "scripts" / "math_poller.py"), "--job"],
                          cwd=str(DELPHI_DIR), env=env, capture_output=True, text=True,
                          timeout=600)


def small_poller(pg_url, small, large, *, queue, zid, promote=True):
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller.admission import MemoryAdmission, MemoryModel
    from polismath.poller.capacity import CapacityRouter, CapacitySettings
    from polismath.poller.promotion import SmallCapacityLoop
    from polismath.poller.service import MathPollerService, PollerConfig

    pg = PostgresClient(PostgresConfig(url=pg_url, math_env=small, ssl_mode="disable"))
    pg.initialize()
    model = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                        job_floor_mb=0)
    adm = MemoryAdmission(1000 * MB, model, headroom=0.0, base_bytes=100 * MB)
    settings = CapacitySettings(routing=True, promote=promote, staged_label=large)
    router = CapacityRouter(adm, settings)
    assert router.observe(zid, need=850 * MB, input_ms=1) == "large"
    svc = MathPollerService(pg, PollerConfig(database_url=pg_url, math_env=small,
                                             memory_limit_mb=1000),
                            admission=adm, capacity=router)
    loop = SmallCapacityLoop(svc, router, settings, queue=queue, source_commit=COMMIT)
    return pg, router, loop


class TestTheChild:
    def test_computes_one_conversation_stages_it_and_promotion_waits_for_the_receipt(
            self, queue_db, db, env, labels, tmp_path):
        """Findings 3 and 4 on the real chain: the child under the daemon's
        frame checks the typed config and stages one conversation; the
        staged bundle is promoted only once the daemon has finalized the
        job (the interruption between the staged commit and finalize
        promotes nothing), and never on a manifest the database refused."""
        small, large = labels
        big, other = fresh_zids(2)
        seed_conversation(db, big, participants=6, comments=6)
        seed_conversation(db, other, participants=4, comments=4)
        pg_url = queue_db[0]
        c = client(queue_db, env)
        pg, router, loop = small_poller(pg_url, small, large, queue=c, zid=big)
        daemon = Daemon(queue_db[1], env)
        try:
            # The small poller admits the job; the daemon claims it.
            loop.tick()
            job_id = router.record(big).job_id
            assert job_id is not None and job_row(db, env, job_id)[0] == "queued"
            claim = daemon.claim()
            assert claim["job_id"] == job_id
            # The child runs under the frame the daemon writes for that job:
            # the admission's typed config, carried whole.
            status = c.job_status(job_id)
            admitted = json.loads(cq.decode_frame_uri(status["input"]["uri"]))
            daemon_vars, manifest = daemon_env(tmp_path, zid=big, label=large, env=env,
                                               config=admitted["config"], job_id=job_id,
                                               attempt_id=claim["attempt"])
            result = run_child(pg_url, large, daemon_vars)
            assert result.returncode == 0, result.stderr[-3000:]
            assert "frame checked:" in result.stderr
            # Exactly the one conversation, under the staged label only.
            assert coherent(db, big, large)
            assert fp(pg_url, other, large) is None and fp(pg_url, big, small) is None
            staged = fp(pg_url, big, large)
            assert staged is not None and staged.complete
            m = json.loads(manifest.read_text())
            assert (m["stage"], m["outcome"], m["job_id"]) == ("math_rebuild", "succeeded", job_id)
            assert m["inputs"]["math_env"] == large and m["inputs"]["math_tick"] == staged.math_tick
            assert m["inputs"]["vote_hwm"] == staged.lvt and m["outputs"] == []
            assert not any(p in result.stderr for p in (HEARTBEAT_PHRASE,) + STALE_PHRASES)

            # The interruption: the staged bundle is committed, the daemon has
            # not finalized the attempt (the job is still running). No
            # promotion; the record waits (pending), nothing is asked for.
            assert job_row(db, env, job_id)[0] == "running"
            loop.tick()
            assert fp(pg_url, big, small) is None
            counts = router.counts()
            assert (counts["pending_promotion"], counts["promoted_total"]) == (1, 0)
            assert not c.receipt(job_id).finalized

            # A manifest the database refuses (a digest that names no row)
            # is no receipt either.
            text = manifest.read_text().rstrip("\n")
            refused = daemon.finalize(claim, text, sha="0" * 64)
            assert refused["outcome"] == "invalid_output" and job_row(db, env, job_id)[0] == "running"
            loop.tick()
            assert fp(pg_url, big, small) is None and not c.receipt(job_id).finalized

            # The daemon finalizes: the receipt names the staged bundle, and
            # the small poller promotes it.
            done = daemon.finalize(claim, text)
            assert done["outcome"] == "succeeded", done
            receipt = c.receipt(job_id)
            assert receipt.finalized and receipt.binds(staged, large)
            assert receipt.output_sha256 == cq.sha256_hex(text.encode("utf-8"))
            loop.tick()
            assert coherent(db, big, small)
            target = fp(pg_url, big, small)
            assert target.lvt == staged.lvt
            counts = router.counts()
            assert (counts["pending_promotion"], counts["promoted_total"]) == (0, 1)
            # The daemon releases the scope after the terminal attempt; the
            # record keeps its job id for the receipt.
            assert daemon.release(f"math:{small}:{big}") is True
            assert router.record(big).job_id == job_id
        finally:
            daemon.close()
            pg.shutdown()

    def test_refuses_skew_an_untyped_frame_and_a_served_label_without_touching_the_database(
            self, queue_db, db, env, labels, tmp_path):
        small, large = labels
        (big,) = fresh_zids(1)
        seed_conversation(db, big, participants=3, comments=3)
        daemon, manifest = daemon_env(tmp_path, zid=big, label=large, env=env,
                                      config=config_for(big, small, large, commit="b" * 40))
        result = run_child(queue_db[0], large, daemon)
        assert result.returncode == 2 and "version skew" in result.stderr
        assert fp(queue_db[0], big, large) is None and not manifest.exists()
        # A frame without the typed config (the old untyped shape): refused.
        daemon, manifest = daemon_env(tmp_path, zid=big, label=large, env=env,
                                      config={"need_bytes": 1, "staged_label": large})
        result = run_child(queue_db[0], large, daemon)
        assert result.returncode == 2 and "typed math config" in result.stderr
        assert not manifest.exists()
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
