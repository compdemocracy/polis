"""Real database oracles shared across psycopg and Rust. No live job admission."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

import psycopg2
import pytest
from polismath.queue import executor as ex
from .conftest import connect
from .support import BINARY, CommitProxy, Driver, ROOT


def uid():
    return str(uuid.uuid4())


def sql(db, statement, args=None):
    conn = connect(db["url"])
    try:
        with conn.cursor() as cur:
            cur.execute(statement, args)
            return cur.fetchall() if cur.description else []
    finally:
        conn.close()


def enqueue_args(db, key, priority=1, product=None, max_attempts=3):
    return [db["env"], 1, product or key, "public-actor", key, "1" * 64, uid(), uid(),
        ex.NOOP_URI, ex.NOOP_SHA256, ex.NOOP_SHA256, ex.NOOP_IMAGE, priority, max_attempts]


def enqueue(driver, db, key, **kwargs):
    reply = driver.call("pq_enqueue", enqueue_args(db, key, **kwargs))
    assert reply["outcome"] == "enqueued"
    return reply


def claim(driver, db, priority=1, seconds=60):
    owner, attempt = uid(), uid()
    reply = driver.call("pq_claim", [db["env"], priority, owner, attempt, seconds])
    assert reply["outcome"] == "owned"
    assert (reply["owner_id"], reply["attempt_id"]) == (owner, attempt)
    return reply


def token(db, job):
    return [db["env"], job["job_id"], job["owner_id"], job["attempt_id"], job["lease_epoch"]]


def finish(driver, db, job):
    return driver.call("pq_finalize", token(db, job) + [ex.NOOP_URI, ex.NOOP_SHA256])


def mutate(db, function, before, after):
    source = sql(db, "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=%s", (function,))[0][0]
    assert source.count(before) == 1, (function, before)
    sql(db, source.replace(before, after))


def test_shared_sql_and_wire_pin():
    digest = hashlib.sha256((ROOT / "server/postgres/migrations/000019_create_polis_queue.sql").read_bytes()).hexdigest()
    assert digest == ex.QUEUE_SQL_SHA256
    assert digest in (ROOT / "queue-rs/src/lib.rs").read_text()
    assert digest in (ROOT / "server/src/queue/protocol.ts").read_text()


@pytest.mark.parametrize("remove_skip", [False, True])
def test_a1_locked_row_progress(db, driver, language, remove_skip):
    first = enqueue(driver, db, "locked")
    second = enqueue(driver, db, "available")
    if remove_skip:
        mutate(db, "pq_claim", "FOR UPDATE SKIP LOCKED", "FOR UPDATE")
    locker = psycopg2.connect(db["url"])
    with locker.cursor() as cur:
        cur.execute("SELECT 1 FROM polis_queue_jobs WHERE job_id=%s FOR UPDATE", (first["job_id"],))
    try:
        if remove_skip:
            with pytest.raises((psycopg2.errors.LockNotAvailable, RuntimeError)):
                claim(driver, db)
        else:
            job = claim(driver, db)
            assert job["job_id"] == second["job_id"]
            assert finish(driver, db, job)["outcome"] == "succeeded"
    finally:
        locker.rollback()
        locker.close()
    assert claim(driver, db)["job_id"] == first["job_id"]


def test_a1_concurrent_claims_and_weighted_progress(db, driver, language):
    for priority in range(3):
        for i in range(12):
            enqueue(driver, db, f"lane-{priority}-{i}", priority=priority)
    def work(_):
        client = Driver(language, db["dsn"], db["env"])
        taken = []
        try:
            for lane in (0, 0, 0, 1, 1, 2):
                job = claim(client, db, lane)
                taken.append(job["job_id"])
            return taken
        finally:
            client.close()
    with ThreadPoolExecutor(max_workers=4) as pool:
        groups = list(pool.map(work, range(4)))
    taken = sum(groups, [])
    assert len(taken) == len(set(taken)) == 24
    assert sql(db, "SELECT priority,count(*) FROM polis_queue_jobs WHERE state='running' GROUP BY priority ORDER BY priority") == [(0, 12), (1, 8), (2, 4)]
    assert sql(db, "SELECT count(*) FROM polis_queue_attempts WHERE outcome='running'")[0][0] == 24


def test_a1_read_then_unconditional_update_control(db, driver, language):
    enqueue(driver, db, "duplicate-control")
    # Deliberately broken algorithm: two callers read queued before either
    # updates; no state CAS. The barrier is an actual held database lock.
    source = sql(db, "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='pq_claim'")[0][0]
    begin = source.index(" WITH candidate AS (")
    end = source.index(" IF NOT FOUND THEN", begin)
    broken = """ SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.priority=p_priority AND q.state='queued' LIMIT 1;
 PERFORM pg_advisory_xact_lock_shared(173991);
 UPDATE public.polis_queue_jobs q SET state='running',owner_id=p_owner,attempt_id=p_attempt,
 locked_until=clock_timestamp()+interval '60 seconds',lease_epoch=q.lease_epoch+1,attempt_count=q.attempt_count+1
 WHERE q.env=p_env AND q.job_id=j.job_id RETURNING q.* INTO j;
