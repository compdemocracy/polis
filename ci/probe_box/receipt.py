"""The only private export: bounded numeric observations and fixed verdicts.

No file copying, field names from a dataset, paths, IDs, raw blob values, logs or
free text are accepted. Entry positions follow the digest-bound run inventory.
Optional named legacy defects use fixed public keys and one exact timestamp pair.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter

from contracts import Job, validate_job


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


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


# Union of the committed empty schedule's constant and moderation omissions.
# This boundary deliberately has no engine imports or runtime recipe loading.
LEGACY_EMPTY_KEYS = frozenset({
    "consensus", "group-aware-consensus", "group-clusters", "group-votes",
    "in-conv", "mod-in", "mod-out", "n", "n-cmts", "pca.center",
    "pca.comment-extremity", "pca.comment-projection", "tids",
    "user-vote-counts", "votes-base",
})


def validate_legacy_defects(value: object) -> list:
    """Closed, bounded observations; never serialize arbitrary comparer data."""
    if type(value) is not list or len(value) != 1:
        raise ValueError("RECEIPT_LEGACY_DEFECT")
    for defect in value:
        if type(defect) is not dict:
            raise ValueError("RECEIPT_LEGACY_DEFECT")
        if defect.get("name") != "legacy-defect-empty-omits-keys":
            raise ValueError("RECEIPT_LEGACY_DEFECT")
        closed(defect, {"name", "keys"})
        keys = defect["keys"]
        if (type(keys) is not list or not 1 <= len(keys) <= len(LEGACY_EMPTY_KEYS)
                or any(type(key) is not str or key not in LEGACY_EMPTY_KEYS for key in keys)
                or keys != sorted(set(keys))):
            raise ValueError("RECEIPT_LEGACY_DEFECT")
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


DIAGNOSTIC_FAMILIES = ("projection", "clusters", "repness", "moderation", "meta")
DIAGNOSTIC_KINDS = ("numeric-tolerance", "strict-tolerance", "exact-value", "shape", "nonfinite")
DIAGNOSTIC_MAGNITUDES = ("over1-to2", "over2-to10", "over10", "not-applicable")
RECIPE_TOKENS = frozenset({
    "sample-uniform6", "large-r16-uniform6", "large-r8-uniform8", "large-r4-uniform8",
    "large-r2-uniform8", "large-r1-uniform6", "revote-uniform6", "banned-uniform6",
    "smallmix-uniform6", "midmix-uniform6", "zero-empty", "modheavy-single", "meta-single",
    "midmix-restart3", "meta-uniform6", "public-vw-uniform8", "public-vw-front6",
    "public-vw-single", "public-biodiversity-uniform8", "public-vw-every56", "public-vw-restart4",
})


def validate_diagnostics(entry):
    if type(entry["recipe"]) is not str or entry["recipe"] not in RECIPE_TOKENS:
        raise ValueError("RECEIPT_RECIPE")
    rows, truncated = entry["diagnostics"], entry["diagnostics_truncated"]
    if type(rows) is not list or len(rows) > 8 or type(truncated) is not bool:
        raise ValueError("RECEIPT_DIAGNOSTICS")
    if (entry["verdict"] not in ("PASS", "FAIL") or not entry["checks"]
            or bool(rows) != (entry["verdict"] == "FAIL") or (truncated and not rows)):
        raise ValueError("RECEIPT_DIAGNOSTICS")
    keys = []
    for row in rows:
        d = closed(row, {"checkpoint", "family", "kind", "magnitude"})
        c, f, k, m = (d[x] for x in ("checkpoint", "family", "kind", "magnitude"))
        if (type(c) is not int or not 0 <= c < entry["checks"]
                or f not in DIAGNOSTIC_FAMILIES or k not in DIAGNOSTIC_KINDS
                or m not in DIAGNOSTIC_MAGNITUDES
                or ((k == "numeric-tolerance") != (m != "not-applicable"))):
            raise ValueError("RECEIPT_DIAGNOSTICS")
        keys.append((c, DIAGNOSTIC_FAMILIES.index(f), DIAGNOSTIC_KINDS.index(k), DIAGNOSTIC_MAGNITUDES.index(m)))
    if keys != sorted(set(keys)):
        raise ValueError("RECEIPT_DIAGNOSTICS")


def validate_receipt(value: object, job: Job) -> dict:
    job = validate_job(job)
    if job["schema"] == "polis-probe-job/2":
        from roles_census import validate_receipt as validate_census_receipt
        return validate_census_receipt(value, job)
    r = closed(value, {"schema", "run_id", "job_sha256", "verdict", "entries", "controls", "selection", "digests"})
    if (r["schema"] not in ("polis-probe-receipt/1", "polis-probe-receipt/2", "polis-probe-receipt/3") or r["run_id"] != job["run_id"] or
            r["job_sha256"] != sha(job) or r["verdict"] not in ("PASS", "FAIL", "INCOMPLETE")):
        raise ValueError("RECEIPT_BINDING")
    if type(r["entries"]) is not list or not 1 <= len(r["entries"]) <= 256:
        raise ValueError("RECEIPT_ENTRIES")
    v3 = r["schema"] == "polis-probe-receipt/3"
    diagnostic_fields = {"recipe", "diagnostics", "diagnostics_truncated"} if v3 else set()
    for entry in r["entries"]:
        optional = {"legacy_defects"} if type(entry) is dict and "legacy_defects" in entry else set()
        e = closed(entry, {"verdict", "checks", "worst_absolute", "worst_relative", "outliers", "nonfinite"} | optional | diagnostic_fields)
        if optional:
            validate_legacy_defects(e["legacy_defects"])
        if e["verdict"] not in ("PASS", "FAIL", "INCOMPLETE"):
            raise ValueError("RECEIPT_VERDICT")
        for key in ("checks", "outliers", "nonfinite"):
            count(e[key])
        for key in ("worst_absolute", "worst_relative"):
            finite(e[key])
        if e["verdict"] == "PASS" and (not e["checks"] or e["outliers"] or e["nonfinite"]):
            raise ValueError("RECEIPT_FALSE_PASS")
        if v3:
            validate_diagnostics(e)
    if v3 and sum(len(e["diagnostics"]) for e in r["entries"]) > 256:
        raise ValueError("RECEIPT_DIAGNOSTICS_LIMIT")
    if v3 and sum(len(e["diagnostics"]) for e in r["entries"]) < 256:
        if any(e["diagnostics_truncated"] and len(e["diagnostics"]) < 8 for e in r["entries"]):
            raise ValueError("RECEIPT_DIAGNOSTICS_TRUNCATION")
    controls = closed(r["controls"], {"passed", "expected"})
    count(controls["passed"]); count(controls["expected"])
    if not controls["expected"] or controls["passed"] > controls["expected"]:
        raise ValueError("RECEIPT_CONTROLS")
    if r["verdict"] == "PASS" and (any(e["verdict"] != "PASS" for e in r["entries"]) or
            controls["passed"] != controls["expected"]):
        raise ValueError("RECEIPT_FALSE_PASS")
    all_pass = (all(e["verdict"] == "PASS" for e in r["entries"])
                and controls["passed"] == controls["expected"])
    if v3 and r["verdict"] != ("PASS" if all_pass else "FAIL"):
        raise ValueError("RECEIPT_FALSE_PASS")
    selection = r["selection"]
    if v3 and selection is not None:
        selected = closed(selection, {"seed", "seed_source", "bucket_counts", "chosen_entry_sizes"})
        if selected["seed_source"] not in ("config", "run-id"):
            raise ValueError("RECEIPT_SELECTION_SEED_SOURCE")
        validate_selection({k: v for k, v in selected.items() if k != "seed_source"})
        expected_seed = job.get("representative_selection", {
            "seed_source": "run-id",
            "seed": hashlib.sha256(job["run_id"].encode("ascii")).hexdigest(),
        })
        if any(selected[key] != expected_seed[key] for key in ("seed_source", "seed")):
            raise ValueError("RECEIPT_SELECTION_SEED_BINDING")
    elif r["schema"] == "polis-probe-receipt/2":
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


def receipt_limit(job: Job) -> int:
    # Closed dispatch; a receipt cannot choose its own export allowance.
    job = validate_job(job)
    return {"polis-probe-job/1":131072,"polis-probe-job/2":131072}[job["schema"]]


def decode_json(raw: bytes):
    if len(raw)>131072:raise ValueError("RECEIPT_LIMIT")
    def pairs(items):
        out={}
        for k,v in items:
            if k in out:raise ValueError("RECEIPT_DUPLICATE_KEY")
            out[k]=v
        return out
    def constant(_):raise ValueError("RECEIPT_NONFINITE")
    try:
        result=json.loads(raw,object_pairs_hook=pairs,parse_constant=constant)
    except (UnicodeError,json.JSONDecodeError,RecursionError):
        raise ValueError("RECEIPT_JSON") from None
    pending=[(result,0)]
    while pending:
        v,depth=pending.pop()
        if depth>16:raise ValueError("RECEIPT_DEPTH")
        if type(v) is dict:pending.extend((x,depth+1) for x in v.values())
        elif type(v) is list:pending.extend((x,depth+1) for x in v)
    return result


def decode_receipt(raw: bytes, job: Job) -> dict:
    if len(raw)>receipt_limit(job):raise ValueError("RECEIPT_LIMIT")
    try:return validate_receipt(decode_json(raw),job)
    except (KeyError,TypeError,OverflowError,UnicodeError,RecursionError):
        raise ValueError("RECEIPT_SCHEMA") from None
