"""The Delphi shadow rehearsal's selection check, read from the database after
the runs: every comment is embedded, and what each conversation's newest
run stores is exactly what participants are shown.

For every conversation whose newest succeeded shadow run names
participant_visible/1:
  - shown: what participants are shown, by a query written here from the
    comment list participants are served (server/src/comment.ts,
    participantVisibleClause), not by the code under test;
  - embedded: the conversation's rows in delphi_comment_embeddings, which
    must be every comment with text the newest run could read (one written
    after its admission is embedded by the next run, which a comment
    participants are not shown does not start);
  - placed and clustered: the comment ids in the served UMAP graph's nodes
    and cluster assignments, which must be exactly the shown ones, and every
    edge between two of them;
  - quoted: no string in the served keyword, feature or topic-name families
    holds the first 24 characters (all, when shorter) of a comment
    participants are not shown, unless a shown comment holds them too.

Prints one JSON document; "ok" is the verdict. Counts and closed words only:
never a comment, its text or a conversation's code.

    python selection_check.py <shadow env>
"""
import json
import os
import sys

import psycopg2

SCOPE = "delphi"
TEXT_FAMILIES = ("Delphi_CommentClustersStructureKeywords", "Delphi_CommentClustersFeatures",
                 "Delphi_CommentClustersLLMTopicNames")
PREFIX = 24


def number(v):
    if isinstance(v, dict):
        v = v.get("N")
    return int(float(v)) if v is not None else None


def strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from strings(x)


def rows(cur, env, zid, family):
    cur.execute("SELECT item::text FROM delphi_result_current_rows "
                "WHERE env=%s AND zid=%s AND scope_key=%s AND family=%s", (env, zid, SCOPE, family))
    return [json.loads(r[0]) for r in cur.fetchall()]


def check(cur, env, zid, admitted_ms):
    cur.execute("SELECT c.tid, c.txt, c.created, (c.active AND c.velocity > 0 AND CASE WHEN "
                "coalesce(v.strict_moderation, false) THEN c.mod = 1 ELSE c.mod <> -1 END) "
                "FROM comments c JOIN conversations v USING (zid) WHERE c.zid = %s", (zid,))
    comments = cur.fetchall()
    with_text = {tid for tid, txt, _, _ in comments if txt and txt.strip()}
    readable = {tid for tid, txt, created, _ in comments if txt and txt.strip() and created <= admitted_ms}
    shown = {tid for tid, txt, created, visible in comments
             if visible and txt and txt.strip() and created <= admitted_ms}
    hidden_texts = [txt.strip() for tid, txt, _, visible in comments if not visible and txt and txt.strip()]
    shown_texts = [txt for tid, txt, _, visible in comments if visible]
    cur.execute("SELECT DISTINCT tid FROM delphi_comment_embeddings WHERE env=%s AND zid=%s", (env, zid))
    embedded = {r[0] for r in cur.fetchall()}
    edges = rows(cur, env, zid, "Delphi_UMAPGraph")
    nodes = {number(e["source_id"]) for e in edges if number(e["source_id"]) == number(e["target_id"])}
    ends = {number(e[k]) for e in edges for k in ("source_id", "target_id")}
    clustered = {number(a["comment_id"]) for a in rows(cur, env, zid, "Delphi_CommentHierarchicalClusterAssignments")}
    quoted = 0
    for family in TEXT_FAMILIES:
        for item in rows(cur, env, zid, family):
            for s in strings(item):
                for t in hidden_texts:
                    head = t[:PREFIX]
                    if head in s and not any(head in v for v in shown_texts):
                        quoted += 1
    result = {
        "zid": zid, "comments": len(comments), "with_text": len(with_text),
        "added_after_run": len(with_text - readable), "embedded": len(embedded),
        "shown": len(shown), "hidden": len(with_text - shown), "placed": len(nodes),
        "clustered": len(clustered), "hidden_placed": len(nodes & (with_text - shown)),
        "hidden_clustered": len(clustered & (with_text - shown)), "hidden_quoted": quoted,
    }
    result["ok"] = (readable <= embedded <= with_text and nodes == shown and ends <= shown
                    and clustered == shown and quoted == 0)
    return result


def main():
    env = sys.argv[1]
    with psycopg2.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT ON (j.zid) j.zid, j.config_effective->>'selection', "
                    "(extract(epoch FROM j.created_at) * 1000)::bigint FROM delphi_jobs j JOIN polis_queue_jobs q ON q.env=j.env AND q.job_id=j.job_id "
                    "WHERE j.env=%s AND q.state='succeeded' ORDER BY j.zid, j.created_at DESC", (env,))
        newest = cur.fetchall()
        conversations = [check(cur, env, zid, at) for zid, sel, at in newest if sel == "participant_visible/1"]
        unnamed = sorted(zid for zid, sel, _ in newest if sel != "participant_visible/1")
    print(json.dumps({"env": env, "conversations": conversations, "newest_without_selection": len(unnamed),
                      "ok": bool(conversations) and not unnamed and all(c["ok"] for c in conversations)},
                     sort_keys=True))


if __name__ == "__main__":
    main()
