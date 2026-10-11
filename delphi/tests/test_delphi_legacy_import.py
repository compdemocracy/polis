"""All twenty generated codec families cross the local export/import boundary."""
import copy
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

from polismath.delphi_storage import legacy_import as legacy
from polismath.delphi_storage.codec import decode_family, encode_family, item_from_python
from polismath.delphi_storage.golden_corpus import GOLDEN, corpus


ZID = 9001
REPORT = "r9001generated"


def files():
    return {family: encode_family(family, rows).decode() for family, rows in corpus().items()}


def test_every_family_accounted_for_and_control_rows_never_activated():
    source = files()
    result = legacy.import_output(source, ZID, [REPORT])
    assert set(result["counts"]) == set(legacy.FAMILIES)
    for family, wire in source.items():
        counts = result["counts"][family]
        assert counts["source"] == sum(counts[k] for k in ("imported", "archived", "quarantined"))
        if family in legacy.CONTROL_FAMILIES:
            assert result["legacy_control_files"][family] == wire
            assert family not in result["family_files"] and counts["imported"] == 0
        else:
            assert result["family_files"][family] == wire


def test_nul_quarantine_preserves_exact_row_and_other_row_imports():
    family = "Delphi_CommentEmbeddings"
    rows = [item_from_python(dict(conversation_id=str(ZID), comment_id=1, text="valid")),
            item_from_python(dict(conversation_id=str(ZID), comment_id=2, text="bad\0value"))]
    result = legacy.import_output({family: encode_family(family, rows).decode()}, ZID, [])
    assert result["counts"][family] == dict(source=2, imported=1, archived=0, quarantined=1)
    assert result["quarantine"][family]["reason"] == "postgres-jsonb-nul"
    assert decode_family(result["family_files"][family].encode())[1] == rows[:1]
    assert decode_family(result["quarantine"][family]["codec_wire"].encode())[1] == rows[1:]
    # Canonical wire in a JSON string has escaped backslashes, never literal NUL.
    assert "\0" not in json.dumps(result)


def test_binary_nul_is_not_quarantined():
    assert not legacy.has_nul({"B": b"\0"})
    assert legacy.has_nul({"M": {"bad\0key": {"S": "value"}}})


@pytest.mark.parametrize("zid,reports", [(9002, [REPORT]), (ZID, []), (ZID, ["wrong-report"])])
def test_cross_conversation_or_unbound_report_refused(zid, reports):
    with pytest.raises(ValueError, match="mismatch|binding"):
        legacy.import_output(files(), zid, reports)


def test_manifest_reader_accepts_frozen_golden_bytes():
    assert legacy.read_export(GOLDEN) == files()


def test_local_export_consumes_all_pages_and_roundtrips(tmp_path):
    family = "Delphi_CommentEmbeddings"
    rows = corpus()[family]
    client = Mock()
    token = {"conversation_id": {"S": str(ZID)}, "comment_id": {"N": "1"}}
    client.scan.side_effect = [{"Items": rows[:1], "LastEvaluatedKey": token}, {"Items": rows[1:]}]
    legacy.export_local(client, tmp_path, [family])
    assert client.scan.call_args_list[1].kwargs["ExclusiveStartKey"] == token
    assert legacy.read_export(tmp_path)[family] == encode_family(family, rows).decode()


@pytest.mark.parametrize("endpoint", ["https://dynamodb.us-east-1.amazonaws.com", "http://example.com",
                                     "http://127.0.0.1@evil.invalid", "http://127.0.0.1/?target=prod"])
def test_export_refuses_nonlocal_endpoints_before_sdk(endpoint):
    with pytest.raises(ValueError, match="loopback"):
        legacy.local_client(endpoint)


def test_changed_export_refused(tmp_path):
    family = "Delphi_CommentEmbeddings"
    client = Mock()
    client.scan.return_value = {"Items": corpus()[family]}
    legacy.export_local(client, tmp_path, [family])
    path = tmp_path / (family + ".jsonl")
    path.write_bytes(path.read_bytes().replace(b"generated-embedding-model", b"changed-embedding-model"))
    with pytest.raises(ValueError, match="digest"):
        legacy.read_export(tmp_path)


