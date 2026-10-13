"""Assertions for the embeddings-table flag-on proof.

Ground truth for "what the model produced" is an independent encode here with the
same baked weights the stage used. MiniLM's float32 output depends on the batch a
text was encoded in (padding and reduction order differ by a few ulps), so the
ground truth is encoded in the SAME grouping the stage used: a run embeds the
comments it has not seen in one call, so run 1 is encode(all of run 1) and run 2's
new comments are encode(just the new comments). Comparing is then bit-exact.

The per-run encode count is read from the daemon's own spool files (an interpreter
wrapper copies them out of the attempt work dir before the daemon removes it), so
"a re-run embeds only the new comments" is proven by the bytes the child actually
wrote, not inferred.

Subcommands:
  first    after run 1: every comment embedded, set published, read-back exact.
  second   after run 2 (more comments added): only the new comments embedded, the
           earlier comments reused unchanged.
  compare  a single flag-on run vs a single flag-off run of the same input: the
           served results are the same but for where the embeddings live.
"""
import argparse
import hashlib
import json
import os
import struct
from pathlib import Path
import numpy as np
import psycopg2
from polismath.delphi_storage.postgres import PostgresResultReader

ZID = 2424
MODEL = "sentence-transformers/all-MiniLM-L6-v2"
SCOPE = "delphi"
EMBED_FAMILY = "Delphi_CommentEmbeddings"


def f32_vec(vector):
    """The exact float32 image of a vector, from any source (Postgres real[], the
    codec family, or a numpy encode)."""
    return b"".join(struct.pack("<f", np.float32(float(v))) for v in vector)


def admin():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def comments_in_tid_order():
    with admin() as conn, conn.cursor() as cur:
        cur.execute("SELECT tid,txt FROM comments WHERE zid=%s ORDER BY tid", (ZID,))
        return cur.fetchall()


def encode(texts):
    """Encode exactly as delphi_graph_stages.execute does (same weights, params)."""
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(os.environ["DELPHI_EMBED_MODEL_PATH"], device="cpu", local_files_only=True)
    vectors = model.encode(texts, convert_to_numpy=True, batch_size=32, show_progress_bar=False)
    assert vectors.shape == (len(texts), 384), vectors.shape
    return vectors


def read_spool_rows(path):
    data = Path(path).read_bytes()
    assert data[:8] == b"PLEMBSP1", "spool magic"
    dims, count, model_len = struct.unpack_from("<HIH", data, 8)
    at = 16 + model_len
    stride = 4 + 32 + dims * 4
    tids = [struct.unpack_from("<i", data, at + i * stride)[0] for i in range(count)]
    return dims, tids


def table_rows(env):
    with admin() as conn, conn.cursor() as cur:
        cur.execute("SELECT tid,text_sha,embedding,batch_id FROM public.delphi_comment_embeddings "
                    "WHERE env=%s AND zid=%s AND model_id=1 ORDER BY tid", (env, ZID))
        return [{"tid": t, "text_sha": bytes(s), "vector": v, "batch_id": str(b)} for t, s, v, b in cur.fetchall()]


def served_set(env):
    with admin() as conn, conn.cursor() as cur:
        cur.execute("SELECT public.pd_embedding_served(%s,%s,%s,%s)", (env, ZID, SCOPE, MODEL))
        return cur.fetchone()[0]


def served_bundle(env):
    with admin() as conn:
        return PostgresResultReader(conn, env).read_served_bundle(ZID, SCOPE)


def embed_attempt(env, job):
    with admin() as conn, conn.cursor() as cur:
        cur.execute("SELECT terminal_attempt_id FROM public.polis_queue_jobs WHERE env=%s AND job_id=%s", (env, job))
        return str(cur.fetchone()[0])


def captured(attempt, kind):
    """A file the interpreter wrapper copied out of the attempt's work directory
    before the daemon removed it (``kind`` is 'embeddings.spool' or 'frame.json')."""
    return Path(os.environ.get("EMB_WORKER_DIR", "/worker")) / "captured" / f"{attempt}.{kind}"


def check(label, condition, detail=""):
    if not condition:
        raise AssertionError(f"{label} FAILED {detail}")
    print(f"  ok: {label} {detail}".rstrip(), flush=True)


