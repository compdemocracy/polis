"""The only private export: bounded numeric observations and fixed verdicts.

No file copying, field names from a dataset, paths, IDs, raw blob values, logs or
free text are accepted. Entry positions follow the digest-bound run inventory.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from contracts import Job, validate_job


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def closed(value: object, fields: set[str]) -> dict:
    if type(value) is not dict or set(value) != fields:
        raise ValueError("RECEIPT_SCHEMA")
    return value


def count(value: object) -> int:
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise ValueError("RECEIPT_COUNT")
    return value


def finite(value: object) -> float:
    if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
        raise ValueError("RECEIPT_METRIC")
    return value


def validate_receipt(value: object, job: Job) -> dict:
    job = validate_job(job)
    r = closed(value, {"schema", "run_id", "job_sha256", "verdict", "entries", "controls", "selection", "digests"})
    if (r["schema"] != "polis-probe-receipt/1" or r["run_id"] != job["run_id"] or
            r["job_sha256"] != sha(job) or r["verdict"] not in ("PASS", "FAIL", "INCOMPLETE")):
        raise ValueError("RECEIPT_BINDING")
    if type(r["entries"]) is not list or not 1 <= len(r["entries"]) <= 256:
        raise ValueError("RECEIPT_ENTRIES")
    for entry in r["entries"]:
        e = closed(entry, {"verdict", "checks", "worst_absolute", "worst_relative", "outliers", "nonfinite"})
        if e["verdict"] not in ("PASS", "FAIL", "INCOMPLETE"):
            raise ValueError("RECEIPT_VERDICT")
        for key in ("checks", "outliers", "nonfinite"):
            count(e[key])
        for key in ("worst_absolute", "worst_relative"):
            finite(e[key])
        if e["verdict"] == "PASS" and (not e["checks"] or e["outliers"] or e["nonfinite"]):
            raise ValueError("RECEIPT_FALSE_PASS")
    controls = closed(r["controls"], {"passed", "expected"})
    count(controls["passed"]); count(controls["expected"])
    if not controls["expected"] or controls["passed"] > controls["expected"]:
        raise ValueError("RECEIPT_CONTROLS")
    if r["verdict"] == "PASS" and (any(e["verdict"] != "PASS" for e in r["entries"]) or
            controls["passed"] != controls["expected"]):
        raise ValueError("RECEIPT_FALSE_PASS")
    selection = r["selection"]
    if selection is not None:
        closed(selection, {"seed", "bucket_counts", "selected_sizes"})
        count(selection["seed"])
        for name in ("bucket_counts", "selected_sizes"):
            rows = selection[name]
            if type(rows) is not list or len(rows) > 256:
                raise ValueError("RECEIPT_SELECTION")
            for row in rows:
                if type(row) is not list or len(row) != (3 if name == "bucket_counts" else 2):
                    raise ValueError("RECEIPT_SELECTION")
                for n in row:
                    count(n)
    digests = closed(r["digests"], {"producer", "verifier", "inputs", "recordings", "policy"})
    for d in digests.values():
        if type(d) is not str or re.fullmatch(r"[a-f0-9]{64}", d) is None:
            raise ValueError("RECEIPT_DIGEST")
    if (digests["producer"] != job["producer"]["image"].split("@sha256:")[1] or
            digests["verifier"] != job["verifier"]["image"].split("@sha256:")[1]):
        raise ValueError("RECEIPT_IMAGE_BINDING")
    if len(canonical(r)) > 131072:
        raise ValueError("RECEIPT_LIMIT")
    return r
