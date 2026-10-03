"""The large memory class under docker compose (P-073 §7.1): the two services
of ``docker-compose.yml``, ``math-python`` (small) and ``math-python-large``,
on one throwaway Postgres, configured only through a compose env file, as the
deploy hook configures a box.

What it proves, end to end through the real service definitions: every knob
the hand-off needs reaches each container (a setting compose does not forward
is invisible); the small poller routes an oversized conversation instead of
computing it and writes the manifest; the large worker reads it, computes the
conversation and publishes it under its own label only; the small poller
promotes the staged bundle into its own label; a later vote takes the same
path (warm update, promotion of the newer bundle); an ordinary conversation is
published by the small poller alone; and the large worker's readiness lines
never carry the heartbeat phrase the P-072 alarm counts.

Generated fixtures only. Thresholds are scaled down: the small poller gets a
1g cgroup and the large worker 4g, and the route fraction is chosen so a
conversation of a few hundred thousand votes routes while a small one does
not.

Opt-in (needs docker and a delphi image; it starts containers):

    POLIS_TEST_COMPOSE_PARITY=1
    POLIS_PARITY_IMAGE=<a delphi image built from this checkout, target final>
    COMPOSE_PROJECT_NAME=<unique per run>        (default: a random one)
    POLIS_PARITY_PG_PORT=<free host port>        (default: a random free one)
    POLIS_TEST_MINIO=1                           (optional: the manifest goes
                                                  through the compose MinIO
                                                  service over S3 instead of a
                                                  shared volume)

Everything it starts is removed afterwards (``docker compose down -v``).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration

SMALL, LARGE = "math-python", "math-python-large"
SMALL_LABEL, LARGE_LABEL = "python", "python-large"
HEARTBEAT_PHRASE = "math_poller readiness/1 role=primary progress=ok"
STALE_PHRASES = ("math_poller discovery_stale/1", "math_poller readiness_test/1")
PG_USER, PG_PASSWORD, PG_DB = "postgres", "generated-parity-secret", "polis-parity"
BUCKET = "generated-parity-bucket"
# Generated conversations: one routed to the large class, one ordinary.
LARGE_ZID, SMALL_ZID = 7301, 7302
LARGE_SHAPE = (600, 600)       # participants x comments, ~240k votes
SMALL_SHAPE = (20, 10)


def _find_checkout():
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / "docker-compose.yml").is_file() and (candidate / "server").is_dir():
            return candidate
    return None


CHECKOUT = _find_checkout()


def _require():
    if os.environ.get("POLIS_TEST_COMPOSE_PARITY") != "1":
        pytest.skip("set POLIS_TEST_COMPOSE_PARITY=1 to run the compose parity test (needs docker)")
    if CHECKOUT is None:
        pytest.skip("no Polis checkout with docker-compose.yml found")
    if shutil.which("docker") is None:
        pytest.skip("docker not available")
    image = os.environ.get("POLIS_PARITY_IMAGE")
    if not image:
        pytest.skip("set POLIS_PARITY_IMAGE to a delphi image built from this checkout")
    return image


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Stack:
    """One compose project over docker-compose.yml plus a test override."""

    def __init__(self, workdir: Path, image: str, use_minio: bool):
        self.project = os.environ.get("COMPOSE_PROJECT_NAME") or f"parity-{uuid.uuid4().hex[:8]}"
        self.port = int(os.environ.get("POLIS_PARITY_PG_PORT") or _free_port())
        self.use_minio = use_minio
        self.workdir = workdir
        server_env = workdir / "server.env"
        server_env.write_text("")
        commit = uuid.uuid4().hex + uuid.uuid4().hex[:8]
        if use_minio:
            manifest = f"s3://{BUCKET}/math-capacity/{SMALL_LABEL}/manifest.json"
        else:
            manifest = "file:///app/capacity/manifest.json"
        # The env file is the only configuration channel, as on a box: the
        # deploy hook writes .env and compose interpolates it.
        env = {
            "POSTGRES_DB": PG_DB, "POSTGRES_USER": PG_USER, "POSTGRES_PASSWORD": PG_PASSWORD,
            "DATABASE_URL": f"postgres://{PG_USER}:{PG_PASSWORD}@postgres:5432/{PG_DB}",
            "SERVER_ENV_FILE": str(server_env), "TAG": "parity",
            "MATH_PYTHON_ENV": SMALL_LABEL,
            "MATH_CAPACITY_ROUTING": "1", "MATH_CAPACITY_PROMOTE": "1",
            "MATH_CAPACITY_ROUTE_FRACTION": "0.3", "MATH_CAPACITY_KEEP_FRACTION": "0.2",
            "MATH_CAPACITY_STATE_PATH": "/app/backfill-state/capacity.json",
            "MATH_CAPACITY_MANIFEST_URI": manifest,
            "DELPHI_POLLER_CONTAINER_MEMORY": "1g", "MATH_LARGE_CONTAINER_MEMORY": "4g",
            "MATH_POLLER_SOURCE_COMMIT": commit,
            "MATH_POLLER_INSTANCE_ID": "i-0generatedparity",
            "MATH_POLLER_READINESS_INTERVAL_S": "5",
            "MATH_POLLER_RECONCILE_INTERVAL_MS": "3000",
            "POLL_FROM_DAYS_AGO": "10",
        }
        if use_minio:
            env.update({"AWS_S3_ENDPOINT": "http://minio:9000", "AWS_REGION": "us-east-1"})
        self.env_file = workdir / "parity.env"
        self.env_file.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
        # The override only adapts the stack to a test host: a prebuilt image,
        # a private Postgres port, no dump mount, no published MinIO ports, and
        # (file mode) one volume both pollers see, standing in for the bucket.
        shared = "" if use_minio else "      - parity-capacity:/app/capacity\n"
        # The pollers never receive the env document's AWS key pair (they
        # sign as the instance role); local MinIO needs one, so only this
        # test override gives it to them.
        minio_keys = ("    environment:\n      - AWS_ACCESS_KEY_ID=minioadmin\n"
                      "      - AWS_SECRET_ACCESS_KEY=minioadmin\n") if use_minio else ""
        self.override = workdir / "override.yml"
        self.override.write_text(
            "services:\n"
            "  postgres:\n"
            "    restart: \"no\"\n"
            f"    ports: !override [\"127.0.0.1:{self.port}:5432\"]\n"
            "    volumes: !override [\"parity-pg:/var/lib/postgresql/data\"]\n"
            f"  {SMALL}:\n"
            f"    image: {image}\n"
            "    pull_policy: never\n"
            "    restart: \"no\"\n"
            + minio_keys
            + ("    volumes:\n" + shared if shared else "")
            + f"  {LARGE}:\n"
            f"    image: {image}\n"
            "    pull_policy: never\n"
            "    restart: \"no\"\n"
            + minio_keys
            + ("    volumes:\n" + shared if shared else "")
            + "  minio:\n"
            "    ports: !reset []\n"
            "    volumes: !override [\"parity-minio:/data\"]\n"
            "volumes:\n  parity-pg: {}\n  parity-minio: {}\n"
            + ("" if use_minio else "  parity-capacity: {}\n")
        )

    def compose(self, *args, check=True, timeout=600):
        cmd = ["docker", "compose", "-p", self.project, "--project-directory", str(CHECKOUT),
               "-f", str(CHECKOUT / "docker-compose.yml"), "-f", str(self.override),
               "--env-file", str(self.env_file),
               "--profile", "postgres", "--profile", SMALL, "--profile", LARGE,
               *(("--profile", "local-services") if self.use_minio else ()), *args]
        env = {k: v for k, v in os.environ.items() if k != "COMPOSE_PROJECT_NAME"}
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        if check and result.returncode != 0:
            raise AssertionError(f"{' '.join(args)} failed: {result.stderr[-2000:]}")
        return result

    def logs(self, service) -> str:
        return self.compose("logs", "--no-color", "--no-log-prefix", service, check=False).stdout

    def url(self) -> str:
        return f"postgresql://{PG_USER}:{PG_PASSWORD}@127.0.0.1:{self.port}/{PG_DB}"


def _wait(predicate, timeout, what, stack=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(2)
    detail = ""
    if stack is not None:
        detail = "\n--- small ---\n" + stack.logs(SMALL)[-4000:] + "\n--- large ---\n" + stack.logs(LARGE)[-4000:]
    raise AssertionError(f"timed out waiting for {what}{detail}")


def _connect(url):
    import psycopg2

    conn = psycopg2.connect(url, connect_timeout=3)
    conn.autocommit = True
    return conn


def q(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchall() if cur.description else None


def seed(conn, zid, participants, comments, created_ms):
    """A generated conversation with recent votes, inserted set-wise."""
    q(conn, "SET session_replication_role = replica")
    q(conn, "INSERT INTO conversations (zid, participant_count) VALUES (%s, %s)", (zid, participants))
    q(conn, "INSERT INTO participants (pid, uid, zid, created, mod) "
            "SELECT p, 100000 + p, %s, %s, 0 FROM generate_series(0, %s - 1) p",
      (zid, created_ms, participants))
    q(conn, "INSERT INTO comments (tid, zid, pid, uid, txt, mod, is_meta, created, modified) "
            "SELECT t, %s, 0, 100000, 'c' || t, 0, false, %s, %s FROM generate_series(0, %s - 1) t",
      (zid, created_ms, created_ms, comments))
    q(conn, "INSERT INTO votes (zid, pid, tid, vote, created) "
            "SELECT %s, p, t, CASE WHEN (p %% 2 = 0) = (t %% 2 = 0) THEN -1 ELSE 1 END, "
            "       %s + p * %s + t "
            "FROM generate_series(0, %s - 1) p, generate_series(0, %s - 1) t "
            "WHERE (p + t) %% 3 <> 0",
      (zid, created_ms, comments, participants, comments))
    q(conn, "SET session_replication_role = DEFAULT")
    return q(conn, "SELECT max(created) FROM votes WHERE zid = %s", (zid,))[0][0]


def main_row(conn, zid, label):
    rows = q(conn, "SELECT math_tick, last_vote_timestamp, modified FROM math_main "
                   "WHERE zid = %s AND math_env = %s", (zid, label))
    return rows[0] if rows else None


def capacity_lines(logs: str, klass: str) -> list:
    out = []
    for line in logs.splitlines():
        line = line.strip()
        if line.startswith("{") and '"math_poller.capacity/1"' in line:
            body = json.loads(line)
            if body.get("class") == klass and body.get("role") == "primary":
                out.append(body)
    return out


@pytest.fixture
def stack(tmp_path):
    image = _require()
    use_minio = os.environ.get("POLIS_TEST_MINIO") == "1"
    st = Stack(tmp_path, image, use_minio)
    try:
        st.compose("up", "-d", "--build", "postgres", *(("minio",) if use_minio else ()))
        _wait(lambda: _ready(st.url()), 180, "postgres with the polis schema")
        if use_minio:
            _wait(lambda: st.compose(
                "exec", "-T", "minio", "sh", "-c",
                "mc alias set parity http://localhost:9000 minioadmin minioadmin >/dev/null "
                f"&& mc mb --ignore-existing parity/{BUCKET}", check=False).returncode == 0,
                120, "the MinIO bucket")
        yield st
    finally:
        st.compose("down", "-v", "--remove-orphans", check=False)


def _ready(url):
    try:
        conn = _connect(url)
    except Exception:
        return False
    try:
        return q(conn, "SELECT to_regclass('public.math_main') IS NOT NULL "
                       "AND to_regclass('public.votes') IS NOT NULL")[0][0]
    except Exception:
        return False
    finally:
        conn.close()


def test_route_compute_stage_promote_through_compose(stack):
    db = _connect(stack.url())
    now = int(time.time() * 1000) - 3_600_000
    large_lvt = seed(db, LARGE_ZID, *LARGE_SHAPE, now)
    small_lvt = seed(db, SMALL_ZID, *SMALL_SHAPE, now)

    stack.compose("up", "-d", "--no-build", SMALL, LARGE)

    # The small poller publishes the ordinary conversation itself.
    _wait(lambda: main_row(db, SMALL_ZID, SMALL_LABEL), 240, "the small conversation", stack)
    assert main_row(db, SMALL_ZID, SMALL_LABEL)[1] == small_lvt
    # The large worker stages the routed conversation under its own label, and
    # the small poller promotes it into its own.
    staged = _wait(lambda: (lambda r: r if r and r[1] == large_lvt else None)(
        main_row(db, LARGE_ZID, LARGE_LABEL)), 300, "the staged large bundle", stack)
    promoted = _wait(lambda: (lambda r: r if r and r[1] == large_lvt else None)(
        main_row(db, LARGE_ZID, SMALL_LABEL)), 180, "the promotion", stack)
    assert promoted[2] >= staged[2]
    # Same payloads, one coherent bundle under the small label.
    assert q(db, "SELECT a.data::text = b.data::text FROM math_main a JOIN math_main b "
                 "USING (zid) WHERE zid = %s AND a.math_env = %s AND b.math_env = %s",
             (LARGE_ZID, LARGE_LABEL, SMALL_LABEL))[0][0]
    ticks = q(db, "SELECT DISTINCT math_tick FROM ("
                  " SELECT math_tick FROM math_main WHERE zid = %s AND math_env = %s"
                  " UNION ALL SELECT math_tick FROM math_bidtopid WHERE zid = %s AND math_env = %s"
                  " UNION ALL SELECT math_tick FROM math_ptptstats WHERE zid = %s AND math_env = %s) t",
              (LARGE_ZID, SMALL_LABEL) * 3)
    assert len(ticks) == 1
    # The large worker computed nothing it was not handed.
    assert main_row(db, SMALL_ZID, LARGE_LABEL) is None

    # A later vote: the warm path stages a newer bundle and it is promoted.
    q(db, "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 0, 0, 1, %s)",
      (LARGE_ZID, large_lvt + 1000))
    newer = large_lvt + 1000
    _wait(lambda: (lambda r: r if r and r[1] == newer else None)(
        main_row(db, LARGE_ZID, SMALL_LABEL)), 240, "the promotion of the update", stack)

    # The demand line catches up within a readiness interval.
    _wait(lambda: max((line["promoted_total"] or 0
                       for line in capacity_lines(stack.logs(SMALL), "small")), default=0) >= 2,
          60, "the small capacity line to count both promotions", stack)
    small_logs, large_logs = stack.logs(SMALL), stack.logs(LARGE)
    # The small poller kept its P-072 heartbeat; the large worker never
    # prints that phrase or a stale phrase (the alarm filters match the whole
    # log group).
    assert HEARTBEAT_PHRASE in small_logs
    assert "math_poller class=large readiness/1 role=primary" in large_logs
    assert HEARTBEAT_PHRASE not in large_logs
    assert not any(p in large_logs for p in STALE_PHRASES)
    # Both capacity lines are bare JSON; the small one counts the promotions.
    small_lines = capacity_lines(small_logs, "small")
    large_lines = capacity_lines(large_logs, "large")
    assert small_lines and large_lines
    assert max(line["promoted_total"] or 0 for line in small_lines) >= 2
    assert {line["label"] for line in large_lines} == {LARGE_LABEL}
    # The latest large line: the routed conversation allowlisted, no version
    # skew, no refusal (an early line may report manifest_missing, before the
    # small poller's first manifest write).
    last = large_lines[-1]
    assert (last["skew"], last["refusal"], last["allowlisted"]) == (0, None, 1), large_lines
    # The routed conversation never took the dump/retry/park path.
    assert not re.search(r"PARK", small_logs)
    db.close()
