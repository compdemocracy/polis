"""Tests for the vote-table wildcard inventory sweep.

Asserts the inventory over ``server/src/**`` and ``delphi/**`` is EXACTLY the
reviewed set of four sites, so any new wildcard over ``votes`` /
``votes_latest_unique`` is reported NEEDS-GATE and fails CI. No database needed.
"""

from __future__ import annotations

import os
import sys

import pytest

# delphi/scripts is put on sys.path by conftest.py (the checkout locator); the
# implementation lives there, this test lives under delphi/tests/scripts so the
# Delphi CI job collects it. The import fails closed to a per-test skip ONLY when
# the implementation MODULE itself is absent (no checkout on sys.path); any other
# import-time failure — a missing dependency, a syntax error, a RuntimeError in a
# LOCATED implementation — propagates as a test ERROR, not a green skip.
try:
    import projection_inventory as inv  # noqa: E402
except ModuleNotFoundError as _import_error:  # pragma: no cover - CI layout only
    if _import_error.name != "projection_inventory":
        raise
    inv = None  # type: ignore[assignment]
    _INV_SKIP = (
        "projection_inventory not found on sys.path (no polis checkout — see conftest); "
        "set POLIS_CHECKOUT_DIR to run these tests"
    )
else:
    _INV_SKIP = None

if _INV_SKIP:
    pytestmark = pytest.mark.skip(reason=_INV_SKIP)

# The reviewed inventory: (file, line-independent) table + classification + symbol.
EXPECTED = {
    ("server/src/routes/votes.ts", "votes_latest_unique", "GATED", "votesGet"),
    ("server/src/routes/votes.ts", "votes", "GATED", "handle_GET_votes_me"),
    ("server/src/server-helpers.ts", "votes", "INTERNAL-ONLY", "getVotesForPids"),
    ("server/src/comment.ts", "votes_latest_unique", "INTERNAL-ONLY", "getNumberOfCommentsRemaining"),
}


_INTERP = f"(interpreter {sys.version.split()[0]})"
# The real-tree sweep scans <checkout>/server/src and <checkout>/delphi.
_CHECKOUT = os.path.abspath(os.path.join(os.path.dirname(inv.__file__), "..", "..")) if inv else None
_SERVER_SRC = os.path.join(_CHECKOUT, "server", "src") if _CHECKOUT else None


def _guarded_import(name: str):
    """The exact guard both test modules use: swallow a ModuleNotFoundError ONLY
    when the named implementation module itself is absent; re-raise anything else."""
    import importlib
    try:
        return importlib.import_module(name), None
    except ModuleNotFoundError as exc:
        if exc.name != name:
            raise
        return None, "module not found"


def test_import_guard_reraises_defects_not_just_missing(tmp_path) -> None:
    """R14 (Astra import-regression witness): a LOCATED implementation that raises
    at import must FAIL the run, not turn green as a skip. Only a genuinely-absent
    named module is swallowed to a skip."""
    d = tmp_path / "guardpkg"
    d.mkdir()
    (d / "projgate_boom.py").write_text("raise RuntimeError('synthetic import regression')\n")
    (d / "projgate_baddep.py").write_text("import nonexistent_dependency_xyz\n")
    sys.path.insert(0, str(d))
    try:
        # A located implementation that raises -> propagates (test ERROR), not skip.
        with pytest.raises(RuntimeError, match="synthetic import regression"):
            _guarded_import("projgate_boom")
        # A located implementation missing a dependency -> propagates.
        with pytest.raises(ModuleNotFoundError):
            _guarded_import("projgate_baddep")
        # The named module genuinely absent -> swallowed to a skip.
        mod, reason = _guarded_import("projgate_totally_absent_xyz")
        assert mod is None and reason == "module not found"
    finally:
        sys.path.remove(str(d))
        for _m in ("projgate_boom", "projgate_baddep"):
            sys.modules.pop(_m, None)


