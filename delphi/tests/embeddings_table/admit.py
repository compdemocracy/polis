"""Admit one Delphi graph (embed -> cluster -> topics -> narrative) for the proof.

Reads the conversation's current comments, builds the standard four-node spec
with the real MiniLM model digest, and admits it on the given queue env and
scope. The same scope is used across runs so a later run's embed stage is handed
the prior served set and re-embeds only the comments missing from it.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import psycopg2
from job_graph_client import GraphClient, numerical_spec
from delphi_graph_stages import model_digest

ZID = 2424


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", required=True)
    parser.add_argument("--scope", default="delphi")
    parser.add_argument("--request-key", required=True)
    parser.add_argument("--report-id", default="rlocalembtable2424")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with psycopg2.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT tid,txt FROM comments WHERE zid=%s ORDER BY tid", (ZID,))
            rows = cur.fetchall()
            cur.execute("SELECT public.pd_graph_hash(%s::jsonb)", (json.dumps({"texts": [t for _, t in rows]}),))
            sha = cur.fetchone()[0]
    plan = numerical_spec([t for _, t in rows], [tid for tid, _ in rows], args.report_id, sha,
                          model_digest(os.environ["DELPHI_EMBED_MODEL_PATH"]))
    with closing(psycopg2.connect(os.environ["QUEUE_DATABASE_URL"])) as conn:
        result = GraphClient(conn, args.env).admit(ZID, args.scope, args.request_key, plan)
    result["statements"] = len(rows)
    result["tids"] = [tid for tid, _ in rows]
    Path(args.out).write_text(json.dumps(result, indent=2))
    print(json.dumps({"graph_id": result["graph_id"], "statements": len(rows), "env": args.env, "scope": args.scope}))


if __name__ == "__main__":
    main()
