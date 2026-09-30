#!/usr/bin/env python3
"""Math Poller CLI — the Python replacement for the Clojure math container.

Polls Postgres for votes/moderation, maintains per-conversation math state in
memory, and writes math_main / math_bidtopid / math_ptptstats under one
math_env.  See polismath.poller (package docstring) and
delphi/docs/MATH_POLLER_DESIGN.md.

Usage:
    uv run python scripts/math_poller.py            # run forever (SIGTERM stops)
    uv run python scripts/math_poller.py --once      # one poll cycle then exit
"""

import argparse
import contextlib
import logging
import math
import os
import signal
import socket
import sys
import threading
import time

import psycopg2

from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.poller.readiness import ReadinessConfigError, ReadinessReporter, ReadinessSettings
from polismath.poller.service import MathPollerService, PollerConfig, PoolDrainTimeout


def _configure_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s",
    )


# The math_env the server reads (the legacy Clojure engine's namespace). While
# this poller runs as a shadow beside that engine, writing under it would
# overwrite the served rows, so startup refuses it unless explicitly allowed.
SERVED_MATH_ENV = "prod"
ALLOW_SERVED_ENV_VAR = "MATH_POLLER_ALLOW_SERVED_ENV"


def _refuse_served_env(math_env: str) -> None:
    """Exit non-zero before touching the database when MATH_ENV is unsafe.

    Refused: an empty or whitespace-only MATH_ENV (always), and the served
    namespace ``prod`` unless MATH_POLLER_ALLOW_SERVED_ENV=1 (cut-over only).
    """
    if not math_env.strip():
        print(
            "refusing to start: MATH_ENV is empty; set it to the poller's own "
            "namespace (e.g. python)",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if (
        math_env.strip() == SERVED_MATH_ENV
        and os.environ.get(ALLOW_SERVED_ENV_VAR) != "1"
    ):
        print(
            f"refusing to start: MATH_ENV={SERVED_MATH_ENV} is the served "
            f"namespace and would overwrite the served math rows; set "
            f"{ALLOW_SERVED_ENV_VAR}=1 only to cut over",
            file=sys.stderr,
        )
        raise SystemExit(2)


# --- Single-writer admission -------------------------------------------------
#
# Every Delphi-role host runs this entrypoint, and PollerConfig's shards are
# per-process, so nothing else stops two hosts from both writing every zid
# under one label. Admission is a Postgres session-level advisory lock keyed on
# the label, held on a dedicated connection for the process lifetime:
#   * not acquired -> log the holder, sleep, retry forever (never exit: the
#     compose restart policy would spin). A replacement host takes over within
#     one retry of the old process dying, because its session's lock dies too;
#   * acquired -> a watchdog thread re-checks that this session still holds
#     the lock; if the connection fails or the lock is gone, the process exits
#     at once (os._exit, code 3) instead of writing without admission.
# Advisory locks need no schema, grant or extra privilege.
LOCK_KEY_PREFIX = "polis-math-python:"
LOCK_RETRY_ENV = "MATH_POLLER_LOCK_RETRY_S"
LOCK_LIVENESS_ENV = "MATH_POLLER_LOCK_LIVENESS_S"
DEFAULT_LOCK_RETRY_S = 30.0
DEFAULT_LOCK_LIVENESS_S = 5.0
LOCK_LOST_EXIT_CODE = 3
# Accepted range for both intervals, in seconds.
LOCK_INTERVAL_MIN_S = 1.0
LOCK_INTERVAL_MAX_S = 3600.0

# A bigint advisory key k appears in pg_locks as classid = high 32 bits,
# objid = low 32 bits, objsubid = 1.
_LOCK_KEY_MATCH = (
    "l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 "
    "AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(%s)::bigint"
)
_TRY_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext(%s))"
_HOLDER_SQL = (
    "SELECT l.pid, a.application_name FROM pg_locks l "
    "LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE " + _LOCK_KEY_MATCH + " LIMIT 1"
)
_HELD_SQL = (
    "SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = pg_backend_pid() AND "
    + _LOCK_KEY_MATCH
    + ")"
)


