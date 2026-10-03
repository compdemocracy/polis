"""P-042 slice 0 acceptance — the migration and the Python journal side.

Astra's four witness scripts (``cost-reduction/scripts/p042-*.py``) are the
design's own acceptance and pass (108/108, 10/10, 35, 18/18), BUT each of them
hard-codes the design markdown as its SQL source: they extract the labelled
``-- p042:*`` blocks from ``P-042-commit-ordered-cursor.md`` and never look at
``server/postgres/migrations/000020_create_math_source_journal.sql``. So they
prove the *design SQL*, not the *shipped migration*.

This module closes that gap two ways:

* ``test_migration_embeds_design_blocks_verbatim`` asserts the migration embeds
  the ``p042:migration`` and ``p042:legacy-lock-safety`` blocks byte-for-byte, so
  the witness's SQL-level results transfer to the migration file. (Offline.)
* ``TestMigrationAgainstRealSchema`` builds a database from the real edge
  migrations plus THIS migration and re-runs the r3-real-schema-check controls,
  the B2 interval guards, the M1 incarnation guard and the M3 truncate sweep
  against the migration-installed schema, and exercises the Python
  ``SourceJournalClient`` / metrics against it. (Self-skipping integration.)
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import time
import uuid

import pytest

_HERE = os.path.dirname(__file__)
_REPO = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
_MIGRATIONS_DIR = os.path.join(_REPO, "server", "postgres", "migrations")
_MIGRATION = os.path.join(_MIGRATIONS_DIR, "000020_create_math_source_journal.sql")


def _plan_path():
    """Locate the design markdown. It lives in the gitignored ``cost-reduction/``
    notes, so it is present in Astra's/Opus's working checkout (where the witness
    scripts also run) but NOT in a clean CI checkout. Honour a ``P042_PLAN_PATH``
    override, else the in-repo notes path, else None (the verbatim test skips)."""
    override = os.environ.get("P042_PLAN_PATH")
    candidates = [override] if override else []
    candidates.append(os.path.join(
        _REPO, "cost-reduction", "04-plans", "P-042-commit-ordered-cursor.md"))
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def _design_blocks() -> dict:
    text = open(_plan_path(), encoding="utf-8").read()
    return dict(re.findall(r"```sql\n-- p042:([\w-]+)\n(.*?)\n```", text, re.S))


def _edge_migration_files() -> list:
    """The real migrations that precede ours (000000..000018 on edge)."""
    files = sorted(
        f for f in glob.glob(os.path.join(_MIGRATIONS_DIR, "0000*.sql"))
        if "000020" not in os.path.basename(f)
    )
    return files


# --------------------------------------------------------------------------- #
# Offline: the migration is a faithful carrier of the accepted design SQL
# --------------------------------------------------------------------------- #
def test_migration_file_exists_and_is_numbered_000020():
    assert os.path.exists(_MIGRATION), _MIGRATION
    assert os.path.basename(_MIGRATION).startswith("000020_")


@pytest.mark.skipif(
    _plan_path() is None,
    reason="design notes (gitignored) not present; set P042_PLAN_PATH to run",
)
def test_migration_embeds_design_blocks_verbatim():
    """The witness scripts prove the design blocks; assert the migration IS them,
    so the 108/108 + 10/10 + 35 witness results transfer to the shipped file."""
    migration = open(_MIGRATION, encoding="utf-8").read()
    blocks = _design_blocks()
    assert blocks.get("migration"), "p042:migration block not found in the plan"
    assert blocks.get("legacy-lock-safety"), "p042:legacy-lock-safety not found"
    assert blocks["migration"] in migration, \
        "migration file does not embed the p042:migration block verbatim"
    assert blocks["legacy-lock-safety"] in migration, \
        "migration file does not embed the p042:legacy-lock-safety block verbatim"


def test_migration_carries_all_design_load_bearing_statements():
    """Always-on offline guard (independent of the gitignored notes): the
    migration must carry every load-bearing statement the design requires, so an
    accidental edit to the core SQL is caught even where the plan is absent."""
    migration = open(_MIGRATION, encoding="utf-8").read()
    required = [
        # tables + identity/ordering
        "CREATE TABLE public.math_source_changes",
        "source_xid xid8 NOT NULL DEFAULT pg_current_xact_id()",
        "UNIQUE NULLS NOT DISTINCT (source_xid, zid)",
        "CREATE TABLE public.math_source_database",
        "incarnation uuid NOT NULL DEFAULT gen_random_uuid()",
        "CREATE TABLE public.math_source_consumers",
        "CREATE TABLE public.math_source_pending",
        # server-side functions and their RAISE guards
        "CREATE FUNCTION public.p042_checked_consumer",
        "P042_PRIMARY_REQUIRED",
        "P042_INCARNATION_MISMATCH",
        "P042_HORIZON_REGRESSION",
        "P042_INTERVAL_ALREADY_OPEN",
        "P042_INTERVAL_NOT_OPEN",
        "P042_INTERVAL_NOT_DRAINED",
        "P042_PAGE_SIZE",
        # statement-level source triggers incl. the AFTER TRUNCATE sweep
        "AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT",
        "AFTER TRUNCATE ON public.%I FOR EACH STATEMENT",
        "CREATE TRIGGER p042_journal_truncated AFTER TRUNCATE ON public.math_source_changes",
        "ENABLE ALWAYS TRIGGER",
        # pid_auto exception cleanup + per-zid counter frame + skipped-row release
        "CREATE OR REPLACE FUNCTION public.p042_pid_frame",
        "P042_PID_LOCK_IMBALANCE",
        "CREATE OR REPLACE FUNCTION pid_auto()",
        "PERFORM public.p042_pid_frame('abort')",
        "CREATE OR REPLACE FUNCTION pid_auto_unlock()",
        # least privilege
        "FROM PUBLIC",
    ]
    missing = [tok for tok in required if tok not in migration]
    assert not missing, f"migration is missing design statements: {missing}"


def test_migration_is_atomic_and_revokes_public():
    """Structural guarantees independent of the design markdown."""
    migration = open(_MIGRATION, encoding="utf-8").read()
    assert "BEGIN;" in migration and migration.rstrip().endswith("COMMIT;"), \
        "migration must install atomically in one transaction"
    assert "SET LOCAL lock_timeout" in migration, "short lock_timeout required"
    assert "REVOKE ALL ON public.math_source_changes" in migration
    assert "FROM PUBLIC" in migration
    # slice 0 installs no consumer
    assert "INSERT INTO public.math_source_consumers" not in migration


# --------------------------------------------------------------------------- #
# Integration: build a DB from the real migrations + THIS migration
# --------------------------------------------------------------------------- #
def _apply_sql_file(dbapi_conn, path: str) -> None:
    with open(path, encoding="utf-8") as fh:
        sql = fh.read()
    cur = dbapi_conn.cursor()
    cur.execute(sql)
    cur.close()


def _autocommit_psycopg2(engine):
    """A fresh, directly-owned psycopg2 autocommit connection (witness semantics:
    each statement is its own transaction, so a deliberately failing statement
    rolls back on its own and later statements still run)."""
    import psycopg2
    u = engine.url
    return psycopg2.connect(
        host=u.host, port=u.port, user=u.username,
        password=u.password, dbname=u.database,
    )


@pytest.fixture(scope="module")
def migrated_engine():
    """A fresh database built from the real edge migrations + 000020.

    Provisioning, in order of preference:
      1. ``P042_MIGRATION_TEST_DSN`` — a superuser DSN on which we CREATE a
         throwaway database (dropped at teardown).
      2. a throwaway ``postgres:17`` container on an ephemeral port via docker.
      3. skip.
    """
    sa = pytest.importorskip("sqlalchemy")
    pytest.importorskip("psycopg2")

    base_dsn = os.environ.get("P042_MIGRATION_TEST_DSN")
    container = None
    port = None

    if base_dsn is None:
        docker = shutil.which("docker")
        if not docker:
            pytest.skip("no P042_MIGRATION_TEST_DSN and docker not available")
        port = _free_port()
        container = f"p042s0-test-{uuid.uuid4().hex[:8]}"
        subprocess.run(
            [docker, "run", "--rm", "-d", "--name", container,
             "-e", "POSTGRES_PASSWORD=postgres",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
             "-p", f"{port}:5432", "postgres:17"],
            check=True, capture_output=True, text=True,
        )
        base_dsn = f"postgresql://postgres@127.0.0.1:{port}/postgres"
        _wait_ready(docker, container)

    admin = sa.create_engine(base_dsn, isolation_level="AUTOCOMMIT")
    dbname = "p042_mig_" + uuid.uuid4().hex
    try:
        with admin.connect() as c:
            c.exec_driver_sql(f"CREATE DATABASE {dbname}")
    except Exception as exc:  # pragma: no cover - environment guard
        admin.dispose()
        if container:
            subprocess.run(["docker", "stop", container],
                           capture_output=True, text=True)
        pytest.skip(f"cannot create test database: {exc}")

    db_dsn = base_dsn.rsplit("/", 1)[0] + "/" + dbname
    engine = sa.create_engine(db_dsn)
    raw = engine.raw_connection()
    try:
        raw.autocommit = True
        for path in _edge_migration_files():
            _apply_sql_file(raw, path)
        _apply_sql_file(raw, _MIGRATION)
    finally:
        raw.close()

    _PROVISION.update(container=container, dbname=dbname, db_dsn=db_dsn,
                      base_dsn=base_dsn, host=engine.url.host, port=engine.url.port,
                      user=engine.url.username)
    yield engine

    _PROVISION.clear()
    engine.dispose()
    try:
        with admin.connect() as c:
            c.exec_driver_sql(f"DROP DATABASE {dbname} WITH (FORCE)")
    finally:
        admin.dispose()
        if container:
            subprocess.run(["docker", "stop", container],
                           capture_output=True, text=True)


# Provisioning info for the psql-exit-status test, populated by the fixture.
_PROVISION: dict = {}


def _run_psql(extra_args, sql_text):
    """Apply ``sql_text`` to the migrated DB through a real ``psql``, returning the
    CompletedProcess, or None if no psql is reachable. Prefers ``docker exec`` into
    the throwaway container; else a host ``psql`` against the DSN."""
    container = _PROVISION.get("container")
    if container:
        cmd = ["docker", "exec", "-i", container, "psql", "-U", _PROVISION["user"],
               "-d", _PROVISION["dbname"], *extra_args, "-f", "-"]
    else:
        psql = shutil.which("psql")
        if not psql:
            return None
        cmd = [psql, _PROVISION["db_dsn"], *extra_args, "-f", "-"]
    return subprocess.run(cmd, input=sql_text, capture_output=True, text=True)


def _gauge(engine, name, consumer_id=None):
    """Read one collected gauge value (optionally scoped to a consumer)."""
    from polismath.poller.source_journal_metrics import collect_samples
    with engine.connect() as conn:
        samples = collect_samples(conn)
    for s in samples:
        if s.name == name and (consumer_id is None
                               or s.dimensions.get("ConsumerId") == consumer_id):
            return s.value
    raise AssertionError(f"gauge {name} for {consumer_id} not emitted")


def _age_progress(engine, consumer_id, seconds):
    """Simulate elapsed time since the last durable C advance (like the review
    probe ages first_dirty_at) so growth is testable without waiting."""
    import sqlalchemy as sa
    with engine.begin() as conn:
        conn.execute(sa.text(
            "UPDATE math_source_progress "
            "SET last_advanced_at = clock_timestamp() - make_interval(secs => :s) "
            "WHERE consumer_id = :c"), {"s": float(seconds), "c": consumer_id})


def _commit_conversation(engine, zid):
    raw = _autocommit_psycopg2(engine)
    try:
        raw.autocommit = True
        cur = raw.cursor()
        cur.execute("INSERT INTO conversations(zid) VALUES (%s)", (zid,))
        cur.close()
    finally:
        raw.close()


def _drain(client, limit=50):
    for _ in range(limit):
        if client.discover_page(page_size=100).n == 0:
            return
    raise AssertionError("discovery never drained")


def _free_port() -> int:
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _wait_ready(docker: str, container: str, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = subprocess.run([docker, "exec", container, "pg_isready", "-U", "postgres"],
                           capture_output=True, text=True)
        if r.returncode == 0:
            time.sleep(0.5)
            return
        time.sleep(0.5)
    raise RuntimeError("throwaway postgres never became ready")


pytestmark = pytest.mark.integration


class TestMigrationAgainstRealSchema:
    """Mirror of p042-r3-real-schema-check.py, but applying THIS migration."""

    def test_schema_objects_installed(self, migrated_engine):
        import sqlalchemy as sa
        with migrated_engine.connect() as conn:
            for t in ("math_source_changes", "math_source_database",
                      "math_source_consumers", "math_source_pending"):
                assert conn.execute(
                    sa.text("SELECT to_regclass(:t)"),
                    {"t": "public." + t}).scalar_one() == t
            assert conn.execute(
                sa.text("SELECT count(*) FROM math_source_database")
            ).scalar_one() == 1
            # 4 tables x 4 statement triggers = 16 source triggers
            assert conn.execute(sa.text(
                "SELECT count(*) FROM pg_trigger "
                "WHERE tgname LIKE 'p042_source_%' AND NOT tgisinternal"
            )).scalar_one() == 16
            # journal AFTER TRUNCATE sweep trigger present
            assert conn.execute(sa.text(
                "SELECT count(*) FROM pg_trigger WHERE tgname='p042_journal_truncated'"
            )).scalar_one() == 1
            # PUBLIC cannot execute the discovery RPCs
            assert conn.execute(sa.text(
                "SELECT has_function_privilege('public',"
                "'public.p042_open(text,xid8)','execute')"
            )).scalar_one() is False
            # slice 0: no consumer registered
            assert conn.execute(sa.text(
                "SELECT count(*) FROM math_source_consumers"
            )).scalar_one() == 0

    def test_pid_lock_safety_and_journaling(self, migrated_engine):
        """The r3 controls: later-row journal failure releases every advisory
        lock, source rolls back, and the ON CONFLICT DO NOTHING re-import path
        preserves pid/count with no residual lock (R3-N5 leak repair)."""
        raw = _autocommit_psycopg2(migrated_engine)
        try:
            raw.autocommit = True
            cur = raw.cursor()
            cur.execute("INSERT INTO users(uid) VALUES(501),(502),(503),(504)")
            cur.execute("INSERT INTO conversations(zid) VALUES(501),(502)")
            cur.execute(
                "CREATE FUNCTION p042_test_fail() RETURNS trigger LANGUAGE plpgsql "
                "AS $$ BEGIN IF NEW.zid=502 THEN RAISE EXCEPTION 'later-row'; END IF; "
                "RETURN NEW; END $$; "
                "CREATE TRIGGER fail_test BEFORE INSERT ON math_source_changes "
                "FOR EACH ROW EXECUTE FUNCTION p042_test_fail()"
            )
            with pytest.raises(Exception) as ei:
                cur.execute(
                    "INSERT INTO participants(zid,uid) "
                    "VALUES(501,501),(501,502),(502,503)")
            assert "later-row" in str(ei.value)
            cur.execute("SELECT count(*) FROM pg_locks "
                        "WHERE pid=pg_backend_pid() AND locktype='advisory'")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM participants WHERE zid IN (501,502)")
            assert cur.fetchone()[0] == 0
            cur.execute("DROP TRIGGER fail_test ON math_source_changes")
            cur.execute("INSERT INTO participants(zid,uid) "
                        "VALUES(501,501),(501,502),(502,503)")
            cur.execute("SELECT zid,pid FROM participants "
                        "WHERE zid IN (501,502) ORDER BY zid,pid")
            assert cur.fetchall() == [(501, 0), (501, 1), (502, 0)]
            cur.execute("SELECT participant_count FROM conversations "
                        "WHERE zid IN (501,502) ORDER BY zid")
            assert cur.fetchall() == [(2,), (1,)]
            cur.execute("SELECT current_setting('polis.p042_pid_frames',true)")
            assert cur.fetchone()[0] == ""
            # ON CONFLICT DO NOTHING re-import: skipped-row lock released, count kept
            cur.execute("INSERT INTO participants(zid,uid) VALUES(501,501),(501,504) "
                        "ON CONFLICT(zid,uid) DO NOTHING")
            cur.execute("SELECT pid,uid FROM participants WHERE zid=501 ORDER BY pid")
            assert cur.fetchall() == [(0, 501), (1, 502), (2, 504)]
            cur.execute("SELECT participant_count FROM conversations WHERE zid=501")
            assert cur.fetchone()[0] == 3
            cur.execute("SELECT count(*) FROM pg_locks "
                        "WHERE pid=pg_backend_pid() AND locktype='advisory'")
            assert cur.fetchone()[0] == 0
            cur.close()
        finally:
            raw.close()

    def test_b2_interval_and_identity_guards_raise(self, migrated_engine):
        """B2/M1: horizon regression, unopened interval, page size, incarnation and
        primary-required raise in SQL rather than reporting an empty poll."""
        from polismath.poller.source_journal import register_consumer, SourceJournalClient
        import sqlalchemy as sa

        cid = "guard-shadow-" + uuid.uuid4().hex[:6]
        register_consumer(migrated_engine, cid, "witness", "python",
                          "synthetic-profile/guard")
        client = SourceJournalClient(migrated_engine, cid)

        with migrated_engine.connect() as conn:
            with conn.begin():
                cur = client.lock(conn)
                # X < C  -> horizon regression
                regress = str(int(cur.next_xid) - 1)
                with pytest.raises(Exception) as ei:
                    client.open(conn, regress)
                assert "P042_HORIZON_REGRESSION" in str(ei.value)
        with migrated_engine.connect() as conn:
            with conn.begin():
                with pytest.raises(Exception) as ei:
                    client.page(conn, 1)
                assert "P042_INTERVAL_NOT_OPEN" in str(ei.value)
        with migrated_engine.connect() as conn:
            with conn.begin():
                with pytest.raises(Exception) as ei:
                    client.close(conn)
                assert "P042_INTERVAL_NOT_OPEN" in str(ei.value)
        # page size guard
        with migrated_engine.connect() as conn:
            with conn.begin():
                snap = client.horizon(conn)
                client.open(conn, snap.x)
                with pytest.raises(Exception) as ei:
                    client.page(conn, 0)
                assert "P042_PAGE_SIZE" in str(ei.value)
        # rotate the incarnation -> mismatch
        with migrated_engine.begin() as conn:
            conn.execute(sa.text(
                "UPDATE math_source_consumers SET database_incarnation=gen_random_uuid() "
                "WHERE consumer_id=:c"), {"c": cid})
        with migrated_engine.connect() as conn:
            with conn.begin():
                with pytest.raises(Exception) as ei:
                    client.lock(conn)
                assert "P042_INCARNATION_MISMATCH" in str(ei.value)

    def test_python_client_drains_and_acks(self, migrated_engine):
        """Exercise the Python journal client end-to-end against the migration:
        register -> commit a source change -> drain -> pending -> ack."""
        from polismath.poller.source_journal import (
            register_consumer, SourceJournalClient,
        )
        import sqlalchemy as sa

        cid = "drain-shadow-" + uuid.uuid4().hex[:6]
        register_consumer(migrated_engine, cid, "witness", "python",
                          "synthetic-profile/drain")
        client = SourceJournalClient(migrated_engine, cid)
        # bootstrap pending (NULL zid) present
        with migrated_engine.connect() as conn:
            boot = client.pending(conn, 10)
        assert any(p.zid is None for p in boot)
        # ack the bootstrap sweep
        with migrated_engine.begin() as conn:
            for p in client.pending(conn, 100):
                client.ack(conn, p.zid, p.dirty_version)

        # commit a real source change on an independent connection
        raw = _autocommit_psycopg2(migrated_engine)
        try:
            raw.autocommit = True
            cur = raw.cursor()
            cur.execute("INSERT INTO conversations(zid) VALUES (7042)")
            cur.close()
        finally:
            raw.close()

        # drain the closed interval to pending
        for _ in range(50):
            if client.discover_page(page_size=100).n == 0:
                break
        with migrated_engine.connect() as conn:
            pend = client.pending(conn, 100)
        assert 7042 in {p.zid for p in pend}

        # fail then ack one, with version-bound backoff
        target = next(p for p in pend if p.zid == 7042)
        with migrated_engine.begin() as conn:
            assert client.fail(conn, 7042, target.dirty_version, 3600) == \
                target.dirty_version
        with migrated_engine.begin() as conn:
            assert client.ack(conn, 7042, target.dirty_version) == 1

    def test_journal_truncate_sweeps_consumers(self, migrated_engine):
        """M3: truncating the journal schedules a NULL-zid sweep for each consumer."""
        from polismath.poller.source_journal import register_consumer
        import sqlalchemy as sa
        cid = "sweep-shadow-" + uuid.uuid4().hex[:6]
        register_consumer(migrated_engine, cid, "witness", "python",
                          "synthetic-profile/sweep")
        with migrated_engine.begin() as conn:
            conn.execute(sa.text(
                "DELETE FROM math_source_pending WHERE consumer_id=:c"), {"c": cid})
            conn.execute(sa.text("TRUNCATE math_source_changes"))
            n = conn.execute(sa.text(
                "SELECT count(*) FROM math_source_pending "
                "WHERE consumer_id=:c AND zid IS NULL"), {"c": cid}).scalar_one()
        assert n == 1

    def test_metrics_collect_mandatory_gauges(self, migrated_engine):
        from polismath.poller.source_journal_metrics import (
            collect_samples, emit_source_journal_metrics, METRIC_NAMESPACE,
        )
        with migrated_engine.connect() as conn:
            samples = collect_samples(conn)
        names = {s.name for s in samples}
        for required in ("ObserverHealthy", "OldestTransactionAgeSeconds",
                         "OldestBackendXminAgeSeconds", "OldestPreparedAgeSeconds",
                         "XidDistance", "JournalRows", "JournalBytes"):
            assert required in names, required
        assert next(s for s in samples if s.name == "ObserverHealthy").value == 1.0
        # emit through a captured sink
        captured = []
        emit_source_journal_metrics(migrated_engine, sink=captured.extend)
        assert any(s.name == "JournalRows" for s in captured)
        assert METRIC_NAMESPACE == "Polis/MathSource"

    # -- Round 2, P2-1: once-only re-run refusal + failure exit status -------- #
    def test_rerun_refuses_and_preserves_incarnation_and_journal(self, migrated_engine):
        """A second application RAISES P042_ALREADY_INSTALLED before any DDL and
        leaves the incarnation, journal and cursors untouched (not a silent
        no-op, not a clobber)."""
        import sqlalchemy as sa
        migration = open(_MIGRATION, encoding="utf-8").read()
        with migrated_engine.begin() as conn:
            conn.execute(sa.text("INSERT INTO conversations(zid) VALUES (91001)"))
        with migrated_engine.connect() as conn:
            before_inc = conn.execute(sa.text(
                "SELECT incarnation FROM math_source_database")).scalar_one()
            before_journal = conn.execute(sa.text(
                "SELECT count(*) FROM math_source_changes")).scalar_one()
        raw = _autocommit_psycopg2(migrated_engine)
        try:
            raw.autocommit = True
            cur = raw.cursor()
            with pytest.raises(Exception) as ei:
                cur.execute(migration)
            assert "P042_ALREADY_INSTALLED" in str(ei.value)
            raw.rollback()
        finally:
            raw.close()
        with migrated_engine.connect() as conn:
            assert conn.execute(sa.text(
                "SELECT incarnation FROM math_source_database")).scalar_one() == before_inc
            assert conn.execute(sa.text(
                "SELECT count(*) FROM math_source_changes")).scalar_one() == before_journal

    def test_failure_path_returns_nonzero_only_with_on_error_stop(self):
        """The advertised invocation must fail loudly. On an already-installed DB
        `psql -v ON_ERROR_STOP=1` exits nonzero; without the flag psql exits 0
        after the ROLLBACK (which is exactly why the flag is required)."""
        migration = open(_MIGRATION, encoding="utf-8").read()
        stop = _run_psql(["-v", "ON_ERROR_STOP=1"], migration)
        if stop is None:
            pytest.skip("no psql reachable (no docker container and no host psql)")
        assert stop.returncode != 0, (stop.returncode, stop.stderr)
        assert "P042_ALREADY_INSTALLED" in (stop.stdout + stop.stderr)
        nostop = _run_psql([], migration)
        assert nostop.returncode == 0, (
            "control: without ON_ERROR_STOP psql masks the failure as success; "
            f"got {nostop.returncode}")

    # -- Round 2, P2-2: the granted consumer role can actually run horizon ---- #
    def test_horizon_and_discovery_work_as_granted_consumer_role(self):
        """horizon() reads math_source_database directly (outside the RPCs), so
        the migration's consumer grants must include SELECT on it. Provision a
        fresh DB with the role + GUC so the migration's guarded grant block
        applies, then run horizon + register + a discovery cycle + ack under
        `SET LOCAL ROLE`, and confirm PUBLIC stays revoked."""
        import sqlalchemy as sa
        from polismath.poller.source_journal import SourceJournalClient, HORIZON_SQL

        base = _PROVISION.get("base_dsn")
        if not base:
            pytest.skip("no base DSN available for a fresh role database")
        suffix = uuid.uuid4().hex[:8]
        role = "p042_role_" + suffix
        dbname = "p042_role_" + suffix
        admin = sa.create_engine(base, isolation_level="AUTOCOMMIT")
        engine = None
        try:
            with admin.connect() as c:
                c.exec_driver_sql(f"CREATE ROLE {role} NOLOGIN")
                c.exec_driver_sql(f"CREATE DATABASE {dbname}")
            db_dsn = base.rsplit("/", 1)[0] + "/" + dbname
            engine = sa.create_engine(db_dsn)
            raw = engine.raw_connection()
            try:
                raw.autocommit = True
                cur = raw.cursor()
                for path in _edge_migration_files():
                    cur.execute(open(path, encoding="utf-8").read())
                # GUC picked up by the migration's guarded grant block.
                cur.execute(f"SET p042.consumer_role = '{role}'")
                cur.execute(open(_MIGRATION, encoding="utf-8").read())
                cur.close()
            finally:
                raw.close()

            client = SourceJournalClient(engine, "role-consumer-" + suffix)

            def as_role(fn):
                with engine.connect() as conn:
                    with conn.begin():
                        conn.exec_driver_sql(f"SET LOCAL ROLE {role}")
                        return fn(conn)

            # The exact P2-2 defect: this used to raise 42501 on math_source_database.
            snap = as_role(lambda conn: client.horizon(conn))
            assert snap.database_incarnation is not None

            # register (horizon + INSERT consumer + INSERT bootstrap) as the role
            def _register(conn):
                s = client.horizon(conn)
                conn.execute(sa.text(
                    "INSERT INTO math_source_consumers(consumer_id,engine,math_env,"
                    "scope_digest,system_identifier,database_incarnation,next_xid) "
                    "VALUES(:c,'witness','python','scope',:sid,"
                    "CAST(:inc AS uuid),CAST(CAST(:x AS text) AS xid8))"),
                    {"c": client.consumer_id, "sid": s.system_identifier,
                     "inc": s.database_incarnation, "x": s.x})
                conn.execute(sa.text(
                    "INSERT INTO math_source_pending(consumer_id,zid) VALUES(:c,NULL)"),
                    {"c": client.consumer_id})
            as_role(_register)

            # a full discovery cycle (lock/open/page/close) + pending + ack as role
            _commit_conversation(engine, 95001)

            def _cycle(conn):
                cur = client.lock(conn)
                if not cur.interval_open:
                    client.open(conn, client.horizon(conn).x)
                r = client.page(conn, 100)
                if r.n == 0:
                    client.close(conn)
                return r
            for _ in range(50):
                if as_role(_cycle).n == 0:
                    break

            def _ack(conn):
                items = client.pending(conn, 100)
                for it in items:
                    client.ack(conn, it.zid, it.dirty_version)
                return items
            acked = as_role(_ack)
            assert any(it.zid == 95001 for it in acked) or acked == []

            # PUBLIC remains revoked from the RPC.
            with engine.connect() as conn:
                assert conn.execute(sa.text(
                    "SELECT has_function_privilege('public',"
                    "'public.p042_open(text,xid8)','execute')")).scalar_one() is False
                # the granted role can execute it and read the identity table
                assert conn.execute(sa.text(
                    "SELECT has_table_privilege(:r,'public.math_source_database','SELECT')"),
                    {"r": role}).scalar_one() is True
        finally:
            if engine is not None:
                engine.dispose()
            with admin.connect() as c:
                c.exec_driver_sql(f"DROP DATABASE IF EXISTS {dbname} WITH (FORCE)")
                c.exec_driver_sql(f"DROP ROLE IF EXISTS {role}")
            admin.dispose()

    # -- Round 2, P2-3: ConsumerNoProgressSeconds is durable-advance based ----- #
    def _register_drained(self, engine, tag):
        from polismath.poller.source_journal import register_consumer, SourceJournalClient
        cid = tag + "-" + uuid.uuid4().hex[:6]
        register_consumer(engine, cid, "witness", "python", "scope/" + tag)
        client = SourceJournalClient(engine, cid)
        import sqlalchemy as sa
        with engine.begin() as conn:
            for it in client.pending(conn, 1000):
                client.ack(conn, it.zid, it.dirty_version)
        _drain(client)
        return cid, client

    def test_no_progress_grows_on_unseen_journal_demand(self, migrated_engine):
        """M4 stall drill: an old active xid plus a newer committed change leaves
        the journal with demand the consumer cannot reach; while C does not
        advance, ConsumerNoProgressSeconds must grow (not sit at a healthy 0)."""
        import sqlalchemy as sa
        cid, client = self._register_drained(migrated_engine, "np-unseen")
        blocker = _autocommit_psycopg2(migrated_engine)
        try:
            blocker.autocommit = False
            bcur = blocker.cursor()
            bcur.execute("SELECT pg_current_xact_id()")   # hold an old xid open
            _commit_conversation(migrated_engine, 96001)  # newer committed demand
            client.discover_page(page_size=100)           # cannot advance past blocker
            # the stall has persisted (simulate 5 min since the last real advance)
            _age_progress(migrated_engine, cid, 300)
            client.discover_page(page_size=100)           # still cannot advance
            with migrated_engine.connect() as conn:
                journal = conn.execute(sa.text(
                    "SELECT count(*) FROM math_source_changes")).scalar_one()
            assert journal > 0
            assert _gauge(migrated_engine, "ConsumerNoProgressSeconds", cid) >= 300
            assert _gauge(migrated_engine, "ObserverHealthy") == 1.0
        finally:
            blocker.rollback()
            blocker.close()

    def test_no_progress_not_reset_by_backoff(self, migrated_engine):
        """Backing off a pending item must NOT reset the gauge (it is not pending
        age); OldestPendingAgeSeconds keeps the delayed work."""
        cid, client = self._register_drained(migrated_engine, "np-backoff")
        _commit_conversation(migrated_engine, 96101)
        _drain(client)
        _age_progress(migrated_engine, cid, 300)
        before = _gauge(migrated_engine, "ConsumerNoProgressSeconds", cid)
        assert before >= 300
        with migrated_engine.begin() as conn:
            item = client.pending(conn, 100)[0]
            client.fail(conn, item.zid, item.dirty_version, 3600)
        after = _gauge(migrated_engine, "ConsumerNoProgressSeconds", cid)
        assert after >= 300, "backoff must not reset no-progress to zero"
        # delayed work is still counted by OldestPendingAgeSeconds
        assert _gauge(migrated_engine, "OldestPendingAgeSeconds", cid) >= 0

    def test_no_progress_resets_on_durable_advance(self, migrated_engine):
        """A durable C advance resets the gauge even while older pending remains."""
        import sqlalchemy as sa
        cid, client = self._register_drained(migrated_engine, "np-advance")
        _commit_conversation(migrated_engine, 96201)
        _drain(client)                                   # older pending for 96201
        _age_progress(migrated_engine, cid, 300)
        assert _gauge(migrated_engine, "ConsumerNoProgressSeconds", cid) >= 300
        # a real new change; draining it advances C (no blocker) -> stamp now
        _commit_conversation(migrated_engine, 96202)
        _drain(client)
        with migrated_engine.connect() as conn:
            still_pending = conn.execute(sa.text(
                "SELECT count(*) FROM math_source_pending WHERE consumer_id=:c"),
                {"c": cid}).scalar_one()
        assert still_pending >= 1, "older pending must still be present"
        assert _gauge(migrated_engine, "ConsumerNoProgressSeconds", cid) < 300, \
            "a durable C advance must reset no-progress even with older pending"

    def test_no_progress_zero_when_no_demand(self, migrated_engine):
        """No demand -> a genuine zero (no pending, no journal work at/after C)."""
        cid, client = self._register_drained(migrated_engine, "np-idle")
        import sqlalchemy as sa
        with migrated_engine.begin() as conn:
            for it in client.pending(conn, 1000):
                client.ack(conn, it.zid, it.dirty_version)
        _drain(client)
        _age_progress(migrated_engine, cid, 300)  # even after 5 min, no demand -> 0
        assert _gauge(migrated_engine, "ConsumerNoProgressSeconds", cid) == 0


# --------------------------------------------------------------------------- #
# Flag: OFF by default; when OFF the client factory is inert (no DB needed)
# --------------------------------------------------------------------------- #
def test_flag_defaults_off_and_gates_client(monkeypatch):
    from polismath.poller import source_journal as sj
    monkeypatch.delenv(sj.SOURCE_JOURNAL_ENABLED_ENV, raising=False)
    assert sj.source_journal_enabled() is False
    # OFF -> factory returns None without touching the engine (engine=None proves it)
    assert sj.maybe_source_journal_client(None, "any-consumer") is None
    monkeypatch.setenv(sj.SOURCE_JOURNAL_ENABLED_ENV, "true")
    assert sj.source_journal_enabled() is True
    client = sj.maybe_source_journal_client(object(), "any-consumer")
    assert client is not None and client.consumer_id == "any-consumer"
    monkeypatch.setenv(sj.SOURCE_JOURNAL_ENABLED_ENV, "banana")
    assert sj.source_journal_enabled() is False  # unrecognised -> OFF
