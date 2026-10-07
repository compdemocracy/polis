"""The capacity line across revisions: a mixed deploy and retained history.

``fixtures/capacity-revisions.txt`` holds one small-class capacity line per
revision (primary and standby), a line from before revisioning (no ``rev``),
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


def fixed_counts(keys):
    """The fixture's counts: routing 1, the two admission flags 0, the rest 10 + position."""
    return {k: 1 if k == "routing" else 0 if k in ("queue_full", "queue_unreachable") else 10 + i
            for i, k in enumerate(keys)}


def bodies():
    return [json.loads(line) for line in LINES]


def test_revision_table_is_the_emitted_key_set():
    assert keys_through(CAPACITY_REV) == COUNT_KEYS
    assert sorted(CAPACITY_REV_KEYS) == list(range(1, CAPACITY_REV + 1))


def test_this_revision_is_what_the_emitter_writes():
    mine = [line for line in LINES if json.loads(line).get("rev") == CAPACITY_REV]
    assert mine == [build_line("primary", "python", fixed_counts(COUNT_KEYS)),
                    build_line("standby", "python", None)]


def test_fixture_covers_older_and_newer_revisions():
    revs = [b.get("rev") for b in bodies()]
    assert revs[0] is None, "the first line predates revisioning"
    assert max(r for r in revs if r) > CAPACITY_REV, "a forward revision is present"


def test_older_lines_carry_exactly_their_revision_keys():
    for b in bodies():
        rev = b.get("rev", 1)
        if rev <= CAPACITY_REV:
            assert set(b) - HEAD - {"rev"} == set(keys_through(rev))


@pytest.mark.parametrize("line", LINES)
def test_every_revision_parses_to_this_decoders_shape(line):
    raw = json.loads(line)
    body = parse_line(line)
    rev = raw.get("rev", 1)
    assert body["rev"] == rev
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
                for b in bodies() if b.get("rev", 1) == rev and b["role"] == "primary")


def test_an_older_revision_may_not_carry_a_key_it_did_not_declare():
    c = _counts(CAPACITY_REV)
    with pytest.raises(ValueError, match="does not declare"):
        decode_counts({**c, "zid": 1})
    if CAPACITY_REV > 1:
        newest = CAPACITY_REV_KEYS[CAPACITY_REV][0]
        with pytest.raises(ValueError, match="does not declare"):
            decode_counts({**_counts(CAPACITY_REV - 1), newest: 0})


def test_a_revision_missing_a_key_it_declares_is_refused():
    for rev in range(1, CAPACITY_REV + 1):
        c = _counts(rev)
        del c[keys_through(rev)[-1]]
        with pytest.raises(ValueError, match="lacks"):
            decode_counts(c)
    # The pre-revisioning line still needs every revision-1 key.
    legacy = {k: v for k, v in bodies()[0].items() if k not in HEAD}
    del legacy["large_parked"]
    with pytest.raises(ValueError, match="lacks"):
        decode_counts(legacy)


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
