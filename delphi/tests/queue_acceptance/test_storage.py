"""Actual nested claim plans, fixed-profile storage and quiet recovery."""
import json
import os
from pathlib import Path
import time

import psycopg2
import pytest
from .conftest import connect
from .test_acceptance import claim, enqueue, finish, mutate, sql, token


def retain(language, name, value):
    directory = Path(os.environ["QUEUE_EVIDENCE_DIR"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{language}-{name}.json").write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def seed_history(db, count=10000, ready=0):
    # Bulk public fixtures, same closed stage/descriptors and constraints.
    sql(db, """INSERT INTO polis_queue_runs(env,run_id,zid,product_key,requested_generation,input_uri,input_sha256,
        expected_output_uri,expected_output_sha256,config_sha256,code_image_digest,contract_version,state)
        SELECT %s,md5('run-'||i)::uuid,1,'history-'||i,1,'public:noop',repeat('1',64),'public:noop',repeat('1',64),
        repeat('1',64),'public-noop','polis-queue/1',CASE WHEN i<=%s THEN 'dead' ELSE 'pending' END
        FROM generate_series(1,%s) i""", (db["env"], count, count + ready))
    sql(db, """INSERT INTO polis_queue_jobs(env,job_id,run_id,stage,state,priority,max_attempts)
        SELECT %s,md5('job-'||i)::uuid,md5('run-'||i)::uuid,'noop',CASE WHEN i<=%s THEN 'dead' ELSE 'queued' END,
        CASE WHEN i%%2=0 THEN 0 ELSE 2 END,3 FROM generate_series(1,%s) i""", (db["env"], count, count + ready))
    sql(db, "ANALYZE polis_queue_jobs")
    sql(db, "ANALYZE polis_queue_runs")


def plans(text):
    decoder, offset, found = json.JSONDecoder(), 0, []
    while True:
        start = text.find('{', offset)
        if start < 0:
            return found
        try:
            value, used = decoder.raw_decode(text[start:])
            offset = start + used
            if isinstance(value, dict) and "Plan" in value:
                found.append(value)
        except ValueError:
            offset = start + 1


def nodes(plan):
    yield plan
    for child in plan.get("Plans", []):
        yield from nodes(child)


@pytest.mark.parametrize("missing_priority", [False, True])
def test_a2_actual_inner_plan(db, driver, language, missing_priority):
    seed_history(db, ready=10000)
    if missing_priority:
        sql(db, "DROP INDEX polis_queue_ready")
        sql(db, "CREATE INDEX polis_queue_ready ON polis_queue_jobs(env,eligible_at,created_at,job_id) WHERE state IN ('queued','retry_wait') AND attempt_count-parked_attempt_count<max_attempts")
    settings = {
        "session_preload_libraries": "auto_explain", "auto_explain.log_min_duration": "0",
        "auto_explain.log_analyze": "on", "auto_explain.log_nested_statements": "on",
        "auto_explain.log_format": "json", "auto_explain.log_buffers": "on",
        "auto_explain.log_timing": "off",
    }
    for name, value in settings.items():
        sql(db, "ALTER ROLE queue_acceptance SET " + name + " = %s", (value,))
    try:
        offset = sql(db, "SELECT (pg_stat_file(pg_current_logfile())).size")[0][0]
        import uuid
        result = driver.call("pq_claim", [db["env"], 1, str(uuid.uuid4()), str(uuid.uuid4()), 60])
        assert result["outcome"] == "none"
        deadline = time.monotonic() + 5
        selected = []
        while not selected:
            raw = sql(db, "SELECT pg_read_file(pg_current_logfile(),%s,10000000)", (offset,))[0][0]
            selected = [p for p in plans(raw) if "WITH candidate AS" in p.get("Query Text", "")]
            assert time.monotonic() < deadline
            time.sleep(.02)
        assert len(selected) == 1
        plan = selected[0]
        scanned = list(nodes(plan["Plan"]))
        indexes = [n for n in scanned if n.get("Index Name") == "polis_queue_ready"]
        conditions = [n.get("Index Cond", "") for n in indexes]
        removed = sum(n.get("Rows Removed by Filter", 0) for n in scanned)
        if missing_priority:
            assert removed >= 10000
            assert not any("priority" in c for c in conditions)
        else:
            assert indexes and any("priority" in c for c in conditions)
            assert removed == 0
            assert plan["Plan"]["Shared Hit Blocks"] < 40
        retain(language, f"a2-{'control' if missing_priority else 'baseline'}", plan)
    finally:
        for name in settings:
            sql(db, "ALTER ROLE queue_acceptance RESET " + name)


@pytest.mark.parametrize("expiry_index", [False, True])
def test_a7_10000_heartbeats_and_vacuum(db, driver, language, expiry_index):
    enqueue(driver, db, "hot-profile")
    job = claim(driver, db, seconds=900)
    sql(db, "ALTER TABLE polis_queue_jobs SET (autovacuum_enabled=false)")
    if expiry_index:
        sql(db, "CREATE INDEX queue_expiry_control ON polis_queue_jobs(locked_until)")
    sql(db, "SELECT pg_stat_reset_single_table_counters('polis_queue_jobs'::regclass)")
    for _ in range(10000):
        result = driver.call("pq_heartbeat", token(db, job) + [900])
        assert result["outcome"] == "owned"
    # Closed backend connections flush their stats; sample from a fresh session.
    stats = sql(db, "SELECT n_tup_upd,n_tup_hot_upd,n_dead_tup FROM pg_stat_user_tables WHERE relname='polis_queue_jobs'")[0]
    assert stats[0] == 10000
    ratio = stats[1] / stats[0]
    if expiry_index:
        assert ratio == 0
    else:
        assert ratio >= .90
    before = sql(db, "SELECT vacuum_count FROM pg_stat_user_tables WHERE relname='polis_queue_jobs'")[0][0]
    sql(db, "VACUUM (VERBOSE, ANALYZE) polis_queue_jobs")
    after = sql(db, "SELECT vacuum_count,n_dead_tup FROM pg_stat_user_tables WHERE relname='polis_queue_jobs'")[0]
    assert after[0] == before + 1
    assert after[1] <= 100
    retain(language, f"a7-{'control' if expiry_index else 'baseline'}", {"updates": stats[0], "hot_updates": stats[1], "hot_ratio": ratio,
        "dead_before": stats[2], "dead_after": after[1], "vacuum_count": after[0], "profile": "PG17-local-fillfactor80-single-owner-no-autovacuum"})


@pytest.mark.parametrize("remove_budget", [False, True])
def test_a8_exhausted_rows_leave_ready_index(db, driver, remove_budget):
    enqueue(driver, db, "budget", max_attempts=1)
    sql(db, "UPDATE polis_queue_jobs SET attempt_count=1")
    if remove_budget:
        # Removing only the selection predicate hits the independent table
        # budget check instead of obtaining ownership. Both guards matter.
        mutate(db, "pq_claim", "AND q.attempt_count-q.parked_attempt_count<q.max_attempts", "")
        constraints = sql(db, "SELECT conname FROM pg_constraint WHERE conrelid='polis_queue_jobs'::regclass AND pg_get_constraintdef(oid) LIKE '%<= max_attempts%' ")
        assert len(constraints) == 1
        sql(db, 'ALTER TABLE polis_queue_jobs DROP CONSTRAINT "' + constraints[0][0] + '"')
        assert claim(driver, db)["attempt_count"] == 2
    else:
        import uuid
        assert driver.call("pq_claim", [db["env"], 1, str(uuid.uuid4()), str(uuid.uuid4()), 60])["outcome"] == "none"
        due = driver.call("pq_due", [db["env"], None, 100])
        assert len(due) == 1
        assert driver.call("pq_reap_one", [db["env"], due[0]])["outcome"] == "dead"
        assert driver.call("pq_due", [db["env"], None, 100]) == []
        assert sql(db, "SELECT count(*) FROM polis_queue_jobs WHERE state IN ('queued','retry_wait') AND attempt_count-parked_attempt_count<max_attempts")[0][0] == 0


def test_a8_pages_progress_past_busy_low_ids_and_head_lock(db, driver):
    for i in range(105):
        enqueue(driver, db, f"park-{i}")
        job = claim(driver, db)
        assert driver.call("pq_park", token(db, job) + ["public-park"])["outcome"] == "parked"
    sql(db, "UPDATE polis_queue_jobs SET eligible_at=clock_timestamp()")
    first = driver.call("pq_due", [db["env"], None, 100])
    assert len(first) == 100
    locker = psycopg2.connect(db["url"])
    with locker.cursor() as cur:
        cur.execute("SELECT 1 FROM polis_queue_jobs WHERE job_id=%s FOR UPDATE", (first[0],))
        cur.execute("SELECT 1 FROM polis_queue_heads FOR UPDATE")
    try:
        assert driver.call("pq_reap_one", [db["env"], first[0]]) is None
        # Each per-job transaction releases its locks. Independent SQL proves
        # progress is committed while another low-ID row and every head is held.
        for job_id in first[1:]:
            assert driver.call("pq_reap_one", [db["env"], job_id])["outcome"] == "queued"
        second = driver.call("pq_due", [db["env"], first[-1], 100])
        assert len(second) == 5
        for job_id in second:
            assert driver.call("pq_reap_one", [db["env"], job_id])["outcome"] == "queued"
        assert sql(db, "SELECT count(*) FROM polis_queue_jobs WHERE state='queued'")[0][0] == 104
        # fail/release/park deliberately do not need the product-head lock.
        job = claim(driver, db)
        assert driver.call("pq_release", token(db, job))["outcome"] == "retry_wait"
    finally:
        locker.rollback()
        locker.close()
    assert driver.call("pq_due", [db["env"], None, 100]) == [first[0]]
    assert driver.call("pq_reap_one", [db["env"], first[0]])["outcome"] == "queued"


@pytest.mark.parametrize("drop_index", [False, True])
def test_a8_zid_lookup_and_parent_delete(db, driver, language, drop_index):
    seed_history(db)
    sql(db, "INSERT INTO polis_queue_heads(env,product_key,zid) SELECT %s,'head-'||i,1 FROM generate_series(1,10000) i", (db["env"],))
    for table in ("polis_queue_heads", "polis_queue_runs"):
        sql(db, "ANALYZE " + table)
        if drop_index:
            sql(db, "DROP INDEX " + table + "_zid")
        plan = sql(db, "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT 1 FROM ONLY public." + table + " x WHERE zid=2 FOR KEY SHARE OF x")[0][0][0]
        scanned = list(nodes(plan["Plan"]))
        retain(language, f"a8-{table}-{'control' if drop_index else 'baseline'}", plan)
        if drop_index:
            # runs_history can filter by its second key while traversing many
            # index pages. Tuple-filter counts alone miss this expensive plan.
            assert plan["Plan"]["Shared Hit Blocks"] >= 20
        else:
            assert any(n.get("Index Name") == table + "_zid" for n in scanned)
            assert plan["Plan"]["Shared Hit Blocks"] < 20
    sql(db, "DELETE FROM conversations WHERE zid=2")
    with pytest.raises(psycopg2.errors.ForeignKeyViolation):
        sql(db, "DELETE FROM conversations WHERE zid=1")
    assert sql(db, "SELECT zid FROM conversations") == [(1,)]


def test_a8_removed_reaper_control(db, driver):
    enqueue(driver, db, "no-reaper")
    job = claim(driver, db)
    assert driver.call("pq_park", token(db, job) + ["public-park"])["outcome"] == "parked"
    sql(db, "UPDATE polis_queue_jobs SET eligible_at=clock_timestamp()")
    mutate(db, "pq_reap_one", " j=public.pq_lock(p_env,p_job,true,false);", " RETURN NULL; j=public.pq_lock(p_env,p_job,true,false);")
    assert driver.call("pq_due", [db["env"], None, 100]) == [job["job_id"]]
    assert driver.call("pq_reap_one", [db["env"], job["job_id"]]) is None
    assert sql(db, "SELECT state FROM polis_queue_jobs")[0][0] == "parked"


def test_a8_missing_per_job_commit_control(db, driver):
    # Deliberately broken caller algorithm: hold all page mutations in one
    # transaction. An independent client sees zero quiet-recovery progress
    # until the whole page commits; interruption loses every transition.
    for i in range(2):
        enqueue(driver, db, f"page-control-{i}")
        job = claim(driver, db)
        assert driver.call("pq_park", token(db, job) + ["public-park"])["outcome"] == "parked"
    sql(db, "UPDATE polis_queue_jobs SET eligible_at=clock_timestamp()")
    ids = driver.call("pq_due", [db["env"], None, 100])
    conn = psycopg2.connect(db["dsn"])
    try:
        with conn.cursor() as cur:
            for job_id in ids:
                cur.execute("SELECT public.pq_reap_one(%s,%s::uuid)", (db["env"], job_id))
                assert cur.fetchone()[0]["outcome"] == "queued"
        assert sql(db, "SELECT count(*) FROM polis_queue_jobs WHERE state='queued'")[0][0] == 0
        conn.rollback()
        assert driver.call("pq_due", [db["env"], None, 100]) == ids
    finally:
        conn.close()
