"""Read-only independent recount of the admitted aggregate vote context."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
from polismath.utils.vote_convention import SEMANTIC_AGREE, SEMANTIC_DISAGREE, SEMANTIC_PASS

SEMANTIC_SIGNS = (SEMANTIC_DISAGREE, SEMANTIC_PASS, SEMANTIC_AGREE)
COUNT_SIGNS = (("agrees", SEMANTIC_AGREE), ("disagrees", SEMANTIC_DISAGREE), ("passes", SEMANTIC_PASS))


def digest(value, **kwargs):
    return hashlib.sha256(json.dumps(value, **kwargs).encode()).hexdigest()


def canonical_groups(math):
    bases = dict(zip(math["base-clusters"]["id"], math["base-clusters"]["members"]))
    assert len(bases) == len(math["base-clusters"]["id"])
    groups = {g["id"]: [pid for bid in g["members"] for pid in bases[bid]]
              for g in math["group-clusters"]}
    assert len(groups) == len(math["group-clusters"])
    assert groups == {g["id"]: g["members"] for g in math["group_clusters"]}
    assignments = {str(pid): gid for gid, members in groups.items() for pid in members}
    assert len(assignments) == sum(map(len, groups.values()))
    return groups, assignments


def audit_context(context, math, votes, statement_ids):
    groups, assignments = canonical_groups(math)
    assert context["group_mapping"] == "base-clusters-unfold/1"
    assert context["source_convention"] == "semantic:+1=agree"
    assert context["group_assignments_sha256"] == digest(assignments, sort_keys=True, separators=(",", ":"))
    assert context["math_sha256"] == digest(math, sort_keys=True, separators=(",", ":"), allow_nan=False)
    counts = Counter((v["tid"], assignments.get(str(v["pid"])), v["vote"])
                     for v in votes if v["vote"] is not None)
    overall = Counter()
    for (tid, gid, sign), count in counts.items():
        assert sign in SEMANTIC_SIGNS
        overall[tid, sign] += count
    rows = context["comments"]
    assert len(rows) == len(statement_ids) == len({row["comment_id"] for row in rows})
    assert {row["comment_id"] for row in rows} == set(statement_ids)
    scopes = 0
    for row in rows:
        tid = row["comment_id"]
        assert row["comment-id"] == tid
        for name, sign in COUNT_SIGNS:
            assert row["total-" + name] == row[name] == overall[tid, sign], (tid, name)
        assert row["total-votes"] == row["votes"] == sum(overall[tid, s] for s in SEMANTIC_SIGNS)
        scopes += 1
        present = 0
        for gid in groups:
            total = sum(counts[tid, gid, s] for s in SEMANTIC_SIGNS)
            present += total > 0
            for name, sign in COUNT_SIGNS:
                assert row.get(f"group-{gid}-{name}", 0) == counts[tid, gid, sign], (tid, gid, name)
            assert row.get(f"group-{gid}-votes", 0) == total
            scopes += 1
        assert row["num_groups"] == present
    return dict(comments=len(rows), scoped_counts=scopes, count_fields=scopes * 4,
                group_sizes={str(g): len(m) for g, m in groups.items()},
                latest_votes=len(votes), unassigned_votes=sum(n for (t, g, s), n in counts.items() if g is None))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof", type=Path, default=Path("/proof"))
    parser.add_argument("--env", default="demo1424")
    parser.add_argument("--zid", type=int, default=1424)
    parser.add_argument("--scope", default="delphi")
    parser.add_argument("--context-only", type=Path, help="diagnostic recount; does not certify published reports")
    args = parser.parse_args()
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from polismath.utils.vote_convention import RowConventionSource, database_row_fetcher, using_convention_source, load_semantic_votes
    from polismath.delphi_storage.postgres import PostgresResultReader
    from delphi_graph_stages import code_digest
    with psycopg2.connect(os.environ["DATABASE_URL"]) as conn:
        conn.set_session(isolation_level="REPEATABLE READ", readonly=True)
        def query(sql, params=None):
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(re.sub(r"(?<!:):([A-Za-z_]\w*)", r"%(\1)s", sql), params or {})
                return list(cur.fetchall())
        rows = query("SELECT tid,txt FROM comments WHERE zid=:zid ORDER BY tid", dict(zid=args.zid))
        statement_ids, texts = [r["tid"] for r in rows], [r["txt"] for r in rows]
        if args.context_only:
            context = json.loads(args.context_only.read_text())
        else:
            admitted = json.loads((args.proof / "demo-admitted.json").read_text())
            node = query("""SELECT n.job_id::text,n.resolved,n.resolved_sha,public.pd_graph_hash(n.resolved) AS actual_sha
                FROM delphi_graph_nodes n JOIN delphi_graph_served s ON s.env=n.env AND s.zid=n.zid
                JOIN delphi_artifacts a ON a.env=s.env AND a.artifact_id=s.artifact_id AND a.job_id=n.job_id
                WHERE n.env=:env AND n.zid=:zid AND n.graph_id=:graph AND s.scope_key=:scope""",
                dict(env=args.env,zid=args.zid,graph=admitted["graph_id"],scope=args.scope))
            assert len(node) == 1
            node = node[0]
            assert node["resolved_sha"] == node["actual_sha"]
            resolved = node["resolved"]
            declared = resolved["declared"]
            config = declared["config"]
            assert declared["code"] == hashlib.sha256((ROOT / "scripts/job_graph_stage.py").read_bytes()).hexdigest()
            assert config["adapter_sha256"] == code_digest()
            assert config["comment_ids"] == statement_ids and declared["snapshot"]["data"]["texts"] == texts
            context = config["narrative_context"]
        math = query("SELECT data FROM math_main WHERE zid=:zid AND math_env=:env ORDER BY modified DESC LIMIT 1", dict(zid=args.zid, env=context["math_env"]))[0]["data"]
        if isinstance(math, str):
            math = json.loads(math)
        with using_convention_source(RowConventionSource(database_row_fetcher(query))):
            votes = load_semantic_votes(query("SELECT zid,pid,tid,vote FROM votes_latest_unique WHERE zid=:zid", dict(zid=args.zid)), null_policy="keep")
        receipt = audit_context(context, math, votes, statement_ids)
        assert receipt["comments"] == 316 and receipt["scoped_counts"] == 948
        if not args.context_only:
            receipt.update(resolved_sha=node["resolved_sha"], profile="fixed-stand-in/1")
        receipt["outcome"] = "context-only-diagnostic" if args.context_only else "verified-source-counts"
        if not args.context_only:
            (args.proof / "narrative-audit.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt))


if __name__ == "__main__":
    main()
