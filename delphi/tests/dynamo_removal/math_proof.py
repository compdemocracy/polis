#!/usr/bin/env python3
"""Verify a real math job's receipt and promote its staged local demo bundle."""
import argparse
from contextlib import closing
import json
import os
import time

import psycopg2

from polismath.database.postgres import PostgresClient, PostgresConfig, staged_newer
from polismath.poller.capacity_queue import QueueClient, QueueSettings, decode_frame_uri
from polismath.poller.rebuild_child import check_child_label


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--zid", type=int, required=True)
    parser.add_argument("--staged-label", required=True)
    parser.add_argument("--target-label", required=True)
    parser.add_argument("--wait-seconds", type=int, default=0)
    args = parser.parse_args()
    # This proof never promotes production labels.
    check_child_label(args.target_label, served_env="prod", target_label=args.staged_label, env={})
    queue = QueueClient(QueueSettings(os.environ["MATH_CAPACITY_QUEUE_DSN"],
                                     os.environ["MATH_CAPACITY_QUEUE_ENV"]))
    deadline = time.monotonic() + args.wait_seconds
    while True:
        status = queue.job_status(args.job_id)
        if status["state"] == "succeeded":
            break
        if status["state"] in {"dead", "cancelled"} or time.monotonic() >= deadline:
            raise AssertionError("real math job not successful: " + status["state"])
        time.sleep(1)
    frame = json.loads(decode_frame_uri(status["input"]["uri"]))
    assert frame["zid"] == args.zid
    assert frame["config"]["staged_label"] == args.staged_label
    assert frame["config"]["target_label"] == args.target_label
    receipt = queue.receipt(args.job_id)
    assert receipt.finalized, "successful job has no valid stored manifest receipt"
    database_url = os.environ["DATABASE_URL"]
    pg = PostgresClient(PostgresConfig(url=database_url, math_env=args.target_label, ssl_mode="disable"))
    pg.initialize()
    try:
        with closing(psycopg2.connect(database_url)) as lock:
            lock.autocommit = True
            with lock.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(hashtext(%s))",
                               ("polis-math-python:" + args.target_label,))
                assert cursor.fetchone()[0], "another writer owns target label"
            fps = pg.math_fingerprints([args.zid], [args.staged_label, args.target_label])
            staged = fps.get((args.zid, args.staged_label))
            target = fps.get((args.zid, args.target_label))
            assert staged and staged.complete and receipt.binds(staged, args.staged_label)
            if staged_newer(staged, target):
                pg.promote_bundle(args.zid, from_env=args.staged_label, to_env=args.target_label,
                                  expected_target=target, expected_staged=staged)
            promoted = pg.math_fingerprints([args.zid], [args.target_label])[(args.zid, args.target_label)]
            assert promoted.complete and promoted.lvt == staged.lvt
        print(json.dumps(dict(outcome="verified-and-promoted", job_id=args.job_id,
                              attempts=status["attempt_count"], receipt_sha256=receipt.output_sha256,
                              staged_math_tick=staged.math_tick, target_math_tick=promoted.math_tick,
                              vote_hwm=promoted.lvt, target_label=args.target_label), sort_keys=True))
    finally:
        pg.shutdown()


if __name__ == "__main__":
    main()
