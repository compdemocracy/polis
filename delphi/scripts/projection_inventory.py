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
import glob
import hashlib
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

# ---------------------------------------------------------------------------
# The single source of truth for WHAT the sweep scans (repo-relative). Both
# run_sweep's default roots AND the Delphi CI copy step derive from this (via
# `python projection_inventory.py --print-scan-inputs`), so the set of files the
# scanner reads can never silently diverge from the set CI ships. Runtime /
# served-path source only — test/doc/notebook/real_data trees are not served and
# are deliberately excluded. Add a new served subtree here (never in the workflow).
SCAN_INPUT_DIRS: tuple[str, ...] = (
    "server/src",
    "delphi/polismath",
    "delphi/umap_narrative",
    "delphi/scripts",
)
# Top-level delphi runtime entry points (a glob, so a new one is auto-included).
SCAN_INPUT_GLOBS: tuple[str, ...] = ("delphi/*.py",)


def scan_inputs(repo_root: str) -> list[str]:
    """The repo-relative scan inputs (declared dirs + glob-expanded files)."""
    inputs = list(SCAN_INPUT_DIRS)
    for pattern in SCAN_INPUT_GLOBS:
        for match in sorted(glob.glob(os.path.join(repo_root, pattern))):
            rel = os.path.relpath(match, repo_root)
            if os.path.basename(rel) not in _EXCLUDE_FILES:
                inputs.append(rel)
    return inputs


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