def test_inventory_is_exactly_the_reviewed_set() -> None:
    if not _SERVER_SRC or not os.path.isdir(_SERVER_SRC):
        pytest.skip(f"{_INTERP} server/src absent — real-tree sweep needs the server source")
    sites = inv.run_sweep()
    got = {(s.file, s.table, s.classification, s.symbol) for s in sites}
    needs = [(s.file, s.line, s.table, s.note) for s in sites if s.classification == "NEEDS-GATE"]
    assert needs == [], f"{_INTERP} unreviewed vote-table wildcard(s): {needs}"
    assert got == EXPECTED, f"{_INTERP} inventory drifted.\n got={got}\n expected={EXPECTED}"
    # Exactly four hits, all matched to a disposition.
    assert len(sites) == 4, f"{_INTERP} expected 4 sites, got {len(sites)}: {sites}"


def test_exemption_digest_is_quote_style_independent() -> None:
    """R12: the exemption digest is `ast.dump`-based (structural), so it is stable
    across CPython 3.12.x — where `ast.unparse` f-string quoting differs. Two sources
    differing only in quote style parse to the SAME AST and share the SAME digest,
    while a structural change does not. Verified identical under 3.12.11 and 3.12.6."""
    import ast

    dq = ast.parse('q = f"SELECT * FROM {t}"')
    sq = ast.parse("q = f'SELECT * FROM {t}'")  # only the quote style differs
    assert inv._normalised_digest(dq) == inv._normalised_digest(sq)
    changed = ast.parse('q = f"SELECT * FROM {other}"')  # structural change
    assert inv._normalised_digest(dq) != inv._normalised_digest(changed)


def test_new_wildcard_is_flagged_needs_gate(tmp_path) -> None:
    """A planted wildcard in a scanned tree must be reported NEEDS-GATE (so a real
    new one fails CI). Also proves comments/docstrings do NOT trip the sweep."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    (src / "leak.ts").write_text(
        'export function leak() {\n'
        '  // SELECT * FROM votes -- this comment must NOT be flagged\n'
        '  return pg.query("SELECT * FROM votes WHERE created > 0");\n'
        '}\n'
    )
    (src / "docstring.py").write_text(
        '"""Doc mentions SELECT * FROM votes_latest_unique but is not a query."""\n'
        'def f():\n'
        '    """Also SELECT * FROM votes here in a docstring — not a query."""\n'
        '    return 1\n'
    )
    sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
    needs = [s for s in sites if s.classification == "NEEDS-GATE"]
    # The real query line is flagged; the comment and both docstrings are not.
    assert len(needs) == 1, [ (s.file, s.line) for s in sites ]
    assert needs[0].table == "votes" and needs[0].line == 3


def test_catches_multiline_alias_and_schema_wildcards(tmp_path) -> None:
    """R3 defect 4: three ordinary spellings that a line-by-line, unqualified-only
    scan missed. Each must be flagged NEEDS-GATE."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    for filename, query in {
        "multiline.ts": "SELECT\n* FROM votes",
        "qualified.ts": "SELECT v.* FROM votes v",
        "schema.ts": "SELECT * FROM public.votes",
    }.items():
        (src / filename).write_text("const rows = pg.query(`" + query + "`);\n")
    sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
    needs = {s.file.split("/")[-1] for s in sites if s.classification == "NEEDS-GATE"}
    assert needs == {"multiline.ts", "qualified.ts", "schema.ts"}, [
        (s.file, s.line, s.kind) for s in sites
    ]