"""
    sql(db, source[:begin] + broken + source[end:])
    locker = connect(db["url"])
    with locker.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(173991)")
    def work():
        client = Driver(language, db["dsn"], db["env"])
        try:
            return claim(client, db)
        finally:
            client.close()
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            tasks = [pool.submit(work) for _ in range(2)]
            deadline = time.monotonic() + 10
            while sql(db, "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted")[0][0] != 2:
                assert time.monotonic() < deadline
                time.sleep(.01)
            with locker.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(173991)")
            replies = [task.result() for task in tasks]
        assert replies[0]["job_id"] == replies[1]["job_id"]
        assert replies[0]["attempt_id"] != replies[1]["attempt_id"]
        assert sql(db, "SELECT count(*) FROM polis_queue_attempts WHERE outcome='running'")[0][0] == 2
    finally:
        locker.close()


@pytest.mark.parametrize("unfenced", [False, True])
def test_a3_expired_owner_all_stale_seams(db, driver, unfenced):
    enqueue(driver, db, "lease-transfer")
    old = claim(driver, db, seconds=10)
    # Pause the old executor by making no further calls, then observe DB time.
    deadline = time.monotonic() + 15
    while not sql(db, "SELECT locked_until<=clock_timestamp() FROM polis_queue_jobs")[0][0]:
        assert time.monotonic() < deadline
        time.sleep(.05)
    assert driver.call("pq_reap_one", [db["env"], old["job_id"]])["outcome"] == "retry_wait"
    # Backoff itself is not under test; retain expiry's real DB-time evidence.
    sql(db, "UPDATE polis_queue_jobs SET eligible_at=clock_timestamp()")
    current = claim(driver, db)
    if unfenced:
        source = sql(db, "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='pq_owns'")[0][0]
        a, b = source.index("AS $function$") + len("AS $function$"), source.rindex("$function$")
        sql(db, source[:a] + " SELECT true\n" + source[b:])
        assert driver.call("pq_heartbeat", token(db, old) + [60])["outcome"] == "owned"
        return
    for name, extra in [("pq_heartbeat", [60]), ("pq_release", []), ("pq_fail", [True, "old-owner"]), ("pq_park", ["old-owner"]), ("pq_finalize", [ex.NOOP_URI, ex.NOOP_SHA256])]:
        assert driver.call(name, token(db, old) + extra)["outcome"] == "fenced", name
    assert finish(driver, db, current)["outcome"] == "succeeded"


@pytest.mark.parametrize("rpc", ["pq_claim", "pq_finalize"])
@pytest.mark.parametrize("before", [False, True])
def test_a4_real_severed_commit(db, driver, language, rpc, before):
    first = enqueue(driver, db, "uncertain-first")
    second = enqueue(driver, db, "uncertain-second")
    old = claim(driver, db) if rpc == "pq_finalize" else None
    args = token(db, old) + [ex.NOOP_URI, ex.NOOP_SHA256] if old else [db["env"], 1, uid(), uid(), 60]
    proxy = CommitProxy(db["dsn"], rpc, before=before)
    client = Driver(language, proxy.url, db["env"])
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.call, rpc, args)
            assert proxy.reached.wait(10), "actual COMMIT barrier absent"
            state = sql(db, "SELECT state FROM polis_queue_jobs WHERE job_id=%s", (first["job_id"],))[0][0]
            assert state == (("running" if old else "queued") if before else ("succeeded" if old else "running"))
            proxy.release.set()
            with pytest.raises(ex.CommitOutcomeUnknown) as lost:
                pending.result(timeout=10)
        assert proxy.rpc_count == 1
        provisional = lost.value.reply
        if old:
            replay = driver.call(rpc, args)
            assert replay["outcome"] == ("succeeded" if before else "already_succeeded")
            assert replay["attempt_id"] == old["attempt_id"]
            assert replay["output_sha256"] == ex.NOOP_SHA256
        else:
            renewed = driver.call("pq_heartbeat", token(db, provisional) + [60])
            assert renewed["outcome"] == ("fenced" if before else "owned")
            assert sql(db, "SELECT state FROM polis_queue_jobs WHERE job_id=%s", (second["job_id"],))[0][0] == "queued"
            assert sql(db, "SELECT count(*) FROM polis_queue_attempts")[0][0] == (0 if before else 1)
            if not before:
                # Broken recovery algorithm: minting another attempt and
                # claiming again strands the first live lease.
                stolen = driver.call("pq_claim", [db["env"], 1, args[2], uid(), 60])
                assert stolen["job_id"] == second["job_id"]
                assert sql(db, "SELECT count(*) FROM polis_queue_jobs WHERE state='running'")[0][0] == 2
    finally:
        proxy.close()
        client.close()


def test_a4_process_killed_after_commit_restarts_exact_identity(db, driver, language):
    enqueue(driver, db, "restart")
    job = claim(driver, db)
    request = {"name": "pq_finalize", "args": token(db, job) + [ex.NOOP_URI, ex.NOOP_SHA256]}
    proxy = CommitProxy(db["dsn"], "pq_finalize")
    command = [str(BINARY)] if language == "rust" else [sys.executable, "-m", "tests.queue_acceptance.support"]
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, "QUEUE_DATABASE_URL": proxy.url, "QUEUE_ENV": db["env"]})
    try:
        child.stdin.write(json.dumps(request) + "\n")
        child.stdin.flush()
        assert proxy.reached.wait(10)
        assert sql(db, "SELECT state FROM polis_queue_jobs")[0][0] == "succeeded"
        child.kill()
        child.wait(timeout=10)
        assert child.returncode == -signal.SIGKILL
        proxy.release.set()
        restarted = Driver(language, db["dsn"], db["env"])
        try:
            assert restarted.call(request["name"], request["args"])["outcome"] == "already_succeeded"
        finally:
            restarted.close()
        assert sql(db, "SELECT count(*),count(DISTINCT attempt_id) FROM polis_queue_attempts")[0] == (1, 1)
        assert sql(db, "SELECT published_generation FROM polis_queue_heads")[0][0] == 1
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()
        proxy.close()


def test_a4_replay_discrimination_and_failing_control(db, driver):
    enqueue(driver, db, "exact-replay")
    job = claim(driver, db)
    assert finish(driver, db, job)["outcome"] == "succeeded"
    assert finish(driver, db, job)["outcome"] == "already_succeeded"
    wrong = token(db, job)
    for index, replacement in [(2, uid()), (3, uid()), (4, "999")]:
        args = list(wrong)
        args[index] = replacement
        assert driver.call("pq_finalize", args + [ex.NOOP_URI, ex.NOOP_SHA256])["outcome"] == "fenced"
    assert driver.call("pq_finalize", wrong + [ex.NOOP_URI, "2" * 64])["outcome"] == "invalid_output"
    mutate(db, "pq_finalize", "RETURN public.pq_result('already_succeeded',j,COALESCE(h.published_run_id=r.run_id,false));", "RETURN public.pq_result('fenced',j);")
    assert finish(driver, db, job)["outcome"] == "fenced"


@pytest.mark.parametrize("before", [False, True])
def test_a5_enqueue_atomicity_and_idempotency(db, driver, language, before):
    args = enqueue_args(db, "enqueue-kill")
    proxy = CommitProxy(db["dsn"], "pq_enqueue", before=before)
    client = Driver(language, proxy.url, db["env"])
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            task = pool.submit(client.call, "pq_enqueue", args)
            assert proxy.reached.wait(10)
            counts = [sql(db, "SELECT count(*) FROM " + table)[0][0] for table in ("polis_queue_requests", "polis_queue_runs", "polis_queue_jobs", "polis_queue_heads")]
            assert counts == [0 if before else 1] * 4
            proxy.release.set()
            with pytest.raises(ex.CommitOutcomeUnknown):
                task.result(timeout=10)
        reply = driver.call("pq_enqueue", args)
        assert reply["outcome"] in ("enqueued", "existing")
        repeat = list(args)
        repeat[6], repeat[7] = uid(), uid()
        assert driver.call("pq_enqueue", repeat)["run_id"] == args[6]
        repeat[5] = "2" * 64
        assert driver.call("pq_enqueue", repeat)["outcome"] == "conflict"
        assert [sql(db, "SELECT count(*) FROM " + table)[0][0] for table in ("polis_queue_requests", "polis_queue_runs", "polis_queue_jobs", "polis_queue_heads")] == [1] * 4
    finally:
        proxy.close()
        client.close()


def test_a6_older_completion_and_failed_desired_preserve_pointer(db, driver):
    enqueue(driver, db, "old", product="shared")
    old = claim(driver, db)
    enqueue(driver, db, "new", product="shared")
    new = claim(driver, db)
    assert finish(driver, db, new)["published"] is True
    assert finish(driver, db, old)["published"] is False
    assert finish(driver, db, old)["outcome"] == "already_succeeded"
    enqueue(driver, db, "desired-fails", product="shared")
    desired = claim(driver, db)
    assert driver.call("pq_fail", token(db, desired) + [True, "public-failure"])["outcome"] == "dead"
    head = driver.call("pq_head_status", [db["env"], "shared"])
    assert head["desired_state"] == "dead"
    assert head["published_run_id"] == new["run_id"]
    assert head["desired_run_id"] == desired["run_id"]
    # Broken desired-run policy publishes old work when no newer pointer exists.
    enqueue(driver, db, "suppressed", product="other")
    suppressed = claim(driver, db)
    enqueue(driver, db, "pending", product="other")
    mutate(db, "pq_publish_allowed", "h.desired_run_id=r.run_id AND h.requested_generation=r.requested_generation", "true")
    assert finish(driver, db, suppressed)["published"] is True


def test_a5_split_transaction_control(db):
    # Deliberately broken producer algorithm, shared by both language gates:
    # commit a run before creating its request/job/head. An interruption at
    # this boundary leaves a durable fragment; pq_enqueue has no such boundary.
    sql(db, """INSERT INTO polis_queue_runs(env,run_id,zid,product_key,requested_generation,
        input_uri,input_sha256,expected_output_uri,expected_output_sha256,config_sha256,
        code_image_digest,contract_version)
        VALUES(%s,%s,1,'split-control',1,%s,%s,%s,%s,%s,%s,'polis-queue/1')""",
        (db["env"], uid(), ex.NOOP_URI, ex.NOOP_SHA256, ex.NOOP_URI,
         ex.NOOP_SHA256, ex.NOOP_SHA256, ex.NOOP_IMAGE))
    counts = [sql(db, "SELECT count(*) FROM " + table)[0][0] for table in
        ("polis_queue_requests", "polis_queue_runs", "polis_queue_jobs", "polis_queue_heads")]
    assert counts == [0, 1, 0, 0]
    assert counts not in ([0] * 4, [1] * 4)