# Reviewed dispositions (agree with the second reviewer's P-042-wildcard-inventory.md). A hit
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
    URL) is not mistaken for a comment (review round-3 defect 3). Comment characters
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
    a vote table. Rather than chase dataflow shapes, it pins a reviewed DIGEST of the
    guarding function's STRUCTURAL AST (``ast.dump`` — comments dropped,
    whitespace normalised) captured at review time, alongside the exact query text,
    the guard variable, and the fact that the guard set excludes every vote table.
    At scan time BOTH digests are recomputed. Any edit to the function (a moved/dead
    guard, a caught exception, a destructuring rewrite, a changed query) OR anywhere
    in the module (rebinding/augmenting the guard set, e.g. `EQUIV_TABLES +=
    ("votes",)`) changes a digest -> the exemption is stale and the hit is
    NEEDS-GATE. A whitespace-only or comment-only edit does not change either
    normalised digest."""

    file_suffix: str
    function_name: str       # the reviewed guarding function
    query_text: str          # exact decoded query the exemption covers
    guard_var: str           # the membership-guard variable, e.g. EQUIV_TABLES
    forbidden_tables: frozenset[str]  # exemption void if the guard set intersects these
    function_digest: str     # sha256 of ast.dump(function) at review time
    module_digest: str       # sha256 of ast.dump(module) at review time
    note: str


CLEARED_UNRESOLVED: tuple[ClearedUnresolved, ...] = (
    ClearedUnresolved(
        file_suffix="delphi/polismath/replay/equiv_query.py",
        function_name="fetch_math_row",
        query_text="SELECT * FROM {table} WHERE zid = :zid AND math_env = :math_env",
        guard_var="EQUIV_TABLES",
        forbidden_tables=frozenset({"votes", "votes_latest_unique"}),
        function_digest="048839c8fbbec1950c585b88303aace14c0daacac943f33e016e37d0168b3fbc",
        module_digest="193c083870237c567378d86dd1847598102c90a475f677fde63c832a1f4731ae",
        note="replay harness fetch_math_row; {table} guarded by `table not in "
        "EQUIV_TABLES` (math_main/bidtopid/ptptstats) — never a vote table. "
        "Query + guard set isolated into delphi/polismath/replay/equiv_query.py "
        "(P-042 projgate-isolation; per the second reviewer's board [499]) so the whole-module pin "
        "is disturbed only by an edit to the query/guard, not by unrelated edits to "
        "poller_equiv.py. Function digest UNCHANGED across the verbatim move "
        "(048839c8…); module digest recorded against the new isolated module; "
        "structural re-review (guard set, single occurrence, enclosing fn, "
        "guard-flow) passed.",
    ),
)

STALE_EXEMPTION_NOTE = "exemption evidence stale: re-review"

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


def _joinedstr_text(node: "ast.JoinedStr") -> tuple[Optional[str], Optional[str]]:
    """Reconstruct an f-string to `...{name}...` text plus the single interpolated
    Name (or None if it interpolates zero/multiple values or a non-Name)."""
    parts: list[str] = []
    qvars: list[Optional[str]] = []
    for v in node.values:
        if isinstance(v, ast.Constant) and isinstance(v.value, str):
            parts.append(v.value)
        elif isinstance(v, ast.FormattedValue):
            if isinstance(v.value, ast.Name):
                parts.append("{" + v.value.id + "}")
                qvars.append(v.value.id)
            else:
                parts.append("{?}")
                qvars.append(None)
        else:
            return None, None
    qvar = qvars[0] if len(qvars) == 1 and qvars[0] is not None else None
    return "".join(parts), qvar


def _guard_set_ok(tree: ast.AST, entry: ClearedUnresolved) -> bool:
    """The guard set must be a LITERAL tuple/list/set of string constants only, with
    no vote table. A non-literal element (e.g. a Name) voids the exemption."""
    found = False
    for n in ast.walk(tree):
        targets = (n.targets if isinstance(n, ast.Assign)
                   else [n.target] if isinstance(n, ast.AnnAssign) else [])
        if not any(isinstance(t, ast.Name) and t.id == entry.guard_var for t in targets):
            continue
        found = True
        val = getattr(n, "value", None)
        if not isinstance(val, (ast.Tuple, ast.List, ast.Set)):
            return False
        vals: list[str] = []
        for e in val.elts:
            if not (isinstance(e, ast.Constant) and isinstance(e.value, str)):
                return False  # dynamic / non-literal member
            vals.append(e.value)
        if set(vals) & entry.forbidden_tables:
            return False
    return found


def _enclosing_function(tree: ast.AST, node: ast.AST):
    best = None
    for fn in ast.walk(tree):
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and node in set(ast.walk(fn)):
            best = fn
    return best


def _guard_flow_ok(fn: ast.AST, qvar: str, guard_var: str, query_node: ast.AST) -> bool:
    """The query variable must be guarded by `if <qvar> not in <guard_var>: raise`
    BEFORE the query, with NO write (assign/augment/annotate/del) to <qvar> between
    the guard and the query."""
    q_line = getattr(query_node, "lineno", None)
    if q_line is None:
        return False
    guard_line = None
    for node in ast.walk(fn):
        if isinstance(node, ast.If) and isinstance(node.test, ast.Compare):
            t = node.test
            if (
                isinstance(t.left, ast.Name) and t.left.id == qvar
                and len(t.ops) == 1 and isinstance(t.ops[0], ast.NotIn)
                and len(t.comparators) == 1 and isinstance(t.comparators[0], ast.Name)
                and t.comparators[0].id == guard_var
                and any(isinstance(s, ast.Raise) for s in ast.walk(node))
                and node.lineno < q_line
            ):
                guard_line = node.lineno if guard_line is None else max(guard_line, node.lineno)
    if guard_line is None:
        return False
    # No rewrite of qvar between the guard and the query.
    for node in ast.walk(fn):
        targets: list[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets = [node.target]
        elif isinstance(node, ast.Delete):
            targets = list(node.targets)
        for t in targets:
            if isinstance(t, ast.Name) and t.id == qvar and guard_line < getattr(node, "lineno", -1) <= q_line:
                return False
    return True


def _normalised_digest(node: ast.AST) -> str:
    """sha256 of the node's STRUCTURAL AST dump (``ast.dump`` with field names, no
    line/col attributes). Comments and whitespace are absent from the AST, so a
    formatter/comment edit does not change it, while any structural change does.
    Unlike ``ast.unparse`` (whose f-string quoting differs across CPython 3.12.x
    patch releases — an unstable digest), ``ast.dump`` records only structure and
    string VALUES, so the digest is stable across interpreters."""
    return hashlib.sha256(
        ast.dump(node, annotate_fields=True, include_attributes=False).encode("utf-8")
    ).hexdigest()


def _exemption_status(rel: str, kind: str, raw: str, source: str) -> str:
    """Return 'cleared', 'stale', or 'none' for an unresolved hit against the
    reviewed exemptions. 'stale' means an exemption covers this file+query but its
    pinned safety evidence no longer holds (-> NEEDS-GATE, re-review)."""
    if kind != "unresolved-table":
        return "none"
    for entry in CLEARED_UNRESOLVED:
        if not rel.endswith(entry.file_suffix) or raw.strip() != entry.query_text:
            continue
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return "stale"
        # Pinned digest of the WHOLE module (binds the external guard-set definition
        # and any rebinding/augmentation of it, e.g. `EQUIV_TABLES += ("votes",)`).
        if _normalised_digest(tree) != entry.module_digest:
            return "stale"
        # Module-level guard set must be a literal tuple/set with no vote table.
        if not _guard_set_ok(tree, entry):
            return "stale"
        # Exactly one AST occurrence of the query, interpolating one Name.
        occ = []
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                text, qvar = _joinedstr_text(node)
                if text == entry.query_text:
                    occ.append((node, qvar))
        if len(occ) != 1:
            return "stale"
        node, qvar = occ[0]
        if qvar is None:
            return "stale"
        fn = _enclosing_function(tree, node)
        if fn is None or getattr(fn, "name", None) != entry.function_name:
            return "stale"
        # Pinned digest of the guarding function's normalised source (catches dead
        # guards, caught exceptions, destructuring, etc.).
        if _normalised_digest(fn) != entry.function_digest:
            return "stale"
        # Straight-line structural checks retained as belt-and-suspenders.
        if not _guard_flow_ok(fn, qvar, entry.guard_var, node):
            return "stale"
        return "cleared"
    return "none"


def _classify(rel: str, line: int, table: str, kind: str, raw: str,
              note_override: Optional[str] = None) -> WildcardSite:
    low = raw.lower()
    for d in DISPOSITIONS:
        if rel.endswith(d.file_suffix) and d.table == table and d.signature.lower() in low:
            return WildcardSite(rel, line, table, kind, d.symbol, d.reaches_wire,
                                d.classification, d.note)
    note = ("unresolved wildcard table (template/variable/concatenation) — review it"
            if kind == "unresolved-table"
            else "unreviewed wildcard over a vote table — classify and gate or narrow it")
    return WildcardSite(rel, line, table, kind, "?", True, "NEEDS-GATE", note_override or note)


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
    empty-success proof (review round-2 defect 4)."""