def test_catches_qualified_quoted_and_url_bearing_wildcards(tmp_path) -> None:
    """R4 defect 3: table-qualified star, quoted-table alias, and a query on a line
    with a URL (whose // must not be treated as a comment) — each is one hit."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    cases = {
        "tqual.ts": 'const q = "SELECT votes.* FROM votes";\n',
        "quoted.ts": "const q = 'SELECT v.* FROM \"votes\" AS v';\n",
        "url.ts": 'const u = "https://synthetic.invalid"; const q = "SELECT * FROM votes";\n',
    }
    for fn, source in cases.items():
        (src / fn).write_text(source)
        sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
        (src / fn).unlink()
        assert len(sites) == 1, (fn, [(s.file, s.line, s.kind) for s in sites])
        assert sites[0].classification == "NEEDS-GATE"


def test_catches_quoted_identifiers_and_escaped_literals(tmp_path) -> None:
    """R5 defect: quoted qualifiers/aliases and ESCAPED TS string literals must be
    decoded before matching (each is exactly one hit)."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    cases = {
        "qqual.ts": "const q = 'SELECT \"votes\".* FROM \"votes\"';\n",
        "qalias.ts": "const q = 'SELECT \"v\".* FROM votes AS \"v\"';\n",
        "escaped.ts": 'const q = "SELECT v.* FROM \\"votes\\" AS v";\n',
    }
    for fn, source in cases.items():
        (src / fn).write_text(source)
        sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
        (src / fn).unlink()
        assert len(sites) == 1, (fn, source, [(s.file, s.line, s.kind) for s in sites])
        assert sites[0].classification == "NEEDS-GATE"


def test_decodes_unicode_and_hex_escapes(tmp_path) -> None:
    """R6: \\u0076 and \\x76 both decode to `v`, so each is `SELECT * FROM votes`."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    for fn, source in {
        "uni.ts": 'const q = "SELECT * FROM \\u0076otes";\n',
        "hex.ts": 'const q = "SELECT * FROM \\x76otes";\n',
    }.items():
        (src / fn).write_text(source)
        sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
        (src / fn).unlink()
        assert len(sites) == 1 and sites[0].table == "votes", (fn, source, sites)


def test_unresolved_template_table_is_reported_needs_gate(tmp_path) -> None:
    """R6: a wildcard SELECT whose table is a template/variable is UNRESOLVED and
    must be reported NEEDS-GATE (the documented fallback), not silently cleared."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    (src / "tmpl.ts").write_text(
        'const table = "votes"; const q = `SELECT * FROM ${table}`;\n'
    )
    sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
    assert len(sites) == 1, sites
    assert sites[0].classification == "NEEDS-GATE" and sites[0].kind == "unresolved-table"
    # A subquery `SELECT * FROM (...)` is NOT an unresolved candidate.
    (src / "tmpl.ts").write_text(
        'const q = "SELECT * FROM (SELECT tid FROM comments) x";\n'
    )
    assert inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path)) == []


def test_python_floor_division_is_not_a_comment(tmp_path) -> None:
    """R6 regression: `//` in a .py file is floor division, not a comment, so a real
    `SELECT *` on the same line is still found; a `#` comment wildcard is NOT."""
    delphi = tmp_path / "delphi"
    delphi.mkdir()
    # Division and the query on ONE line separated by ';' (exercises the regression).
    (delphi / "div.py").write_text('n = 10 // 2; q = "SELECT * FROM votes"\n')
    sites = inv.run_sweep(roots=[str(delphi)], repo_root=str(tmp_path))
    assert len(sites) == 1 and sites[0].table == "votes", sites
    (delphi / "div.py").unlink()
    # A `#` comment containing a wildcard must NOT count.
    (delphi / "cmt.py").write_text('q = "safe"  # SELECT * FROM votes\n')
    assert inv.run_sweep(roots=[str(delphi)], repo_root=str(tmp_path)) == []


