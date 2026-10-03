"""The Python leg of the two-convention gate (P-078 PR-F).

    python ci/vote_convention/engine_leg.py --database gate_v0 --convention v0 --out OUT/v0

Runs, against one provisioned gate database, every Python path that reads
``votes`` the way production does today, and writes each result as bytes under
OUT for compare.py:

* ``math/``: the poller's cold rebuild (``MathPollerService._load_or_init`` over
  ``PostgresClient.poll_votes``/``poll_moderation``) and ``MathWriter`` for every
  conversation that carries a math_env; the three published rows (math_main,
  math_bidtopid, math_ptptstats) dumped as Postgres serialises them.
* ``replay/``: the replay-harness fixtures read back through the production
  loader and replayed cut by cut exactly as delphi/tests/test_pca_column_order.py
  does; each cut's ``tids``/``pca`` and the verdict against the recorded
  expectation.
* ``fold/``: the frozen fold oracle on the raw rows, once as today's callers call
  it (its own declared sign) and once through its declared-sign companion.
* ``db/``: the stored ``votes`` rows; ``vote`` is the one declared-sign field.

Nothing reads the convention from the database yet (that is PR-A); the only
place this leg knows the convention is the declared-sign companion of the fold,
which takes it from --convention.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "delphi"))
sys.path.insert(0, str(HERE))

import logging  # noqa: E402

import numpy as np  # noqa: E402
import psycopg2  # noqa: E402
from psycopg2.extras import RealDictCursor  # noqa: E402

from polismath.conversation.conversation import Conversation  # noqa: E402
from polismath.database.postgres import PostgresClient, PostgresConfig  # noqa: E402
from polismath.poller.service import MathPollerService, PollerConfig  # noqa: E402

import fixtures  # noqa: E402
import fold_declared  # noqa: E402
from provision import CONVENTIONS, dsn  # noqa: E402


def write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = payload if isinstance(payload, bytes) else (json.dumps(payload, sort_keys=True, indent=1) + "\n").encode()
    path.write_bytes(data)


def pg_client(database: str, math_env: str) -> PostgresClient:
    host = os.environ.get("VOTE_GATE_PG_HOST", "127.0.0.1")
    port = int(os.environ.get("VOTE_GATE_PG_PORT", "5470"))
    password = os.environ.get("VOTE_GATE_PG_PASSWORD", "gate")
    # The production constructor: no convention argument, so it reads with the
    # code constant exactly as the live poller does today.
    client = PostgresClient(PostgresConfig(host=host, port=port, database=database, user="postgres",
                                           password=password, ssl_mode="disable", math_env=math_env))
    client.initialize()
    return client


def math_leg(database: str, out: Path, convs) -> dict:
    by_env = {}
    for c in convs:
        if c.math_env:
            by_env.setdefault(c.math_env, []).append(c)
    written = 0
    for env, items in sorted(by_env.items()):
        pg = pg_client(database, env)
        try:
            svc = MathPollerService(pg, PollerConfig(math_env=env))
            for c in sorted(items, key=lambda c: c.zid):
                with patch("time.time", return_value=fixtures.CLOCK / 1000):
                    svc._cold_start.active = True
                    try:
                        conv = svc._load_or_init(c.zid)
                    finally:
                        svc._cold_start.active = False
                    for _ in range(c.math_publications):
                        svc._writer.write_conv_updates(c.zid, conv)
                written += 1
        finally:
            pg.shutdown()
    db = psycopg2.connect(dsn(database))
    with db.cursor() as cur:
        for table in ("math_main", "math_bidtopid", "math_ptptstats"):
            cur.execute(f"SELECT zid, math_env, math_tick, data::text FROM {table} ORDER BY zid, math_env")
            for zid, env, tick, data in cur.fetchall():
                write(out / "math" / f"{zid:05d}.{env}.{table}.json",
                      json.dumps({"zid": zid, "math_env": env, "math_tick": tick}, sort_keys=True).encode()
                      + b"\n" + data.encode() + b"\n")
    db.close()
    return {"conversations": written}


def assert_g12(actual, expected) -> bool:
    actual, expected = np.asarray(actual), np.asarray(expected)
    return actual.shape == expected.shape and bool(
        np.all(np.abs(actual - expected) <= 1e-6 + 1e-4 * np.maximum(np.abs(actual), np.abs(expected))))


def replay_leg(database: str, out: Path, convs) -> dict:
    pg = pg_client(database, fixtures.GATE_MATH_ENV)
    verdicts = {}
    try:
        for c in convs:
            if not c.replay:
                continue
            # The production loader converts; restore the fixture's own order.
            votes = sorted(pg.poll_votes(c.zid), key=lambda v: v["created"])
            conv = Conversation(f"gate-{c.source}", last_updated=votes[0]["created"])
            conv.pca = {"center": np.zeros(1), "comps": np.ones((2, 1))}
            previous, cuts, ok = 0, [], True
            expected = c.replay.get("expected") or [None] * len(c.replay["cuts"])
            for cut, exp in zip(c.replay["cuts"], expected):
                batch = {"votes": [dict(pid=v["pid"], tid=v["tid"], vote=v["vote"], created=v["created"])
                                   for v in votes[previous:cut]]}
                conv = conv.update_votes(batch, recompute=False).recompute()
                blob = conv.to_dict()
                step = {"cut": cut, "tids": blob["tids"], "pca": blob["pca"]}
                if exp is not None:
                    match = (blob["tids"] == exp["tids"]
                             and assert_g12(blob["pca"]["comps"], exp["pca"]["comps"])
                             and np.array_equal(blob["pca"]["center"], exp["pca"]["center"])
                             and assert_g12(blob["pca"]["comment-projection"], exp["pca"]["comment-projection"]))
                    step["matches_recorded"] = match
                    ok = ok and match
                cuts.append(step)
                previous = cut
            write(out / "replay" / f"{c.source.replace('/', '-')}.json", {"source": c.source, "cuts": cuts})
            verdicts[c.source] = ok if c.replay.get("expected") else None
    finally:
        pg.shutdown()
    return verdicts


def fold_and_rows_leg(database: str, out: Path, convs, agree_value: int) -> dict:
    db = psycopg2.connect(dsn(database))
    summary = {}
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        for c in convs:
            cur.execute("SELECT pid, tid, vote, created FROM votes WHERE zid=%s ORDER BY created, pid, tid", (c.zid,))
            rows = [dict(r) for r in cur.fetchall()]
            write(out / "db" / f"{c.zid:05d}.votes.json", rows)
            if not rows:
                continue
            direct = fold_declared.fold_summary(fold_declared.oracle().fold_votes(rows))
            declared = fold_declared.fold_summary(fold_declared.fold_votes_declared(rows, storage_agree_value=agree_value))
            write(out / "fold" / f"{c.zid:05d}.direct.json", direct)
            write(out / "fold" / f"{c.zid:05d}.declared.json", declared)
            summary[c.zid] = len(rows)
    db.close()
    return {"conversations": len(summary)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--convention", choices=sorted(CONVENTIONS), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    logging.disable(logging.WARNING)
    convs = fixtures.all_conversations()
    report = {
        "convention": args.convention,
        "agree_value": CONVENTIONS[args.convention],
        "math": math_leg(args.database, args.out, convs),
        "replay": replay_leg(args.database, args.out, convs),
        "fold": fold_and_rows_leg(args.database, args.out, convs, CONVENTIONS[args.convention]),
    }
    write(args.out / "engine-leg.json", report)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
