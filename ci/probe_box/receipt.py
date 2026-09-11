"""The only private export: bounded numeric observations and fixed verdicts.

No file copying, field names from a dataset, paths, IDs, raw blob values, logs or
free text are accepted. Entry positions follow the digest-bound run inventory.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter

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


def validate_selection(value: object) -> dict:
    """Independent export boundary for the counts-only selection report.

    This supervisor has no engine/package dependency and never loads a row,
    ordinal map or path supplied by the candidate.
    """
    r = closed(value, {"seed", "bucket_counts", "chosen_entry_sizes"})
    if type(r["seed"]) is not str or re.fullmatch(r"[a-f0-9]{64}", r["seed"]) is None:
        raise ValueError("RECEIPT_SELECTION_SEED")
    totals = {"population", "target", "selected", "shortfall", "occupied", "covered", "uncovered"}
    c = closed(r["bucket_counts"], totals | {"cells"})
    def number(n):
        if type(n) is not int or not 0 <= n <= 2**63 - 1:
            raise ValueError("RECEIPT_SELECTION_COUNT")
    for k in totals:
        number(c[k])
    cells, sizes = c["cells"], r["chosen_entry_sizes"]
    if type(cells) is not list or len(cells) > 400 or type(sizes) is not list or not 1 <= len(sizes) <= 20:
        raise ValueError("RECEIPT_SELECTION_CENSUS")
    grid = {}
    for cell in cells:
        closed(cell, {"p_bin", "v_bin", "population", "selected"})
        for n in cell.values():
            number(n)
        key = cell["p_bin"], cell["v_bin"]
        if key in grid or max(key) > 19 or cell["selected"] > cell["population"]:
            raise ValueError("RECEIPT_SELECTION_CELL")
        grid[key] = cell
    actual = Counter()
    for row in sizes:
        closed(row, {"P", "V", "C", "U", "matrix_area", "registered_participants", "all_comments", "p_bin", "v_bin"})
        for n in row.values():
            number(n)
        p, v, comments, u = (row[k] for k in ("P", "V", "C", "U"))
        key = row["p_bin"], row["v_bin"]
        if (key != (len(str(p)) if p else 0, len(str(v)) if v else 0)
                or row["matrix_area"] != p*comments or u > min(v, p*comments)
                or max(p, comments) > u or ((v == 0) != (p == comments == u == 0))):
            raise ValueError("RECEIPT_SELECTION_SIZE")
        actual[key] += 1
    if (cells != sorted(cells, key=lambda x: (x["p_bin"], x["v_bin"])) or sizes != sorted(
            sizes, key=lambda x: tuple(x[k] for k in ("p_bin", "v_bin", "P", "V", "C", "U", "matrix_area", "registered_participants", "all_comments")))):
        raise ValueError("RECEIPT_SELECTION_ORDER")
    occupied = {k for k, cell in grid.items() if cell["population"]}
    expected_grid = {(p, v) for p in range(max(k[0] for k in occupied)+1)
                     for v in range(max(k[1] for k in occupied)+1)} if occupied else set()
    if (set(grid) != expected_grid or not set(actual) <= set(grid)
            or any(actual[k] != cell["selected"] for k, cell in grid.items())
            or sum(x["population"] for x in cells) != c["population"]
            or sum(x["selected"] for x in cells) != c["selected"]
            or c["target"] != 20 or c["selected"] != len(sizes) or len(sizes) != min(20, c["population"])
            or c["shortfall"] != 20-len(sizes) or c["occupied"] != len(occupied)
            or c["covered"] != len(actual) or c["uncovered"] != len(occupied)-len(actual)
            or len(actual) < min(8, len(occupied), c["population"])):
        raise ValueError("RECEIPT_SELECTION_CENSUS")
    for axis in (0, 1):
        for extreme in (min, max):
            limit = extreme(k[axis] for k in occupied)
            if not any(k[axis] == limit for k in actual):
                raise ValueError("RECEIPT_SELECTION_COVERAGE")
    return r


def validate_receipt(value: object, job: Job) -> dict:
    job = validate_job(job)
    r = closed(value, {"schema", "run_id", "job_sha256", "verdict", "entries", "controls", "selection", "digests"})
    if (r["schema"] not in ("polis-probe-receipt/1", "polis-probe-receipt/2") or r["run_id"] != job["run_id"] or
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
    if r["schema"] == "polis-probe-receipt/2":
        validate_selection(selection)
    elif selection is not None:
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
