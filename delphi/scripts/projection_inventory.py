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
# `\b` after the name keeps `voters` from matching `votes`; a closing quote is
# allowed after it. These run on DECODED string-literal contents, so escaped
# source quotes have already been unescaped.
_TBL = r'(?:"?public"?\s*\.\s*)?"?(votes_latest_unique|votes)\b"?'
# `\s` (DOTALL) so a newline between SELECT and * is caught.
_SELECT_STAR_RE = re.compile(r"select\s+\*\s+from\s+" + _TBL, re.IGNORECASE | re.DOTALL)
# `SELECT alias.* FROM votes alias` / `SELECT votes.* FROM votes` — qualifier may be
# quoted; resolved via the alias->table map (alias, or the table name itself).
_ALIAS_STAR_RE = re.compile(r'"?(\w+)"?\s*\.\s*\*', re.IGNORECASE)
_FROM_ALIAS_RE = re.compile(
    r'\b(?:from|join)\s+' + _TBL + r'(?:\s+(?:as\s+)?"?(\w+)"?)?', re.IGNORECASE | re.DOTALL
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


def _blank_python_docstrings(text: str) -> str:
    """Blank module/class/function docstrings (via ast), keeping line numbers.
    ``#`` comments need no separate pass: the literal extractor ignores comments,
    so a `SELECT *` in a comment is never scanned."""
    lines = text.splitlines()
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return text
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
    return "\n".join("" if i in blanked else line for i, line in enumerate(lines, start=1))


_ESCAPES = {"n": " ", "t": " ", "r": " ", "b": " ", "f": " ", "v": " ", "0": " ", "a": " "}


def _decode_escape(text: str, i: int) -> tuple[str, int]:
    """Decode the escape sequence at text[i]=='\\'; return (decoded_str, new_i).
    Handles \\uXXXX, \\u{...}, \\xXX (unicode/hex), whitespace escapes -> space,
    and \\<char> -> <char>."""
    n = len(text)
    esc = text[i + 1] if i + 1 < n else ""
    if esc == "u" and i + 2 < n and text[i + 2] == "{":
        j = text.find("}", i + 3)
        if j != -1:
            try:
                return chr(int(text[i + 3:j], 16)), j + 1
            except ValueError:
                pass
        return "u", i + 2
    if esc == "u" and i + 6 <= n:
        try:
            return chr(int(text[i + 2:i + 6], 16)), i + 6
        except ValueError:
            pass
    if esc == "x" and i + 4 <= n:
        try:
            return chr(int(text[i + 2:i + 4], 16)), i + 4
        except ValueError:
            pass
    return _ESCAPES.get(esc, esc), i + 2


def _extract_string_literals(text: str, is_py: bool) -> list[tuple[int, str]]:
    """Yield (start_line, DECODED content) for each ', " or ` string/template
    literal, skipping comments. Comment syntax is PER LANGUAGE — ``#`` for Python,
    ``//``/``/* */`` for JS/TS — so a Python ``//`` (floor division) is never a
    comment. Escapes (``\\"``, ``\\uXXXX``, ``\\xXX``) are decoded so quoted and
    unicode/hex-escaped SQL identifiers are matchable. Comments are not literals, so
    a ``SELECT *`` in a comment is never returned."""
    out: list[tuple[int, str]] = []
    i, n, line = 0, len(text), 1
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if is_py:
            comment_here = c == "#"
        else:
            comment_here = text.startswith("//", i)
        if comment_here:
            while i < n and text[i] != "\n":
                i += 1
            continue
        if not is_py and text.startswith("/*", i):
            i += 2
            while i < n and not text.startswith("*/", i):
                if text[i] == "\n":
                    line += 1
                i += 1
            i += 2
            continue
        if c in ("'", '"', "`"):
            quote = c
            start_line = line
            i += 1
            buf: list[str] = []
            while i < n:
                d = text[i]
                if d == "\\" and i + 1 < n:
                    if text[i + 1] == "\n":
                        line += 1
                    decoded, i = _decode_escape(text, i)
                    buf.append(decoded)
                    continue
                if d == quote:
                    i += 1
                    break
                if d == "\n":
                    line += 1
                buf.append(d)
                i += 1
            out.append((start_line, "".join(buf)))
            continue
        i += 1
    return out


# A wildcard SELECT whose FROM target is not a bare identifier we can resolve.
UNRESOLVED = "<unresolved-table>"


@dataclass(frozen=True)
class ClearedUnresolved:
    """A reviewed exemption for one interpolated wildcard proven never to resolve to
    a vote table. It is bound to its actual safety EVIDENCE — the exact query text,
    the guard variable, and the fact that the guard set excludes every vote table —
    all re-verified from source at scan time. A second/changed query, a guard set
    that admits a vote table, or a removed guard therefore fails the exemption."""

    file_suffix: str
    query_text: str          # exact decoded query the exemption covers
    guard_var: str           # the membership-guard variable, e.g. EQUIV_TABLES
    forbidden_tables: frozenset[str]  # exemption void if the guard set intersects these
    note: str


CLEARED_UNRESOLVED: tuple[ClearedUnresolved, ...] = (
    ClearedUnresolved(
        file_suffix="delphi/polismath/replay/poller_equiv.py",
        query_text="SELECT * FROM {table} WHERE zid = :zid AND math_env = :math_env",
        guard_var="EQUIV_TABLES",
        forbidden_tables=frozenset({"votes", "votes_latest_unique"}),
        note="replay harness fetch_math_row; {table} guarded by `table not in "
        "EQUIV_TABLES` (math_main/bidtopid/ptptstats) — never a vote table",
    ),
)

# One `SELECT <projection-list> FROM <target>` segment.
_SELECT_FROM_SEG_RE = re.compile(r"\bselect\b(.*?)\bfrom\b\s*", re.IGNORECASE | re.DOTALL)
# A qualified star anywhere in a projection list: v.*, "v".*, ${a}.*, {a}.*.
_QUAL_STAR_RE = re.compile(r'(?:"[^"]*"|\$\{[^}]*\}|\{[^}]*\}|\w+)\s*\.\s*\*')
# A bare `*` that is a projection item (not `count(*)`).
_BARE_STAR_ITEM_RE = re.compile(r"(?:^|,)\s*\*\s*(?:,|$)")
# An INTERPOLATED qualifier before `.*`.
_INTERP_QUAL_RE = re.compile(r'(?:\$\{[^}]*\}|\{[^}]*\})\s*\.\s*\*')
# Interpolation markers: ${...} / {...} (f-string, .format), %s/%d/%(name)s.
_INTERP_RE = re.compile(r"\$\{|\{|%s|%d|%\(")
_PLAIN_TABLE_RE = re.compile(r'"?[A-Za-z_][\w.\"]*"?$')


def _proj_has_wildcard(proj: str) -> bool:
    return bool(_QUAL_STAR_RE.search(proj)) or bool(_BARE_STAR_ITEM_RE.search(proj.strip()))


def _from_target(after: str) -> str:
    """The FROM target token (up to whitespace / , ; ) )."""
    after = after.lstrip()
    if not after:
        return ""
    if after[0] == "(":
        return "("
    m = re.match(r"[^\s,;)]+", after)
    return m.group(0) if m else ""


def _target_is_unresolved(target: str) -> bool:
    if target == "":
        return True  # dangling concatenation tail (`"... FROM " + x`)
    if target == "(":
        return False  # subquery over a derived table, not a table wildcard
    if re.match(r'"?[A-Za-z_][\w."]*\(', target):
        return False  # a table function (e.g. get_visible_comments($1)) — like a subquery
    if _INTERP_RE.search(target):
        return True  # template / f-string / %-format interpolation
    if re.match(_TBL, target, re.IGNORECASE):
        return False  # a recognizable vote table (already added by _SELECT_STAR_RE)
    if _PLAIN_TABLE_RE.match(target):
        return False  # a resolvable non-vote table (e.g. comments)
    return True  # anything else -> conservatively unresolved


def _sql_hits_in(content: str) -> list[tuple[str, str]]:
    """(table, kind) wildcard hits in one DECODED SQL string. A wildcard SELECT
    whose table/qualifier/schema-qualified target contains an interpolation
    (`${}`, f-string `{}`, `%s`, concatenation) is UNRESOLVED and reported
    NEEDS-GATE rather than silently cleared."""
    hits: list[tuple[str, str]] = []
    for m in _SELECT_STAR_RE.finditer(content):
        hits.append((m.group(1).lower(), "select-star"))

    # Scan each `SELECT <list> FROM <target>` segment: a wildcard item ANYWHERE in
    # the projection list (not only a leading `*`/`<q>.*`) is unresolved when its
    # qualifier is interpolated or the FROM target is unresolvable.
    for m in _SELECT_FROM_SEG_RE.finditer(content):
        proj = m.group(1)
        if not _proj_has_wildcard(proj):
            continue
        if _INTERP_QUAL_RE.search(proj) or _target_is_unresolved(_from_target(content[m.end():])):
            hits.append((UNRESOLVED, "unresolved-table"))

    alias_table: dict[str, str] = {}
    for m in _FROM_ALIAS_RE.finditer(content):
        tbl = m.group(1).lower()
        alias_table[tbl] = tbl
        alias = m.group(2)
        if alias and alias.lower() not in _SQL_KEYWORDS:
            alias_table[alias.lower()] = tbl
    if alias_table:
        for m in _ALIAS_STAR_RE.finditer(content):
            table = alias_table.get(m.group(1).lower())
            if table is not None:
                hits.append((table, "alias-star"))
    return hits


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _scan_text(rel: str, text: str, is_ts: bool) -> list[tuple[int, str, str, str]]:
    """Return (line_no, table, kind, raw) for each wildcard hit. SQL is matched on
    DECODED string-literal contents (so quoted/escaped spellings resolve); the
    node-sql ``.star()`` builder is matched in comment-stripped code (TS only)."""
    hits: list[tuple[int, str, str, str]] = []

    for start_line, content in _extract_string_literals(text, is_py=not is_ts):
        for table, kind in _sql_hits_in(content):
            hits.append((start_line, table, kind, content.strip()[:200]))

    if is_ts:
        code = _blank_comments(text, "//", allow_block=True)
        for m in _BUILDER_STAR_RE.finditer(code):
            line = _line_of(code, m.start())
            raw = code[code.rfind("\n", 0, m.start()) + 1:code.find("\n", m.start())].strip()
            hits.append((line, "votes_latest_unique", "builder-star", raw))

    seen: set[tuple[int, str, str]] = set()
    unique: list[tuple[int, str, str, str]] = []
    for line, table, kind, raw in sorted(hits):
        key = (line, table, kind)
        if key not in seen:
            seen.add(key)
            unique.append((line, table, kind, raw))
    return unique


def _has_membership_guard(fn: ast.AST, var: str) -> bool:
    """The function guards `if <x> not in <var>: raise ...` (in any nested block)."""
    for node in ast.walk(fn):
        if isinstance(node, ast.If) and isinstance(node.test, ast.Compare):
            has_not_in = any(isinstance(op, ast.NotIn) for op in node.test.ops)
            names = [c.id for c in node.test.comparators if isinstance(c, ast.Name)]
            if has_not_in and var in names and any(
                isinstance(s, ast.Raise) for s in ast.walk(node)
            ):
                return True
    return False


def _is_cleared_unresolved(rel: str, kind: str, raw: str, source: str) -> bool:
    """Clear an unresolved hit ONLY if a reviewed exemption's evidence still holds in
    `source`: exact query text, a guard set (parsed) that excludes every vote table,
    and a membership guard in the function that contains the query."""
    if kind != "unresolved-table":
        return False
    for entry in CLEARED_UNRESOLVED:
        if not rel.endswith(entry.file_suffix):
            continue
        if raw.strip() != entry.query_text:
            continue  # a different/changed query is not covered
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return False
        # Guard set must exclude every vote table.
        allowed: Optional[set[str]] = None
        for node in ast.walk(tree):
            targets = (node.targets if isinstance(node, ast.Assign)
                       else [node.target] if isinstance(node, ast.AnnAssign) else [])
            for t in targets:
                if isinstance(t, ast.Name) and t.id == entry.guard_var:
                    val = node.value
                    if isinstance(val, (ast.Tuple, ast.List, ast.Set)):
                        allowed = {e.value for e in val.elts
                                   if isinstance(e, ast.Constant) and isinstance(e.value, str)}
        if allowed is None or (allowed & entry.forbidden_tables):
            return False
        # The function containing the query must guard on the same variable.
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                seg = ast.get_source_segment(source, fn) or ""
                if entry.query_text in seg and _has_membership_guard(fn, entry.guard_var):
                    return True
        return False
    return False


def _classify(rel: str, line: int, table: str, kind: str, raw: str) -> WildcardSite:
    low = raw.lower()
    for d in DISPOSITIONS:
        if rel.endswith(d.file_suffix) and d.table == table and d.signature.lower() in low:
            return WildcardSite(rel, line, table, kind, d.symbol, d.reaches_wire,
                                d.classification, d.note)
    note = ("unresolved wildcard table (template/variable/concatenation) — review it"
            if kind == "unresolved-table"
            else "unreviewed wildcard over a vote table — classify and gate or narrow it")
    return WildcardSite(rel, line, table, kind, "?", True, "NEEDS-GATE", note)


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
                with open(path, encoding="utf-8", errors="replace") as fh:
                    original = fh.read()
            except OSError as exc:
                raise InventoryScanError(f"unreadable file {path}: {exc}") from exc
            is_py = path.endswith(".py")
            text = _blank_python_docstrings(original) if is_py else original
            for line, table, kind, raw in _scan_text(rel, text, is_ts=not is_py):
                if _is_cleared_unresolved(rel, kind, raw, original):
                    continue  # reviewed non-vote interpolation, guard re-verified from source
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