def test_interpolated_table_forms_are_needs_gate(tmp_path) -> None:
    """R7: an interpolated table/qualifier/schema — f-string `{}`, template `${}`,
    or `public.${}` — is UNRESOLVED and reported NEEDS-GATE, never cleared."""
    cases = [
        ("py", "delphi", "fstr.py", 'table = "votes"; q = f"SELECT * FROM {table}"'),
        ("ts", "server/src", "qual.ts", 'const table="votes"; const q=`SELECT v.* FROM ${table} v`;'),
        ("ts", "server/src", "schema.ts", 'const table="votes"; const q=`SELECT * FROM public.${table}`;'),
    ]
    for _lang, subdir, fn, source in cases:
        root = tmp_path / subdir
        root.mkdir(parents=True, exist_ok=True)
        (root / fn).write_text(source + "\n")
        sites = inv.run_sweep(roots=[str(root)], repo_root=str(tmp_path))
        (root / fn).unlink()
        assert len(sites) == 1, (fn, source, sites)
        assert sites[0].classification == "NEEDS-GATE" and sites[0].kind == "unresolved-table"


def test_table_function_from_is_not_unresolved(tmp_path) -> None:
    """A wildcard over a table function (like a subquery) is a non-vote source."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    (src / "fn.ts").write_text('const q = "SELECT * FROM get_visible_comments($1)";\n')
    assert inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path)) == []


def test_mixed_projection_and_interpolated_qualifier_needs_gate(tmp_path) -> None:
    """R8 d1: a wildcard item ANYWHERE in the projection list, or an interpolated
    qualifier, is UNRESOLVED -> NEEDS-GATE — not only a leading `*`/`<q>.* FROM`."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    for fn, source in {
        "iq.ts": 'const table="votes", alias="v"; const q=`SELECT ${alias}.* FROM ${table} ${alias}`;',
        "mix.ts": 'const table="votes"; const q=`SELECT v.*, 1 FROM ${table} v`;',
    }.items():
        (src / fn).write_text(source + "\n")
        sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
        (src / fn).unlink()
        assert len(sites) == 1, (fn, source, sites)
        assert sites[0].classification == "NEEDS-GATE" and sites[0].kind == "unresolved-table"
    # A resolved mixed projection is still a (recognized) hit; a non-wildcard list is clean.
    (src / "res.ts").write_text('const q = "SELECT v.*, 1 FROM votes v";\n')
    assert len(inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))) == 1
    (src / "res.ts").write_text('const q = "SELECT a, b FROM votes";\n')
    assert inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path)) == []


# Path to the real replay-harness file that carries the reviewed exemption —
# derived from the located implementation (checkout/delphi/scripts), not this test's
# location, so it is correct wherever the test tree is copied.
_POLLER = os.path.join(
    os.path.dirname(os.path.abspath(inv.__file__)),
    "..", "polismath", "replay", "poller_equiv.py",
) if inv else "/nonexistent/poller_equiv.py"


def _sweep_poller_variant(tmp_path, text: str):
    rel = "delphi/polismath/replay/poller_equiv.py"
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return inv.run_sweep(roots=[str(tmp_path / "delphi")], repo_root=str(tmp_path))


def test_exemption_bound_to_guard_evidence(tmp_path) -> None:
    """R8 d2: the exemption is bound to the query text, the guard, and the non-vote
    guard set — re-verified from source. A changed set, an added unguarded query,
    or a removed guard each fails the exemption."""
    if not os.path.exists(_POLLER):
        import pytest
        pytest.skip("poller_equiv.py not found")
    original = open(_POLLER).read()
    # Baseline: the real guarded, non-vote interpolation is cleared.
    assert _sweep_poller_variant(tmp_path, original) == []

    old_set = 'EQUIV_TABLES: tuple[str, ...] = ("math_main", "math_bidtopid", "math_ptptstats")'
    assert original.count(old_set) == 1
    # (a) guard set now admits `votes` -> exemption void -> NEEDS-GATE.
    admits = _sweep_poller_variant(tmp_path, original.replace(old_set, old_set[:-1] + ', "votes")'))
    assert len(admits) == 1 and admits[0].classification == "NEEDS-GATE"

    # (b) a second, unguarded query in the same file -> NEEDS-GATE (not auto-cleared).
    added = original + ('\ndef added_query():\n    table = "votes"\n'
                        '    return f"SELECT * FROM {table} WHERE zid = :zid"\n')
    hits_b = _sweep_poller_variant(tmp_path, added)
    assert any(h.classification == "NEEDS-GATE" for h in hits_b)

    # (c) the guard removed from the exempted function -> NEEDS-GATE.
    guard = ('    if table not in EQUIV_TABLES:\n'
             '        raise ValueError(f"unknown equiv table {table!r}; '
             'expected one of {EQUIV_TABLES}")\n    result = conn.execute(')
    assert guard in original
    removed = original.replace(guard, "    result = conn.execute(", 1)
    hits_c = _sweep_poller_variant(tmp_path, removed)
    assert any(h.classification == "NEEDS-GATE" for h in hits_c)


