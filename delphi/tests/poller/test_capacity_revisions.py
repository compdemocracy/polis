"""The capacity line across revisions: a mixed deploy and retained history.

``fixtures/capacity-revisions.txt`` holds one small-class capacity line per
revision (primary and standby), the two shapes logged before revisioning (no
``rev``: production's nine counts, revision 1, and the twelve of revision 2),
and a forward line of a revision no decoder knows yet. The line of THIS
emitter's revision must equal what ``build_line`` writes for the fixed counts
below; older lines are the frozen output of their own revision; newer ones are
what a later emitter writes. The server's TypeScript parser reads the same
file (server/__tests__/unit/opsCapacityRevisions.test.ts), so an old or new
parser on either side of a rolling deploy is tested against every revision.
"""

import json
from pathlib import Path

import pytest

from polismath.poller.capacity import (
    CAPACITY_REV,
    CAPACITY_REV_KEYS,
    COUNT_KEYS,
    REV_FORWARD,
    build_line,
    decode_counts,
    keys_through,
    parse_line,
    validate_counts,
)

FIXTURE = Path(__file__).parent / "fixtures" / "capacity-revisions.txt"
LINES = FIXTURE.read_text().strip().split("\n")
HEAD = {"schema", "class", "role", "label"}


def fixed_counts(keys=None):
    """The fixture's counts: routing 1, the two admission flags 0, the rest 10 + position."""
    keys = keys_through(CAPACITY_REV) if keys is None else keys
    return {k: 1 if k == "routing" else 0 if k in ("queue_full", "queue_unreachable") else 10 + i
            for i, k in enumerate(keys)}


def bodies():
    return [json.loads(line) for line in LINES]


def rev_of(body):
    """The revision a line declares, or infers from its keys when it has no ``rev``."""
    return decode_counts({k: v for k, v in body.items() if k not in HEAD},
                         nullable=body["role"] != "primary")["rev"]


def test_revision_table_is_the_emitted_key_set():
    assert sorted(keys_through(CAPACITY_REV)) == sorted(COUNT_KEYS)
    assert len(keys_through(CAPACITY_REV)) == len(COUNT_KEYS)
    assert sorted(CAPACITY_REV_KEYS) == list(range(1, CAPACITY_REV + 1))


def test_this_revision_is_what_the_emitter_writes():
    mine = [line for line in LINES if json.loads(line).get("rev") == CAPACITY_REV]
    assert mine == [build_line("primary", "python", fixed_counts()),
                    build_line("standby", "python", None)]


def test_fixture_covers_older_and_newer_revisions():
    assert [b.get("rev") for b in bodies()[:2]] == [None, None], "two lines predate revisioning"
    assert [rev_of(b) for b in bodies()[:2]] == [1, 2]
    assert max(rev_of(b) for b in bodies()) > CAPACITY_REV, "a forward revision is present"


def test_older_lines_carry_exactly_their_revision_keys():
    for b in bodies():
        rev = rev_of(b)
        if rev <= CAPACITY_REV:
            assert set(b) - HEAD - {"rev"} == set(keys_through(rev))


@pytest.mark.parametrize("line", LINES)
def test_every_revision_parses_to_this_decoders_shape(line):
    raw = json.loads(line)
    body = parse_line(line)
    assert body["rev"] == rev_of(raw)
    assert set(body) == HEAD | {"rev"} | set(COUNT_KEYS)
    for k in COUNT_KEYS:
        assert body[k] == raw.get(k)  # absent in an older revision -> None
    # Keys only a newer revision declared are dropped, never relayed.
    assert not (set(body) - HEAD - {"rev"} - set(COUNT_KEYS))
    # The readiness line's embedded counts read the same way.
    validate_counts({k: v for k, v in raw.items() if k not in HEAD},
                    nullable=raw["role"] != "primary")


def _counts(rev):
    return next({k: v for k, v in b.items() if k not in HEAD}
                for b in bodies() if rev_of(b) == rev and b["role"] == "primary")


def test_an_older_revision_may_not_carry_a_key_it_did_not_declare():
    c = _counts(CAPACITY_REV)
    with pytest.raises(ValueError, match="does not declare"):
        decode_counts({**c, "zid": 1})
    if CAPACITY_REV > 1:
        newest = CAPACITY_REV_KEYS[CAPACITY_REV][0]
        with pytest.raises(ValueError, match="does not declare"):
            decode_counts({**_counts(CAPACITY_REV - 1), "rev": CAPACITY_REV - 1, newest: 0})
        # Without rev, an unrevisioned shape with one more key matches neither shape.
        with pytest.raises(ValueError):
            decode_counts({k: v for k, v in {**_counts(1), newest: 0}.items() if k != "rev"})


def test_a_revision_missing_a_key_it_declares_is_refused():
    for rev in range(1, CAPACITY_REV + 1):
        c = _counts(rev)
        del c[keys_through(rev)[-1]]
        with pytest.raises(ValueError, match="lacks"):
            decode_counts(c)
    # A line logged before revisioning still has to be one of the two shapes.
    for legacy in bodies()[:2]:
        c = {k: v for k, v in legacy.items() if k not in HEAD}
        del c["large_demand"]
        with pytest.raises(ValueError, match="lacks"):
            decode_counts(c)
    edge = {k: v for k, v in bodies()[1].items() if k not in HEAD}
    del edge["large_parked"]
    with pytest.raises(ValueError, match="lacks"):
        decode_counts(edge)


def test_a_newer_revision_keeps_every_key_this_decoder_knows():
    c = _counts(CAPACITY_REV)
    c["rev"] = CAPACITY_REV + 1
    c["future_count"] = 3
    assert decode_counts(c)["rev"] == CAPACITY_REV + 1
    del c["routing"]
    with pytest.raises(ValueError, match="lacks"):
        decode_counts(c)


@pytest.mark.parametrize("value", ["3", -1, 1.5, True, {"a": 1}])
def test_a_forward_key_is_still_a_count(value):
    c = {**_counts(CAPACITY_REV), "rev": CAPACITY_REV + 1, "future_count": value}
    with pytest.raises(ValueError):
        decode_counts(c)


@pytest.mark.parametrize("key", ["Future", "1x", "a-b", "x" * 65])
def test_a_forward_key_has_a_plain_name(key):
    with pytest.raises(ValueError, match="bad key"):
        decode_counts({**_counts(CAPACITY_REV), "rev": CAPACITY_REV + 1, key: 1})


@pytest.mark.parametrize("rev", [0, -1, CAPACITY_REV + REV_FORWARD + 1, "1", 1.0, True, None])
def test_the_revision_is_a_known_range_integer(rev):
    with pytest.raises(ValueError, match="revision"):
        decode_counts({**_counts(CAPACITY_REV), "rev": rev})