def run_sweep(roots: Optional[Sequence[str]] = None, repo_root: Optional[str] = None) -> list[WildcardSite]:
    repo_root = repo_root or _repo_root()
    if roots is None:
        roots = [os.path.join(repo_root, p) for p in scan_inputs(repo_root)]
    # Each root is a directory (walked) or a single file (scanned directly). A
    # declared input that is missing is a hard error, never an empty-success proof.
    paths: list[str] = []
    for root in roots:
        if os.path.isdir(root):
            paths.extend(_iter_source_files(root))
        elif os.path.isfile(root):
            paths.append(root)
        else:
            raise InventoryScanError(f"scan input missing/unreadable: {root}")
    sites: list[WildcardSite] = []
    for path in paths:
        rel = os.path.relpath(path, repo_root)
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                original = fh.read()
        except OSError as exc:
            raise InventoryScanError(f"unreadable file {path}: {exc}") from exc
        is_py = path.endswith(".py")
        text = _blank_python_docstrings(original) if is_py else original
        for line, table, kind, raw in _scan_text(rel, text, is_ts=not is_py):
            status = _exemption_status(rel, kind, raw, original)
            if status == "cleared":
                continue  # reviewed non-vote interpolation; digest + checks re-verified
            override = STALE_EXEMPTION_NOTE if status == "stale" else None
            sites.append(_classify(rel, line, table, kind, raw, note_override=override))
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
    p.add_argument("--repo-root", default=None, help="repo root the scan inputs resolve against")
    p.add_argument("--print-scan-inputs", action="store_true",
                   help="print the repo-relative scan inputs (one per line) and exit; the "
                        "Delphi CI copy step derives from this so it can never diverge")
    args = p.parse_args(argv)
    repo_root = args.repo_root or _repo_root()
    if args.print_scan_inputs:
        for rel in scan_inputs(repo_root):
            print(rel)
        return 0
    sites = run_sweep(roots=args.root, repo_root=repo_root)
    print(format_report(sites))
    return 1 if any(s.classification == "NEEDS-GATE" for s in sites) else 0


if __name__ == "__main__":
    sys.exit(main())