def test_exemption_binds_occurrence_and_value(tmp_path) -> None:
    """R9: the exemption binds THIS occurrence and its guarded value — a second
    identical query, a table reassigned after the guard, or a non-literal guard-set
    member each voids it."""
    if not os.path.exists(_POLLER):
        import pytest
        pytest.skip("poller_equiv.py not found")
    original = open(_POLLER).read()
    exact = "SELECT * FROM {table} WHERE zid = :zid AND math_env = :math_env"
    old_set = 'EQUIV_TABLES: tuple[str, ...] = ("math_main", "math_bidtopid", "math_ptptstats")'
    anchor = '    result = conn.execute(\n        sa.text(f"' + exact + '")'
    assert original.count(anchor) == 1

    # (a) a SECOND identical, unguarded occurrence of the exact query.
    dup = original + '\ndef added_query():\n    table = "votes"\n    return f"' + exact + '"\n'
    hits_a = _sweep_poller_variant(tmp_path, dup)
    assert hits_a and all(h.classification == "NEEDS-GATE" for h in hits_a)

    # (b) table reassigned between the guard and the query.
    rebound = original.replace(anchor, '    table = "votes"\n' + anchor)
    hits_b = _sweep_poller_variant(tmp_path, rebound)
    assert hits_b and all(h.classification == "NEEDS-GATE" for h in hits_b)

    # (c) a non-literal (dynamic) member in the guard set.
    dynamic = original.replace(old_set, 'VOTE_TABLE = "votes"\n' + old_set[:-1] + ", VOTE_TABLE)")
    hits_c = _sweep_poller_variant(tmp_path, dynamic)
    assert hits_c and all(h.classification == "NEEDS-GATE" for h in hits_c)

    # The unmodified file is still cleared.
    assert _sweep_poller_variant(tmp_path, original) == []


def test_exemption_digest_catches_flow_edits_survives_formatting(tmp_path) -> None:
    """R10: the exemption pins a digest of the guard function's normalised source.
    An unreachable/caught guard or a destructuring rewrite changes the digest ->
    NEEDS-GATE 'exemption evidence stale: re-review'; a whitespace-only or
    comment-only edit does NOT change the normalised digest -> still cleared."""
    import ast as _ast

    if not os.path.exists(_POLLER):
        import pytest
        pytest.skip("poller_equiv.py not found")
    original = open(_POLLER).read()
    exact = "SELECT * FROM {table} WHERE zid = :zid AND math_env = :math_env"
    guard = ('    if table not in EQUIV_TABLES:\n'
             '        raise ValueError(f"unknown equiv table {table!r}; '
             'expected one of {EQUIV_TABLES}")\n')
    anchor = '    result = conn.execute(\n        sa.text(f"' + exact + '")'
    fn = next(n for n in _ast.parse(original).body
              if isinstance(n, _ast.FunctionDef) and n.name == "fetch_math_row")
    fn_src = _ast.get_source_segment(original, fn)
    assert fn_src.count(guard) == 1

    def replace_guard(rep: str) -> str:
        return original.replace(fn_src, fn_src.replace(guard, rep))

    dead = replace_guard("    if False:\n" + "".join("    " + ln for ln in guard.splitlines(keepends=True)))
    swallowed = replace_guard("    try:\n" + "".join("    " + ln for ln in guard.splitlines(keepends=True))
                              + "    except ValueError:\n        pass\n")
    destructured = original.replace(anchor, '    table, = ("votes",)\n' + anchor)

    def is_stale(text: str) -> bool:
        hits = _sweep_poller_variant(tmp_path, text)
        return bool(hits) and all(
            h.classification == "NEEDS-GATE" and h.note == inv.STALE_EXEMPTION_NOTE for h in hits
        )

    assert is_stale(dead)          # unreachable guard
    assert is_stale(swallowed)     # caught guard exception
    assert is_stale(destructured)  # destructuring reassignment

    # Whitespace-only and comment-only edits normalise away -> still cleared.
    whitespace = original.replace(anchor, "\n" + anchor)
    assert _sweep_poller_variant(tmp_path, whitespace) == []
    commented = original.replace(
        "    if table not in EQUIV_TABLES:",
        "    # reviewer note added\n    if table not in EQUIV_TABLES:",
    )
    assert _sweep_poller_variant(tmp_path, commented) == []


