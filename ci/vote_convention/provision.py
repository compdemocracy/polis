"""Provision one gate database at a storage convention (P-078 PR-F).

    python ci/vote_convention/provision.py --convention v0 --database gate_v0

``v0`` stores agree as -1 (today's data shape); ``v1`` stores agree as +1. The
same semantic fixture set (fixtures.py) is written either way: each raw value is
``storage_vote(semantic, agree_value)``, the one Python chokepoint, so the two
databases differ in exactly the sign of every non-pass vote and in nothing else.
The database is cloned from ``gate_template`` (the server migrations, applied by
the throwaway Postgres container at start). When the migrations include PR-A's
``vote_convention`` row, the v1 leg advances it to (1, +1) with the plan's own
statement, and the v0 leg leaves the seed (0, -1).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "delphi"))
sys.path.insert(0, str(HERE))

# The database driver, the engine's convention module and the fixture set are
# imported where they are used, so the convention-row logic below can be
# unit-tested with the standard library alone.

#: The two conventions the gate proves equivalent. Agree's raw value per version.
CONVENTIONS = {"v0": -1, "v1": 1}


def dsn(database: str) -> str:
    host = os.environ.get("VOTE_GATE_PG_HOST", "127.0.0.1")
    port = os.environ.get("VOTE_GATE_PG_PORT", "5470")
    password = os.environ.get("VOTE_GATE_PG_PASSWORD", "gate")
    return f"postgresql://postgres:{password}@{host}:{port}/{database}"


def connect(database: str, attempts: int = 90):
    import psycopg2

    last = None
    for _ in range(attempts):
        try:
            return psycopg2.connect(dsn(database))
        except psycopg2.OperationalError as exc:  # init scripts still running
            last = exc
            time.sleep(1)
    raise SystemExit(f"cannot reach the gate Postgres: {last}")


def wait_for_template() -> None:
    for _ in range(90):
        db = connect("gate_template")
        try:
            with db.cursor() as cur:
                cur.execute("SELECT to_regclass('public.votes_latest_unique') IS NOT NULL")
                ready = cur.fetchone()[0]
        finally:
            db.close()
        if ready:
            return
        time.sleep(1)
    raise SystemExit("gate_template never received the migrations")


def create_database(name: str) -> None:
    wait_for_template()
    admin = connect("postgres")
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        cur.execute(f'CREATE DATABASE "{name}" TEMPLATE gate_template')
    admin.close()


#: The plan's version bump (P-078 §2a), verbatim but for its reason: the v1 leg
#: moves the database's declared convention exactly as the migration will. No
#: vote row is touched here; the fixtures are then written at agree = +1.
FLIP_STATEMENT = (
    "UPDATE public.vote_convention"
    "   SET version = 1, agree_value = 1, changed_at = clock_timestamp(), changed_by = session_user,"
    "       reason = %s"
    " WHERE singleton"
)
FLIP_REASON = "two-convention gate: generated fixture database at agree = +1 (P-078 PR-F)"
#: (version, agree_value) the convention row must read at each leg.
DECLARED = {-1: (0, -1), 1: (1, 1)}


def declare_convention(cur, agree_value: int):
    """Make the database's declared convention match the leg, when it has one.

    Once PR-A's ``public.vote_convention`` exists, every chokepoint reads the
    sign from it, so a v1 database left at the seed (0, -1) would be read as
    its opposite. The v0 leg leaves the seed; the v1 leg applies the plan's
    version bump. Without the table (edge before PR-A) nothing is done and
    None is returned. Returns the (version, agree_value) read back."""
    cur.execute("SELECT to_regclass('public.vote_convention') IS NOT NULL")
    if not cur.fetchone()[0]:
        return None
    cur.execute("SELECT version, agree_value FROM public.vote_convention WHERE singleton FOR UPDATE")
    row = cur.fetchone()
    if row is None or tuple(row) != (0, -1):
        raise SystemExit(f"the gate expects the convention seed (0, -1) in a fresh database, found {row}")
    if agree_value == 1:
        cur.execute(FLIP_STATEMENT, (FLIP_REASON,))
    cur.execute("SELECT version, agree_value FROM public.vote_convention WHERE singleton")
    got = tuple(cur.fetchone())
    if got != DECLARED[agree_value]:
        raise SystemExit(f"convention row reads {got}, the leg needs {DECLARED[agree_value]}")
    return got


def load(name: str, agree_value: int) -> dict:
    from psycopg2.extras import execute_batch, execute_values
    from polismath.utils.vote_convention import storage_vote, validate_storage_agree_value
    import fixtures

    agree_value = validate_storage_agree_value(agree_value)
    convs = fixtures.all_conversations()
    db = connect(name)
    db.autocommit = False
    clock = fixtures.CLOCK
    counts = {"conversations": 0, "votes": 0, "raw": {"-1": 0, "0": 0, "1": 0}}
    with db.cursor() as cur:
        counts["convention_row"] = declare_convention(cur, agree_value)
        cur.execute("CREATE OR REPLACE FUNCTION now_as_millis() RETURNS BIGINT AS $$ SELECT 1700000000000::bigint $$ LANGUAGE SQL")
        execute_values(cur, "INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES %s", [
            (1, "Generated Owner", "owner@example.invalid", True, "gate-owner", clock),
            (2, "Generated Admin", "admin@example.invalid", True, "gate-admin", clock),
            (3, "Generated Participant", "participant@example.invalid", False, "gate-participant", clock),
            (4, "Generated foreign owner", "foreign@example.invalid", True, "gate-foreign", clock),
        ])
        known = {1, 2, 3, 4}
        for c in convs:
            new = [u for u in c.uids if u not in known]
            execute_values(cur, "INSERT INTO users(uid,hname,email,site_id,created) VALUES %s",
                           [(u, f"Generated {u}", f"g{u}@example.invalid", f"gate-site-{u}", clock) for u in new])
            known.update(new)
            cur.execute(
                "INSERT INTO conversations(zid,owner,topic,description,is_active,is_draft,is_public,profanity_filter,spam_filter,created,modified)"
                " VALUES(%s,%s,%s,%s,true,false,true,false,false,%s,%s)",
                (c.zid, c.owner, c.topic, f"Generated fixture {c.source}", c.created, c.created))
            if c.capability:
                cur.execute("INSERT INTO zinvites(zid,zinvite,uuid,created) VALUES(%s,%s,%s,%s)",
                            (c.zid, c.capability, f"00000000-0000-4000-8000-{c.zid:012d}", clock))
            # pid_auto numbers participants densely from 0 in insertion order.
            execute_batch(cur, "INSERT INTO participants(zid,uid,created) VALUES(%s,%s,%s)",
                          [(c.zid, c.uids[p], clock) for p in range(c.participants)])
            execute_batch(cur, "INSERT INTO comments(zid,pid,uid,txt,lang,created,modified,mod) VALUES(%s,%s,%s,%s,'en',%s,%s,%s)",
                          [(c.zid, a, c.uids[a], c.comment_txt[t], cr, cr, m) for t, a, m, cr in c.comments])
            rows = []
            for pid, tid, semantic, created in c.votes:
                raw = int(storage_vote(semantic, agree_value))
                counts["raw"][str(raw)] += 1
                rows.append((c.zid, pid, tid, raw, created))
            # One INSERT per row: the votes rule upserts votes_latest_unique per statement.
            execute_batch(cur, "INSERT INTO votes(zid,pid,tid,vote,created) VALUES(%s,%s,%s,%s,%s)", rows, page_size=2000)
            counts["conversations"] += 1
            counts["votes"] += len(rows)
        cur.execute("SELECT setval('users_uid_seq',(SELECT max(uid) FROM users)),"
                    " setval('conversations_zid_seq',(SELECT max(zid) FROM conversations))")
    db.commit()
    db.close()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--convention", choices=sorted(CONVENTIONS), required=True)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    create_database(args.database)
    counts = load(args.database, CONVENTIONS[args.convention])
    print(json.dumps({"database": args.database, "convention": args.convention,
                      "agree_value": CONVENTIONS[args.convention], **counts}, sort_keys=True))


if __name__ == "__main__":
    main()
