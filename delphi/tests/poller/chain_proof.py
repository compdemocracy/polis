"""The composed chain, with real pieces, on one Postgres (P-073 r2).

Not collected by pytest: a script an operator or a reviewer runs against a
throwaway database holding the real migration chain (000000 .. 000024), the
real ``polis-jobs`` daemon binary as a worker of class ``large``, and the real
math poller code: the small poller's router, queue client and promotion loop
in this process, the queue child (``scripts/math_poller.py --job``) started
by the daemon. Generated fixtures only (one made-up conversation, sized by a
memory model that makes it exceed a small budget); nothing here touches a
served deployment.

What it proves, in order, each step asserted and printed:

  1. route -> enqueue (pd_enqueue, the typed math config in the admission)
  2. the daemon claims the job, runs the child, the child checks the frame,
     computes the one conversation and stages it under python-large
  3. the daemon finalizes (the manifest row, exit proof, pq_finalize) and
     releases the scope (pd_release_scope)
  4. the small poller promotes on the receipt (the job's manifest names the
     staged bundle) into its own label: served
  5. cancel of a queued job (daemon stopped): the poller's guarded release
     admits a fresh job
  6. the daemon stopped mid-job (SIGTERM): the attempt is interrupted with
     exit proof, the next daemon retries once and the result is promoted
  7. the child killed (SIGKILL to its process group): exit proof, the retry
     runs once
  8. cancel of a running job: the fenced heartbeat kills the child, exit is
     confirmed, the daemon releases the scope, a fresh job is admitted
  9. dead: a child that cannot fit fails every attempt; three dead jobs make
     the fourth admission `poisoned`; the record is parked and counted; a new
     source commit (a deploy) admits again and the chain completes

Usage (on a build box, from the repository root, with the daemon built and
the Delphi virtualenv synced):

  PYTHONPATH=delphi delphi/.venv/bin/python delphi/tests/poller/chain_proof.py \\
    --db postgresql://postgres@127.0.0.1:55801/pyq \\
    --executor postgresql://polis_jobs_test@127.0.0.1:55801/pyq \\
    --daemon queue-rs/target/debug/polis-jobs --delphi delphi \\
    --python delphi/.venv/bin/python --work /tmp/chain-proof

Exit 0 iff every step held. It removes what it wrote.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg2

MB = 1024 * 1024
SMALL, STAGED = "python", "python-large"
COMMIT_A = "a" * 40
COMMIT_B = "b" * 40
T0 = time.time()


def say(step: str, message: str) -> None:
    print(f"[{time.time() - T0:7.1f}s] {step}: {message}", flush=True)


def check(step: str, condition: bool, message: str) -> None:
    say(step, ("ok   " if condition else "FAIL ") + message)
    if not condition:
        raise SystemExit(f"chain proof failed at {step}: {message}")


class Pg:
    def __init__(self, url: str) -> None:
        self.conn = psycopg2.connect(url)
        self.conn.autocommit = True

    def q(self, sql: str, params=None):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or ())
            return cur.fetchall() if cur.description else None

    def one(self, sql: str, params=None):
        return self.q(sql, params)[0][0]


class DaemonProcess:
    """The real polis-jobs binary as a worker of class large, with the child's
    environment riding on its own (the daemon strips the queue DSN)."""

    def __init__(self, args, env_name: str, work: Path, name: str, *, child_env: dict) -> None:
        self.work = work
        self.name = name
        self.journal = work / "journal"
        self.journal.mkdir(parents=True, exist_ok=True)
        self.stderr_path = work / f"daemon-{name}-{uuid.uuid4().hex[:6]}.log"
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
            "POLIS_JOBS_ENABLED": "1",
            "QUEUE_DATABASE_URL": args.executor,
            "QUEUE_ENV": env_name,
            "POLIS_JOBS_TRANSPORT": "loopback",
            "POLIS_JOBS_WORKER_CLASS": "large",
            "POLIS_JOBS_LEASE_SECONDS": "15",
            "POLIS_JOBS_HEARTBEAT_SECONDS": "2",
            "POLIS_JOBS_POLL_SECONDS": "1",
            "POLIS_JOBS_REAP_SECONDS": "1",
            "POLIS_JOBS_READINESS_SECONDS": "2",
            "POLIS_JOBS_KILL_GRACE_SECONDS": "2",
            "POLIS_JOBS_SHUTDOWN_GRACE_SECONDS": "3",
            "POLIS_JOBS_LOG_BATCH_MS": "200",
            "POLIS_JOBS_JOURNAL_DIR": str(self.journal),
            "POLIS_JOBS_WORK_DIR": str(work / "attempts"),
            "POLIS_JOBS_BOOT_ID": f"boot-{name}",
            "POLIS_JOBS_CONTAINER_ID": "chain-proof-host",
            "POLIS_JOBS_IDENTITY": f"chain-proof-{name}",
            "DELPHI_APP_PATH": str(Path(args.delphi).resolve()),
            # abspath, not resolve(): a virtualenv's python is a symlink and
            # must be invoked through it to see the virtualenv.
            "POLIS_JOBS_PYTHON": os.path.abspath(args.python),
            # The child's environment (the daemon forwards its own).
            "DATABASE_URL": args.db,
            "DATABASE_SSL_MODE": "disable",
            "MATH_ENV": STAGED,
            # Room for the generated conversation's estimated need (1600 MiB
            # under the child's own model); phase 9 lowers it to make the
            # child refuse.
            "MATH_POLLER_MEMORY_LIMIT_MB": "16384",
            "POSTGRES_CONNECT_TIMEOUT": "10",
            "MATH_POLLER_LOCK_LIVENESS_S": "1",
            "LOG_LEVEL": "INFO",
            "PYTHONPATH": str(Path(args.delphi).resolve()),
            "MATH_POLLER_SOURCE_COMMIT": COMMIT_A,
        }
        env.update(child_env)
        self.proc = subprocess.Popen([args.daemon], env=env, stdout=subprocess.DEVNULL,
                                     stderr=open(self.stderr_path, "wb"))
        say("daemon", f"{name} started pid={self.proc.pid} child env "
                      f"{ {k: v for k, v in child_env.items()} }")

    def transitions(self):
        out = []
        for line in self.stderr_path.read_text(errors="replace").splitlines():
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if v.get("schema") == "polis_jobs.transition/1":
                out.append(v)
        return out

    def readiness(self):
        last = None
        for line in self.stderr_path.read_text(errors="replace").splitlines():
            if line.startswith("polis_jobs readiness/1 "):
                last = json.loads(line.split(" ", 4)[4])
        return last

    def wait_transition(self, job_id: str, to: str, secs: float = 90):
        deadline = time.time() + secs
        while time.time() < deadline:
            for t in self.transitions():
                if t["job_id"] == job_id and t["to"] == to:
                    return t
            time.sleep(0.2)
        raise SystemExit(f"no transition to {to} for {job_id[:8]} within {secs}s:\n"
                         + self.stderr_path.read_text(errors="replace")[-4000:])

    def child_pgid(self, attempt_id: str) -> int:
        """The child's process group, from the daemon's journal entry."""
        deadline = time.time() + 30
        while time.time() < deadline:
            for entry in self.journal.glob("*.json"):
                if entry.name.startswith("."):
                    continue
                try:
                    data = json.loads(entry.read_text())
                except ValueError:
                    continue
                if data.get("attempt_id") == attempt_id and data.get("pgid"):
                    return int(data["pgid"])
            time.sleep(0.2)
        raise SystemExit(f"no journal entry with a pgid for attempt {attempt_id[:8]}")

    def stop(self, sig=signal.SIGTERM, secs: float = 30) -> int | None:
        self.proc.send_signal(sig)
        try:
            code = self.proc.wait(timeout=secs)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            code = self.proc.wait()
        say("daemon", f"{self.name} stopped with {sig.name}: exit {code}")
        return code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="superuser DSN (the math writer, the fixture)")
    ap.add_argument("--executor", required=True, help="an executor-member login DSN")
    ap.add_argument("--daemon", required=True, help="the polis-jobs binary")
    ap.add_argument("--delphi", required=True, help="the delphi directory (DELPHI_APP_PATH)")
    ap.add_argument("--python", required=True, help="the Delphi virtualenv's python")
    ap.add_argument("--work", required=True, help="a scratch directory")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(args.delphi).resolve()))
    os.environ["MATH_POLLER_SOURCE_COMMIT"] = COMMIT_A
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller import capacity_queue as cq
    from polismath.poller.admission import MemoryAdmission, MemoryModel, read_conversation_sizes
    from polismath.poller.capacity import CapacityRouter, CapacitySettings, validate_counts
    from polismath.poller.promotion import SmallCapacityLoop
    from polismath.poller.service import MathPollerService, PollerConfig
    from tests.poller.test_backfill_postgres import _TABLES, coherent, seed_conversation
    from tests.vote_fixtures import AGREE, seed_vote

    work = Path(args.work)
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    env_name = f"chain-{uuid.uuid4().hex[:8]}"
    zid = 40000 + (uuid.uuid4().int % 50000)
    scope = f"math:{SMALL}:{zid}"
    db = Pg(args.db)
    daemon: DaemonProcess | None = None
    pg = None
    try:
        # ---------------------------------------------------------------- 0
        say("setup", f"env={env_name} zid={zid} scope={scope} labels {SMALL} <- {STAGED}")
        check("setup", db.one("SELECT contract_version FROM polis_queue_install") == "polis-queue/3",
              "the database carries polis-queue/3 (000019, 000023, 000024)")
        seed_conversation(db.conn, zid, participants=80, comments=30)
        votes = db.one("SELECT count(*) FROM votes WHERE zid=%s", (zid,))
        say("setup", f"generated conversation: {votes} votes")

        # The small poller: a 1000 MiB box, 100 MiB base; one vote row costs
        # 1 MiB in this model, so the conversation needs ~{votes} MiB and
        # exceeds the 900 MiB small capacity.
        pg = PostgresClient(PostgresConfig(url=args.db, math_env=SMALL, ssl_mode="disable"))
        pg.initialize()
        model = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                            job_floor_mb=0)
        adm = MemoryAdmission(1000 * MB, model, headroom=0.0, base_bytes=100 * MB)
        settings = CapacitySettings(routing=True, promote=True, staged_label=STAGED)
        router = CapacityRouter(adm, settings)
        svc = MathPollerService(pg, PollerConfig(database_url=args.db, math_env=SMALL,
                                                 memory_limit_mb=1000),
                                admission=adm, capacity=router)
        queue = cq.QueueClient(cq.QueueSettings(dsn=args.executor, env=env_name))
        loop = SmallCapacityLoop(svc, router, settings, queue=queue, source_commit=COMMIT_A)
        sizes = read_conversation_sizes(pg, zid)
        disposition = router.observe(zid, sizes=sizes, input_ms=int(time.time() * 1000))
        check("1 route", disposition == "large",
              f"sizes={sizes}: the estimator routes it large (need "
              f"{router.record(zid).need_bytes / MB:.0f} MiB > 900 MiB small capacity)")

        def fp(label):
            return pg.math_fingerprints([zid], [label]).get((zid, label))

        def status(job_id):
            return queue.job_status(job_id)

        def dump_logs(job_id, tail=30):
            rows = db.q("SELECT l.stream, l.line FROM polis_queue_logs l JOIN polis_queue_attempts a "
                        "ON a.env=l.env AND a.attempt_id=l.attempt_id WHERE l.env=%s AND a.job_id=%s "
                        "ORDER BY a.lease_epoch, l.seq", (env_name, job_id))
            for stream, line in rows[-tail:]:
                print(f"    child {stream}: {line[:300]}", flush=True)

        def wait_state(job_id, state, secs=120):
            deadline = time.time() + secs
            while time.time() < deadline:
                now = status(job_id)["state"]
                if now == state:
                    return
                if now in ("dead", "cancelled") and state not in ("dead", "cancelled"):
                    break
                time.sleep(0.3)
            dump_logs(job_id)
            raise SystemExit(f"job {job_id[:8]} did not reach {state} within {secs}s "
                             f"(state {status(job_id)['state']})")

        def counts():
            router.set_queue_depth(queue.class_depth())
            c = router.counts()
            validate_counts(c)
            return c

        # ---------------------------------------------------------------- 1
        loop.tick()
        job1 = router.record(zid).job_id
        check("1 enqueue", job1 is not None and status(job1)["state"] == "queued",
              f"pd_enqueue admitted job {job1[:8]} (queued), scope guarded by it")
        check("1 enqueue", db.one("SELECT root_job_id::text FROM delphi_job_guards WHERE env=%s "
                                  "AND scope_key=%s", (env_name, scope)) == job1,
              "delphi_job_guards holds the scope for the job")
        c = counts()
        check("1 depth", (c["large_demand"], c["large_leased"]) == (1, 0),
              f"capacity line from pq_class_depth: large_demand=1 large_leased=0 ({c})")
        admitted = json.loads(cq.decode_frame_uri(status(job1)["input"]["uri"]))
        check("1 typed config", set(admitted["config"]) == {"staged_label", "target_label",
                                                            "need_bytes", "input_through_ms",
                                                            "binding", "source_commit"},
              f"the admission carries the typed math config {admitted['config']}")

        # ---------------------------------------------------------------- 2-3
        daemon = DaemonProcess(args, env_name, work, "a", child_env={})
        t = daemon.wait_transition(job1, "dispatched")
        say("2 claim", f"daemon claimed job {job1[:8]} attempt {t['attempt_id'][:8]} and "
                       f"dispatched the child (stage {t['stage']})")
        c = counts()
        st = status(job1)["state"]
        check("2 depth", c["large_demand"] == 0 and (c["large_leased"] == 1 or st != "running"),
              f"capacity line while the child runs: large_demand=0 large_leased="
              f"{c['large_leased']} (job state {st})")
        wait_state(job1, "succeeded")
        dump_logs(job1, tail=6)
        t = daemon.wait_transition(job1, "succeeded")
        say("3 finalize", f"attempt ended: exit_code={t['exit_code']} dur_ms={t['dur_ms']}; "
                          f"state succeeded")
        staged = fp(STAGED)
        check("2 staged", staged is not None and staged.complete and coherent(db.conn, zid, STAGED),
              f"the child staged the bundle under {STAGED}: tick={staged.math_tick} "
              f"newest_vote={staged.lvt}")
        check("2 staged", fp(SMALL) is None, f"nothing under {SMALL} yet")
        receipt = queue.receipt(job1)
        check("3 receipt", receipt.finalized and receipt.binds(staged, STAGED),
              f"the receipt: pq_job_status succeeded output_sha256={receipt.output_sha256[:12]}.., "
              f"manifest names {receipt.math_env} tick={receipt.math_tick} "
              f"vote_hwm={receipt.vote_hwm}")
        lines = db.q("SELECT line FROM polis_queue_logs l JOIN polis_queue_attempts a ON "
                     "a.env=l.env AND a.attempt_id=l.attempt_id WHERE l.env=%s AND a.job_id=%s "
                     "AND l.stream='stdout' ORDER BY l.seq", (env_name, job1))
        say("2 child", "child stdout rows in polis_queue_logs: " + str(len(lines)))
        t = daemon.wait_transition(job1, "scope_released")
        check("3 release", t["reason"] == scope and db.one(
            "SELECT count(*) FROM delphi_job_guards WHERE env=%s", (env_name,)) == 0,
              f"the daemon released the scope ({t['from']} -> scope_released)")

        # ---------------------------------------------------------------- 4
        loop.tick()
        served = fp(SMALL)
        check("4 promote", served is not None and served.lvt == staged.lvt
              and coherent(db.conn, zid, SMALL),
              f"promoted on the receipt into {SMALL}: tick={served.math_tick} "
              f"newest_vote={served.lvt}")
        row = db.q("SELECT math_env, math_tick FROM math_main WHERE zid=%s ORDER BY math_env",
                   (zid,))
        say("4 served", f"math_main rows: {row}")
        c = counts()
        check("4 counts", (c["large_demand"], c["pending_promotion"], c["promoted_total"]) == (0, 0, 1),
              f"capacity line after promotion {c}")

        # ---------------------------------------------------------------- 5
        daemon.stop()
        daemon = None
        db.q("INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 1, 1, %s, %s)",
             (zid, seed_vote(AGREE), int(time.time() * 1000)))
        router.advance(zid, int(time.time() * 1000))
        loop.tick()
        job2 = router.record(zid).job_id
        check("5 new input", job2 != job1 and status(job2)["state"] == "queued",
              f"a new vote: new job {job2[:8]} queued (the old scope was released)")
        mgmt = int(status(job2)["mgmt_version"])
        check("5 cancel", queue.cancel(job2, mgmt)["outcome"] == "cancelled",
              f"pq_cancel of the queued job {job2[:8]}")
        check("5 cancel", db.one("SELECT root_job_id::text FROM delphi_job_guards WHERE env=%s "
                                 "AND scope_key=%s", (env_name, scope)) == job2,
              "the cancelled job still holds the guard (nobody released it)")
        loop.tick()
        job3 = router.record(zid).job_id
        check("5 re-enqueue", job3 not in (job1, job2) and status(job3)["state"] == "queued",
              f"the poller released the scope through pd_release_scope and admitted {job3[:8]}")

        # ---------------------------------------------------------------- 6
        # A long handover wait after the lock makes the child's run a window
        # of ~20 s in which the daemon can be stopped, the child killed, the
        # job cancelled.
        daemon = DaemonProcess(args, env_name, work, "b",
                               child_env={"MATH_POLLER_LOCK_LIVENESS_S": "20"})
        t = daemon.wait_transition(job3, "dispatched")
        attempt3 = t["attempt_id"]
        time.sleep(3)
        code = daemon.stop()
        check("6 restart", code == 0, "daemon stopped mid-job with SIGTERM (exit 0)")
        st = status(job3)
        att = db.q("SELECT error_code, process_exit_confirmed_at IS NOT NULL FROM "
                   "polis_queue_attempts WHERE env=%s AND attempt_id=%s::uuid",
                   (env_name, attempt3))[0]
        check("6 restart", st["state"] == "retry_wait" and att[0] == "interrupted_by_shutdown"
              and att[1] is True,
              f"job {job3[:8]} is retry_wait; attempt {attempt3[:8]} interrupted_by_shutdown "
              f"with exit proof")
        daemon = DaemonProcess(args, env_name, work, "c", child_env={})
        wait_state(job3, "succeeded")
        daemon.wait_transition(job3, "scope_released")
        attempts = db.one("SELECT count(*) FROM polis_queue_attempts WHERE env=%s AND job_id=%s",
                          (env_name, job3))
        check("6 restart", attempts == 2, f"the next daemon ran the retry once ({attempts} attempts)")
        loop.tick()
        served2 = fp(SMALL)
        check("6 promote", served2.lvt > served.lvt, f"promoted the newer bundle (newest vote "
                                                     f"{served2.lvt} > {served.lvt})")

        # ---------------------------------------------------------------- 7
        daemon.stop()
        daemon = DaemonProcess(args, env_name, work, "d",
                               child_env={"MATH_POLLER_LOCK_LIVENESS_S": "20"})
        db.q("INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 2, 1, %s, %s)",
             (zid, seed_vote(AGREE), int(time.time() * 1000)))
        router.advance(zid, int(time.time() * 1000))
        loop.tick()
        job4 = router.record(zid).job_id
        t = daemon.wait_transition(job4, "dispatched")
        pgid = daemon.child_pgid(t["attempt_id"])
        time.sleep(2)
        os.killpg(pgid, signal.SIGKILL)
        say("7 killed child", f"SIGKILL sent to the child's process group {pgid}")
        t = daemon.wait_transition(job4, "retry_wait")
        att = db.q("SELECT error_code, process_exit_confirmed_at IS NOT NULL FROM "
                   "polis_queue_attempts WHERE env=%s AND attempt_id=%s::uuid",
                   (env_name, t["attempt_id"]))[0]
        check("7 killed child", t["reason"] == "stage_failed:signal_9" and att[1] is True,
              f"attempt {t['attempt_id'][:8]}: {t['reason']}, exit proven (group reaped)")
        wait_state(job4, "succeeded")
        daemon.wait_transition(job4, "scope_released")
        attempts = db.one("SELECT count(*) FROM polis_queue_attempts WHERE env=%s AND job_id=%s",
                          (env_name, job4))
        check("7 killed child", attempts == 2, f"the retry ran once ({attempts} attempts)")
        loop.tick()
        check("7 promote", fp(SMALL).lvt > served2.lvt, "promoted the newer bundle")

        # ---------------------------------------------------------------- 8
        db.q("INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 3, 1, %s, %s)",
             (zid, seed_vote(AGREE), int(time.time() * 1000)))
        router.advance(zid, int(time.time() * 1000))
        loop.tick()
        job5 = router.record(zid).job_id
        t = daemon.wait_transition(job5, "dispatched")
        time.sleep(2)
        mgmt = int(status(job5)["mgmt_version"])
        check("8 cancel running", queue.cancel(job5, mgmt)["outcome"] == "cancelled",
              f"pq_cancel of the running job {job5[:8]}")
        t = daemon.wait_transition(job5, "exit_confirmed:cancelled")
        check("8 cancel running", t["reason"] == "cancelled",
              "the fenced heartbeat killed the child; exit confirmed")
        t = daemon.wait_transition(job5, "scope_released")
        check("8 cancel running", t["from"] == "cancelled",
              "the daemon released the cancelled job's scope")
        loop.tick()
        job6 = router.record(zid).job_id
        check("8 re-enqueue", job6 != job5 and status(job6)["state"] in ("queued", "running",
                                                                           "succeeded"),
              f"a fresh job {job6[:8]} admitted after the cancel")
        wait_state(job6, "succeeded")
        daemon.wait_transition(job6, "scope_released")
        loop.tick()
        before_poison = fp(SMALL)

        # ---------------------------------------------------------------- 9
        daemon.stop()
        # A child that cannot fit: a 1024 MiB limit admits the process (its
        # base is ~240 MiB) but leaves a capacity below the declared 1600 MiB
        # need: exit 1 ("does not fit") at once, every attempt.
        daemon = DaemonProcess(args, env_name, work, "e",
                               child_env={"MATH_POLLER_MEMORY_LIMIT_MB": "1024"})
        dead = []
        for n in range(3):
            db.q("INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, %s, 2, %s, %s)",
                 (zid, 4 + n, seed_vote(AGREE), int(time.time() * 1000)))
            router.advance(zid, int(time.time() * 1000))
            loop.tick()
            job = router.record(zid).job_id
            check(f"9 dead {n + 1}", job not in dead and job not in (job5, job6),
                  f"job {job[:8]} admitted")
            wait_state(job, "dead", 180)
            t = daemon.wait_transition(job, "scope_released")
            attempts = db.one("SELECT count(*) FROM polis_queue_attempts WHERE env=%s AND "
                              "job_id=%s", (env_name, job))
            code = status(job)["last_error_code"]
            check(f"9 dead {n + 1}", attempts == 3 and code in ("stage_failed:1", "stage_failed:2")
                  and t["from"] == "dead",
                  f"job {job[:8]} dead after {attempts} attempts ({code}); scope released")
            dead.append(job)
        c = counts()
        say("9 poison", f"capacity line before the fourth ask: {c}")
        loop.tick()
        rec = router.record(zid)
        check("9 poison", rec.poisoned_commit == COMMIT_A and rec.job_id == dead[-1],
              f"the fourth admission is poisoned (latest dead job {dead[-1][:8]}); the record "
              f"is parked under commit {COMMIT_A[:8]}")
        c = counts()
        check("9 poison", (c["large_poisoned"], c["large_demand"], c["large_leased"]) == (1, 0, 0),
              f"capacity line: large_poisoned=1 ({c}); pq_class_depth dead="
              f"{queue.class_depth()['dead']}")
        before = db.one("SELECT count(*) FROM polis_queue_jobs WHERE env=%s", (env_name,))
        loop.tick()
        check("9 poison", db.one("SELECT count(*) FROM polis_queue_jobs WHERE env=%s",
                                 (env_name,)) == before,
              "parked: no further job is asked for under this commit")
        check("9 poison", fp(SMALL) == before_poison, "nothing new was served")
        # A deploy: the poller and the child run a new source commit.
        daemon.stop()
        daemon = DaemonProcess(args, env_name, work, "f",
                               child_env={"MATH_POLLER_SOURCE_COMMIT": COMMIT_B})
        loop._source_commit = COMMIT_B
        loop.tick()
        job = router.record(zid).job_id
        check("9 new commit", job not in dead and router.record(zid).poisoned_commit is None,
              f"under commit {COMMIT_B[:8]} the queue admitted {job[:8]} again")
        wait_state(job, "succeeded")
        daemon.wait_transition(job, "scope_released")
        loop.tick()
        final = fp(SMALL)
        check("9 new commit", final.lvt > before_poison.lvt,
              f"the chain completed: served newest_vote {final.lvt}")
        ready = daemon.readiness()
        say("9 daemon", f"last readiness line: finalized_total={ready and ready.get('finalized_total')} "
                        f"released_total={ready and ready.get('released_total')} "
                        f"failed_total={ready and ready.get('failed_total')} "
                        f"contract={ready and ready.get('contract')}")
        say("done", "every step held")
        return 0
    except BaseException:
        # Before the rows go: what every child of this env said.
        try:
            rows = db.q("SELECT a.job_id::text, l.stream, l.line FROM polis_queue_logs l JOIN "
                        "polis_queue_attempts a ON a.env=l.env AND a.attempt_id=l.attempt_id "
                        "WHERE l.env=%s ORDER BY a.lease_epoch, l.seq", (env_name,))
            for job, stream, line in rows[-40:]:
                print(f"    child[{job[:8]}] {stream}: {line[:300]}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"    (child logs unavailable: {exc.__class__.__name__})", flush=True)
        raise
    finally:
        if daemon is not None:
            daemon.stop()
        try:
            for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks"):
                db.q(f"DELETE FROM {table} WHERE zid=%s", (zid,))
            for table in ("delphi_job_guards", "polis_queue_requests", "polis_queue_logs",
                          "polis_queue_attempts", "delphi_jobs", "polis_queue_jobs",
                          "polis_queue_heads", "polis_queue_runs"):
                db.q(f"DELETE FROM {table} WHERE env=%s", (env_name,))
            db.q("SET session_replication_role = replica")
            for table in _TABLES:
                db.q(f"DELETE FROM {table} WHERE zid=%s", (zid,))
            db.q("SET session_replication_role = DEFAULT")
            say("cleanup", f"removed env {env_name} and zid {zid}")
        finally:
            if pg is not None:
                pg.shutdown()


if __name__ == "__main__":
    sys.exit(main())
