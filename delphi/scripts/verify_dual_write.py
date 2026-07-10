#!/usr/bin/env python3
"""Dual-write parity verification (Storage V2 design §6.1 M1, §10).

Reads the LEGACY Delphi_* math tables and the V2 artifacts back
INDEPENDENTLY and compares them numerically (Decimal vs float by value,
booleans strictly) — a bug in the dual-writer's join logic cannot hide,
because nothing here shares code with the writer.

Usage:
    python scripts/verify_dual_write.py --job-id <job_id> --zid <zid>
        [--endpoint-url http://localhost:8000]

Exit code 0 = parity; 1 = mismatches (listed); 2 = missing data.
Backend/config for the v2 side via the usual DELPHI_STORAGE_* env vars.
"""

import argparse
import logging
import os
import sys

import boto3
from boto3.dynamodb.conditions import Key

from delphi_storage import get_store
from delphi_storage.codec import decode_payload, from_dynamo
from delphi_storage.conformance.runner import assert_json_equal

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def _legacy_resource(endpoint_url):
    kwargs = {"region_name": os.environ.get("AWS_REGION", "us-east-1")}
    if endpoint_url:
        kwargs["endpoint_url"] = endpoint_url
        kwargs["aws_access_key_id"] = os.environ.get("AWS_ACCESS_KEY_ID", "dummy")
        kwargs["aws_secret_access_key"] = os.environ.get("AWS_SECRET_ACCESS_KEY", "dummy")
    return boto3.resource("dynamodb", **kwargs)


def _decoded_artifacts(store, job_id: str) -> dict:
    items = store.query_prefix("artifacts", job_id, "math#")
    return {item.sk: decode_payload(item.attributes, item.blob) for item in items}


def _query_all(table, **kwargs) -> list:
    rows: list = []
    while True:
        response = table.query(**kwargs)
        rows.extend(response.get("Items", []))
        last = response.get("LastEvaluatedKey")
        if not last:
            return rows
        kwargs["ExclusiveStartKey"] = last


def _compare(name: str, actual, expected, mismatches: list) -> None:
    try:
        assert_json_equal(actual, expected)
    except AssertionError as e:
        mismatches.append(f"{name}: {e}")


