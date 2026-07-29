"""Executor for the shared conformance case files (cases/*.json).

The pytest side of the cross-language contract; jest executes the SAME files
against the TypeScript implementations. The op vocabulary is specified in
README.md next to this file — keep the three in sync.
"""

import base64
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from pydantic import ValidationError

from delphi_storage.codec import (
    F64,
    decode_payload,
    encode_payload,
    pack_f64,
)
from delphi_storage.interface import DelphiStore, StorageError
from delphi_storage.models import RunManifest, StoreItem

CASES_DIR = Path(__file__).parent / "cases"


@dataclass
class Case:
    name: str
    description: str = ""
    ops: list[dict[str, Any]] = field(default_factory=list)
    path: Optional[Path] = None


def _load(path: Path) -> Case:
    data = json.loads(path.read_text(encoding="utf-8"))
    return Case(
        name=data["name"], description=data.get("description", ""), ops=data["ops"], path=path
    )


def load_cases() -> list[Case]:
    return [
        _load(p) for p in sorted(CASES_DIR.glob("*.json")) if not p.name.startswith("codec_")
    ]


def load_codec_cases() -> list[Case]:
    return [_load(p) for p in sorted(CASES_DIR.glob("codec_*.json"))]


def gen_blob(spec: dict[str, Any]) -> bytes:
    """Deterministic blob generators shared with the jest runner."""
    if spec["kind"] == "f64_seq":
        return pack_f64([i * 0.5 for i in range(spec["n"])])
    raise ValueError(f"unknown blob generator {spec['kind']!r}")


def _numbers_equal(a: Any, b: Any) -> bool:
    return not isinstance(a, bool) and not isinstance(b, bool) and float(a) == float(b)


