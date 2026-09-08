"""P-024 first slice: the transitional polis-queue/1 noop executor against Postgres.

Opt-in integration test. It uses the repository's existing prerequisite
discovery (``tests.conftest.require_polis_postgres``), so it skips cleanly when
neither ``POLIS_TEST_POSTGRES_URL`` nor docker is available, then applies
``server/postgres/migrations/000019_create_polis_queue.sql`` itself - a replay
when the service image already baked it in, a fresh apply otherwise.

The executor runs under a dedicated login that is a member of
``polis_queue_executor`` and holds no direct table write, which is the boundary
the migration's grants define. The provisioning login (the one the fixture
hands us) is only used to apply the migration and to act as the producer.

Not claimed: gates A1-A8. No COMMIT is severed here and no Rust adapter exists.
"""

import os
import re
import uuid

import pytest

from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration

MIGRATION = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "server",
    "postgres",
    "migrations",
    "000019_create_polis_queue.sql",
)

ENV = "test-p024-py"
PRODUCT = "product-noop"
ACTOR = "synthetic-actor"
LOCAL_ROLE_PASSWORD = "pq-local-test"


def _executor_dsn(url: str, user: str, password: str) -> str:
    """Swap the login in a postgres URL, leaving host/port/database alone."""
    return re.sub(r"^(postgres(?:ql)?://)[^@]*@", rf"\1{user}:{password}@", url)


@pytest.fixture(scope="module")
def queue_db():
    """A Postgres with the queue migration applied, plus a restricted login."""
    import psycopg2

    with require_polis_postgres() as url:
        suffix = uuid.uuid4().hex[:8]
        role = f"pq_x_{suffix}"
        conn = psycopg2.connect(url)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname=current_user")
                privileged = cur.fetchone()[0]
            if not privileged:
                pytest.skip(
                    "the test Postgres login can neither create roles nor apply "
                    "the queue migration; provide a superuser or CREATEROLE login"
                )
            with open(MIGRATION, "r", encoding="utf-8") as handle:
                migration_sql = handle.read()
            with conn.cursor() as cur:
                cur.execute(migration_sql)
                cur.execute(
                    f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEROLE "
                    f"PASSWORD '{LOCAL_ROLE_PASSWORD}' IN ROLE polis_queue_executor"
                )
                cur.execute(
                    "INSERT INTO conversations (topic) VALUES (%s) RETURNING zid",
                    (f"p024 queue noop {suffix}",),
                )
                zid = cur.fetchone()[0]
            yield {
                "url": url,
                "zid": zid,
                "env": f"{ENV}-{suffix}",
                "executor_dsn": _executor_dsn(url, role, LOCAL_ROLE_PASSWORD),
                "role": role,
            }
            with conn.cursor() as cur:
                for table in (
                    "polis_queue_requests",
                    "polis_queue_attempts",
                    "polis_queue_jobs",
                    "polis_queue_heads",
                    "polis_queue_runs",
                ):
                    cur.execute(
                        f"DELETE FROM public.{table} WHERE env LIKE %s", (f"{ENV}-%",)
                    )
                cur.execute("DELETE FROM conversations WHERE zid=%s", (zid,))
                cur.execute(f"DROP OWNED BY {role}")
                cur.execute(f"DROP ROLE IF EXISTS {role}")
        finally:
            conn.close()


@pytest.fixture(autouse=True)
def _opt_in(monkeypatch):
    monkeypatch.setenv("POLIS_QUEUE_SUBSTRATE_ENABLED", "true")
    monkeypatch.delenv("NODE_ENV", raising=False)


