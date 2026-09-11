"""Seeded representative selection inside the private snapshot box.

This module returns a counts-only report and a separate private identity map.
Whole extraction/admission is in fixture_samples. Raw rows and rank hashes must
never be logged.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import re
from typing import Any, Iterable, Sequence

VERSION = "representative-logpv/1"
TARGET = 20
SIZE_FIELDS = ("P", "V", "C", "U", "matrix_area", "registered_participants", "all_comments")
CELL_FIELDS = frozenset({"p_bin", "v_bin", "population", "selected"})
TOTAL_FIELDS = frozenset({"population", "target", "selected", "shortfall", "occupied", "covered", "uncovered", "cells"})


class SelectionError(ValueError):
    """A fixed error code, never an interpolated source value or row."""


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise SelectionError(code)


def _count(value: Any) -> bool:
    return type(value) is int and 0 <= value <= 2**63 - 1


def log_bin(count: int) -> int:
    _require(_count(count), "INVALID_COUNT")
    return len(str(count)) if count else 0


def validate_seed(seed: str) -> None:
    _require(type(seed) is str and re.fullmatch(r"[0-9a-f]{64}", seed) is not None,
             "INVALID_SEED")


def _rank(seed: str, kind: str, *values: int) -> bytes:
    message = json.dumps([VERSION, kind, *values], separators=(",", ":")).encode()
    return hmac.new(bytes.fromhex(seed), message, hashlib.sha256).digest()


def _population(rows: Sequence[dict[str, Any]]) -> dict[int, dict[str, int]]:
    population: dict[int, dict[str, int]] = {}
    for row in rows:
        _require(type(row) is dict, "INVALID_METRICS")
        zid = row.get("zid")
        _require(_count(zid) and zid not in population, "INVALID_IDENTITY_CENSUS")
        _require(all(_count(row.get(k)) for k in SIZE_FIELDS), "INVALID_METRICS")
        sizes = {k: row[k] for k in SIZE_FIELDS}
        _require(sizes["matrix_area"] == sizes["P"] * sizes["C"] and
                 sizes["U"] <= sizes["V"] and sizes["U"] <= sizes["matrix_area"] and
                 sizes["P"] <= sizes["U"] and sizes["C"] <= sizes["U"] and
                 ((sizes["V"] == 0) == (sizes["P"] == sizes["C"] == sizes["U"] == 0)),
                 "INCONSISTENT_METRICS")
        sizes.update(p_bin=log_bin(sizes["P"]), v_bin=log_bin(sizes["V"]))
        population[zid] = sizes
    return population


def _cell(sizes: dict[str, int]) -> tuple[int, int]:
    return sizes["p_bin"], sizes["v_bin"]


def _tails(cells: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    if not cells:
        return []
    return [{c for c in cells if c[axis] == extreme(c[axis] for c in cells)}
            for axis in (0, 1) for extreme in (min, max)]


def _check_selection(population: dict[int, dict[str, int]], selected: Sequence[int]) -> None:
    """Independent cardinality/coverage oracle, also applied to the allocator."""
    _require(len(selected) == min(TARGET, len(population)) and
             len(set(selected)) == len(selected) and all(z in population for z in selected),
             "SELECTION_CENSUS")
    cells = {_cell(s) for s in population.values()}
    chosen = {_cell(population[z]) for z in selected}
    _require(all(tail & chosen for tail in _tails(cells)), "TAIL_NOT_COVERED")
    _require(len(chosen) >= min(8, len(cells), len(population)), "CELL_COVERAGE")


def _allocate(cells: dict[tuple[int, int], list[int]], seed: str) -> dict[tuple[int, int], int]:
    quotas = dict.fromkeys(cells, 0)
    total = sum(map(len, cells.values()))
    if total < TARGET:
        return {c: len(ids) for c, ids in cells.items()}
    ranks = {c: (_rank(seed, "cell", *c), c) for c in cells}
    def largest(options: Iterable[tuple[int, int]]) -> tuple[int, int]:
        return min(options, key=lambda c: (-len(cells[c]), ranks[c]))
    for tail in _tails(set(cells)):
        if not any(quotas[c] for c in tail):
            quotas[largest(tail)] = 1
    while sum(q > 0 for q in quotas.values()) < min(8, len(cells), TARGET):
        quotas[largest(c for c in cells if not quotas[c])] = 1
    while sum(quotas.values()) < TARGET:
        available = [c for c in cells if quotas[c] < len(cells[c])]
        chosen = min(available, key=lambda c: (-(TARGET * len(cells[c]) - total * quotas[c]), ranks[c]))
        quotas[chosen] += 1
    return quotas


@dataclass(frozen=True)
class RepresentativeSelection:
    report: dict[str, Any]
    # Identity-bearing output is deliberately absent from repr/diagnostics.
    provenance: tuple[dict[str, int], ...] = field(repr=False)


def select_representative(rows: Sequence[dict[str, Any]], seed: str) -> RepresentativeSelection:
    validate_seed(seed)
    population = _population(rows)
    cells: dict[tuple[int, int], list[int]] = defaultdict(list)
    for zid, sizes in population.items():
        cells[_cell(sizes)].append(zid)
    quotas = _allocate(cells, seed)
    selected = [z for c in sorted(cells)
                for z in sorted(cells[c], key=lambda z: (_rank(seed, "conversation", z), z))[:quotas[c]]]
    _check_selection(population, selected)
    # Report order is numeric sizes only; no link to private ordinal or identity.
    sizes = sorted((dict(population[z]) for z in selected),
                   key=lambda s: tuple(s[k] for k in ("p_bin", "v_bin", *SIZE_FIELDS)))
    cell_rows = []
    if cells:
        for p_bin in range(max(c[0] for c in cells) + 1):
            for v_bin in range(max(c[1] for c in cells) + 1):
                c = (p_bin, v_bin)
                cell_rows.append(dict(p_bin=p_bin, v_bin=v_bin,
                                      population=len(cells.get(c, ())), selected=quotas.get(c, 0)))
    covered = sum(q > 0 for q in quotas.values())
    report = {"seed": seed, "bucket_counts": {
        "population": len(population), "target": TARGET, "selected": len(selected),
        "shortfall": TARGET-len(selected), "occupied": len(cells), "covered": covered,
        "uncovered": len(cells)-covered, "cells": cell_rows}, "chosen_entry_sizes": sizes}
    validate_report(report)
    private = tuple({"ordinal": i, "zid": z} for i, z in enumerate(selected, 1))
    return RepresentativeSelection(report, private)


def validate_report(report: dict[str, Any]) -> None:
    """Reject unknown fields/types before any report reaches stdout or a file."""
    _require(type(report) is dict and set(report) == {"seed", "bucket_counts", "chosen_entry_sizes"},
             "REPORT_FIELDS")
    validate_seed(report["seed"])
    counts, sizes = report["bucket_counts"], report["chosen_entry_sizes"]
    _require(type(counts) is dict and set(counts) == TOTAL_FIELDS, "REPORT_FIELDS")
    _require(all(_count(counts[k]) for k in TOTAL_FIELDS-{"cells"}), "REPORT_COUNT")
    cell_rows = counts["cells"]
    _require(type(cell_rows) is list and type(sizes) is list, "REPORT_FIELDS")
    seen = set()
    for row in cell_rows:
        _require(type(row) is dict and set(row) == CELL_FIELDS and
                 all(_count(v) for v in row.values()), "REPORT_CELL")
        c = _cell(row)
        _require(c not in seen and row["selected"] <= row["population"] and
                 max(c) <= 19, "REPORT_CELL")
        seen.add(c)
    for row in sizes:
        _require(type(row) is dict and set(row) == set(SIZE_FIELDS) | {"p_bin", "v_bin"} and
                 all(_count(v) for v in row.values()), "REPORT_SIZE")
        # Use the same numeric consistency checks without accepting an identity.
        checked = _population([dict(row, zid=0)])[0]
        _require(checked == row, "REPORT_SIZE")
    _require(cell_rows == sorted(cell_rows, key=_cell) and sizes == sorted(
        sizes, key=lambda s: tuple(s[k] for k in ("p_bin", "v_bin", *SIZE_FIELDS))), "REPORT_ORDER")
    actual = Counter(_cell(row) for row in sizes)
    _require(all(actual[_cell(row)] == row["selected"] for row in cell_rows) and
             set(actual) <= seen and sum(row["population"] for row in cell_rows) == counts["population"] and
             sum(row["selected"] for row in cell_rows) == counts["selected"] == len(sizes) and
             counts["target"] == TARGET and counts["selected"] == min(TARGET, counts["population"]) and
             counts["shortfall"] == TARGET-counts["selected"] and
             counts["occupied"] == sum(row["population"] > 0 for row in cell_rows) and
             counts["covered"] == len(actual) and counts["uncovered"] == counts["occupied"]-len(actual),
             "REPORT_CENSUS")
    occupied = {_cell(row) for row in cell_rows if row["population"]}
    _require(all(tail & set(actual) for tail in _tails(occupied)) and
             len(actual) >= min(8, len(occupied), counts["population"]), "REPORT_COVERAGE")
    expected = ({(p, v) for p in range(max(c[0] for c in occupied)+1)
                 for v in range(max(c[1] for c in occupied)+1)} if occupied else set())
    _require(seen == expected, "REPORT_CELL_GRID")
