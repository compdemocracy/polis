"""What a daemon-run child reports in its manifest: inputs consumed and outputs written.

Inputs are observed once, when the child starts and before any stage runs (so
before the reset): the comment-set digest, the vote high-water mark and the
math_main tick pair for the stages' math_env. A stage may read later than that;
the manifest records what was there when the run began.

Outputs are counted after the stages finish, one DynamoDB partition at a time
(a Query with Select=COUNT, paged). Every family a FULL_PIPELINE run writes is
listed, including families that ended with zero rows. S3 visualisations are not
a DynamoDB family and are not listed in output-manifest/1. The families of the
retired stages (RETIRED_FAMILIES) are not written by a run and not listed.

Both sides take their I/O as arguments (``pg_query``, ``dynamodb``) so the
tests can pass recorded fakes; ``default_pg_query`` and ``default_dynamodb``
build the real clients the stages themselves use.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Callable, Dict, List, Optional

PgQuery = Callable[[str, Dict[str, Any]], List[Dict[str, Any]]]

COMMENT_SET_FORMAT = "polis-jobs.comment-set/1"

# The families a FULL_PIPELINE run writes, all keyed by conversation_id = str(zid).
CONVERSATION_FAMILIES = (
    "Delphi_UMAPConversationConfig",
    "Delphi_CommentEmbeddings",
    "Delphi_CommentHierarchicalClusterAssignments",
    "Delphi_CommentClustersStructureKeywords",
    "Delphi_UMAPGraph",
    "Delphi_CommentClustersFeatures",
    "Delphi_CommentClustersLLMTopicNames",
)
# Families only the retired stages wrote: Delphi's own PCA, k-means,
# representativeness, participant projections and comment routing
# (polismath/run_math_pipeline.py, with 502's priorities on the routing rows) and
# 501's group extremity. A run no longer writes them; their tables, codec entries
# and legacy rows stay readable.
RETIRED_FAMILIES = (
    "Delphi_PCAConversationConfig",
    "Delphi_PCAResults",
    "Delphi_KMeansClusters",
    "Delphi_CommentRouting",
    "Delphi_RepresentativeComments",
    "Delphi_PCAParticipantProjections",
    "Delphi_CommentExtremity",
)


class CensusError(Exception):
    pass


def comment_set_sha256(rows: List[Dict[str, Any]]) -> str:
    """sha256 over one line per comment, ordered by tid: ``tid\\tmod\\tactive\\tsha256(txt)\\n``."""
    h = hashlib.sha256()
    h.update((COMMENT_SET_FORMAT + "\n").encode("utf-8"))
    for row in sorted(rows, key=lambda r: int(r["tid"])):
        txt = row.get("txt") or ""
        active = 1 if row.get("active") else 0
        mod = int(row["mod"]) if row.get("mod") is not None else 0
        line = f"{int(row['tid'])}\t{mod}\t{active}\t{hashlib.sha256(txt.encode('utf-8')).hexdigest()}\n"
        h.update(line.encode("utf-8"))
    return h.hexdigest()


def _int_or_none(value: Any) -> Optional[int]:
    return None if value is None else int(value)


def observe_inputs(zid: Any, math_env: str, pg_query: PgQuery) -> Dict[str, Any]:
    """The inputs block of the manifest, read from Postgres before any stage runs."""
    z = int(zid)
    try:
        comments = pg_query("SELECT tid, txt, mod, active FROM comments WHERE zid = :zid", {"zid": z})
        votes = pg_query("SELECT max(created) AS hwm FROM votes WHERE zid = :zid", {"zid": z})
        math = pg_query(
            "SELECT math_tick, caching_tick FROM math_main WHERE zid = :zid AND math_env = :math_env",
            {"zid": z, "math_env": math_env},
        )
    except Exception as e:  # noqa: BLE001 - any driver error means the inputs are unknown
        raise CensusError(f"could not read the run's inputs from Postgres: {e}") from e
    math_row = math[0] if math else {}
    return {
        "math_env": math_env,
        "math_tick": _int_or_none(math_row.get("math_tick")),
        "math_caching_tick": _int_or_none(math_row.get("caching_tick")),
        "comment_set_sha256": comment_set_sha256(comments),
        "vote_hwm": _int_or_none(votes[0].get("hwm")) if votes else None,
        "math_modified_ms": None,
        "target_label": None,
        "source_commit": None,
    }


def observe_inputs_from_bundle(bundle, math_env: str) -> Dict[str, Any]:
    """The inputs block when polis-jobs wrote an input bundle: the values it read
    in the same snapshot as the bundle's rows, checked here (input_bundle.py)."""
    from polismath.job_child.input_bundle import BundleError

    try:
        return bundle.inputs(math_env)
    except BundleError as e:
        raise CensusError(f"could not take the run's inputs from the input bundle: {e}") from e


def _count(table, attr: str, value: str) -> int:
    from boto3.dynamodb.conditions import Key

    total = 0
    kwargs: Dict[str, Any] = {"KeyConditionExpression": Key(attr).eq(value), "Select": "COUNT"}
    while True:
        resp = table.query(**kwargs)
        total += int(resp.get("Count", 0))
        last = resp.get("LastEvaluatedKey")
        if not last:
            return total
        kwargs["ExclusiveStartKey"] = last


def _descriptor(family: str, partitions: List[Dict[str, str]], rows: int) -> Dict[str, Any]:
    out: Dict[str, Any] = {"store": "dynamodb", "family": family, "table": family, "rows": rows}
    if len(partitions) == 1:
        out["key_prefix"] = partitions[0]
    else:
        out["keys"] = partitions
    return out


def count_full_pipeline_outputs(zid: Any, dynamodb) -> List[Dict[str, Any]]:
    """One descriptor per family a FULL_PIPELINE run writes, with its partition key and row count."""
    z = str(zid)
    try:
        return [_descriptor(family, [{"conversation_id": z}], _count(dynamodb.Table(family), "conversation_id", z))
                for family in CONVERSATION_FAMILIES]
    except CensusError:
        raise
    except Exception as e:  # noqa: BLE001
        raise CensusError(f"could not count the run's DynamoDB outputs: {e}") from e


def default_pg_query() -> PgQuery:
    """The Postgres client the UMAP stage uses (DATABASE_URL or DATABASE_*)."""
    from umap_narrative.polismath_commentgraph.utils.storage import PostgresClient

    client = PostgresClient()
    return client.query


def default_dynamodb(region: Optional[str] = None):
    """The DynamoDB resource configured the way run_delphi.py's layer discovery does it."""
    from polismath.delphi_storage.resource import result_resource

    raw = os.environ.get("DYNAMODB_ENDPOINT")
    endpoint = raw if raw and raw.strip() else None
    if endpoint:
        return result_resource("dynamodb", endpoint_url=endpoint, region_name="us-east-1")
    return result_resource("dynamodb", region_name=region or os.environ.get("AWS_REGION", "us-east-1"))