def _interval_seconds(name: str, default: float) -> float:
    """Read an admission interval; refuse (exit 2, before any connection)
    anything that is not a finite number of seconds within
    [LOCK_INTERVAL_MIN_S, LOCK_INTERVAL_MAX_S]. nan/inf/1e309 and huge finite
    values would otherwise break time.sleep and with it the watchdog."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not (math.isfinite(value) and LOCK_INTERVAL_MIN_S <= value <= LOCK_INTERVAL_MAX_S):
        print(
            f"refusing to start: {name}={raw!r} must be a number of seconds "
            f"from {LOCK_INTERVAL_MIN_S:g} to {LOCK_INTERVAL_MAX_S:g}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return value


def _lock_key(math_env: str) -> str:
    return LOCK_KEY_PREFIX + math_env.strip()


def _lock_application_name(math_env: str) -> str:
    return f"math-python:{math_env.strip()}@{socket.gethostname()}"


def _open_lock_connection(config: PollerConfig):
    """A dedicated autocommit connection with the service's own parameters
    (DATABASE_URL parts + DATABASE_SSL_MODE, as PostgresConfig resolves them)."""
    if not config.database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    pc = PostgresConfig(url=config.database_url, math_env=config.math_env)
    params = {
        "host": pc.host,
        "port": pc.port,
        "dbname": pc.database,
        "user": pc.user,
        "password": pc.password,
        "application_name": _lock_application_name(config.math_env),
        "connect_timeout": int(os.environ.get("POSTGRES_CONNECT_TIMEOUT") or 30),
        # Notice a dead peer promptly even while idle or mid-query.
        "keepalives": 1,
        "keepalives_idle": 10,
        "keepalives_interval": 5,
        "keepalives_count": 3,
        "tcp_user_timeout": 30000,
    }
    if pc.ssl_mode:
        params["sslmode"] = pc.ssl_mode
    conn = psycopg2.connect(**params)
    conn.autocommit = True
    return conn


def _acquire_single_writer_lock(conn, math_env: str, retry_s: float, log) -> None:
    """Block until this session holds the label's advisory lock."""
    key = _lock_key(math_env)
    while True:
        with conn.cursor() as cur:
            cur.execute(_TRY_LOCK_SQL, (key,))
            if cur.fetchone()[0]:
                return
            cur.execute(_HOLDER_SQL, (key,))
            row = cur.fetchone()
        if row is None:
            holder = "released"
        else:
            holder = f"{row[1] or 'not visible'} (pid {row[0]})"
        log.warning("waiting for single-writer lock; holder=%s", holder)
        time.sleep(retry_s)


# The process's readiness reporter (P-072), once started: the lock-lost exit
# logs its final standby line before terminating.
_READINESS: "ReadinessReporter | None" = None


def _exit_lock_lost(log, reason: str) -> None:
    """Terminate the whole process (code 3). Never returns."""
    try:
        if _READINESS is not None:
            with contextlib.suppress(Exception):
                _READINESS.lock_lost()
        log.critical("single-writer lock lost (%s); exiting with code %d", reason, LOCK_LOST_EXIT_CODE)
        for stream in (sys.stdout, sys.stderr):
            with contextlib.suppress(OSError, ValueError):
                stream.flush()
    finally:
        # os._exit, not SystemExit: this runs on the watchdog thread, and the
        # service's worker threads must not get another write in.
        os._exit(LOCK_LOST_EXIT_CODE)


def _start_lock_watchdog(conn, math_env: str, interval_s: float, log) -> threading.Thread:
    """Re-check the lock every interval_s. The interval is a scheduling
    target, not a wall-clock bound or a publication fence: the thread must be
    scheduled and its query must complete. ANY way out of the loop (lock
    gone, query failure, or an unexpected exception anywhere in the loop,
    the sleep included) terminates the process, so the service can never
    outlive its watchdog."""
    key = _lock_key(math_env)

    def check_forever() -> str:
        while True:
            time.sleep(interval_s)
            try:
                with conn.cursor() as cur:
                    cur.execute(_HELD_SQL, (key,))
                    held = cur.fetchone()[0]
            except Exception as exc:  # noqa: BLE001 - any failure means admission is unproven
                return f"lock connection failed: {exc.__class__.__name__}"
            if not held:
                return "session no longer holds the lock"

    def watch():
        reason = "watchdog loop ended"
        try:
            reason = check_forever()
        except BaseException as exc:  # noqa: BLE001 - the watchdog must never die quietly
            reason = f"watchdog failed: {exc.__class__.__name__}"
        finally:
            _exit_lock_lost(log, reason)

    thread = threading.Thread(target=watch, name="single-writer-lock", daemon=True)
    thread.start()
    return thread


def _hold_single_writer_lock(config: PollerConfig, log):
    """Admit this process as the label's only writer; returns the lock
    connection, which must stay open (and referenced) for the process life."""
    retry_s = _interval_seconds(LOCK_RETRY_ENV, DEFAULT_LOCK_RETRY_S)
    liveness_s = _interval_seconds(LOCK_LIVENESS_ENV, DEFAULT_LOCK_LIVENESS_S)
    conn = _open_lock_connection(config)
    _acquire_single_writer_lock(conn, config.math_env, retry_s, log)
    log.info(
        "holding single-writer lock for math_env=%s as %s",
        config.math_env.strip(),
        _lock_application_name(config.math_env),
    )
    if _READINESS is not None:
        _READINESS.became_primary()
    _start_lock_watchdog(conn, config.math_env, liveness_s, log)
    return conn


def _start_readiness(config: PollerConfig, log) -> ReadinessReporter:
    """The readiness/liveness lines (P-072), from before the lock is taken,
    so a waiting standby is visible too. A bad interval setting refuses to
    start (exit 2): an unmonitored poller must not look monitored."""
    global _READINESS
    try:
        settings = ReadinessSettings.from_env()
    except ReadinessConfigError as exc:
        print(f"refusing to start: {exc}", file=sys.stderr)
        raise SystemExit(2)
    reporter = ReadinessReporter(settings, config)
    _READINESS = reporter
    reporter.start()
    log.info("readiness lines every %gs (run=%s poller_config=%s stale_after=%gs)",
             settings.interval_s, reporter.run, reporter.poller_config, settings.stale_s)
    return reporter


