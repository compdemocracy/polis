"""Seed one conversation with public-fixture comments for the embeddings-table proof.

Two phases let a later run add comments a first run never saw, so the proof can
show that a re-run embeds only the comments that are new. No votes or math are
needed: the graph embeds comment text, clusters, names topics and renders a
fixed narrative stand-in. Comment ids are assigned by the ``tid_auto`` trigger
(MAX(tid)+1 per conversation), so the comments added in the second phase take the
higher ids; this script prints the ids it created so the caller knows the split.
"""
import argparse
import csv
import json
import os
from pathlib import Path
import psycopg2

ZID = 2424
OWNER_UID = ZID
REPORT_ID = "rlocalembtable2424"


def fixture_comments():
    root = Path(__file__).resolve().parents[2] / "real_data"
    data = next(root.glob("*-biodiversity"))
    rows = list(csv.DictReader(next(data.glob("*comments.csv")).open()))
    # A stable order so the two phases split the conversation the same way every run.
    rows.sort(key=lambda row: int(row["comment-id"]))
    return rows


def participant_pid(cur):
    """The conversation's single fixture participant. pid is assigned by the
    pid_auto trigger (MAX(pid)+1), so it is read back rather than chosen. Comment
    authorship is irrelevant to the embeddings proof, which keys on comment ids,
    so every comment is attributed to this one participant to satisfy the
    comments->participants foreign key."""
    cur.execute("SELECT pid FROM participants WHERE zid=%s ORDER BY pid LIMIT 1", (ZID,))
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute("INSERT INTO participants(zid,uid,created,mod) VALUES (%s,%s,1700000000000,0) RETURNING pid", (ZID, OWNER_UID))
    return cur.fetchone()[0]


def insert_comments(cur, rows):
    pid = participant_pid(cur)
    # tid is assigned by the trigger; insert in fixture-id order so the ids are stable.
    created = []
    for row in rows:
        cur.execute(
            "INSERT INTO comments(zid,pid,uid,txt,mod,is_meta,created,modified,active) "
            "VALUES (%s,%s,%s,%s,%s,false,%s,%s,true) RETURNING tid",
            (ZID, pid, OWNER_UID, row["comment-body"], int(row["moderated"]),
             int(row["timestamp"]) * 1000, int(row["timestamp"]) * 1000),
        )
        created.append(cur.fetchone()[0])
    return created


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True, choices=("init", "add"))
    parser.add_argument("--count", required=True, type=int, help="comments to insert this phase")
    args = parser.parse_args()
    rows = fixture_comments()
    with psycopg2.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            if args.phase == "init":
                cur.execute("INSERT INTO users(uid,hname,email) VALUES (%s,'Embeddings fixture owner','embowner@example.invalid')", (OWNER_UID,))
                cur.execute("INSERT INTO conversations(zid,owner,topic,description,is_active,topics_enabled) "
                            "VALUES (%s,%s,'Biodiversity embeddings fixture','Embeddings-table queue and Postgres proof',true,true)", (ZID, OWNER_UID))
                cur.execute("INSERT INTO reports(rid,zid,report_id) VALUES (%s,%s,%s)", (ZID, ZID, REPORT_ID))
                cur.execute("INSERT INTO zinvites(zid,zinvite) VALUES (%s,'local-embtable-2424')", (ZID,))
                created = insert_comments(cur, rows[: args.count])
            else:
                cur.execute("SELECT count(*) FROM comments WHERE zid=%s", (ZID,))
                have = cur.fetchone()[0]
                created = insert_comments(cur, rows[have : have + args.count])
            cur.execute("SELECT count(*) FROM comments WHERE zid=%s", (ZID,))
            total = cur.fetchone()[0]
    print(json.dumps({"phase": args.phase, "zid": ZID, "report_id": REPORT_ID,
                      "created_tids": created, "total_comments": total}))


if __name__ == "__main__":
    main()