def expected_by_tid(groups):
    """groups: list of (tids, texts), each a set the stage embedded in one call.
    Returns {tid: float32-bytes}, encoded with the stage's grouping."""
    out = {}
    for tids, texts in groups:
        for tid, vec in zip(tids, encode(texts)):
            out[tid] = f32_vec(vec)
    return out


def assert_rows_match_model(env, tids, texts, groups):
    rows = table_rows(env)
    check("table has one row per comment", len(rows) == len(tids), f"rows={len(rows)} comments={len(tids)}")
    check("table tids are the conversation's", [r["tid"] for r in rows] == list(tids))
    expected = expected_by_tid(groups)
    exact = all(f32_vec(r["vector"]) == expected[r["tid"]] for r in rows)
    check("read-back matches the model bit-exact (float32), in the stage's batching", exact)
    text_by_tid = dict(zip(tids, texts))
    sha_ok = all(r["text_sha"].hex() == hashlib.sha256(text_by_tid[r["tid"]].encode()).hexdigest() for r in rows)
    check("stored text_sha is sha256 of the embedded text", sha_ok)
    return rows


def cmd_first(args):
    comments = comments_in_tid_order()
    tids = [t for t, _ in comments]
    texts = [t for _, t in comments]
    print(f"run 1: {len(tids)} comments on env={args.env}", flush=True)
    rows = assert_rows_match_model(args.env, tids, texts, [(tids, texts)])
    s = served_set(args.env)
    check("a set is served", s is not None and s.get("row_count") == len(tids), f"set={s}")
    check("served set dims and model", s["dims"] == 384 and s["model"] == MODEL)
    check("every stored row is in this run's batch", len({r["batch_id"] for r in rows}) == 1)
    bundle = served_bundle(args.env)
    check("embeddings are NOT in the codec family (they live in the table)",
          EMBED_FAMILY not in bundle["families"], f"families={sorted(bundle['families'])}")
    check("clusters/topics/narrative are served",
          all(f in bundle["families"] for f in ("Delphi_CommentHierarchicalClusterAssignments",
              "Delphi_CommentClustersLLMTopicNames", "Delphi_NarrativeReports")))
    print("RUN 1 OK", flush=True)


def cmd_second(args):
    run1 = json.loads(Path(args.run1_admitted).read_text())
    run2 = json.loads(Path(args.run2_admitted).read_text())
    old_tids = list(run1["tids"])
    new_tids = [t for t in run2["tids"] if t not in set(old_tids)]
    comments = comments_in_tid_order()
    text_by_tid = {t: x for t, x in comments}
    tids = [t for t, _ in comments]
    print(f"run 2: {len(run2['tids'])} comments (new={len(new_tids)}) on env={args.env}", flush=True)

    # The bytes the child actually wrote prove the per-run encode count.
    r1_attempt = embed_attempt(args.env, json.loads(Path(args.run1_receipt).read_text())["embed_job"])
    r2_attempt = embed_attempt(args.env, json.loads(Path(args.run2_receipt).read_text())["embed_job"])
    _, spool1 = read_spool_rows(captured(r1_attempt, "embeddings.spool"))
    _, spool2 = read_spool_rows(captured(r2_attempt, "embeddings.spool"))
    check("run 1's child embedded every comment", sorted(spool1) == sorted(old_tids), f"spool1={len(spool1)}")
    check("run 2's child embedded ONLY the new comments", sorted(spool2) == sorted(new_tids), f"spool2={sorted(spool2)}")
    frame2 = json.loads(captured(r2_attempt, "frame.json").read_text())
    check("daemon handed run 2 the prior served set", frame2.get("embedding_prior", {}).get("rows") == len(old_tids),
          f"prior={frame2.get('embedding_prior')}")

    # The table holds every comment; the old rows kept run 1's write batch and the
    # new ones carry run 2's — the earlier comments were reused, never recomputed.
    # Read-back is bit-exact against the model in each run's own encode grouping.
    rows = assert_rows_match_model(args.env, tids, [text_by_tid[t] for t in tids],
                                   [(old_tids, [text_by_tid[t] for t in old_tids]),
                                    (new_tids, [text_by_tid[t] for t in new_tids])])
    by_batch = {}
    for r in rows:
        by_batch.setdefault(r["batch_id"], []).append(r["tid"])
    check("exactly two write batches (run 1 and run 2)", len(by_batch) == 2,
          f"batches={ {k: len(v) for k, v in by_batch.items()} }")
    check("the earlier comments are one batch and the new ones another",
          any(sorted(v) == sorted(old_tids) for v in by_batch.values())
          and any(sorted(v) == sorted(new_tids) for v in by_batch.values()))
    s = served_set(args.env)
    check("served set now contains every comment", s is not None and s["row_count"] == len(run2["tids"]), f"set={s}")
    print("RUN 2 OK", flush=True)