def verify_math_dual_write(store, job_id: str, zid, endpoint_url=None) -> dict:
    """Compare the legacy math tables (at latest_math_tick for zid) against
    the decoded v2 artifacts of job_id. Returns {ok, mismatches, tick}."""
    zid = str(zid)
    mismatches: list = []
    artifacts = _decoded_artifacts(store, job_id)
    if not artifacts:
        return {"ok": False, "mismatches": [f"no v2 math artifacts for job {job_id!r}"]}

    resource = _legacy_resource(endpoint_url)

    config_row = resource.Table("Delphi_PCAConversationConfig").get_item(
        Key={"zid": zid}
    ).get("Item")
    if not config_row:
        return {"ok": False, "mismatches": [f"no legacy config row for zid {zid}"]}
    tick = int(config_row["latest_math_tick"])
    zid_tick = f"{zid}:{tick}"

    # --- math#pca vs Delphi_PCAResults + config counts ---
    pca_artifact = artifacts.get("math#pca")
    if pca_artifact is None:
        mismatches.append("math#pca artifact missing")
    else:
        _compare("pca.math_tick", pca_artifact.get("math_tick"), tick, mismatches)
        legacy_pca = resource.Table("Delphi_PCAResults").get_item(
            Key={"zid": zid, "math_tick": tick}
        ).get("Item")
        if not legacy_pca:
            mismatches.append(f"no legacy Delphi_PCAResults row at tick {tick}")
        else:
            _compare("pca.pca", pca_artifact.get("pca"),
                     from_dynamo(legacy_pca.get("pca")), mismatches)
            # legacy stores only the AGREE list as consensus_comments; the
            # v2 artifact keeps the full consensus dict (a superset)
            _compare("pca.consensus.agree",
                     (pca_artifact.get("consensus") or {}).get("agree", []),
                     from_dynamo(legacy_pca.get("consensus_comments")), mismatches)
            for count in ("participant_count", "comment_count", "group_count"):
                _compare(f"pca.{count}", pca_artifact.get(count),
                         from_dynamo(legacy_pca.get(count)), mismatches)

    # --- math#kmeans vs Delphi_KMeansClusters ---
    kmeans_artifact = artifacts.get("math#kmeans")
    if kmeans_artifact is None:
        mismatches.append("math#kmeans artifact missing")
    else:
        legacy_rows = _query_all(
            resource.Table("Delphi_KMeansClusters"),
            KeyConditionExpression=Key("zid_tick").eq(zid_tick),
        )
        legacy_groups = {
            int(row["group_id"]): {
                "center": from_dynamo(row.get("center")),
                "members": from_dynamo(row.get("members")),
            }
            for row in legacy_rows
        }
        v2_groups = {
            int(group["id"]): {"center": group.get("center"), "members": group.get("members")}
            for group in kmeans_artifact
        }
        _compare("kmeans", v2_groups, legacy_groups, mismatches)

    # --- math#repness vs Delphi_RepresentativeComments ---
    repness_artifact = artifacts.get("math#repness")
    if repness_artifact is None:
        mismatches.append("math#repness artifact missing")
    else:
        group_ids = {int(entry["group_id"]) for entry in repness_artifact}
        legacy_repness: dict = {}
        for group_id in sorted(group_ids):
            rows = _query_all(
                resource.Table("Delphi_RepresentativeComments"),
                KeyConditionExpression=Key("zid_tick_gid").eq(f"{zid_tick}:{group_id}"),
            )
            for row in rows:
                legacy_repness[(group_id, str(row["comment_id"]))] = from_dynamo(
                    row.get("repness")
                )
        v2_repness = {
            (int(entry["group_id"]), str(entry["comment_id"])): entry.get("repness")
            for entry in repness_artifact
        }
        _compare(
            "repness",
            {f"{g}:{c}": v for (g, c), v in sorted(v2_repness.items())},
            {f"{g}:{c}": v for (g, c), v in sorted(legacy_repness.items())},
            mismatches,
        )

    # --- math#routing#* vs Delphi_CommentRouting ---
    routing_rows = [
        row
        for key in sorted(artifacts)
        if key.startswith("math#routing#")
        for row in artifacts[key]
    ]
    if routing_rows:
        legacy_rows = _query_all(
            resource.Table("Delphi_CommentRouting"),
            KeyConditionExpression=Key("zid_tick").eq(zid_tick),
        )
        legacy_routing = {
            str(row["comment_id"]): {
                "stats": from_dynamo(row.get("stats")),
                "priority": from_dynamo(row.get("priority")),
                "consensus_score": from_dynamo(row.get("consensus_score")),
            }
            for row in legacy_rows
        }
        v2_routing = {
            row["comment_id"]: {
                "stats": row.get("stats"),
                "priority": row.get("priority"),
                "consensus_score": row.get("consensus_score"),
            }
            for row in routing_rows
        }
        _compare("routing", v2_routing, legacy_routing, mismatches)
    else:
        mismatches.append("math#routing artifacts missing")

    # --- math#projections#* vs Delphi_PCAParticipantProjections ---
    projection_rows = [
        row
        for key in sorted(artifacts)
        if key.startswith("math#projections#")
        for row in artifacts[key]
    ]
    if projection_rows:
        legacy_rows = _query_all(
            resource.Table("Delphi_PCAParticipantProjections"),
            KeyConditionExpression=Key("zid_tick").eq(zid_tick),
        )
        legacy_projections = {
            str(row["participant_id"]): {
                "coordinates": from_dynamo(row.get("coordinates")),
                "group_id": from_dynamo(row.get("group_id")),
            }
            for row in legacy_rows
        }
        v2_projections = {
            row["participant_id"]: {
                "coordinates": row.get("coordinates"),
                "group_id": row.get("group_id"),
            }
            for row in projection_rows
        }
        _compare("projections", v2_projections, legacy_projections, mismatches)
    else:
        mismatches.append("math#projections artifacts missing")

    return {"ok": not mismatches, "mismatches": mismatches, "tick": tick}


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify math dual-write parity")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--zid", required=True)
    parser.add_argument("--endpoint-url", default=os.environ.get("DYNAMODB_ENDPOINT"))
    args = parser.parse_args()

    report = verify_math_dual_write(
        get_store(), job_id=args.job_id, zid=args.zid, endpoint_url=args.endpoint_url
    )
    if report["ok"]:
        logger.info(f"PARITY OK (tick {report.get('tick')})")
        sys.exit(0)
    for mismatch in report["mismatches"]:
        logger.error(f"MISMATCH: {mismatch}")
    sys.exit(1)


if __name__ == "__main__":
    main()
