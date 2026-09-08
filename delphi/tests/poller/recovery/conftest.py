"""Shared fixtures for the P-022 §C recovery matrix (R01-R12).

Postgres policy
---------------
Every scenario in which DB behaviour matters runs against a REAL Postgres with
the REAL ``server/postgres/migrations/*.sql`` applied — never the hand-maintained
equivalence schema, and never sqlite.  Per P-022 §C "Acceptance":

    Missing Postgres is a failing required job, not pytest skip.

so :func:`recovery_postgres_url` **fails** (loudly, with the command that fixes
it) when ``POLIS_TEST_POSTGRES_URL`` is unset or unreachable.  There is one
deliberate exception: ``POLIS_RECOVERY_ALLOW_NO_PG=1`` turns the failure into a
skip, for a developer running an unrelated part of the suite.  CI must not set
it, and the required job asserts it is unset.

Schema freshness
----------------
The migrations are applied ONCE per session into a template database; each test
then gets its own database created with ``CREATE DATABASE ... TEMPLATE``.  That
is a genuinely fresh migrated schema per test (no cross-test residue in
math_main / math_ticks / votes) at roughly the cost of a file copy.

Fault injection
---------------
All hooks live in the tests.  They monkeypatch the WRITER/ENGINE boundary
(``PostgresClient`` methods, ``MathWriter.write_conv_updates``,
``MathPollerService._load_or_init``) rather than editing production code, so the
code under test is byte-for-byte the deployed code.  :class:`FaultInjector`
provides one-shot and persistent variants and records what it fired.

No fixed sleep is ever used as evidence of an interleaving: ordering comes from
``threading.Event``/``threading.Barrier`` latches at named boundaries and from
``ConversationWorkerPool.join`` (which blocks until the pool is idle).
:func:`eventually` exists only for genuinely asynchronous *progress* assertions,
and is always bounded.
"""

import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional

import pytest
import sqlalchemy as sa

# Every module in this package is part of the required recovery job.
pytestmark = pytest.mark.recovery

_MIGRATIONS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..",
                 "server", "postgres", "migrations")
)

_MISSING_PG_MESSAGE = """
P-022 §C requires a REAL Postgres; POLIS_TEST_POSTGRES_URL is {why}.

This is a REQUIRED job, so it FAILS rather than skipping (P-022 §C Acceptance:
"Missing Postgres is a failing required job, not pytest skip").

Start the compose test Postgres and run the suite with:

    make test-recovery                 # from the repository root

or, to point at an existing database:

    POLIS_TEST_POSTGRES_URL=postgresql://user:pw@host:port/db \\
        uv run pytest tests/poller/recovery

Set POLIS_RECOVERY_ALLOW_NO_PG=1 to downgrade this to a skip for local,
non-required runs only.
"""


@pytest.fixture(autouse=True)
def _quiet_engine_logs():
    """The engine logs a paragraph per compute at INFO; recovery tests run many
    computes each.  Nothing here asserts on log output."""
    import logging

    # conversation.py:91 sets its OWN logger to INFO explicitly, so raising the
    # parent's level is not enough — every already-created polismath logger has
    # to be quieted individually.
    import polismath.conversation.conversation  # noqa: F401  (force creation)

    names = [n for n in logging.root.manager.loggerDict
             if n == "polismath" or n.startswith(("polismath.", "sqlalchemy"))]
    loggers = [logging.getLogger("polismath")] + [
        logging.getLogger(n) for n in names
    ]
    previous = [(lg, lg.level) for lg in loggers]
    for lg in loggers:
        lg.setLevel(logging.WARNING)
    yield
    for lg, level in previous:
        lg.setLevel(level)


# --------------------------------------------------------------------------- #
# Postgres plumbing
# --------------------------------------------------------------------------- #
def _fail_or_skip(why: str) -> None:
    message = _MISSING_PG_MESSAGE.format(why=why)
    if os.environ.get("POLIS_RECOVERY_ALLOW_NO_PG") == "1":
        pytest.skip(message)
    pytest.fail(message, pytrace=False)


def _split_url(url: str):
    """(server-url-without-database, database-name)."""
    match = re.match(r"^(?P<head>.*?)/(?P<db>[^/?]+)(?P<tail>\?.*)?$", url)
    if not match:
        raise ValueError(f"cannot parse a database name out of {url!r}")
    return match.group("head"), match.group("db"), match.group("tail") or ""


