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

import contextlib
import os
import re
import sys
import uuid

import pytest

from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration

# Locate the checkout rather than counting ".." segments. The Delphi Python CI
# job copies only `delphi/tests` into `/app/tests` inside the delphi image
# (.github/workflows/python-ci.yml step 6), where two levels up is `/` and the
# polis checkout genuinely does not exist. Counting segments there silently
# produced `/server/postgres/migrations` and failed the SQL pin for a packaging
# reason rather than a real drift. Same shape as the recovery matrix's conftest.
_MIGRATIONS_SUBPATH = ("server", "postgres", "migrations")
MIGRATION_FILENAME = "000019_create_polis_queue.sql"


def _find_repo_root(start):
    """The polis checkout at or above ``start``, identified by what we need."""
    path = os.path.abspath(start)
    while True:
        if os.path.isdir(os.path.join(path, *_MIGRATIONS_SUBPATH)):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent


#: The polis checkout root, or None when these tests run outside one.
REPO_ROOT = _find_repo_root(os.path.dirname(__file__))

_NO_CHECKOUT_MESSAGE = """
This test reads {needed} from the polis checkout, and no checkout was found at
or above {here}.

That is a packaging fact, not a configuration one: the Delphi Python CI job
copies only `delphi/tests` into `/app/tests` inside the delphi image, so the
checkout is genuinely absent there and nothing inside the image can supply it.

Run the test from a checkout, or point at the migrations explicitly:

    cd delphi && pytest tests/test_queue_noop_executor.py
    POLIS_MIGRATIONS_DIR=/app/migrations pytest tests/test_queue_noop_executor.py
"""

_BAD_OVERRIDE_MESSAGE = """
POLIS_MIGRATIONS_DIR resolves to {path!r}, which is not there.

An explicit override that does not resolve is operator error, so this FAILS
rather than skipping. Unset it to fall back to the checkout's
server/postgres/migrations.
"""


def _resolve_migration():
    """``(path, problem)``; exactly one of the two is None.

    An explicit override that does not resolve fails; an absent checkout skips.
    Neither weakens the pin when the file IS present.
    """
    override = os.environ.get("POLIS_MIGRATIONS_DIR")
    if override:
        candidate = os.path.join(os.path.abspath(override), MIGRATION_FILENAME)
        if not os.path.isfile(candidate):
            return None, ("fail", _BAD_OVERRIDE_MESSAGE.format(path=candidate))
        return candidate, None
    if REPO_ROOT is None:
        return None, (
            "skip",
            _NO_CHECKOUT_MESSAGE.format(
                needed=os.path.join(*_MIGRATIONS_SUBPATH, MIGRATION_FILENAME),
                here=os.path.dirname(os.path.abspath(__file__)),
            ),
        )
    return os.path.join(REPO_ROOT, *_MIGRATIONS_SUBPATH, MIGRATION_FILENAME), None


MIGRATION, _MIGRATION_PROBLEM = _resolve_migration()


def require_migration():
    """The migration path, or a clean skip / loud failure saying why not."""
    if _MIGRATION_PROBLEM is not None:
        kind, message = _MIGRATION_PROBLEM
        if kind == "fail":
            pytest.fail(message, pytrace=False)
        pytest.skip(message)
    return MIGRATION

ENV = "test-p024-py"
PRODUCT = "product-noop"
ACTOR = "synthetic-actor"
LOCAL_ROLE_PASSWORD = "pq-local-test"


def _executor_dsn(url: str, user: str, password: str) -> str:
    """Swap the login in a postgres URL, leaving host/port/database alone."""
    return re.sub(r"^(postgres(?:ql)?://)[^@]*@", rf"\1{user}:{password}@", url)


def _release(conn, created):
    """Drop only what this fixture actually created, and never raise.

    R1: cleanup used to run unconditionally, so a setup that skipped before
    creating anything still issued DELETEs. On a login without CREATEROLE -
    the case the skip exists for - those DELETEs raise InsufficientPrivilege
    from inside `finally`, and that error replaces the intentional
    `pytest.skip`, turning a supported situation into an error. The same shape
    hides a failure that happens before the migration creates the tables.

    So each step is guarded by the flag set after its create succeeded, and a
    cleanup failure is collected rather than thrown from a `finally` that may
    be unwinding something more important.
    """
    failures = []

    def step(label, statement, args=()):
        try:
            with conn.cursor() as cur:
                cur.execute(statement, args or None)
        except Exception as exc:  # noqa: BLE001 - cleanup must not mask
            failures.append(f"{label}: {exc}")

    if created["migration"]:
        for table in (
            "polis_queue_requests",
            "polis_queue_attempts",
            "polis_queue_jobs",
            "polis_queue_heads",
            "polis_queue_runs",
        ):
            # Exact namespace only: never a LIKE over the shared prefix.
            step(
                f"delete {table}",
                f"DELETE FROM public.{table} WHERE env = %s",
                (created["env"],),
            )
    if created["zid"] is not None:
        step(
            "delete conversation",
            "DELETE FROM conversations WHERE zid = %s",
            (created["zid"],),
        )
    if created["role"] is not None:
        step("drop owned", f"DROP OWNED BY {created['role']}")
        step("drop role", f"DROP ROLE IF EXISTS {created['role']}")
    return failures


