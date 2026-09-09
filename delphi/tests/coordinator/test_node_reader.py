"""CO08 / D4: the bytes the REAL Node server serves, from both writers.

The Rust coordinator and the pinned Python reference writer publish the same
checkpoint into two namespaces of one database. The actual server modules —
`server/src/utils/pca.ts` and `server/src/utils/participants.ts` — are then
loaded in one Node process and asked for both namespaces, and the served
artefacts are compared byte for byte:

  * `asJSON`, the string `participationInit` embeds as `response.pca`,
  * `asBufferOfGzippedJson`, the literal body of `GET /api/v3/math/pca2`,
  * the `_.pick(asPOJO, keys)` projection that route serves with `?keys=`,
  * `getBidIndexToPidMapping`, and the `getPidsForGid` join over both.

Scope, stated honestly: there is no `loadBundle` in the server today — #2703
scoped the existing reader by `[math_env, zid]`, it did not introduce CO04's
Bundle. This exercises the consumer that exists, in-process rather than over
HTTP, and it does not close the CO04 Node cache-unit rewrite or the private
2,884-case served corpus.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from coordinator.conftest import ROOT, assert_coherent, connect, rows, seed
from coordinator.test_equivalence import python_checkpoint
from coordinator._node_gate import require_node

HARNESS = ROOT / "coordinator-rs/tools/node_reader.cjs"
EVIDENCE = ROOT / "coordinator-rs/evidence"
COMPARED = ("asJSON_sha256", "asJSON_bytes", "gzip_sha256", "gzip_bytes",
            "keys_projection_sha256", "tids", "n", "repness_keys", "consensus_shape",
            "mapping_sha256", "bid_to_pid", "pids_for_gid", "mapping_is_error")


def node_read(db, zid=1, envs=("python", "rustproto"), keys=("tids", "n", "repness"), gids=(0, 1)):
    spec = json.dumps({"zid": zid, "envs": list(envs), "keys": list(keys), "gids": list(gids)})
    result = subprocess.run(
        ["node", str(HARNESS), spec],
        env=dict(os.environ, DATABASE_URL=db, MATH_ENV="rustproto",
                 CACHE_MATH_RESULTS="true", NODE_ENV="test"),
        cwd=ROOT / "server", capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, (result.stdout, result.stderr)
    return {ns["math_env"]: ns for ns in json.loads(result.stdout)["namespaces"]}


def rust_and_python_publish(db, launch):
    """One visibility checkpoint, both actual writers, two namespaces — plus a
    deliberately different third namespace, so that "the two agree" is only
    evidence once "and a different one does not" is also true (Rev7)."""
    launch(db).done()
    python_checkpoint(db)
    # Same source, opposite declared agree convention: a genuinely different
    # generation for the same zid, in its own namespace.
    launch(db, env="positive", extra={"STORAGE_AGREE_VALUE": "1"}).done()
    a, b = rows(db, env="rustproto"), rows(db, env="python")
    assert a["math_main"] is not None and b["math_main"] is not None
    assert a["math_main"]["math_tick"] == b["math_main"]["math_tick"]
    return a, b


def test_real_node_reader_serves_identical_bytes_for_both_writers(db, launch):
    require_node()
    seed(db)
    rust_and_python_publish(db, launch)
    # A second checkpoint. This harness calls `getPca(zid, undefined)`, whose
    # cold behaviour at a committed generation of zero is a documented reader
    # asymmetry (test_step2_review_controls.py shows the real route serving
    # generation zero with 200 and ETag "0"), so the comparison uses tick 1.
    # Both namespaces advance together.
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    c.close()
    tables, _ = rust_and_python_publish(db, launch)
    assert tables["math_main"]["math_tick"] == 1
    assert_coherent(db, env="rustproto")

    served = node_read(db)
    assert set(served) == {"python", "rustproto"}
    for namespace in served.values():
        assert namespace["present"], namespace
        assert namespace["mapping_is_error"] is False
        assert namespace["etag_math_tick"] == 1
    differences = {field: (served["rustproto"][field], served["python"][field])
                   for field in COMPARED
                   if served["rustproto"][field] != served["python"][field]}
    (EVIDENCE / "d4-node-reader.json").write_text(json.dumps({
        "profile": "real server/src/utils/pca.ts + participants.ts, in-process, one Node process",
        "zid": 1, "math_tick": 1, "compared_fields": list(COMPARED),
        "differences": differences,
        "served": {env: {k: v for k, v in ns.items() if k in COMPARED or k == "etag_math_tick"}
                   for env, ns in served.items()},
    }, indent=2, sort_keys=True))
    assert differences == {}, differences
    # The join is real, not empty: at least one group maps to participants.
    joins = served["rustproto"]["pids_for_gid"]
    assert any(isinstance(v, list) and v for v in joins.values()), joins

    # Rev7: two namespaces agreeing does not prove namespace isolation unless a
    # deliberately different third namespace is served differently. Publish the
    # same conversation under the opposite agree convention, which produces a
    # genuinely different generation, and require the reader to tell them apart.
    both = node_read(db, envs=("rustproto", "positive", "reader"))
    foreign = both["positive"]
    assert foreign["present"], foreign
    assert foreign["asJSON_sha256"] != served["rustproto"]["asJSON_sha256"]
    assert foreign["gzip_sha256"] != served["rustproto"]["gzip_sha256"]
    assert foreign["keys_projection_sha256"] != served["rustproto"]["keys_projection_sha256"]
    # The mirrored convention keeps the same clustering, so bidToPid is
    # legitimately identical; recording that rather than asserting a difference
    # that does not exist.
    assert foreign["mapping_sha256"] == served["rustproto"]["mapping_sha256"]
    # A namespace with no math rows for the same zid: the mapping query really
    # is scoped by math_env, so it finds nothing while the populated one does.
    assert both["reader"]["mapping_is_error"] is True
    assert served["rustproto"]["mapping_is_error"] is False


def test_published_empty_math_versus_the_servers_own_empty_presentation(db, launch):
    """D4's zero-vote-with-comments shape, and a C7 observation from it.

    The pinned #2704 Python poller publishes **nothing** for a conversation
    with approved comments and no votes: its vote watermark finds no work. So
    there is no two-writer equality to assert here. What the real reader does
    instead is synthesize `createEmptyPcaStructure` for the namespace with no
    row, while serving the coordinator's explicitly published empty generation
    for the namespace that has one.

    Both are recorded, and the stable presentation fields are asserted equal.
    Byte equality between a published empty generation and the server's own
    synthesized empty presentation is NOT claimed: the full difference list is
    written to evidence for polis-empty-served/1 to rule on.
    """
    require_node()
    seed(db, votes=False)
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("UPDATE comments SET mod=1 WHERE zid=1 AND tid<2")
    c.close()
    launch(db).done()
    python_checkpoint(db)
    assert rows(db, env="python")["math_main"] is None, (
        "the reference writer publishes no generation for a zero-vote conversation")
    # A second generation, for the same reason as above: this harness's
    # `getPca(zid, undefined)` caller does not return a cold generation zero.
    c = connect(db)
    with c.cursor() as cur:
        cur.execute("UPDATE comments SET mod=1 WHERE zid=1")
    c.close()
    launch(db).done()
    assert rows(db, env="rustproto")["math_main"]["math_tick"] == 1

    served = node_read(db, gids=(0,))
    published, synthesized = served["rustproto"], served["python"]
    assert published["present"], published
    assert synthesized["present"], "the server synthesizes an empty presentation"
    differences = {field: (published[field], synthesized[field])
                   for field in COMPARED
                   if published.get(field) != synthesized.get(field)}
    (EVIDENCE / "d4-node-reader-empty.json").write_text(json.dumps({
        "profile": "zero votes, four approved comments; rustproto has a published "
                   "empty generation, python has none and is synthesized by the server",
        "reference_published": False,
        "note": "the synthesized empty presentation stamps lastVoteTimestamp with "
                "Date.now(), so it is not reproducible across servers or requests; "
                "the published empty generation is",
        "differences": differences, "served": served}, indent=2, sort_keys=True))
    assert published["n"] == synthesized["n"] == 0
    assert published["consensus_shape"] == synthesized["consensus_shape"]
    assert published["mapping_is_error"] is False
    # The mapping is the one place the synthesized path has nothing to serve.
    assert synthesized["mapping_is_error"] is True
    # C7, observed rather than argued: the published math blob lists no
    # comments, while the server's own empty presentation lists the approved
    # ones straight from `comments`. The contract's ruling is that the server
    # must own that listing; this is the two behaviours side by side.
    assert published["tids"] == []
    assert synthesized["tids"] == [0, 1, 2, 3]
    assert "tids" in differences
    # And the synthesized presentation is not even reproducible: pca.ts's
    # createEmptyPcaStructure stamps `lastVoteTimestamp: Date.now()`, so two
    # servers answering the same request for the same conversation serve
    # different bytes. The published generation carries the engine's value.
    now = time.time() * 1000
    assert abs(synthesized["last_vote_timestamp"] - now) < 600_000, (
        synthesized["last_vote_timestamp"], now)
    assert published["last_vote_timestamp"] != synthesized["last_vote_timestamp"]