@pytest.fixture(scope="session")
def recovery_postgres_url() -> str:
    """The base Postgres server URL, verified reachable.  FAILS if missing."""
    url = os.environ.get("POLIS_TEST_POSTGRES_URL")
    if not url:
        _fail_or_skip("not set")
    import psycopg2

    try:
        conn = psycopg2.connect(url, connect_timeout=5)
    except Exception as exc:  # pragma: no cover - infra guard
        _fail_or_skip(f"set to {url!r} but unreachable: {exc}")
    else:
        conn.close()
    return url


@pytest.fixture(scope="session")
def migrated_template(recovery_postgres_url: str) -> str:
    """Name of a session-scoped template database carrying the REAL migrations.

    Built by applying every ``server/postgres/migrations/*.sql`` in filename
    order, so schema constraints/types under test are the migrated ones (P-022
    §C: "Test schema constraints/types against migrations, not only the
    hand-maintained equivalence schema").
    """
    import psycopg2

    head, admin_db, tail = _split_url(recovery_postgres_url)
    template = f"polis_recovery_tmpl_{os.getpid()}"

    files = sorted(
        f for f in os.listdir(_MIGRATIONS_DIR)
        if f.endswith(".sql") and os.path.isfile(os.path.join(_MIGRATIONS_DIR, f))
    )
    if not files:  # pragma: no cover - infra guard
        pytest.fail(f"no migrations found in {_MIGRATIONS_DIR}", pytrace=False)

    admin = psycopg2.connect(recovery_postgres_url, connect_timeout=5)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{template}"')
            cur.execute(f'CREATE DATABASE "{template}"')
    finally:
        admin.close()

    tmpl_url = f"{head}/{template}{tail}"
    conn = psycopg2.connect(tmpl_url, connect_timeout=5)
    conn.autocommit = True
    try:
        for name in files:
            with open(os.path.join(_MIGRATIONS_DIR, name), "r") as fh:
                sql = fh.read()
            with conn.cursor() as cur:
                cur.execute(sql)
    finally:
        conn.close()

    yield template

    admin = psycopg2.connect(recovery_postgres_url, connect_timeout=5)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{template}" WITH (FORCE)')
    finally:
        admin.close()


@pytest.fixture
def pg_url(recovery_postgres_url: str, migrated_template: str) -> str:
    """A FRESH migrated database for this one test, dropped afterwards."""
    import psycopg2

    head, _admin_db, tail = _split_url(recovery_postgres_url)
    name = f"rec_{uuid.uuid4().hex[:12]}"

    admin = psycopg2.connect(recovery_postgres_url, connect_timeout=5)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}" TEMPLATE "{migrated_template}"')
    finally:
        admin.close()

    url = f"{head}/{name}{tail}"
    try:
        yield url
    finally:
        admin = psycopg2.connect(recovery_postgres_url, connect_timeout=5)
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        finally:
            admin.close()


@pytest.fixture
def engine(pg_url: str):
    eng = sa.create_engine(pg_url, poolclass=sa.pool.NullPool)
    try:
        yield eng
    finally:
        eng.dispose()


# --------------------------------------------------------------------------- #
# Seeding (plain SQL; no polismath code involved)
# --------------------------------------------------------------------------- #
@dataclass
class SeededConversation:
    """What a test committed, so the fold can be built from the test's own
    knowledge of the input rather than from a re-read of the system's output."""

    zid: int
    vote_events: List[Dict[str, Any]] = field(default_factory=list)
    comment_rows: List[Dict[str, Any]] = field(default_factory=list)
    participant_rows: List[Dict[str, Any]] = field(default_factory=list)