def _provision_queue_db():
    """Generator behind the `queue_db` fixture, so the tests can drive it.

    Yields once. Everything it creates is recorded as it is created, and only
    those things are released; a prerequisite skip or a mid-setup failure
    reaches the caller intact.
    """
    import psycopg2

    # An explicit POLIS_MIGRATIONS_DIR that does not resolve is operator error
    # and fails here too, exactly as it does for the SQL pin; only the
    # no-checkout case skips.
    migration_path = require_migration()

    with require_polis_postgres() as url:
        suffix = uuid.uuid4().hex[:8]
        role = f"pq_x_{suffix}"
        created = {
            "env": f"{ENV}-{suffix}",
            "role": None,
            "zid": None,
            "migration": False,
        }
        conn = psycopg2.connect(url)
        conn.autocommit = True
        clean_exit = False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT rolsuper OR rolcreaterole FROM pg_roles"
                    " WHERE rolname=current_user"
                )
                privileged = cur.fetchone()[0]
            if not privileged:
                pytest.skip(
                    "the test Postgres login can neither create roles nor apply "
                    "the queue migration; provide a superuser or CREATEROLE login"
                )
            with open(migration_path, "r", encoding="utf-8") as handle:
                migration_sql = handle.read()
            with conn.cursor() as cur:
                cur.execute(migration_sql)
                created["migration"] = True
                cur.execute(
                    f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEROLE "
                    f"PASSWORD '{LOCAL_ROLE_PASSWORD}' IN ROLE polis_queue_executor"
                )
                created["role"] = role
                cur.execute(
                    "INSERT INTO conversations (topic) VALUES (%s) RETURNING zid",
                    (f"p024 queue noop {suffix}",),
                )
                created["zid"] = cur.fetchone()[0]
            yield {
                "url": url,
                "zid": created["zid"],
                "env": created["env"],
                "executor_dsn": _executor_dsn(url, role, LOCAL_ROLE_PASSWORD),
                "role": role,
            }
            clean_exit = True
        finally:
            failures = _release(conn, created)
            conn.close()
            # Only surface a cleanup problem when nothing else is in flight.
            if failures and clean_exit:
                raise RuntimeError(
                    "queue fixture cleanup failed: " + "; ".join(failures)
                )


@pytest.fixture(scope="module")
def queue_db():
    """A Postgres with the queue migration applied, plus a restricted login.

    The configured test database may be shared with other runs, so teardown
    removes only this fixture's own env namespace, its own conversation and its
    own role.
    """
    yield from _provision_queue_db()


@pytest.fixture(autouse=True)
def _opt_in(monkeypatch):
    monkeypatch.setenv("POLIS_QUEUE_SUBSTRATE_ENABLED", "true")
    monkeypatch.delenv("NODE_ENV", raising=False)


def _admin(queue_db, statement, args=()):
    """Run one statement as the provisioning login and return its rows."""
    import psycopg2

    conn = psycopg2.connect(queue_db["url"])
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(statement, args or None)
            return cur.fetchall() if cur.description else None
    finally:
        conn.close()


def _enqueue(
    queue_db,
    key,
    *,
    uri=None,
    sha=None,
    image=None,
    max_attempts=3,
    priority=1,
    env=None,
):
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
                    env or queue_db["env"],
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
                    priority,
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
    """Round 4: both adapters pin the SQL they were written against.

    The pin is not weakened where the file exists. Where no checkout exists at
    all - the delphi image, which carries only `delphi/tests` - there is nothing
    to compare against, so this skips with the reason and the fixing command.
    """
    import hashlib

    from polismath.queue import executor as ex

    path = require_migration()
    with open(path, "rb") as handle:
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


