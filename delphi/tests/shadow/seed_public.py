"""Seed the Delphi shadow's rehearsal with public fixtures only.

Conversations made from the two public datasets in real_data/ (the
biodiversity and vw exports), at several sizes, comments only: the shadow
reads no vote. Conversation 1424 (the whole biodiversity export, with its
votes) is seeded beforehand by tests/dynamo_removal/seed.py through the vote
convention module. Every conversation also gets a math_main row under the
label the math engine writes, so the scheduler reads the engine as caught up.

Prints one JSON line: the conversations and their comment counts.
"""
import csv
import json
import os
from pathlib import Path

import psycopg2

_HERE = Path(__file__).resolve()
ROOT = next((p / "real_data" for p in _HERE.parents if (p / "real_data").is_dir()), Path("/app/real_data"))

# zid -> (datasets, how many comments; None = all)
PLAN = {
    2001: (["biodiversity"], 25),
    2002: (["vw"], 40),
    2003: (["biodiversity"], 60),
    2004: (["vw"], None),
    2005: (["biodiversity"], 200),
    2006: (["biodiversity", "vw"], None),
}


def comments_of(name):
    data = next(ROOT.glob(f"*-{name}"))
    return list(csv.DictReader(next(data.glob("*comments.csv")).open()))


def main():
    math_env = os.environ.get("REHEARSAL_MATH_ENV", "python")
    out = {}
    with psycopg2.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        for zid, (sets, limit) in PLAN.items():
            rows = [c for name in sets for c in comments_of(name)]
            rows = rows[:limit] if limit else rows
            owner = 300000 + zid
            cur.execute("INSERT INTO users(uid,hname,email) VALUES (%s,'Public fixture owner',%s)",
                        (owner, f"owner{zid}@example.invalid"))
            cur.execute("INSERT INTO conversations(zid,owner,topic,description,is_active) "
                        "VALUES (%s,%s,'Public fixture','Shadow rehearsal',true)", (zid, owner))
            cur.execute("INSERT INTO participants(zid,uid) VALUES (%s,%s) RETURNING pid", (zid, owner))
            (pid,) = cur.fetchone()
            for tid, c in enumerate(rows):
                cur.execute(
                    "INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified,active) "
                    "VALUES (%s,%s,%s,%s,%s,%s,false,now_as_millis(),now_as_millis(),true)",
                    (zid, tid, pid, owner, c["comment-body"], int(c["moderated"])))
            out[zid] = len(rows)
        cur.execute("SELECT zid FROM conversations WHERE zid = 1424")
        if cur.fetchone():
            cur.execute("SELECT count(*) FROM comments WHERE zid = 1424")
            out[1424] = cur.fetchone()[0]
        for zid in out:
            cur.execute("INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,modified) "
                        "VALUES (%s,%s,'{}'::jsonb,0,now_as_millis()) ON CONFLICT (zid,math_env) "
                        "DO UPDATE SET modified=now_as_millis()", (zid, math_env))
    print(json.dumps({"conversations": out}, sort_keys=True))


if __name__ == "__main__":
    main()
