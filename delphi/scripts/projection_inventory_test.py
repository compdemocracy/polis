"""Tests for the vote-table wildcard inventory sweep.

Asserts the inventory over ``server/src/**`` and ``delphi/**`` is EXACTLY the
reviewed set of four sites, so any new wildcard over ``votes`` /
``votes_latest_unique`` is reported NEEDS-GATE and fails CI. No database needed.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import projection_inventory as inv  # noqa: E402

# The reviewed inventory: (file, line-independent) table + classification + symbol.
EXPECTED = {
    ("server/src/routes/votes.ts", "votes_latest_unique", "GATED", "votesGet"),
    ("server/src/routes/votes.ts", "votes", "GATED", "handle_GET_votes_me"),
    ("server/src/server-helpers.ts", "votes", "INTERNAL-ONLY", "getVotesForPids"),
    ("server/src/comment.ts", "votes_latest_unique", "INTERNAL-ONLY", "getNumberOfCommentsRemaining"),
}


def test_inventory_is_exactly_the_reviewed_set() -> None:
    sites = inv.run_sweep()
    got = {(s.file, s.table, s.classification, s.symbol) for s in sites}
    needs = [s for s in sites if s.classification == "NEEDS-GATE"]
    assert needs == [], f"unreviewed vote-table wildcard(s): {[ (s.file,s.line,s.table) for s in needs ]}"
    assert got == EXPECTED, f"inventory drifted.\n got={got}\n expected={EXPECTED}"
    # Exactly four hits, all matched to a disposition.
    assert len(sites) == 4


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