def seed_conversation(
    engine,
    zid: int = 1,
    n_ptpts: int = 8,
    n_cmts: int = 5,
    base_created: Optional[int] = None,
    vote_pattern: Optional[Callable[[int, int], int]] = None,
) -> SeededConversation:
    """Seed one conversation: conversations/participants/comments/votes rows.

    Raw DB vote signs (AGREE=-1, DISAGREE=+1) are written directly, so the
    poller's ingress conversion is genuinely exercised.  Two opposing camps by
    participant parity gives a non-degenerate PCA.
    """
    now = int(time.time() * 1000)
    base_created = now - 60_000 if base_created is None else base_created
    long_ago = now - 2 * 24 * 60 * 60 * 1000
    if vote_pattern is None:
        def vote_pattern(pid: int, tid: int) -> int:  # noqa: ARG001
            return -1 if pid % 2 == 0 else 1

    seeded = SeededConversation(zid=zid)
    with engine.begin() as conn:
        conn.execute(sa.text("SET session_replication_role = replica"))
        conn.execute(sa.text("INSERT INTO conversations (zid) VALUES (:zid) "
                             "ON CONFLICT DO NOTHING"), {"zid": zid})
        for pid in range(n_ptpts):
            conn.execute(
                sa.text("INSERT INTO participants (pid, uid, zid, created, mod) "
                        "VALUES (:pid, :uid, :zid, :created, 0)"),
                {"pid": pid, "uid": 100000 * zid + pid, "zid": zid,
                 "created": long_ago},
            )
            seeded.participant_rows.append({"pid": pid, "mod": 0})
        for tid in range(n_cmts):
            conn.execute(
                sa.text("INSERT INTO comments (tid, zid, pid, uid, txt, mod, "
                        "is_meta, created, modified) VALUES (:tid, :zid, 0, "
                        ":uid, :txt, 0, false, :created, :modified)"),
                {"tid": tid, "zid": zid, "uid": 100000 * zid,
                 "txt": f"comment {tid}", "created": long_ago,
                 "modified": long_ago},
            )
            seeded.comment_rows.append(
                {"tid": tid, "mod": 0, "is_meta": False, "modified": long_ago}
            )
        created = base_created
        for pid in range(n_ptpts):
            for tid in range(n_cmts):
                created += 1
                raw = vote_pattern(pid, tid)
                conn.execute(
                    sa.text("INSERT INTO votes (zid, pid, tid, vote, created) "
                            "VALUES (:zid, :pid, :tid, :vote, :created)"),
                    {"zid": zid, "pid": pid, "tid": tid, "vote": raw,
                     "created": created},
                )
                seeded.vote_events.append(
                    {"pid": pid, "tid": tid, "vote": raw, "created": created}
                )
        conn.execute(sa.text("SET session_replication_role = DEFAULT"))
    return seeded


def commit_vote(engine_or_conn, zid: int, pid: int, tid: int, raw_vote: int,
                created: int) -> Dict[str, Any]:
    """Commit ONE vote row (raw storage sign) and return the fold event."""
    stmt = sa.text("INSERT INTO votes (zid, pid, tid, vote, created) "
                   "VALUES (:zid, :pid, :tid, :vote, :created)")
    params = {"zid": zid, "pid": pid, "tid": tid, "vote": raw_vote,
              "created": created}
    if isinstance(engine_or_conn, sa.engine.Engine):
        with engine_or_conn.begin() as conn:
            conn.execute(sa.text("SET session_replication_role = replica"))
            conn.execute(stmt, params)
    else:
        # An OPEN connection/transaction the caller controls — this is how the
        # two-real-connections tests keep one commit pending while another lands.
        engine_or_conn.execute(sa.text("SET session_replication_role = replica"))
        engine_or_conn.execute(stmt, params)
    return {"pid": pid, "tid": tid, "vote": raw_vote, "created": created}


def read_vote_events(engine, zid: int) -> List[Dict[str, Any]]:
    """Read back every committed vote EVENT with a plain SELECT, in the poller's
    own load order.  Used to build the fold from the DB rather than from the
    test's bookkeeping, so the fold checks what was really committed."""
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT pid, tid, vote, created FROM votes WHERE zid = :zid "
                    "ORDER BY zid, tid, pid, created"),
            {"zid": zid},
        ).mappings().all()
    return [dict(r) for r in rows]


def read_math_tables(engine, zid: int, math_env: str) -> Dict[str, Any]:
    """Read the three published tables + math_ticks for one (zid, math_env)."""
    out: Dict[str, Any] = {}
    with engine.connect() as conn:
        out["main"] = _one(conn,
            "SELECT zid, math_env, caching_tick, math_tick, last_vote_timestamp, "
            "data FROM math_main WHERE zid=:z AND math_env=:e", zid, math_env)
        out["bidtopid"] = _one(conn,
            "SELECT zid, math_tick, data FROM math_bidtopid "
            "WHERE zid=:z AND math_env=:e", zid, math_env)
        out["ptptstats"] = _one(conn,
            "SELECT zid, math_tick, data FROM math_ptptstats "
            "WHERE zid=:z AND math_env=:e", zid, math_env)
        out["ticks"] = _one(conn,
            "SELECT zid, math_tick, caching_tick FROM math_ticks "
            "WHERE zid=:z AND math_env=:e", zid, math_env)
    return out