def assert_json_equal(actual: Any, expected: Any, path: str = "$") -> None:
    """Deep equality; numbers compare by value (DynamoDB may return 2 for a
    stored 2.0), booleans strictly."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        assert actual is expected or actual == expected and isinstance(actual, bool) and isinstance(
            expected, bool
        ), f"{path}: expected {expected!r}, got {actual!r}"
        return
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        assert _numbers_equal(actual, expected), f"{path}: expected {expected!r}, got {actual!r}"
        return
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected object, got {type(actual).__name__}"
        assert set(actual) == set(expected), (
            f"{path}: key mismatch — expected {sorted(expected)}, got {sorted(actual)}"
        )
        for key in expected:
            assert_json_equal(actual[key], expected[key], f"{path}.{key}")
        return
    if isinstance(expected, list):
        assert isinstance(actual, list), f"{path}: expected list, got {type(actual).__name__}"
        assert len(actual) == len(expected), (
            f"{path}: expected {len(expected)} elements, got {len(actual)}"
        )
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_json_equal(a, e, f"{path}[{i}]")
        return
    assert actual == expected, f"{path}: expected {expected!r}, got {actual!r}"


def _expected_blob(op_expect: dict[str, Any]) -> Optional[bytes]:
    if "blob_b64" in op_expect:
        return base64.b64decode(op_expect["blob_b64"])
    if "blob_gen" in op_expect:
        return gen_blob(op_expect["blob_gen"])
    return None


def _item_from_spec(spec: dict[str, Any]) -> StoreItem:
    blob: Optional[bytes] = None
    if spec.get("blob_b64") is not None:
        blob = base64.b64decode(spec["blob_b64"])
    elif spec.get("blob_gen") is not None:
        blob = gen_blob(spec["blob_gen"])
    return StoreItem(pk=spec["pk"], sk=spec["sk"], attributes=spec.get("attributes", {}), blob=blob)


def _assert_manifest_subset(run: Any, expect: dict[str, Any], context: str) -> None:
    for key, expected in expect.items():
        if key in ("found", "latest"):
            continue
        actual = getattr(run, key)
        actual = getattr(actual, "value", actual)  # enums compare by value
        assert_json_equal(actual, expected, f"{context}.{key}")


def _run_op(store: DelphiStore, op: dict[str, Any]) -> None:
    kind = op["op"]
    expect = op.get("expect") or {}
    expected_error = op.get("expect_error")

    def call():
        if kind == "put":
            return store.put(op["entity"], _item_from_spec(op["item"]))
        if kind == "put_batch":
            return store.put_batch(op["entity"], [_item_from_spec(s) for s in op["items"]])
        if kind == "get":
            return store.get(op["entity"], op["pk"], op["sk"])
        if kind == "query_prefix":
            return store.query_prefix(op["entity"], op["pk"], op.get("sk_prefix", ""))
        if kind == "query_between":
            return store.query_between(op["entity"], op["pk"], op["sk_from"], op["sk_to"])
        if kind == "delete_partition":
            return store.delete_partition(op["entity"], op["pk"])
        if kind == "enqueue_run":
            return store.enqueue_run(RunManifest(**op["run"]))
        if kind == "get_run":
            return store.get_run(op["job_id"])
        if kind == "claim_next_run":
            return store.claim_next_run(
                worker_id=op["worker_id"],
                lease_seconds=op["lease_seconds"],
                now=op.get("now"),
            )
        if kind == "extend_lease":
            return store.extend_lease(
                job_id=op["job_id"],
                worker_id=op["worker_id"],
                lease_seconds=op["lease_seconds"],
                now=op.get("now"),
            )
        if kind == "update_run_status":
            return store.update_run_status(
                op["job_id"], op["status"], error=op.get("error"), now=op.get("now")
            )
        if kind == "merge_run_fields":
            return store.merge_run_fields(op["job_id"], op["fields"])
        if kind == "complete_run":
            return store.complete_run(op["job_id"], now=op.get("now"))
        if kind == "append_log":
            return store.append_log(op["job_id"], op["message"], now=op.get("now"))
        if kind == "advance_latest":
            return store.advance_latest(
                scope=op["scope"],
                job_id=op["job_id"],
                job_type=op["job_type"],
                only_if_absent_or_imported=op.get("only_if_absent_or_imported", False),
                now=op.get("now"),
            )
        if kind == "get_latest":
            return store.get_latest(op["scope"])
        if kind == "list_runs":
            return store.list_runs(
                zid=op.get("zid"), rid=op.get("rid"), status=op.get("status")
            )
        raise ValueError(f"unknown op {kind!r}")

    if expected_error is not None:
        try:
            call()
        except StorageError as e:
            assert e.code == expected_error, (
                f"expected error {expected_error!r}, got {e.code!r} ({e})"
            )
            return
        except (ValidationError, ValueError) as e:
            assert expected_error == "invalid", (
                f"expected error {expected_error!r}, got invalid ({e})"
            )
            return
        raise AssertionError(f"expected error {expected_error!r}, but op succeeded")

    result = call()

    if kind == "get":
        if not expect:
            return
        if not expect["found"]:
            assert result is None, f"expected absent item, got {result!r}"
            return
        assert result is not None, "expected item, got None"
        if "attributes" in expect:
            assert_json_equal(result.attributes, expect["attributes"], "attributes")
        expected_blob = _expected_blob(expect)
        if expected_blob is not None:
            assert result.blob == expected_blob, "blob bytes differ"
        if "blob_len" in expect:
            assert result.blob is not None and len(result.blob) == expect["blob_len"], (
                f"expected blob of {expect['blob_len']} bytes, "
                f"got {len(result.blob) if result.blob else None}"
            )
    elif kind in ("query_prefix", "query_between"):
        if "sks" in expect:
            assert [item.sk for item in result] == expect["sks"], (
                f"expected sks {expect['sks']}, got {[item.sk for item in result]}"
            )
    elif kind == "delete_partition":
        if "deleted" in expect:
            assert result == expect["deleted"], f"expected {expect['deleted']} deleted, got {result}"
    elif kind == "get_run":
        if not expect:
            return
        if not expect["found"]:
            assert result is None, f"expected absent run, got {result!r}"
            return
        assert result is not None, "expected run, got None"
        _assert_manifest_subset(result, expect, "run")
    elif kind == "claim_next_run":
        if "job_id" in expect:
            if expect["job_id"] is None:
                assert result is None, f"expected no claim, got {result.job_id if result else None}"
            else:
                assert result is not None and result.job_id == expect["job_id"], (
                    f"expected claim of {expect['job_id']!r}, "
                    f"got {result.job_id if result else None!r}"
                )
                _assert_manifest_subset(result, {k: v for k, v in expect.items() if k != "job_id"}, "claim")
    elif kind == "extend_lease":
        if "ok" in expect:
            assert result is expect["ok"], f"expected ok={expect['ok']}, got {result}"
    elif kind in ("update_run_status", "merge_run_fields", "complete_run"):
        if expect:
            _assert_manifest_subset(result, expect, kind)
        if kind == "complete_run" and "latest" in expect:
            for pointer_expect in expect["latest"]:
                pointer = store.get_latest(pointer_expect["scope"])
                assert pointer is not None, f"no latest pointer for {pointer_expect['scope']!r}"
                assert pointer.job_id == pointer_expect["job_id"], (
                    f"latest {pointer_expect['scope']!r}: expected job "
                    f"{pointer_expect['job_id']!r}, got {pointer.job_id!r}"
                )
                assert pointer.seq == pointer_expect["seq"], (
                    f"latest {pointer_expect['scope']!r}: expected seq "
                    f"{pointer_expect['seq']}, got {pointer.seq}"
                )
    elif kind == "append_log":
        if "seq" in expect:
            assert result == expect["seq"], f"expected seq {expect['seq']}, got {result}"
    elif kind == "advance_latest":
        if "advanced" in expect:
            assert result.advanced is expect["advanced"], (
                f"expected advanced={expect['advanced']}, got {result.advanced}"
            )
        if "seq" in expect:
            assert result.pointer.seq == expect["seq"], (
                f"expected seq {expect['seq']}, got {result.pointer.seq}"
            )
    elif kind == "get_latest":
        if not expect:
            return
        if not expect["found"]:
            assert result is None, f"expected no pointer, got {result!r}"
            return
        assert result is not None, "expected pointer, got None"
        for key in ("job_id", "seq", "job_type"):
            if key in expect:
                actual = getattr(result, key)
                actual = getattr(actual, "value", actual)
                assert_json_equal(actual, expect[key], f"latest.{key}")
    elif kind == "list_runs":
        if "job_ids" in expect:
            assert [r.job_id for r in result] == expect["job_ids"], (
                f"expected {expect['job_ids']}, got {[r.job_id for r in result]}"
            )


def run_case(store: DelphiStore, case: Case) -> None:
    for i, op in enumerate(case.ops):
        try:
            _run_op(store, op)
        except AssertionError as e:
            raise AssertionError(f"case {case.name!r}, op {i} ({op['op']}): {e}") from e


def run_codec_case(case: Case) -> None:
    for i, op in enumerate(case.ops):
        kind = op["op"]
        try:
            if kind == "codec_roundtrip":
                value = op["value"]
                enc = encode_payload(value)
                assert_json_equal(decode_payload(enc.meta, enc.blob), value)
                forced = encode_payload(value, force="json+zstd")
                assert_json_equal(decode_payload(forced.meta, forced.blob), value)
                if isinstance(value, list) and value and all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) for v in value
                ):
                    f64 = encode_payload(F64([float(v) for v in value]))
                    decoded = decode_payload(f64.meta, f64.blob)
                    assert decoded == [float(v) for v in value], "f64 round-trip differs"
            elif kind == "codec_decode_fixture":
                blob = base64.b64decode(op["blob_b64"]) if op.get("blob_b64") else None
                decoded = decode_payload(op["meta"], blob)
                assert_json_equal(decoded, op["expect_value"])
            else:
                raise ValueError(f"unknown codec op {kind!r}")
        except AssertionError as e:
            raise AssertionError(f"case {case.name!r}, op {i} ({kind}): {e}") from e
