"""Bounded, lossless codec/1 export import through normal fenced graph execution.

This never resumes historical jobs or guards. Their exact exports remain an
immutable archive in the import artifact. JSONB-incompatible NUL rows remain
in a separate quarantine with their original canonical bytes and a reason.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
import sys
from urllib.parse import urlsplit

from .codec import FAMILIES, decode_family, encode_family, encode_item, header

MODEL = "legacy-dynamo-export/1"
CONTROL_FAMILIES = frozenset({"Delphi_JobQueue", "Delphi_JobActiveGuard"})
MAX_BYTES = 450_000  # Leave room inside the graph's 512 KiB output envelope.
MAX_MANIFEST_BYTES = 16_384  # Twenty known family names and SHA-256 digests.


def digest(data):
    return hashlib.sha256(data).hexdigest()


def code_digest():
    return digest(Path(__file__).read_bytes())


def codec_digest():
    return digest(Path(__file__).with_name("codec.py").read_bytes())


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def inventory(files):
    return {family: digest(wire.encode("utf-8")) for family, wire in sorted(files.items())}


def read_regular_file(path, limit):
    """Do not follow symlinks, block on FIFOs, or trust a pre-read size alone."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(path, flags), "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("export input must be a regular file")
        if metadata.st_size > limit:
            raise ValueError("export file exceeds byte limit")
        raw = source.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("export file exceeds byte limit")
        return raw


def read_export(directory):
    """Read an explicit manifest; reject missing, changed, extra or foreign files."""
    directory = Path(directory)
    expected = {}
    for line in read_regular_file(directory / "SHA256SUMS", MAX_MANIFEST_BYTES).decode("utf-8").splitlines():
        sha, filename = line.split("  ", 1)
        family = filename.removesuffix(".jsonl")
        if (filename != family + ".jsonl" or family not in FAMILIES
                or family in expected or len(sha) != 64
                or any(c not in "0123456789abcdef" for c in sha)):
            raise ValueError("invalid export manifest")
        expected[family] = sha
    actual = {p.name for p in directory.glob("*.jsonl")}
    if not expected or actual != {f + ".jsonl" for f in expected}:
        raise ValueError("export inventory mismatch")
    files = {}
    remaining = MAX_BYTES
    for family, sha in sorted(expected.items()):
        raw = read_regular_file(directory / (family + ".jsonl"), remaining)
        remaining -= len(raw)
        if digest(raw) != sha or decode_family(raw)[0] != family:
            raise ValueError("export digest or family mismatch")
        files[family] = raw.decode("utf-8")
    return files


def export_local(client, directory, families):
    """Canonicalize every page from an explicitly local DynamoDB client."""
    directory = Path(directory)
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("export destination must be empty")
    directory.mkdir(parents=True, exist_ok=True)
    files = {}
    total_bytes = 0
    for family in sorted(set(families)):
        if family not in FAMILIES:
            raise ValueError("unknown export family")
        total_bytes += len(header(family).encode("utf-8")) + 1
        if total_bytes > MAX_BYTES:
            raise ValueError("export exceeds bounded inline import")
        items, start = [], None
        while True:
            arguments = dict(TableName=family, ConsistentRead=True)
            if start is not None:
                arguments["ExclusiveStartKey"] = start
            reply = client.scan(**arguments)
            for item in reply.get("Items", []):
                # Canonical sorting cannot change row byte sizes. Check each
                # row before retaining it or fetching another scan page.
                total_bytes += len(encode_item(family, item).encode("utf-8")) + 1
                if total_bytes > MAX_BYTES:
                    raise ValueError("export exceeds bounded inline import")
                items.append(item)
            start = reply.get("LastEvaluatedKey")
            if not start:
                break
        raw = encode_family(family, items)
        files[family] = raw.decode("utf-8")
        (directory / (family + ".jsonl")).write_bytes(raw)
    if not files:
        raise ValueError("no families selected")
    (directory / "SHA256SUMS").write_text("".join(
        f"{sha}  {family}.jsonl\n" for family, sha in inventory(files).items()))
    return inventory(files)


def local_client(endpoint):
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or parsed.username or parsed.password or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment):
        raise ValueError("export requires an explicit loopback DynamoDB endpoint")
    import boto3
    from botocore.config import Config
    return boto3.client("dynamodb", endpoint_url=endpoint, region_name="us-east-1",
                        aws_access_key_id="local", aws_secret_access_key="local",
                        config=Config(connect_timeout=5, read_timeout=30, retries={"max_attempts": 1}))


