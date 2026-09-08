#!/usr/bin/env python3
"""Wildcard inventory sweep for the ``votes`` / ``votes_latest_unique`` tables.

Projection-gate acceptance criterion 1 requires proving that NO response, export,
or report path selects these two tables with a wildcard beyond the known set — the
inventory must be produced and be empty, or every hit classified. This sweep scans
``server/src/**`` and ``delphi/**`` for:

  * ``SELECT * FROM votes`` / ``SELECT * FROM votes_latest_unique`` (any case);
  * node-sql builder wildcards ``sql_votes_latest_unique.star()`` (the only vote
    builder; ``sql_votes`` is commented out in db/sql.ts).

and emits a typed inventory: for each hit, the file:line, the table, whether its
columns reach the wire, and a classification:

  * ``GATED``        — a served wildcard the projection gate freezes;
  * ``INTERNAL-ONLY``— a wildcard whose columns are narrowed before any wire/export
                       (an added internal column does not directly escape here);
  * ``NEEDS-GATE``   — a wildcard NOT in the reviewed dispositions: an unreviewed
                       leak candidate. Its presence fails the inventory test.

Comments and Python docstrings are stripped before scanning (the real queries live
in string literals / builder calls, which survive; a ``SELECT *`` mentioned in a
docstring or ``//`` comment is not a query). The gate's own tooling files are
excluded (they contain example/reproduction SQL by design).

This is a static text sweep — it takes no database and makes no network call.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
from dataclasses import dataclass
from typing import Optional, Sequence

VOTE_TABLES = ("votes_latest_unique", "votes")

# A vote table, optionally schema-qualified and/or double-quoted:
#   votes | "votes" | public.votes | public."votes" | "public"."votes"
_TBL = r"(?:\"?public\"?\s*\.\s*)?\"?(votes_latest_unique|votes)\"?"
# `\s` (DOTALL) so a newline between SELECT and * is caught.
# Bare `SELECT * FROM [public.]votes` (not `SELECT * FROM (subquery)`; `count(*)`
# has no `select \*` before it, so it is not matched).
_SELECT_STAR_RE = re.compile(r"select\s+\*\s+from\s+" + _TBL, re.IGNORECASE | re.DOTALL)
# `SELECT alias.* FROM votes alias` / `SELECT votes.* FROM votes` — resolved via the
# alias->table map below (the alias may be a real alias OR the table name itself).
_ALIAS_STAR_RE = re.compile(r"\b(\w+)\s*\.\s*\*", re.IGNORECASE)
_FROM_ALIAS_RE = re.compile(
    r"\b(?:from|join)\s+" + _TBL + r"(?:\s+(?:as\s+)?(\w+))?", re.IGNORECASE | re.DOTALL
)
_SQL_KEYWORDS = {
    "where", "group", "order", "on", "left", "right", "inner", "outer", "join",
    "full", "cross", "using", "limit", "having", "union", "and", "or", "as",
}
# node-sql wildcard on the vlu builder.
_BUILDER_STAR_RE = re.compile(r"sql_votes_latest_unique\s*\.\s*star\s*\(")

_SCAN_EXTS = (".ts", ".js", ".mjs", ".py")
_EXCLUDE_DIRS = {"node_modules", "__pycache__", ".git", "dist", "build"}
# The gate's own tooling carries example/reproduction SQL — not product queries.
_EXCLUDE_FILES = {
    "projection_gate.py",
    "projection_gate_test.py",
    "projection_inventory.py",
    "projection_inventory_test.py",
    "projection-gate-witness.mjs",
}


@dataclass(frozen=True)
class WildcardSite:
    file: str          # repo-relative path
    line: int
    table: str
    kind: str          # "select-star" | "builder-star"
    symbol: str        # best-effort enclosing function / disposition symbol
    reaches_wire: bool
    classification: str  # GATED | INTERNAL-ONLY | NEEDS-GATE
    note: str


@dataclass(frozen=True)
class _Disposition:
    file_suffix: str   # repo-relative path suffix to match
    table: str
    signature: str     # case-insensitive substring that must appear on the hit line
    symbol: str
    reaches_wire: bool
    classification: str
    note: str


# Reviewed dispositions (agree with Astra's P-042-wildcard-inventory.md). A hit
# that matches none of these is reported NEEDS-GATE and fails the inventory test.
DISPOSITIONS: tuple[_Disposition, ...] = (
    _Disposition(
        "server/src/routes/votes.ts", "votes_latest_unique",
        "sql_votes_latest_unique.star()", "votesGet", True, "GATED",
        "star() -> handle_GET_votes -> finishArray; six frozen columns",
    ),
    _Disposition(
        "server/src/routes/votes.ts", "votes",
        "select * from votes where zid", "handle_GET_votes_me", True, "GATED",
        "adds weight, then finishArray; seven frozen columns",
    ),
    _Disposition(
        "server/src/server-helpers.ts", "votes",
        "select * from votes where zid", "getVotesForPids", False, "INTERNAL-ONLY",
        "aggregateVotesToPidVotesObj narrows to pid/tid/vote vectors; no direct escape",
    ),
    _Disposition(
        "server/src/comment.ts", "votes_latest_unique",
        "select * from votes_latest_unique where zid", "getNumberOfCommentsRemaining",
        False, "INTERNAL-ONLY",
        "CTE; final SELECT returns only remaining/total/pid counts",
    ),
)


def _blank_comments(text: str, line_token: str, allow_block: bool) -> str:
    """Blank comments while PRESERVING string literals (', ", `) and line numbers.

    A char scanner, not a regex, so a `//` inside a string (e.g. an ``https://``
    URL) is not mistaken for a comment (Astra round-3 defect 3). Comment characters
    are replaced by spaces; newlines are kept so offsets map to the right line.
    """
    out: list[str] = []
    i, n = 0, len(text)
    quote: Optional[str] = None
    while i < n:
        c = text[i]
        if quote is not None:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            quote = c
            out.append(c)
            i += 1
            continue
        if text.startswith(line_token, i):
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if allow_block and text.startswith("/*", i):
            while i < n and not text.startswith("*/", i):
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            if i < n:
                out.append("  ")
                i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _strip_ts_comments(text: str) -> str:
    return _blank_comments(text, "//", allow_block=True)


def _blank_python_noncode(path: str, text: str) -> str:
    """Blank Python docstrings (via ast) then ``#`` comments (string-aware). Real
    queries are argument strings (not docstrings), so they survive."""
    lines = text.splitlines()
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return _blank_comments(text, "#", allow_block=False)
    blanked: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(getattr(body[0], "value", None), ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                d = body[0]
                for ln in range(d.lineno, (d.end_lineno or d.lineno) + 1):
                    blanked.add(ln)
    kept = "\n".join("" if i in blanked else line for i, line in enumerate(lines, start=1))
    return _blank_comments(kept, "#", allow_block=False)


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _raw_at(text: str, offset: int) -> str:
    start = text.rfind("\n", 0, offset) + 1
    end = text.find("\n", offset)
    return text[start:end if end != -1 else len(text)].strip()


def _scan_text(rel: str, text: str) -> list[tuple[int, str, str, str]]:
    """Return (line_no, table, kind, raw_line) for each wildcard hit. Scans the
    whole (comment/docstring-stripped) text so MULTILINE, schema-qualified and
    aliased-star spellings are caught, not just a bare one-line form."""
    hits: list[tuple[int, str, str, str]] = []

    def add(offset: int, table: str, kind: str) -> None:
        hits.append((_line_of(text, offset), table.lower(), kind, _raw_at(text, offset)))

    for m in _SELECT_STAR_RE.finditer(text):
        add(m.start(), m.group(1), "select-star")
    for m in _BUILDER_STAR_RE.finditer(text):
        add(m.start(), "votes_latest_unique", "builder-star")

    # Aliased star: map both the table name itself and any alias to the table,
    # then find `<name>.*` (so `votes.*` and `v.*` both resolve).
    alias_table: dict[str, str] = {}
    for m in _FROM_ALIAS_RE.finditer(text):
        tbl = m.group(1).lower()
        alias_table[tbl] = tbl
        alias = m.group(2)
        if alias and alias.lower() not in _SQL_KEYWORDS:
            alias_table[alias] = tbl
    if alias_table:
        for m in _ALIAS_STAR_RE.finditer(text):
            table = alias_table.get(m.group(1))
            if table is not None:
                add(m.start(), table, "alias-star")

    # De-duplicate (an alias-star and a bare-star can coincide on odd inputs).
    seen: set[tuple[int, str, str]] = set()
    unique: list[tuple[int, str, str, str]] = []
    for line, table, kind, raw in sorted(hits):
        key = (line, table, kind)
        if key not in seen:
            seen.add(key)
            unique.append((line, table, kind, raw))
    return unique


def _classify(rel: str, line: int, table: str, kind: str, raw: str) -> WildcardSite:
    low = raw.lower()
    for d in DISPOSITIONS:
        if rel.endswith(d.file_suffix) and d.table == table and d.signature.lower() in low:
            return WildcardSite(rel, line, table, kind, d.symbol, d.reaches_wire,
                                d.classification, d.note)
    return WildcardSite(rel, line, table, kind, "?", True, "NEEDS-GATE",
                        "unreviewed wildcard over a vote table — classify and gate or narrow it")


def _iter_source_files(root: str) -> list[str]:
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDE_DIRS]
        for fn in filenames:
            if fn in _EXCLUDE_FILES or not fn.endswith(_SCAN_EXTS):
                continue
            found.append(os.path.join(dirpath, fn))
    return found


def _repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))  # delphi/scripts
    return os.path.abspath(os.path.join(here, "..", ".."))


class InventoryScanError(RuntimeError):
    """A requested scan root is missing/unreadable — an ungraded FAIL, never an
    empty-success proof (Astra round-2 defect 4)."""


def run_sweep(roots: Optional[Sequence[str]] = None, repo_root: Optional[str] = None) -> list[WildcardSite]:
    repo_root = repo_root or _repo_root()
    if roots is None:
        roots = [os.path.join(repo_root, "server", "src"), os.path.join(repo_root, "delphi")]
    sites: list[WildcardSite] = []
    for root in roots:
        if not os.path.isdir(root):
            raise InventoryScanError(f"scan root missing/unreadable: {root}")
        for path in _iter_source_files(root):
            rel = os.path.relpath(path, repo_root)
            try:
                text = open(path, encoding="utf-8", errors="replace").read()
            except OSError as exc:
                raise InventoryScanError(f"unreadable file {path}: {exc}") from exc
            if path.endswith(".py"):
                text = _blank_python_noncode(path, text)
            else:
                text = _strip_ts_comments(text)
            for line, table, kind, raw in _scan_text(rel, text):
                sites.append(_classify(rel, line, table, kind, raw))
    sites.sort(key=lambda s: (s.file, s.line))
    return sites


def format_report(sites: Sequence[WildcardSite]) -> str:
    rows = ["file:line | table | kind | wire | class | symbol"]
    for s in sites:
        rows.append(
            f"{s.file}:{s.line} | {s.table} | {s.kind} | "
            f"{'wire' if s.reaches_wire else 'internal'} | {s.classification} | {s.symbol}"
        )
    needs = [s for s in sites if s.classification == "NEEDS-GATE"]
    rows.append(f"TOTAL {len(sites)} site(s); NEEDS-GATE {len(needs)}")
    return "\n".join(rows)


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", action="append", default=None, help="scan root (repeatable)")
    args = p.parse_args(argv)
    sites = run_sweep(roots=args.root)
    print(format_report(sites))
    return 1 if any(s.classification == "NEEDS-GATE" for s in sites) else 0


if __name__ == "__main__":
    sys.exit(main())
