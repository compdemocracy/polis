"""Wait for a graph to finish, publish its bundle, then release the scope guard.

Publishing moves the served pointer to this run's narrative artifact; the
embedding set it produced becomes the conversation's served set (reachable
upstream from that artifact). Releasing the scope guard (pd_graph_reconcile,
what a coordinator does in production once every node is terminal) lets the next
run be admitted on the same scope.
"""
import argparse
from contextlib import closing
import json
import os
import sys
import time
from pathlib import Path
import psycopg2
from job_graph_client import GraphClient

ZID = 2424


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", required=True)
    parser.add_argument("--scope", default="delphi")
    parser.add_argument("--admitted", required=True)
    parser.add_argument("--wait-seconds", type=int, default=900)
    args = parser.parse_args()
    admitted = json.loads(Path(args.admitted).read_text())
    with closing(psycopg2.connect(os.environ["QUEUE_DATABASE_URL"])) as conn:
        client = GraphClient(conn, args.env)
        deadline = time.monotonic() + args.wait_seconds
        prior = None
        while time.monotonic() < deadline:
            state = client.status(admitted["graph_id"])
            status = {n["key"]: n["readiness"]["state"] for n in state["nodes"]}
            if status != prior:
                print(json.dumps(status), file=sys.stderr, flush=True)
                prior = status
            if all(s == "succeeded" for s in status.values()):
                break
            if any(s in ("dead", "cancelled", "parked") for s in status.values()):
                raise RuntimeError(state)
            time.sleep(1)
        else:
            raise RuntimeError("graph completion deadline exceeded")
        nodes = {n["key"]: n for n in state["nodes"]}
        # Read the current served generation, then publish this run on top of it.
        with psycopg2.connect(os.environ["DATABASE_URL"]) as admin:
            with admin.cursor() as cur:
                cur.execute("SELECT COALESCE(generation,0) FROM public.delphi_graph_served WHERE env=%s AND zid=%s AND scope_key=%s",
                            (args.env, ZID, args.scope))
                row = cur.fetchone()
                expected = row[0] if row else 0
        publication = client.publish(admitted["graph_id"], nodes["n"]["job_id"], expected)
        assert publication["outcome"] == "published", publication
    # Release the scope guard so the next run can admit on this scope.
    with psycopg2.connect(os.environ["DATABASE_URL"]) as admin:
        with admin.cursor() as cur:
            cur.execute("SELECT public.pd_graph_reconcile(%s)", (args.env,))
            released = cur.fetchone()[0]
    receipt = {"env": args.env, "scope": args.scope, "generation": publication["generation"],
               "embed_job": nodes["e"]["job_id"], "narrative_job": nodes["n"]["job_id"],
               "reconcile": released}
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