def _one(conn, sql: str, zid: int, math_env: str) -> Optional[Dict[str, Any]]:
    row = conn.execute(sa.text(sql), {"z": zid, "e": math_env}).mappings().first()
    return dict(row) if row else None


def tables_are_coherent(tables: Dict[str, Any]) -> List[str]:
    """Return the reasons a published generation is INCOHERENT (empty == fine).

    "Coherent" here is the contract a reader needs: all three data rows exist and
    carry the SAME math_tick, i.e. one complete generation.
    """
    problems = []
    for name in ("main", "bidtopid", "ptptstats"):
        if tables.get(name) is None:
            problems.append(f"{name} row missing")
    if problems:
        return problems
    ticks = {name: tables[name]["math_tick"]
             for name in ("main", "bidtopid", "ptptstats")}
    if len(set(ticks.values())) != 1:
        problems.append(f"mixed generations: math_tick per table = {ticks}")
    return problems


# --------------------------------------------------------------------------- #
# Service construction
# --------------------------------------------------------------------------- #
@pytest.fixture
def make_service(tmp_path):
    """Build real ``MathPollerService`` instances against the real Postgres
    client.  Cleans up pools/engines afterwards."""
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller.service import MathPollerService, PollerConfig

    built = []

    def _make(url: str, math_env: str = "recovery", **cfg_kwargs):
        pg = PostgresClient(
            PostgresConfig(url=url, math_env=math_env, ssl_mode="disable")
        )
        pg.initialize()
        kwargs = dict(
            database_url=url,
            math_env=math_env,
            poll_from_days_ago=1,
            worker_pool_size=2,
            dump_dir=str(tmp_path / "errorconv"),
        )
        kwargs.update(cfg_kwargs)
        svc = MathPollerService(pg, PollerConfig(**kwargs))
        svc._ensure_runtime()
        built.append((svc, pg))
        return svc

    yield _make

    for svc, pg in built:
        try:
            if svc._pool is not None:
                svc._pool.shutdown(wait=False)
        except Exception:  # pragma: no cover - teardown best effort
            pass
        try:
            pg.shutdown()
        except Exception:  # pragma: no cover - teardown best effort
            pass


def drain(svc, timeout: float = 60.0) -> None:
    """Block until the pool is idle — a latch on the pool's own condition
    variable, NOT a sleep."""
    assert svc._pool is not None
    assert svc._pool.join(timeout=timeout), (
        "worker pool did not drain within the bound; work is stuck"
    )


def pool_pending(pool, zid: int) -> bool:
    """Queued-or-active work for one zid, read under the pool's OWN lock.

    Used to assert that no queued request was dropped and that no handler is
    still in flight.  Reads the pool's private bookkeeping deliberately: the
    point IS the pool's internal accounting, and taking ``_lock`` means the
    snapshot cannot tear against a concurrent submit/park.
    """
    with pool._lock:
        return bool(pool._queues.get(zid)) or zid in pool._active


def eventually(
    predicate: Callable[[], bool],
    *,
    timeout: float = 30.0,
    interval: float = 0.05,
    message: str = "bounded eventual-progress assertion failed",
) -> None:
    """Bounded eventual-progress assertion.

    Used ONLY where progress is genuinely asynchronous and no latch exists; the
    passing evidence is the predicate, never elapsed time, and the bound makes a
    stall a failure rather than a hang.
    """
    deadline = time.monotonic() + timeout
    last = False
    while time.monotonic() < deadline:
        last = bool(predicate())
        if last:
            return
        time.sleep(interval)
    raise AssertionError(f"{message} (bound {timeout}s)")


# --------------------------------------------------------------------------- #
# Fault injection
# --------------------------------------------------------------------------- #
class InjectedFault(RuntimeError):
    """Raised by a :class:`FaultInjector` hook.  A distinct type so a test can
    assert it saw the injected failure and not an unrelated one."""


