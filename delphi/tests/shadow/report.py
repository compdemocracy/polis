"""The Delphi shadow rehearsal's report, read from the database after the runs.

Prints one JSON document: every job of the shadow env with its run record's
facts (state, attempt times, comment count, size class, twin_of, the census
digest against the admitted one, families), every delphi_step/1 line of every
attempt, which envs hold rows in each queue and result table, the published
env's served pointer (compared with the value given before the runs), and
the result tables' sizes. Counts, seconds, digests and labels only.

    python report.py <shadow env> <published env> <served before as JSON>
"""
import json
import os
import sys

import psycopg2

TABLES = ["delphi_jobs", "polis_queue_jobs", "polis_queue_runs", "polis_queue_attempts",
          "polis_queue_logs", "delphi_graphs", "delphi_artifacts", "delphi_result_batches",
          "delphi_result_families", "delphi_result_rows", "delphi_graph_served",
          "delphi_writer_runs", "delphi_comment_embeddings"]
PREFIX = "delphi_step/1 "


def main():
    env, published, before = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    with psycopg2.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT job_id::text FROM delphi_jobs WHERE env=%s ORDER BY created_at", (env,))
        jobs = []
        for (job_id,) in cur.fetchall():
            cur.execute("SELECT pd_run_record(%s,%s::uuid)", (env, job_id))
            r = cur.fetchone()[0]
            shadow = (r.get("config_effective") or {}).get("shadow") or {}
            attempt = r.get("attempt") or {}
            steps = []
            if attempt.get("attempt_id"):
                cur.execute("SELECT line FROM polis_queue_logs WHERE env=%s AND attempt_id=%s::uuid "
                            "AND stream='stdout' AND line LIKE 'delphi_step/1 %%' ORDER BY seq",
                            (env, attempt["attempt_id"]))
                steps = [json.loads(line[len(PREFIX):]) for (line,) in cur.fetchall()]
            census = ((r.get("manifest") or {}).get("inputs") or {}).get("comment_set_sha256")
            jobs.append({
                "job_id": job_id, "state": r.get("state"), "status": r.get("status"),
                "comments": shadow.get("comments"), "size_class": shadow.get("size_class"),
                "twin_of": shadow.get("twin_of"),
                "census_digest_matches": census == shadow.get("comment_set_sha256") if census else None,
                "models": (r.get("manifest") or {}).get("models"),
                "attempt": {k: attempt.get(k) for k in ("number", "outcome", "started_at", "ended_at", "error_code")},
                "families": {f["family"]: {"rows": f["row_count"], "sha": f["content_sha256"]}
                             for f in r.get("families") or []},
                "steps": steps,
            })
        envs = {}
        for table in TABLES:
            cur.execute(f"SELECT env, count(*) FROM {table} GROUP BY env ORDER BY env")
            envs[table] = dict(cur.fetchall())
        cur.execute("SELECT zid, scope_key, generation, artifact_id::text FROM delphi_graph_served "
                    "WHERE env=%s ORDER BY zid, scope_key", (published,))
        after = [list(r) for r in cur.fetchall()]
        sizes = {}
        for table in ("delphi_result_rows", "delphi_result_families", "delphi_comment_embeddings",
                      "polis_queue_logs", "delphi_artifacts", "delphi_jobs"):
            cur.execute("SELECT pg_total_relation_size(%s)", (f"public.{table}",))
            sizes[table] = cur.fetchone()[0]
        cur.execute("SELECT pg_database_size(current_database())")
        sizes["database"] = cur.fetchone()[0]
    print(json.dumps({"env": env, "jobs": jobs, "envs": envs,
                      "published": {"env": published, "before": before, "after": after,
                                    "unchanged": before == after},
                      "bytes": sizes}, sort_keys=True))


if __name__ == "__main__":
    main()
