"""The one Python helper for test and tool code that writes vote rows (P-078 PR-G).

A fixture that INSERTs or COPYs into ``votes`` bypasses the API, so whatever
number it writes is a storage-sign value. Before P-078 PR-G each such writer
spelled that number itself (``vote=-1`` for an agree, ``-int(row['vote'])`` for
a public export row). Now every writer names the vote by MEANING and takes the
stored number from here, so a fixture never restates the storage sign and the
same fixture writes correct rows at either convention.

Vocabulary (``polismath.utils.vote_convention``):

* semantic  +1 agree, -1 disagree, 0 pass (``AGREE``/``DISAGREE``/``PASS``, or
            the names ``"agree"``/``"disagree"``/``"pass"``);
* storage   the number in ``votes.vote``: ``semantic * storage_agree_value``;
* export    the number in a votes CSV export (agree = ``EXPORT_AGREE_VALUE``).

The convention a fixture writes under is an argument. Left out, it is
:data:`~polismath.utils.vote_convention.STORAGE_AGREE_VALUE`, the convention
every row has been written under since 2012. A writer that holds a cursor on a
database that carries its own convention row (P-078 PR-A,
``vote_convention_current()``) passes :func:`database_convention` instead, so
the seed follows the row exactly as ``vote_insert()`` would.

Standard library only: tools outside ``delphi/`` import it with
``delphi/tests`` on ``sys.path`` (``import vote_fixtures``); delphi tests as
``tests.vote_fixtures``.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Iterable, List, Optional, Tuple, Union


def _vote_convention():
    """``polismath.utils.vote_convention``, the one Python convention module.

    Imported normally where the engine's dependencies are installed. A tool
    that seeds a database without them (coordinator-rs/tools, ci/probe_box)
    gets the same file loaded on its own: it imports nothing from the rest of
    ``polismath`` on purpose, so it needs no package ``__init__``."""
    name = "polismath.utils.vote_convention"
    try:
        return importlib.import_module(name)
    except ImportError:
        pass
    path = Path(__file__).resolve().parents[1] / "polismath" / "utils" / "vote_convention.py"
    spec = importlib.util.spec_from_file_location("_vote_fixtures_convention", path)
    module = importlib.util.module_from_spec(spec)
    # Registered before it runs: a @dataclass with postponed annotations looks
    # its own module up in sys.modules while the class is being built.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_vc = _vote_convention()
EXPORT_AGREE_VALUE = _vc.EXPORT_AGREE_VALUE
SEMANTIC_AGREE = _vc.SEMANTIC_AGREE
SEMANTIC_DISAGREE = _vc.SEMANTIC_DISAGREE
SEMANTIC_PASS = _vc.SEMANTIC_PASS
STORAGE_AGREE_VALUE = _vc.STORAGE_AGREE_VALUE
VoteConventionError = _vc.VoteConventionError
semantic_vote = _vc.semantic_vote
storage_vote = _vc.storage_vote
validate_storage_agree_value = _vc.validate_storage_agree_value

AGREE: int = SEMANTIC_AGREE
DISAGREE: int = SEMANTIC_DISAGREE
PASS: int = SEMANTIC_PASS

#: Semantic votes by name.
NAMES = {"agree": AGREE, "disagree": DISAGREE, "pass": PASS}

Semantic = Union[int, str]


def semantic(vote: Semantic) -> int:
    """A vote named by meaning, as the semantic integer. Refuses anything that
    is not one of the three votes (a bool, a float, 2, None)."""
    if isinstance(vote, str):
        try:
            return NAMES[vote]
        except KeyError:
            raise VoteConventionError(f"not a vote name: {vote!r}") from None
    if type(vote) is not int or vote not in (AGREE, DISAGREE, PASS):
        raise VoteConventionError(f"not a semantic vote: {vote!r}")
    return vote


def convention(storage_agree_value: Optional[int] = None) -> int:
    """The convention a fixture writes under: the argument, validated, or the
    declared default :data:`STORAGE_AGREE_VALUE`."""
    if storage_agree_value is None:
        return STORAGE_AGREE_VALUE
    return validate_storage_agree_value(storage_agree_value)


def seed_vote(vote: Semantic, storage_agree_value: Optional[int] = None) -> int:
    """The number a fixture stores in ``votes.vote`` for ``vote``."""
    return int(storage_vote(semantic(vote), convention(storage_agree_value)))


def seed_vote_from_export(export_value: Any, storage_agree_value: Optional[int] = None) -> int:
    """A ``vote`` cell of a votes CSV export (agree = +1) as the stored number."""
    value = int(export_value)
    return seed_vote(int(semantic_vote(value, EXPORT_AGREE_VALUE)), storage_agree_value)


def read_vote(raw: Any, storage_agree_value: Optional[int] = None) -> Optional[int]:
    """A stored ``votes.vote`` back to its semantic vote; NULL stays None."""
    if raw is None:
        return None
    return semantic(int(semantic_vote(int(raw), convention(storage_agree_value))))


def seed_rows(rows: Iterable[Tuple[Any, ...]], storage_agree_value: Optional[int] = None,
              *, vote_index: int = 2) -> List[Tuple[Any, ...]]:
    """Rows whose ``vote_index`` column is a semantic vote, with that column
    replaced by the stored number (every other column unchanged)."""
    s = convention(storage_agree_value)
    out = []
    for row in rows:
        row = tuple(row)
        out.append(row[:vote_index] + (seed_vote(row[vote_index], s),) + row[vote_index + 1:])
    return out


#: The schema of a sign declaration beside a raw fixture (P-078 PR-F/PR-G).
DECLARATION_SCHEMA = "declared-vote-sign/1"


def declaration(companion: Union[str, Path]) -> dict:
    """A ``*.sign.json`` companion, checked: its schema, its fixture's bytes
    (``fixture_sha256``: a fixture changed after its sign was declared is
    refused) and its ``storage_agree_value``. Returns the companion with
    ``fixture_path`` (absolute) added."""
    import hashlib
    import json

    companion = Path(companion)
    meta = json.loads(companion.read_text())
    if meta.get("schema") != DECLARATION_SCHEMA:
        raise VoteConventionError(f"{companion}: not a {DECLARATION_SCHEMA} companion")
    fixture = (companion.parent / meta["fixture"]).resolve()
    if hashlib.sha256(fixture.read_bytes()).hexdigest() != meta["fixture_sha256"]:
        raise VoteConventionError(f"{companion}: {fixture.name} changed after its sign was declared")
    validate_storage_agree_value(meta["storage_agree_value"])
    return {**meta, "fixture_path": str(fixture)}


def load_declared(companion: Union[str, Path]) -> Tuple[Any, int]:
    """A declared JSON fixture and the convention its raw votes are stored in."""
    import json

    meta = declaration(companion)
    return json.loads(Path(meta["fixture_path"]).read_text()), meta["storage_agree_value"]


def database_convention(cursor) -> int:
    """The storage convention of the database ``cursor`` is connected to: the
    ``agree_value`` of ``vote_convention_current()`` when the database carries
    the convention row (P-078 PR-A), otherwise the declared default (a database
    without the row is at version 0, agree = -1, by definition)."""
    cursor.execute("SELECT to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present")
    if not _first(cursor.fetchone()):
        return STORAGE_AGREE_VALUE
    cursor.execute("SELECT agree_value FROM public.vote_convention_current()")
    return validate_storage_agree_value(int(_first(cursor.fetchone())))


def _first(row):
    """The first column of a row from a plain or a dict cursor."""
    return next(iter(row.values())) if isinstance(row, dict) else row[0]


def main(argv: Optional[List[str]] = None) -> int:
    """``python3 delphi/tests/vote_fixtures.py agree pass disagree`` prints the
    stored value of each named vote, for shell and SQL fixtures."""
    names = sys.argv[1:] if argv is None else argv
    if not names:
        print(main.__doc__, file=sys.stderr)
        return 2
    print(" ".join(str(seed_vote(name)) for name in names))
    return 0


if __name__ == "__main__":
    sys.exit(main())