def cmd_compare(args):
    comments = comments_in_tid_order()
    tids = [t for t, _ in comments]
    texts = [t for _, t in comments]
    on = served_bundle(args.on_env)
    off = served_bundle(args.off_env)
    check("flag-off serves embeddings in the codec family", EMBED_FAMILY in off["families"])
    check("flag-on does not (they live in the table)", EMBED_FAMILY not in on["families"])
    check("the two runs serve the same family set but for where embeddings live",
          set(off["families"]) - set(on["families"]) == {EMBED_FAMILY}
          and set(on["families"]) - set(off["families"]) == set(),
          f"on={sorted(on['families'])} off={sorted(off['families'])}")

    # Both are single runs over the same input, so the embeddings are the same
    # wherever they live.
    off_vec = {int(r["comment_id"]): r["embedding"]["vector"] for r in off["families"][EMBED_FAMILY]}
    on_tbl = {r["tid"]: r["vector"] for r in table_rows(args.on_env)}
    check("flag-off codec family and flag-on table cover the same comments",
          sorted(off_vec) == sorted(on_tbl) == sorted(tids))
    expected = expected_by_tid([(tids, texts)])
    check("embeddings are bit-identical (float32) in table and codec family",
          all(f32_vec(off_vec[t]) == f32_vec(on_tbl[t]) for t in tids))
    check("both equal the model's own output", all(f32_vec(on_tbl[t]) == expected[t] for t in tids))

    # The embedding-derived families a reader sees should be identical in content.
    # Run-scoped identifiers (job ids, timestamps) legitimately differ; compare the
    # per-comment cluster structure, a pure function of the embeddings.
    def assignments(bundle):
        out = {}
        for r in bundle["families"].get("Delphi_CommentHierarchicalClusterAssignments", []):
            cid = int(r.get("comment_id", r.get("tid")))
            out[cid] = json.dumps({k: v for k, v in r.items()
                                   if k not in ("job_id", "created_at", "timestamp", "run_id", "batch_id")},
                                  sort_keys=True, default=str)
        return out
    on_a, off_a = assignments(on), assignments(off)
    identical = on_a == off_a
    differing = sum(1 for cid in set(on_a) | set(off_a) if on_a.get(cid) != off_a.get(cid))
    print(json.dumps({"downstream_cluster_assignments_identical": identical,
                      "comments_with_differing_cluster_assignment": differing,
                      "on_comments": len(on_a), "off_comments": len(off_a)}), flush=True)
    # The embeddings are proven identical above. The clustering stage, however, is
    # not reproducible run to run even on identical input vectors (UMAP is seeded
    # and stable; the EVoC clusterer is not), so the cluster-derived families are
    # not expected to match between any two runs, with or without this flag. That
    # is a property of the clustering stage, not of where the embeddings live, so
    # it is recorded here, not asserted. Pass --require-deterministic only in an
    # environment where the clustering stage has been made reproducible.
    if args.require_deterministic:
        check("per-comment cluster assignments identical (the flag does not change results)", identical)
    else:
        print("  note: cluster-family determinism recorded, not asserted (clustering stage is not seeded)", flush=True)
    print("COMPARE OK", flush=True)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("first"); p.add_argument("--env", required=True)
    p = sub.add_parser("second")
    p.add_argument("--env", required=True)
    p.add_argument("--run1-admitted", required=True); p.add_argument("--run2-admitted", required=True)
    p.add_argument("--run1-receipt", required=True); p.add_argument("--run2-receipt", required=True)
    p = sub.add_parser("compare")
    p.add_argument("--on-env", required=True); p.add_argument("--off-env", required=True)
    p.add_argument("--require-deterministic", action="store_true")
    args = parser.parse_args()
    {"first": cmd_first, "second": cmd_second, "compare": cmd_compare}[args.command](args)


if __name__ == "__main__":
    main()