def has_nul(value):
    if isinstance(value, str):
        return "\0" in value
    if isinstance(value, dict):
        return any(has_nul(k) or has_nul(v) for k, v in value.items())
    if isinstance(value, (list, set, tuple)):
        return any(has_nul(v) for v in value)
    return False


def check_binding(item, zid, report_ids):
    def scalar(name):
        value = item[name]
        return value.get("S", value.get("N"))
    for name in ("conversation_id", "zid"):
        if name in item and scalar(name) != str(zid):
            raise ValueError("source conversation mismatch")
    for name, separator in (("zid_tick", ":"), ("zid_tick_gid", ":"), ("zid_topic_jobid", "#")):
        if name in item and (scalar(name) or "").split(separator, 1)[0] != str(zid):
            raise ValueError("source composite conversation mismatch")
    for name in ("report_id", "rid_section_model"):
        if name in item and (scalar(name) or "").split("#", 1)[0] not in report_ids:
            raise ValueError("source report requires explicit binding")


def validate_report_mapping(connection, zid, report_ids):
    """Validate explicit report bindings against the local application database."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT report_id FROM reports WHERE zid=%s AND report_id=ANY(%s)",
                       (zid, list(report_ids)))
        actual = {row[0] for row in cursor.fetchall()}
    if actual != set(report_ids):
        raise ValueError("source report is not attached to the requested conversation")


def import_output(files, zid, report_ids):
    if type(zid) is not int or zid <= 0 or not files or set(files) - set(FAMILIES):
        raise ValueError("invalid import identity or family set")
    output = dict(model=MODEL, source_sha256=digest(json_bytes(inventory(files))),
                  source_inventory=inventory(files), legacy_control_files={}, quarantine={}, counts={})
    results = {}
    for family, wire in sorted(files.items()):
        actual, rows = decode_family(wire.encode("utf-8"))
        if actual != family:
            raise ValueError("source family mismatch")
        good, bad = [], []
        for row in rows:
            check_binding(row, zid, report_ids)
            (bad if has_nul(row) else good).append(row)
        if family in CONTROL_FAMILIES:
            output["legacy_control_files"][family] = wire
            output["counts"][family] = dict(source=len(rows), archived=len(rows), imported=0, quarantined=0)
        else:
            results[family] = encode_family(family, good).decode("utf-8")
            if bad:
                output["quarantine"][family] = dict(reason="postgres-jsonb-nul",
                    codec_wire=encode_family(family, bad).decode("utf-8"), row_count=len(bad))
            output["counts"][family] = dict(source=len(rows), archived=0,
                                            imported=len(good), quarantined=len(bad))
    if results:
        output["family_files"] = results
    if len(json_bytes(output)) > MAX_BYTES:
        raise ValueError("import artifact exceeds bounded inline import; no rows imported")
    return output


def build_spec(files, zid, report_ids, worker_path=None):
    """Import one checksummed export as an ordinary one-node graph."""
    output = import_output(files, zid, report_ids)
    worker = Path(worker_path) if worker_path else Path(__file__).resolve().parents[2] / "scripts/job_graph_stage.py"
    # This single-key ASCII object has exactly PostgreSQL jsonb's text spelling.
    snapshot = {"texts": ["legacy import"]}
    snapshot_sha = digest(json.dumps(snapshot).encode("utf-8"))
    config = dict(family_files=files, source_sha256=output["source_sha256"],
                  report_ids=sorted(set(report_ids)), importer_sha256=code_digest(),
                  codec_sha256=codec_digest())
    spec = dict(schema="polis-job-graph/1", nodes=[dict(
        key="legacy_import", stage="graph_narrative", **{"class": "delphi"},
        declared=dict(snapshot=dict(data=snapshot, sha256=snapshot_sha),
                      code=digest(worker.read_bytes()), model=MODEL,
                      runtime="python-" + sys.version.split()[0], seed=0, config=config,
                      mode="full", memory_bytes=64 * 1024 * 1024, work_units=1),
        inputs=[], max_attempts=3)])
    if len(json_bytes(spec)) > 900_000:
        raise ValueError("import admission exceeds graph input bound")
    return spec


def execute_import(frame):
    declared = frame["input"]["declared"]
    config = declared["config"]
    if (frame["stage"] != "graph_narrative" or declared["model"] != MODEL
            or frame["input"]["artifacts"]
            or config.get("importer_sha256") != code_digest()
            or config.get("codec_sha256") != codec_digest()):
        raise ValueError("legacy import provenance mismatch")
    output = import_output(config["family_files"], frame["zid"], config["report_ids"])
    if config["source_sha256"] != output["source_sha256"]:
        raise ValueError("legacy import source digest mismatch")
    return output