def _backfill_config(log):
    """The opt-in pre-switch backfill (P-070), or None. A bad MATH_BACKFILL_*
    value turns the backfill off and is logged; it never stops the poller."""
    from polismath.poller.backfill import BackfillConfig, ConfigError

    try:
        cfg = BackfillConfig.from_env()
    except ConfigError as exc:
        log.error("math-backfill DISABLED: %s", exc)
        return None
    return cfg if cfg.enabled else None


def _memory_admission(config: PollerConfig, log):
    """The shared memory budget (polismath.poller.admission). Refuses to start
    (exit 2) when the container limit is unknown: no cgroup limit and no
    MATH_POLLER_MEMORY_LIMIT_MB. Every compute path reserves against it."""
    from polismath.poller.admission import MemoryAdmission

    try:
        admission = MemoryAdmission.from_config(config)
    except ValueError as exc:
        log.error("memory admission unusable (%s); refusing to start", exc)
        raise SystemExit(2)
    if not admission.limited:
        log.error(
            "memory limit unknown: no cgroup limit (/sys/fs/cgroup/memory.max or "
            "memory.limit_in_bytes) and MATH_POLLER_MEMORY_LIMIT_MB unset; refusing to start"
        )
        raise SystemExit(2)
    log.info(
        "memory admission: limit_mb=%.0f (%s) budget_mb=%.0f cache_budget_mb=%.0f base_mb=%.0f",
        admission.limit_bytes / 2**20, admission.source, admission.budget_bytes / 2**20,
        admission.cache_budget_bytes / 2**20, admission.base_bytes / 2**20,
    )
    return admission


def _build_service(config: PollerConfig) -> MathPollerService:
    if not config.database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    log = logging.getLogger("math_poller")
    admission = _memory_admission(config, log)
    pg = PostgresClient(PostgresConfig(url=config.database_url, math_env=config.math_env))
    pg.initialize()
    return MathPollerService(
        pg, config, backfill_config=_backfill_config(log), admission=admission,
        # One run id for the readiness lines and the backfill's report lines.
        run_id=_READINESS.run if _READINESS is not None else None,
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Polis Python math poller")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single vote+moderation poll cycle, block until processed, exit.",
    )
    args = parser.parse_args(argv)

    _configure_logging()
    log = logging.getLogger("math_poller")

    config = PollerConfig.from_env()
    _refuse_served_env(config.math_env)
    readiness = None if args.once else _start_readiness(config, log)
    # Held (and referenced) until the process exits; closing it releases the lock.
    lock_conn = _hold_single_writer_lock(config, log)  # noqa: F841
    service = _build_service(config)
    if readiness is not None and hasattr(service, "readiness_snapshot"):
        readiness.set_source(service.readiness_snapshot)

    if args.once:
        log.info("Running a single poll cycle (--once)")
        try:
            service.poll_once()
        except PoolDrainTimeout as exc:
            # Report through the logger _configure_logging() just set up, the
            # way _build_service reports its own failure, instead of letting
            # the default excepthook print a bare traceback to stderr.
            log.error("Single poll cycle did not complete: %s", exc)
            # stop() here rather than leaving the pool to
            # concurrent.futures' interpreter-exit hook: the shutdown is then
            # inside main's control and logged. A worker stuck FOREVER still
            # blocks — shutdown(wait=True) joins non-daemon executor threads
            # either way, and forcing exit past that would need os._exit.
            service.stop()
            return 1
        service.stop()
        return 0

    # Graceful shutdown on SIGTERM/SIGINT (docker stop, Ctrl-C).
    def _handle_signal(signum, _frame):
        log.info("Received signal %s; stopping poller", signum)
        service._stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    # Backfill operator controls (P-070): SIGUSR1 approves the gate after the
    # N largest; SIGUSR2 pauses or resumes. Handlers only set flags (the
    # scheduler persists them); with the backfill off they log and do nothing.
    def _handle_backfill_signal(signum, _frame):
        backfill = getattr(service, "backfill", None)
        if backfill is None:
            log.warning("Received signal %s but the backfill is not enabled", signum)
            return
        threading.Thread(
            target=backfill.approve_gate if signum == signal.SIGUSR1 else backfill.toggle_pause,
            name="backfill-signal", daemon=True,
        ).start()

    signal.signal(signal.SIGUSR1, _handle_backfill_signal)
    signal.signal(signal.SIGUSR2, _handle_backfill_signal)

    log.info(
        "Starting math poller: math_env=%s vote_interval=%dms mod_interval=%dms "
        "pool=%d",
        config.math_env,
        config.vote_interval_ms,
        config.mod_interval_ms,
        config.worker_pool_size,
    )
    service.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