def frame():
    spec = legacy.build_spec(files(), ZID, [REPORT])
    return dict(stage="graph_narrative", zid=ZID,
                input=dict(declared=spec["nodes"][0]["declared"], artifacts={}))


def test_import_worker_rechecks_source_and_code_provenance():
    actual = frame()
    assert legacy.execute_import(actual) == legacy.import_output(files(), ZID, [REPORT])
    for name in ("source_sha256", "importer_sha256", "codec_sha256"):
        changed = copy.deepcopy(actual)
        changed["input"]["declared"]["config"][name] = "0" * 64
        with pytest.raises(ValueError, match="digest|provenance"):
            legacy.execute_import(changed)


def test_normal_graph_stage_manifest_binds_import_payload():
    from scripts import job_graph_stage
    actual = frame()
    actual.update(schema="polis-job-stage-frame/1", job_id="generated-job",
                  run_id="generated-run", attempt_id="generated-attempt")
    actual["input"]["schema"] = "polis-job-input/1"
    wire = json.dumps(actual["input"])
    actual.update(input_json=wire, input_sha256=legacy.digest(wire.encode()))
    manifest = job_graph_stage.run(actual)
    payload = manifest["output"]["payload"]
    assert manifest["output"]["sha256"] == legacy.digest(payload.encode())
    assert json.loads(payload)["counts"] == legacy.import_output(files(), ZID, [REPORT])["counts"]


def test_identical_export_produces_identical_request_and_different_export_does_not():
    first = legacy.build_spec(files(), ZID, [REPORT])
    assert first == legacy.build_spec(files(), ZID, [REPORT])
    changed = files()
    changed["Delphi_CommentEmbeddings"] = changed["Delphi_CommentEmbeddings"].replace(
        "generated-embedding-model", "changed-embedding-model")
    assert first != legacy.build_spec(changed, ZID, [REPORT])


def test_report_mapping_uses_actual_database_relationship():
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = [(REPORT,)]
    legacy.validate_report_mapping(connection, ZID, [REPORT])
    cursor.fetchall.return_value = []
    with pytest.raises(ValueError, match="attached"):
        legacy.validate_report_mapping(connection, ZID, [REPORT])


def test_oversized_artifact_refused_without_truncation():
    family = "Delphi_CommentEmbeddings"
    source = {family: encode_family(family, [item_from_python(dict(
        conversation_id=str(ZID), comment_id=1, text="x" * legacy.MAX_BYTES))]).decode()}
    with pytest.raises(ValueError, match="bounded inline"):
        legacy.import_output(source, ZID, [])


