"""Closed job and public-output boundaries for the reusable probe box.

This module grants no launch or data access. Image arguments are an exec-form
array, never shell source. Raw probe output is never a public result.
"""
from __future__ import annotations

import json
import re
from typing import Literal, TypedDict, NotRequired


class ImageCommand(TypedDict):
    image: str
    args: list[str]


class Job(TypedDict):
    schema: Literal["polis-probe-job/1"]
    run_id: str
    producer: ImageCommand
    verifier: ImageCommand
    max_seconds: int
    reader: NotRequired[ImageCommand]


class BoundaryError(ValueError):
    """A fixed error code; never include the rejected value in a public log."""


def command(value: object) -> ImageCommand:
    if type(value) is not dict or set(value) != {"image", "args"}:
        raise BoundaryError("COMMAND_SCHEMA")
    image, args = value["image"], value["args"]
    if (type(image) is not str or len(image) > 256 or
            re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}", image) is None):
        raise BoundaryError("IMAGE_DIGEST")
    if (type(args) is not list or not 1 <= len(args) <= 32 or
            any(type(arg) is not str or not arg or len(arg) > 256 or
                any(ord(c) < 32 or ord(c) > 126 for c in arg) for arg in args)):
        raise BoundaryError("ARGUMENTS")
    return {"image": image, "args": list(args)}


def validate_job(value: object) -> Job:
    if type(value) is not dict or set(value) - {"reader"} != {
        "schema", "run_id", "producer", "verifier", "max_seconds"
    } or value["schema"] != "polis-probe-job/1":
        raise BoundaryError("JOB_SCHEMA")
    run_id = value["run_id"]
    if type(run_id) is not str or re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
        raise BoundaryError("RUN_ID")
    ceiling = value["max_seconds"]
    if type(ceiling) is not int or not 1 <= ceiling <= 18000:
        raise BoundaryError("CAMPAIGN_CEILING")
    producer, verifier = command(value["producer"]), command(value["verifier"])
    if producer["image"] == verifier["image"]:
        raise BoundaryError("SEPARATE_VERIFIER")
    result: Job = {"schema": "polis-probe-job/1", "run_id": run_id,
                   "producer": producer, "verifier": verifier, "max_seconds": ceiling}
    if "reader" in value:
        result["reader"] = command(value["reader"])
    return result


def decode_job(raw: bytes) -> Job:
    if len(raw) > 20000:
        raise BoundaryError("JOB_SIZE")

    def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in items:
            if key in result:
                raise BoundaryError("DUPLICATE_KEY")
            result[key] = value
        return result

    try:
        return validate_job(json.loads(raw, object_pairs_hook=pairs))
    except (UnicodeError, json.JSONDecodeError):
        raise BoundaryError("JOB_JSON") from None


def public_result(run_id: str, passed: bool) -> bytes:
    if type(run_id) is not str or re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
        raise BoundaryError("RUN_ID")
    if type(passed) is not bool:
        raise BoundaryError("VERDICT")
    return f"run_id={run_id}\n{'PASS' if passed else 'FAIL'}\n".encode("ascii")


def audit_public_output(raw: bytes, run_id: str, artifacts: list[str]) -> bool:
    """Audit captured application output BEFORE release, with zero artifacts.

    This does not audit GitHub's own job scaffolding or claim that a public
    transcript can be made private after printing it. The runner must capture
    all child stdout/stderr and invoke this boundary before emitting bytes.
    """
    if type(artifacts) is not list or artifacts:
        raise BoundaryError("PUBLIC_ARTIFACT")
    for passed in (True, False):
        if raw == public_result(run_id, passed):
            return passed
    raise BoundaryError("PUBLIC_OUTPUT")
