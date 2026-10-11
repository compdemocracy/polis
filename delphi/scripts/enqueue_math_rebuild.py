#!/usr/bin/env python3
"""Admit one math rebuild through the Postgres queue, including small conversations.

DATABASE_URL supplies read access to the conversation. MATH_CAPACITY_QUEUE_DSN
must be a restricted executor login; MATH_CAPACITY_QUEUE_ENV names its namespace.
The large worker runs the existing math_poller.py --job entry and writes only the
staged label. Publication/promotion remains a separate, receipt-gated operation.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
import sys

import psycopg2

from polismath.poller.admission import MemoryAdmission
from polismath.poller.capacity_queue import QueueClient, QueueSettings, canonical_bytes
from polismath.poller.rebuild_child import check_child_label, check_math_config
from polismath.poller.service import PollerConfig


SNAPSHOT_SQL = """
SELECT EXISTS(SELECT 1 FROM conversations WHERE zid = %(zid)s),
       (SELECT count(*) FROM votes WHERE zid = %(zid)s),
       (SELECT count(DISTINCT pid) FROM votes WHERE zid = %(zid)s),
       (SELECT count(*) FROM comments WHERE zid = %(zid)s),
       GREATEST((SELECT max(created) FROM votes WHERE zid = %(zid)s),
                (SELECT max(modified) FROM comments WHERE zid = %(zid)s))
"""


def validate_request(zid, staged_label, target_label, source_commit):
    """Refuse a malformed or served-label admission before opening either DB."""
    if type(zid) is not int or zid <= 0:
        raise ValueError("zid must be a positive integer")
    config = dict(staged_label=staged_label, target_label=target_label,
                  source_commit=source_commit, need_bytes=1,
                  input_through_ms=None, binding="operator")
    check_math_config(config, label=staged_label, input_label=staged_label)
    check_child_label(staged_label, served_env="prod", target_label=target_label, env={})


def read_snapshot(database_url, zid):
    # Counts and timestamps only: no stored vote values cross a convention boundary.
    with closing(psycopg2.connect(database_url, connect_timeout=5,
                                 application_name="math-rebuild-admission")) as connection:
        connection.set_session(readonly=True)
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout='30s'")
            cursor.execute(SNAPSHOT_SQL, {"zid": zid})
            exists, votes, voters, comments, input_ms = cursor.fetchone()
    if not exists:
        raise ValueError("conversation does not exist")
    return (votes, voters, comments), input_ms


def admit(zid, *, staged_label, target_label, source_commit, model, snapshot,
          queue, dry_run=False):
    validate_request(zid, staged_label, target_label, source_commit)
    sizes, input_ms = snapshot
    model.validate()
    config = dict(staged_label=staged_label, target_label=target_label,
                  source_commit=source_commit,
                  need_bytes=max(1, model.above_base_bytes(*sizes)),
                  input_through_ms=input_ms,
                  binding=hashlib.sha256(canonical_bytes({
                      "admission": "operator-rebuild/1", "model": model.describe(),
                  })).hexdigest()[:16])
    check_math_config(config, label=staged_label, input_label=staged_label)
    if dry_run:
        outcome, job_id = "dry_run", None
    else:
        outcome, job_id = queue.enqueue_math_rebuild(
            zid, config=config, staged_label=staged_label, target_label=target_label)
    return dict(schema="polis-math-rebuild-admission/1", outcome=outcome,
                job_id=job_id, config=config,
                sizes=dict(zip(("votes", "voters", "comments"), sizes)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zid", type=int, required=True)
    parser.add_argument("--staged-label", required=True)
    parser.add_argument("--target-label", required=True)
    parser.add_argument("--source-commit", required=True,
                        help="Must match MATH_POLLER_SOURCE_COMMIT on the worker")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        validate_request(args.zid, args.staged_label, args.target_label, args.source_commit)
        queue = None if args.dry_run else QueueClient(QueueSettings(
            dsn=os.environ.get("MATH_CAPACITY_QUEUE_DSN", ""),
            env=os.environ.get("MATH_CAPACITY_QUEUE_ENV", "")))
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise ValueError("DATABASE_URL is required")
        model = MemoryAdmission.from_config(PollerConfig.from_env()).model
        result = admit(args.zid, staged_label=args.staged_label,
                       target_label=args.target_label, source_commit=args.source_commit,
                       model=model, snapshot=read_snapshot(database_url, args.zid),
                       queue=queue, dry_run=args.dry_run)
    except (ValueError, RuntimeError, psycopg2.Error) as exc:
        # Database diagnostics can include a DSN or credentials. Emit the type only.
        print(f"math rebuild admission refused ({type(exc).__name__})", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 1 if result["outcome"] in {"poisoned", "conflict"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
