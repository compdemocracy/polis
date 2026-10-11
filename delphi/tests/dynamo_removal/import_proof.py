#!/usr/bin/env python3
"""Shared CI import proof: actual local Dynamo export -> actual queued graph child.

prepare seeds generated codec data and admits work. verify waits for the real
daemon and publishes via the public generation-checked RPC. This script never
claims or finalizes a queue job and never fabricates process exit proof.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import psycopg2

DELPHI = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(DELPHI))
sys.path.insert(0, str(DELPHI / "scripts"))
from job_graph_client import GraphClient
from polismath.delphi_storage import legacy_import as legacy
from polismath.delphi_storage.codec import decode_family, encode_family, item_from_python
from polismath.delphi_storage.golden_corpus import corpus
from polismath.delphi_storage.postgres import PostgresResultReader

ZID, REPORT, ENV, SCOPE = 9001, "r9001generated", "proof-import", "generated-import"


def cli(*arguments):
    completed = subprocess.run([sys.executable, str(DELPHI / "scripts/import_dynamo_export.py"),
                                *map(str, arguments)], capture_output=True, text=True)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip())
    return json.loads(completed.stdout)


def seed_database():
    with psycopg2.connect(os.environ["DATABASE_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute("INSERT INTO users(uid,hname,email) VALUES (%s,'Generated importer owner',"
                           "'importer@example.invalid') ON CONFLICT(uid) DO NOTHING", (ZID,))
            cursor.execute("INSERT INTO conversations(zid,owner,topic) VALUES (%s,%s,'Generated importer') "
                           "ON CONFLICT(zid) DO NOTHING", (ZID, ZID))
            cursor.execute("INSERT INTO reports(report_id,zid) SELECT %s,%s WHERE NOT EXISTS"
                           "(SELECT 1 FROM reports WHERE report_id=%s)", (REPORT, ZID, REPORT))
        legacy.validate_report_mapping(connection, ZID, [REPORT])


def prepare(root, endpoint):
    seed_database()
    client = legacy.local_client(endpoint)
    data = corpus()
    # Deliberately incompatible result data proves durable quarantine, no votes.
    data["Delphi_CommentEmbeddings"].append(item_from_python(dict(
        conversation_id=str(ZID), comment_id=999, text="generated\0quarantine")))
    for family, rows in sorted(data.items()):
        key = legacy.FAMILIES[family]["key"]
        client.create_table(TableName=family, BillingMode="PAY_PER_REQUEST",
                            AttributeDefinitions=[dict(AttributeName=n, AttributeType=t) for n, t in key],
                            KeySchema=[dict(AttributeName=n, KeyType="HASH" if i == 0 else "RANGE")
                                       for i, (n, _) in enumerate(key)])
        client.get_waiter("table_exists").wait(TableName=family)
        for row in rows:
            client.put_item(TableName=family, Item=row)
    directory = root / ("export-" + uuid.uuid4().hex)
    args = ["export-local", directory, "--endpoint", endpoint]
    for family in sorted(data):
        args.extend(["--family", family])
    exported = cli(*args)
    assert set(exported) == set(legacy.FAMILIES)
    source = legacy.read_export(directory)
    for family in data:
        assert source[family].encode() == encode_family(family, data[family])
    preview = cli("preview", directory, "--zid", ZID, "--report-id", REPORT)
    arguments = ["enqueue", directory, "--zid", ZID, "--report-id", REPORT,
                 "--env", ENV, "--scope", SCOPE]
    first, again = cli(*arguments), cli(*arguments)
    assert first["outcome"] == "enqueued", first
    assert again["outcome"] == "existing" and first["graph_id"] == again["graph_id"]
    assert first["counts"] == preview["counts"]
    receipt = dict(graph_id=first["graph_id"], root_job_id=first["root_job_id"],
                   export_dir=str(directory), source_sha256=first["source_sha256"],
                   counts=first["counts"], families=len(data), duplicate_outcome=again["outcome"])
    (root / "import-receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
    print(json.dumps(dict(phase="prepared", **receipt), sort_keys=True))


def verify(root, wait_seconds):
    receipt = json.loads((root / "import-receipt.json").read_text())
    with closing(psycopg2.connect(os.environ["QUEUE_DATABASE_URL"])) as connection:
        graph = GraphClient(connection, ENV)
        deadline = time.monotonic() + wait_seconds
        while True:
            status = graph.status(receipt["graph_id"])
            assert len(status["nodes"]) == 1
            node = status["nodes"][0]
            state = node["readiness"]["state"]
            if state == "succeeded":
                break
            if state in {"dead", "cancelled"}:
                raise AssertionError("import graph failed: " + state)
            if time.monotonic() >= deadline:
                raise AssertionError("real importer worker has not completed: " + state)
            time.sleep(1)
        artifact = node["artifact"]
        payload = artifact["payload"]
        assert artifact["content_sha"] == legacy.digest(payload.encode())
        output = json.loads(payload)
        assert output["counts"] == receipt["counts"]
        source = legacy.read_export(receipt["export_dir"])
        assert output == legacy.import_output(source, ZID, [REPORT])
        for family in legacy.CONTROL_FAMILIES:
            assert output["legacy_control_files"][family] == source[family]
        assert output["counts"]["Delphi_CommentEmbeddings"]["quarantined"] == 1
        assert decode_family(output["quarantine"]["Delphi_CommentEmbeddings"]["codec_wire"].encode())[1][0]["text"]["S"] == "generated\0quarantine"
        served = graph.served(ZID, SCOPE)
        if served is None:
            publication = graph.publish(receipt["graph_id"], node["job_id"], 0)
            assert publication["outcome"] == "published", publication
        else:
            assert served["bundle"]["root"] == artifact["artifact_id"]
        reader = PostgresResultReader(connection, ENV)
        bundle = reader.read_served_bundle(ZID, SCOPE)
        assert set(bundle["families"]) == set(legacy.FAMILIES) - legacy.CONTROL_FAMILIES
        for family, rows in bundle["families"].items():
            assert len(rows) == receipt["counts"][family]["imported"]
            # Reencode native PG readback to prove tags, decimals, sets, and bytes.
            assert encode_family(family, [item_from_python(row) for row in rows]).decode() == output["family_files"][family]
        repeated = ["enqueue", receipt["export_dir"], "--zid", ZID, "--report-id", REPORT,
                    "--env", ENV, "--scope", SCOPE]
        again = cli(*repeated)
        assert again["outcome"] == "existing" and again["graph_id"] == receipt["graph_id"]
        result = dict(phase="verified", graph_id=receipt["graph_id"], artifact_id=artifact["artifact_id"],
                      result_families=len(bundle["families"]), archived_control_families=len(output["legacy_control_files"]),
                      quarantined_rows=1, source_families=len(receipt["counts"]),
                      source_rows=sum(c["source"] for c in receipt["counts"].values()),
                      imported_rows=sum(c["imported"] for c in receipt["counts"].values()),
                      archived_rows=sum(c["archived"] for c in receipt["counts"].values()),
                      attempts=node["attempts"], generation=bundle["generation"],
                      duplicate_outcome=again["outcome"])
        (root / "import-verification.json").write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
        print(json.dumps(result, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "verify"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8000")
    parser.add_argument("--wait-seconds", type=int, default=0)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    if args.phase == "prepare":
        prepare(args.directory, args.endpoint)
    else:
        verify(args.directory, args.wait_seconds)


if __name__ == "__main__":
    main()