def test_exemption_module_digest_binds_the_guard_set(tmp_path) -> None:
    """R11: the exemption also pins a digest of the WHOLE module, so a module-level
    change to the guard set — outside the function, leaving the function digest
    unchanged — is NEEDS-GATE. A module-level whitespace/comment edit still clears."""
    if not os.path.exists(_POLLER):
        import pytest
        pytest.skip("poller_equiv.py not found")
    original = open(_POLLER).read()
    old_set = 'EQUIV_TABLES: tuple[str, ...] = ("math_main", "math_bidtopid", "math_ptptstats")'
    assert original.count(old_set) == 1

    def is_stale(text: str) -> bool:
        hits = _sweep_poller_variant(tmp_path, text)
        return bool(hits) and all(
            h.classification == "NEEDS-GATE" and h.note == inv.STALE_EXEMPTION_NOTE for h in hits
        )

    # (a) augmenting the guard set at module level (function body untouched).
    assert is_stale(original.replace(old_set, old_set + '\nEQUIV_TABLES += ("votes",)'))
    # (b) rebinding the guard set after its definition.
    assert is_stale(original.replace(old_set, old_set + '\nEQUIV_TABLES = ("votes",)'))
    # (c) module-level comment-only and whitespace-only edits still clear.
    assert _sweep_poller_variant(
        tmp_path, original.replace(old_set, "# reviewer module note\n" + old_set)
    ) == []
    assert _sweep_poller_variant(tmp_path, original.replace(old_set, old_set + "\n")) == []


def test_voters_is_not_matched_as_votes(tmp_path) -> None:
    """Word boundary: `voters` must not match `votes`."""
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    (src / "voters.ts").write_text('const q = "SELECT * FROM voters";\n')
    assert inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path)) == []


def test_url_double_slash_is_not_stripped_as_comment(tmp_path) -> None:
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    # A real `//` comment IS stripped; a `//` inside a string is preserved.
    (src / "mix.ts").write_text(
        'const a = "no query here"; // SELECT * FROM votes  (a real comment)\n'
        'const b = "see https://x/y"; const q = "SELECT * FROM votes";\n'
    )
    sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
    assert len(sites) == 1 and sites[0].line == 2, [(s.file, s.line) for s in sites]


def test_missing_scan_root_fails_not_empty_success(tmp_path) -> None:
    """R3 defect 4: an absent/unreadable root is an ungraded FAIL, not empty PASS."""
    import pytest
    with pytest.raises(inv.InventoryScanError):
        inv.run_sweep(roots=[str(tmp_path / "does-not-exist")], repo_root=str(tmp_path))


def test_subquery_and_count_star_are_not_flagged(tmp_path) -> None:
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    (src / "safe.ts").write_text(
        'const a = "select * from (select tid, vote, count(*) from votes_latest_unique) foo";\n'
        'const b = "select tid, count(*) from votes group by tid";\n'
    )
    sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
    assert sites == [], sites