@dataclass
class FaultInjector:
    """One-shot / persistent failure injection at a NAMED boundary.

    ``mode='once'`` fires exactly once (the transient-blip case); ``'always'``
    fires forever (the persistent-outage case); ``'nth'`` fires on the n-th call.
    Every call is recorded so a test can assert how many attempts were made
    (bounded retries, no hot loop).
    """

    name: str
    mode: str = "once"
    nth: int = 1
    calls: int = 0
    fired: int = 0
    exception: Callable[[], BaseException] = lambda: InjectedFault("injected")

    def should_fire(self) -> bool:
        self.calls += 1
        if self.mode == "always":
            hit = True
        elif self.mode == "once":
            hit = self.fired == 0
        elif self.mode == "nth":
            hit = self.calls == self.nth
        elif self.mode == "never":
            hit = False
        else:  # pragma: no cover - programming error
            raise ValueError(f"unknown fault mode {self.mode!r}")
        if hit:
            self.fired += 1
        return hit

    def maybe_raise(self) -> None:
        if self.should_fire():
            raise self.exception()


def fail_stage(target: Any, method: str, injector: FaultInjector,
               *, after: bool = False) -> Callable[[], None]:
    """Wrap ``target.method`` so ``injector`` can fail BEFORE (default) or AFTER
    the real call.  Returns an undo callable.

    ``after=True`` is the committed-write / lost-ack case: the DB work really
    happened and committed, but the caller sees an exception.
    """
    original = getattr(target, method)

    def wrapper(*args, **kwargs):
        if not after:
            injector.maybe_raise()
            return original(*args, **kwargs)
        result = original(*args, **kwargs)
        injector.maybe_raise()
        return result

    setattr(target, method, wrapper)
    return lambda: setattr(target, method, original)


class Latch:
    """A named boundary latch: the hooked call announces arrival and blocks
    until released.  Used instead of sleeps to pin an interleaving."""

    def __init__(self, name: str):
        self.name = name
        self.arrived = threading.Event()
        self.release = threading.Event()
        self.arrivals = 0

    def wait_arrival(self, timeout: float = 30.0) -> None:
        assert self.arrived.wait(timeout), (
            f"latch {self.name!r} was never reached within {timeout}s"
        )

    def let_go(self) -> None:
        self.release.set()

    def block(self, timeout: float = 30.0) -> None:
        self.arrivals += 1
        self.arrived.set()
        assert self.release.wait(timeout), (
            f"latch {self.name!r} was never released within {timeout}s"
        )


def latch_method(target: Any, method: str, latch: Latch,
                 predicate: Optional[Callable[..., bool]] = None
                 ) -> Callable[[], None]:
    """Block inside ``target.method`` at ``latch`` (optionally only when
    ``predicate(*args)`` holds).  Returns an undo callable."""
    original = getattr(target, method)

    def wrapper(*args, **kwargs):
        if predicate is None or predicate(*args, **kwargs):
            latch.block()
        return original(*args, **kwargs)

    setattr(target, method, wrapper)
    return lambda: setattr(target, method, original)


# --------------------------------------------------------------------------- #
# Misc
# --------------------------------------------------------------------------- #
def terminate_backends(admin_url: str, dbname: str) -> int:
    """Kill every server-side backend on ``dbname`` — a REAL connection loss."""
    import psycopg2

    conn = psycopg2.connect(admin_url, connect_timeout=5)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (dbname,),
            )
            return len(cur.fetchall())
    finally:
        conn.close()


def terminate_backend_pid(admin_url: str, backend_pid: int) -> bool:
    """Terminate ONE specific server-side backend, from a SECOND connection.

    This is the form R01's connection-loss test needs: the caller latches an
    ACTIVE transaction, learns its ``pg_backend_pid()``, and kills exactly that
    backend while it is still holding the transaction open — so the next
    statement or the COMMIT genuinely fails on the tested path.  Killing every
    idle backend beforehand does not do that: a fresh connection or a pool
    pre-ping can repair an idle killed connection with no failure ever reaching
    the code under test.

    Returns Postgres's own answer to ``pg_terminate_backend``.
    """
    import psycopg2

    conn = psycopg2.connect(admin_url, connect_timeout=5)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_terminate_backend(%s)", (backend_pid,))
            row = cur.fetchone()
            return bool(row and row[0])
    finally:
        conn.close()


def dbname_of(url: str) -> str:
    return _split_url(url)[1]


def run_child(script_args: List[str], env_extra: Dict[str, str],
              cwd: Optional[str] = None) -> subprocess.Popen:
    """Start a child Python process (used by R05's real process kills)."""
    import sys

    env = dict(os.environ)
    env.update(env_extra)
    return subprocess.Popen(
        [sys.executable, *script_args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=env,
        cwd=cwd or os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", "..")
        ),
    )