def test_a_claim_reply_naming_another_attempt_is_rejected():
    """The minted attempt UUID is half of the fence, so the reply must name it.

    A reply that carries a different attempt is not this claim's job and its
    token must not be used. Checking the finalize reply against an already-wrong
    claim reply is not equivalent: the two would simply agree with each other.
    """
    from polismath.queue import executor as ex

    class WrongAttempt:
        def call(self, name, args):
            if name == "pq_due":
                return []
            if name != "pq_claim":
                raise AssertionError(f"reached {name} with an unverified token")
            job = {field: None for field in ex.ORDINARY_FIELDS}
            job.update(
                schema_version=ex.SCHEMA_VERSION,
                outcome="owned",
                published=False,
                env="test",
                owner_id=args[2],
                attempt_id=str(uuid.uuid4()),
                job_id=str(uuid.uuid4()),
                lease_epoch="1",
                stage="noop",
                input={
                    "uri": ex.NOOP_URI,
                    "sha256": ex.NOOP_SHA256,
                    "config_sha256": ex.NOOP_SHA256,
                    "code_image_digest": ex.NOOP_IMAGE,
                },
            )
            assert job["attempt_id"] != args[3]
            return job

    executor = ex.Executor(WrongAttempt(), "test", sleep=lambda _: None)
    with pytest.raises(ex.ProtocolError):
        executor.run_once()


def test_a_head_writer_with_executor_membership_is_refused(queue_db):
    """One denied UPDATE on one table is not proof of the grant boundary."""
    from polismath.queue import executor as ex

    role = queue_db["role"]
    database = ex.Database(
        ex.Settings(dsn=queue_db["executor_dsn"], env=queue_db["env"])
    )
    _admin(queue_db, f"GRANT UPDATE ON public.polis_queue_heads TO {role}")
    try:
        with pytest.raises(ex.ExecutorRefused):
            database.call("pq_job_status", [queue_db["env"], str(uuid.uuid4())])
    finally:
        _admin(queue_db, f"REVOKE UPDATE ON public.polis_queue_heads FROM {role}")
    # And it works again once the extra grant is gone.
    assert database.call("pq_job_status", [queue_db["env"], str(uuid.uuid4())])


def test_a_login_that_can_become_the_queue_owner_is_refused(queue_db):
    from polismath.queue import executor as ex

    role = queue_db["role"]
    database = ex.Database(
        ex.Settings(dsn=queue_db["executor_dsn"], env=queue_db["env"])
    )
    _admin(queue_db, f"GRANT polis_queue_owner TO {role}")
    try:
        with pytest.raises(ex.ExecutorRefused):
            database.call("pq_job_status", [queue_db["env"], str(uuid.uuid4())])
    finally:
        _admin(queue_db, f"REVOKE polis_queue_owner FROM {role}")
    assert database.call("pq_job_status", [queue_db["env"], str(uuid.uuid4())])


def test_a_suppressed_finalize_acknowledgement_replays_the_exact_token(queue_db):
    """A lost finalize reply is retried with the same token and digest.

    The retry must return already_succeeded from the committed first attempt,
    not a second publication and not a rollback.
    """
    from polismath.queue import executor as ex

    _enqueue(queue_db, "lost-finalize")
    executor = _make_executor(queue_db)
    real_call = executor.db.call
    finals = []
    suppressed = []

    def flaky(name, args):
        result = real_call(name, args)
        if name == "pq_finalize":
            finals.append(list(args))
            if not suppressed:
                suppressed.append(True)
                raise ex.CommitOutcomeUnknown(result)
        return result

    executor.db.call = flaky  # type: ignore[method-assign]
    assert executor.run_once() == "already_succeeded"
    assert len(finals) == 2
    assert finals[0] == finals[1]


def test_weighted_lanes_visit_every_priority_under_backlog(queue_db):
    """Continuous urgent arrivals must not starve lane 2."""
    from polismath.queue import executor as ex

    for lane in range(3):
        for index in range(7):
            _enqueue(queue_db, f"lane-{lane}-{index}", priority=lane)
    executor = _make_executor(queue_db)
    real_call = executor.db.call
    seen = []

    def observe(name, args):
        result = real_call(name, args)
        if name == "pq_claim" and result["outcome"] == "owned":
            seen.append(args[1])
        return result

    executor.db.call = observe  # type: ignore[method-assign]
    for _ in range(len(ex.LANES)):
        assert executor.run_once() == "succeeded"
    assert seen == list(ex.LANES)


def test_reaper_pages_101_parked_jobs_and_resets_its_cursor(queue_db):
    """Discovery is bounded at 100, and a short page resets the cursor."""
    env = queue_db["env"]
    # Retire this module's remaining backlog so the pages are this test's rows.
    _admin(
        queue_db,
        "UPDATE public.polis_queue_jobs SET state='dead'"
        " WHERE env=%s AND state IN ('queued','retry_wait')",
        (env,),
    )
    executor = _make_executor(queue_db)
    for index in range(101):
        _enqueue(queue_db, f"park-{index}")
        job = executor.call(
            "pq_claim", [env, 1, executor.owner, str(uuid.uuid4()), 60]
        )
        assert job["outcome"] == "owned"
        assert (
            executor.call("pq_park", executor.token(job) + ["synthetic"])["outcome"]
            == "parked"
        )
    _admin(
        queue_db,
        "UPDATE public.polis_queue_jobs SET eligible_at=clock_timestamp()"
        " - interval '1 second' WHERE env=%s AND state='parked'",
        (env,),
    )
    assert executor.reap_page() == 100
    assert executor.after_job is not None
    assert (
        _admin(
            queue_db,
            "SELECT count(*) FROM public.polis_queue_jobs"
            " WHERE env=%s AND state='queued'",
            (env,),
        )[0][0]
        == 100
    )
    assert executor.reap_page() == 1
    assert executor.after_job is None
    assert executor.reap_page() == 0