def _enqueue(queue_db, key, *, uri=None, sha=None, image=None, max_attempts=3):
    """Produce one job as the provisioning login, mirroring the Node adapter."""
    import psycopg2

    from polismath.queue import executor as ex

    conn = psycopg2.connect(queue_db["url"])
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT public.pq_enqueue(%s::text,%s::integer,%s::text,%s::text,%s::text,"
                "%s::text,%s::uuid,%s::uuid,%s::text,%s::text,%s::text,%s::text,"
                "%s::smallint,%s::integer)",
                [
                    queue_db["env"],
                    queue_db["zid"],
                    PRODUCT,
                    ACTOR,
                    key,
                    "1" * 64,
                    str(uuid.uuid4()),
                    str(uuid.uuid4()),
                    uri or ex.NOOP_URI,
                    sha or ex.NOOP_SHA256,
                    sha or ex.NOOP_SHA256,
                    image or ex.NOOP_IMAGE,
                    1,
                    max_attempts,
                ],
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def _make_executor(queue_db, env=None):
    from polismath.queue import executor as ex

    settings = ex.Settings(dsn=queue_db["executor_dsn"], env=env or queue_db["env"])
    return ex.Executor(ex.Database(settings), settings.env, sleep=lambda _: None)


def test_sql_pin_matches_the_migration_on_disk():
    """Round 4: both adapters pin the SQL they were written against."""
    import hashlib

    from polismath.queue import executor as ex

    with open(MIGRATION, "rb") as handle:
        assert hashlib.sha256(handle.read()).hexdigest() == ex.QUEUE_SQL_SHA256


def test_refuses_without_the_opt_in_flag(monkeypatch):
    from polismath.queue import executor as ex

    monkeypatch.delenv("POLIS_QUEUE_SUBSTRATE_ENABLED", raising=False)
    with pytest.raises(ex.ExecutorRefused):
        ex.Settings(dsn="postgresql://localhost/x", env="test").check()


def test_refuses_in_production(monkeypatch):
    from polismath.queue import executor as ex

    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(ex.ExecutorRefused):
        ex.Settings(dsn="postgresql://localhost/x", env="test").check()


def test_refuses_an_env_outside_the_dev_test_namespace():
    from polismath.queue import executor as ex

    with pytest.raises(ex.ExecutorRefused):
        ex.Settings(dsn="postgresql://localhost/x", env="prod").check()


def test_wire_validator_rejects_unknown_and_missing_fields():
    from polismath.queue import executor as ex

    ordinary = {field: None for field in ex.ORDINARY_FIELDS}
    ordinary.update(
        schema_version="polis-queue/1", outcome="none", published=False, input=None
    )
    assert ex.validate(dict(ordinary)) is not None
    with pytest.raises(ex.ProtocolError):
        ex.validate(dict(ordinary, extra="x"))
    missing = dict(ordinary)
    del missing["first_parked_at"]
    with pytest.raises(ex.ProtocolError):
        ex.validate(missing)
    with pytest.raises(ex.ProtocolError):
        ex.validate(dict(ordinary, schema_version="polis-queue/2"))
    with pytest.raises(ex.ProtocolError):
        ex.validate(dict(ordinary, published=None))
    with pytest.raises(ex.ProtocolError):
        ex.validate(dict(ordinary, lease_epoch=7))
    with pytest.raises(ex.ProtocolError):
        ex.validate(dict(ordinary, locked_until="2026-01-01T00:00:00-08:00"))


def test_only_the_closed_rpc_inventory_is_callable(queue_db):
    from polismath.queue import executor as ex

    database = ex.Database(
        ex.Settings(dsn=queue_db["executor_dsn"], env=queue_db["env"])
    )
    with pytest.raises(KeyError):
        database.call("pq_reap", [queue_db["env"], None, 1])
    with pytest.raises(ValueError):
        database.call("pq_job_status", [queue_db["env"]])


def test_refuses_a_broad_login(queue_db):
    """The provisioning login can write the tables directly, so it is refused."""
    from polismath.queue import executor as ex

    database = ex.Database(ex.Settings(dsn=queue_db["url"], env=queue_db["env"]))
    with pytest.raises(ex.ExecutorRefused):
        database.call("pq_head_status", [queue_db["env"], PRODUCT])


def test_restricted_login_has_no_direct_table_write(queue_db):
    import psycopg2

    conn = psycopg2.connect(queue_db["executor_dsn"])
    try:
        with conn.cursor() as cur:
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("UPDATE public.polis_queue_jobs SET state='queued'")
    finally:
        conn.close()


def test_claims_heartbeats_and_finalizes_one_noop_job(queue_db):
    reply = _enqueue(queue_db, "cycle")
    assert reply["outcome"] == "enqueued"
    executor = _make_executor(queue_db)
    assert executor.run_once() == "succeeded"
    # The product head moved to this run, and the queue is empty afterwards.
    status = executor.call("pq_head_status", [queue_db["env"], PRODUCT])
    assert status["published_run_id"] == reply["run_id"]
    assert status["published_sha256"] is not None
    assert executor.run_once() == "none"
    job = executor.call("pq_job_status", [queue_db["env"], reply["job_id"]])
    assert job["state"] == "succeeded"
    assert job["owner_id"] is None


def test_permanently_fails_a_job_whose_descriptor_is_not_the_synthetic_one(queue_db):
    """It never dereferences a job-supplied URI; it refuses the job instead."""
    reply = _enqueue(
        queue_db,
        "foreign-descriptor",
        uri="https://example.invalid/not-followed",
        sha="2" * 64,
        max_attempts=1,
    )
    assert reply["outcome"] == "enqueued"
    executor = _make_executor(queue_db)
    assert executor.run_once() == "dead"
    job = executor.call("pq_job_status", [queue_db["env"], reply["job_id"]])
    assert job["state"] == "dead"
    assert job["last_error_code"] == "invalid_synthetic_descriptor"


def test_reaper_recovers_an_expired_lease_without_a_new_enqueue(queue_db):
    import psycopg2

    reply = _enqueue(queue_db, "expired")
    executor = _make_executor(queue_db)
    claimed = executor.call(
        "pq_claim", [queue_db["env"], 1, executor.owner, str(uuid.uuid4()), 60]
    )
    assert claimed["outcome"] == "owned"
    conn = psycopg2.connect(queue_db["url"])
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE public.polis_queue_jobs SET locked_until=clock_timestamp()"
                " - interval '1 second' WHERE env=%s AND job_id=%s",
                (queue_db["env"], reply["job_id"]),
            )
    finally:
        conn.close()
    # A stale token is fenced, the reaper returns the job, and the next cycle
    # completes it. No new enqueue is involved.
    assert (
        executor.call("pq_heartbeat", executor.token(claimed) + [60])["outcome"]
        == "fenced"
    )
    assert executor.reap_page() >= 1
    # The reaper schedules a backoff, which is deliberate; bring it forward so
    # the test does not sleep through the retry interval.
    conn = psycopg2.connect(queue_db["url"])
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE public.polis_queue_jobs SET eligible_at=clock_timestamp()"
                " - interval '1 second' WHERE env=%s AND job_id=%s",
                (queue_db["env"], reply["job_id"]),
            )
    finally:
        conn.close()
    assert executor.run_once() == "succeeded"


def test_an_uncertain_claim_commit_reconciles_instead_of_claiming_again(queue_db):
    """A claim whose COMMIT outcome is unknown must renew, never re-claim.

    Repeating pq_claim would take a second job while the first lease ran
    unattended, so the executor heartbeats the exact token the uncertain reply
    named. Only the COMMIT is made to fail; the SELECT really did own the job.
    """
    from polismath.queue import executor as ex

    reply = _enqueue(queue_db, "uncertain")
    executor = _make_executor(queue_db)
    real_call = executor.db.call
    calls = []
    owned_claims = []

    def flaky(name, args):
        calls.append(name)
        result = real_call(name, args)
        # Only the claim that actually took ownership loses its acknowledgement:
        # an empty lane is not the interesting case.
        if name == "pq_claim" and result["outcome"] == "owned":
            owned_claims.append(result)
            if len(owned_claims) == 1:
                raise ex.CommitOutcomeUnknown(result)
        return result

    executor.db.call = flaky  # type: ignore[method-assign]
    assert executor.run_once() == "succeeded"
    assert len(owned_claims) == 1
    assert "pq_heartbeat" in calls
    job = executor.call("pq_job_status", [queue_db["env"], reply["job_id"]])
    assert job["state"] == "succeeded"
