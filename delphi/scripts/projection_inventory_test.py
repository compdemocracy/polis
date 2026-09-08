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


def test_subquery_and_count_star_are_not_flagged(tmp_path) -> None:
    src = tmp_path / "server" / "src"
    src.mkdir(parents=True)
    (src / "safe.ts").write_text(
        'const a = "select * from (select tid, vote, count(*) from votes_latest_unique) foo";\n'
        'const b = "select tid, count(*) from votes group by tid";\n'
    )
    sites = inv.run_sweep(roots=[str(src)], repo_root=str(tmp_path))
    assert sites == [], sites