def _use_provider(monkeypatch, dsn):
    """Point the fixture's prerequisite discovery at one explicit DSN."""

    @contextlib.contextmanager
    def provider():
        yield dsn

    monkeypatch.setattr(sys.modules[__name__], "require_polis_postgres", provider)


def test_an_unprivileged_login_skips_rather_than_erroring(queue_db, monkeypatch):
    """R1: the intentional prerequisite skip must survive teardown.

    A login without CREATEROLE cannot apply the migration, which is exactly why
    the fixture skips. Cleanup that runs regardless raises InsufficientPrivilege
    from the `finally` and replaces that skip with an error.
    """
    limited = f"pq_lim_{uuid.uuid4().hex[:8]}"
    _admin(
        queue_db,
        f"CREATE ROLE {limited} LOGIN NOSUPERUSER NOCREATEROLE "
        f"PASSWORD '{LOCAL_ROLE_PASSWORD}' IN ROLE polis_queue_executor",
    )
    try:
        _use_provider(
            monkeypatch, _executor_dsn(queue_db["url"], limited, LOCAL_ROLE_PASSWORD)
        )
        with pytest.raises(pytest.skip.Exception):
            next(_provision_queue_db())
    finally:
        _admin(queue_db, f"DROP OWNED BY {limited}")
        _admin(queue_db, f"DROP ROLE IF EXISTS {limited}")


def test_teardown_removes_its_own_namespace_and_leaves_a_sibling(queue_db, monkeypatch):
    sibling = f"{ENV}-sibling-{uuid.uuid4().hex[:8]}"

    def rows(env):
        return _admin(
            queue_db,
            "SELECT count(*) FROM public.polis_queue_jobs WHERE env = %s",
            (env,),
        )[0][0]

    assert _enqueue(queue_db, "sibling", env=sibling)["outcome"] == "enqueued"
    assert rows(sibling) == 1
    try:
        _use_provider(monkeypatch, queue_db["url"])
        generator = _provision_queue_db()
        inner = next(generator)
        assert _enqueue(inner, "inner")["outcome"] == "enqueued"
        assert rows(inner["env"]) == 1
        with pytest.raises(StopIteration):
            next(generator)
        assert rows(inner["env"]) == 0
        assert rows(sibling) == 1
    finally:
        for table in (
            "polis_queue_requests",
            "polis_queue_attempts",
            "polis_queue_jobs",
            "polis_queue_heads",
            "polis_queue_runs",
        ):
            _admin(
                queue_db,
                f"DELETE FROM public.{table} WHERE env = %s",
                (sibling,),
            )


def test_a_mid_setup_failure_releases_only_what_it_created(queue_db, monkeypatch):
    """A failure after the creates still frees them, and deletes nothing else."""
    sibling = f"{ENV}-sibling-{uuid.uuid4().hex[:8]}"

    def counts():
        return (
            _admin(
                queue_db,
                "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pq\\_x\\_%'",
            )[0][0],
            _admin(
                queue_db,
                "SELECT count(*) FROM conversations WHERE topic LIKE 'p024 queue noop %'",
            )[0][0],
            _admin(
                queue_db,
                "SELECT count(*) FROM public.polis_queue_jobs WHERE env = %s",
                (sibling,),
            )[0][0],
        )

    assert _enqueue(queue_db, "sibling-partial", env=sibling)["outcome"] == "enqueued"
    before = counts()
    assert before[2] == 1
    try:
        _use_provider(monkeypatch, queue_db["url"])
        # Fails after the migration, the role and the conversation exist, and
        # before the fixture yields.
        monkeypatch.setattr(
            sys.modules[__name__],
            "_executor_dsn",
            lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("synthetic setup failure")
            ),
        )
        with pytest.raises(RuntimeError, match="synthetic setup failure"):
            next(_provision_queue_db())
        assert counts() == before
    finally:
        for table in (
            "polis_queue_requests",
            "polis_queue_attempts",
            "polis_queue_jobs",
            "polis_queue_heads",
            "polis_queue_runs",
        ):
            _admin(
                queue_db,
                f"DELETE FROM public.{table} WHERE env = %s",
                (sibling,),
            )