@pytest.mark.parametrize("target", ["SHA256SUMS", "Delphi_CommentEmbeddings.jsonl"])
@pytest.mark.parametrize("kind", ["symlink", "fifo"])
def test_export_reader_refuses_nonregular_inputs_without_blocking(tmp_path, target, kind):
    family = "Delphi_CommentEmbeddings"
    raw = encode_family(family, [item_from_python(dict(conversation_id=str(ZID), comment_id=1))])
    (tmp_path / (family + ".jsonl")).write_bytes(raw)
    (tmp_path / "SHA256SUMS").write_text(f"{legacy.digest(raw)}  {family}.jsonl\n")
    path = tmp_path / target
    original = path.read_bytes()
    path.unlink()
    if kind == "symlink":
        outside = tmp_path / "original"
        outside.write_bytes(original)
        path.symlink_to(outside)
    else:
        os.mkfifo(path)
    # A subprocess timeout is the regression assertion: an ordinary FIFO open
    # would block forever before any regular-file validation could run.
    program = """from polismath.delphi_storage.legacy_import import read_export
import sys
try:
    read_export(sys.argv[1])
except (OSError, ValueError):
    sys.exit(0)
sys.exit(1)
"""
    result = subprocess.run([sys.executable, "-c", program, str(tmp_path)],
        cwd=Path(legacy.__file__).resolve().parents[2], capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr.decode()


@pytest.mark.parametrize("target", ["SHA256SUMS", "Delphi_CommentEmbeddings.jsonl"])
def test_export_reader_refuses_oversize_regular_files(tmp_path, target):
    family = "Delphi_CommentEmbeddings"
    raw = encode_family(family, [])
    (tmp_path / (family + ".jsonl")).write_bytes(raw)
    (tmp_path / "SHA256SUMS").write_text(f"{legacy.digest(raw)}  {family}.jsonl\n")
    limit = legacy.MAX_MANIFEST_BYTES if target == "SHA256SUMS" else legacy.MAX_BYTES
    with (tmp_path / target).open("wb") as source:
        source.truncate(limit + 1)
    with pytest.raises(ValueError, match="byte limit"):
        legacy.read_export(tmp_path)


def test_export_reader_enforces_actual_bytes_if_file_grows_after_stat(tmp_path, monkeypatch):
    source = tmp_path / "growing"
    source.write_bytes(b"x" * 33)
    monkeypatch.setattr(legacy.os, "fstat", lambda fd: SimpleNamespace(st_mode=stat.S_IFREG, st_size=0))
    with pytest.raises(ValueError, match="byte limit"):
        legacy.read_regular_file(source, 32)


@pytest.mark.parametrize("paged", [False, True])
def test_export_budget_stops_before_fetching_more_or_writing_oversize_family(tmp_path, paged):
    family = "Delphi_CommentEmbeddings"
    rows = [item_from_python(dict(conversation_id=str(ZID), comment_id=i, text="x" * 240_000)) for i in range(2)]
    token = {"conversation_id": {"S": str(ZID)}, "comment_id": {"N": "1"}}
    pages = ([{"Items": rows[:1], "LastEvaluatedKey": token}, {"Items": rows[1:], "LastEvaluatedKey": token}]
             if paged else [{"Items": rows, "LastEvaluatedKey": token}])
    client = Mock()
    client.scan.side_effect = pages
    with pytest.raises(ValueError, match="bounded inline"):
        legacy.export_local(client, tmp_path, [family])
    assert client.scan.call_count == len(pages)
    assert not (tmp_path / (family + ".jsonl")).exists()
    assert not (tmp_path / "SHA256SUMS").exists()


def test_export_budget_is_shared_across_families(tmp_path):
    families = ["Delphi_CommentEmbeddings", "Delphi_CommentExtremity"]
    client = Mock()
    client.scan.side_effect = [
        {"Items": [item_from_python(dict(conversation_id=str(ZID), comment_id=1, text="x" * 240_000))]},
        {"Items": [item_from_python(dict(conversation_id=str(ZID), comment_id="1", text="x" * 240_000))]},
    ]
    with pytest.raises(ValueError, match="bounded inline"):
        legacy.export_local(client, tmp_path, families)
    assert client.scan.call_count == 2
    assert not (tmp_path / "SHA256SUMS").exists()


def test_export_reader_shares_byte_limit_across_families(tmp_path):
    source = {
        "Delphi_CommentEmbeddings": [item_from_python(dict(conversation_id=str(ZID), comment_id=1, text="x" * 240_000))],
        "Delphi_CommentExtremity": [item_from_python(dict(conversation_id=str(ZID), comment_id="1", text="x" * 240_000))],
    }
    manifest = []
    for family, rows in source.items():
        raw = encode_family(family, rows)
        (tmp_path / (family + ".jsonl")).write_bytes(raw)
        manifest.append(f"{legacy.digest(raw)}  {family}.jsonl\n")
    (tmp_path / "SHA256SUMS").write_text("".join(manifest))
    with pytest.raises(ValueError, match="byte limit"):
        legacy.read_export(tmp_path)
