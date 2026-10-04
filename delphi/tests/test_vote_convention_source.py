"""The injectable vote convention (P-078 PR-C).

Every function in ``polismath.utils.vote_convention`` that is not handed a
storage sign takes it from the installed ``ConventionSource``. The default is
today's constant; a fake database row declaring the other sign makes every
function follow it. Vote values here are derived from the module's named
values, never written as bare signs.
"""

from __future__ import annotations

import numpy as np
import pytest

import polismath.utils.vote_convention as vc
from polismath.utils.general import delphi_vote_to_postgres, postgres_vote_to_delphi
from polismath.utils.vote_convention import (
    ABSENT_CONVENTION,
    GEOMETRY_AXIS_AGREE_VALUE,
    ROW_AGREE_KEY,
    ROW_VERSION_KEY,
    SEMANTIC_AGREE,
    SEMANTIC_DISAGREE,
    SEMANTIC_PASS,
    STORAGE_AGREE_VALUE,
    WIRE_AGREE_VALUE,
    ConstantConventionSource,
    RowConventionSource,
    StorageConvention,
    VoteConventionError,
    database_row_fetcher,
    emit_axis,
    load_semantic_votes,
    restore_axis,
    semantic_vote,
    storage_vote,
    using_convention_source,
)

TODAY = STORAGE_AGREE_VALUE
OTHER = vc.flipped(STORAGE_AGREE_VALUE)
SEMANTICS = (SEMANTIC_AGREE, SEMANTIC_DISAGREE, SEMANTIC_PASS)


def raw(semantic, agree_value):
    """The stored value of ``semantic`` under ``agree_value``: agree is stored as
    ``agree_value``, disagree as its opposite, pass as zero."""
    return {SEMANTIC_AGREE: agree_value, SEMANTIC_DISAGREE: vc.flipped(agree_value),
            SEMANTIC_PASS: SEMANTIC_PASS}[semantic]


class FakeRow:
    """A database row source: answers ``(version, agree_value)`` and counts reads."""

    def __init__(self, row):
        self.row, self.reads = row, 0

    def __call__(self):
        self.reads += 1
        return self.row


# --- the source ------------------------------------------------------------------


def test_default_source_is_todays_constant():
    assert isinstance(vc.get_convention_source(), ConstantConventionSource)
    assert vc.storage_agree_value() == STORAGE_AGREE_VALUE
    assert vc.current_convention() == StorageConvention(STORAGE_AGREE_VALUE, None, "constant")


@pytest.mark.parametrize("agree_value", [TODAY, OTHER])
def test_every_function_follows_the_source(agree_value):
    """A fake row source at either sign: each function that is not handed a
    sign converts by the row's."""
    with using_convention_source(RowConventionSource(FakeRow((1, agree_value)))):
        assert vc.storage_agree_value() == agree_value
        assert vc.resolve_storage_agree_value(None) == agree_value
        for s in SEMANTICS:
            stored = raw(s, agree_value)
            assert semantic_vote(stored) == s
            assert storage_vote(s) == stored
            assert postgres_vote_to_delphi(stored) == s
            assert delphi_vote_to_postgres(s) == stored
        rows = [{"pid": i, "vote": raw(s, agree_value)} for i, s in enumerate(SEMANTICS)]
        assert [r["vote"] for r in load_semantic_votes(rows)] == list(SEMANTICS)
    # Restored afterwards.
    assert vc.storage_agree_value() == STORAGE_AGREE_VALUE


def test_a_declared_value_beats_the_source():
    with using_convention_source(ConstantConventionSource(OTHER)):
        assert semantic_vote(raw(SEMANTIC_AGREE, TODAY), TODAY) == SEMANTIC_AGREE
        rows = [{"vote": raw(SEMANTIC_AGREE, TODAY)}]
        assert load_semantic_votes(rows, storage_agree_value=TODAY)[0]["vote"] == SEMANTIC_AGREE


def test_row_source_reads_once_per_cycle():
    fetch = FakeRow((0, TODAY))
    source = RowConventionSource(fetch)
    assert source.current() == StorageConvention(TODAY, 0, "database")
    source.current()
    assert fetch.reads == 1
    source.begin_cycle()
    fetch.row = (1, OTHER)
    assert source.current() == StorageConvention(OTHER, 1, "database")
    assert fetch.reads == 2


def test_row_source_without_a_row_is_version_zero_at_the_fallback():
    source = RowConventionSource(FakeRow(None))
    assert source.current() == ABSENT_CONVENTION
    assert ABSENT_CONVENTION == StorageConvention(STORAGE_AGREE_VALUE, 0, "database-absent")


@pytest.mark.parametrize("row", [(0, 0), (0, 2), (0, True), (0, "-1"), (-1, TODAY), ("0", TODAY)])
def test_row_source_refuses_an_inadmissible_row_and_does_not_cache_it(row):
    fetch = FakeRow(row)
    source = RowConventionSource(fetch)
    with pytest.raises(VoteConventionError):
        source.current()
    with pytest.raises(VoteConventionError):
        source.current()
    assert fetch.reads == 2


def test_set_convention_source_refuses_a_non_source():
    with pytest.raises(VoteConventionError):
        vc.set_convention_source(object())


def test_database_row_fetcher():
    calls = []

    def query(present, rows):
        def run(sql):
            calls.append(sql)
            return [{"present": present}] if sql == vc.CONVENTION_PRESENT_SQL else rows
        return run

    assert database_row_fetcher(query(False, None))() is None
    assert calls == [vc.CONVENTION_PRESENT_SQL]
    assert database_row_fetcher(query(True, [{"version": 1, "agree_value": OTHER}]))() == (1, OTHER)
    for rows in ([], [{"version": 1, "agree_value": OTHER}] * 2):
        with pytest.raises(VoteConventionError):
            database_row_fetcher(query(True, rows))()


# --- rows that carry their own convention (read in the same statement) -----------


@pytest.mark.parametrize("agree_value", [TODAY, OTHER])
def test_a_row_declaring_its_convention_is_converted_by_it(agree_value):
    rows = [{"pid": 1, "vote": raw(SEMANTIC_AGREE, agree_value),
             ROW_AGREE_KEY: agree_value, ROW_VERSION_KEY: 7}]
    # The installed source says the opposite; the row's own declaration wins.
    with using_convention_source(ConstantConventionSource(vc.flipped(agree_value))):
        out = load_semantic_votes(rows)
    assert out == [{"pid": 1, "vote": SEMANTIC_AGREE}]


def test_a_row_with_a_missing_convention_is_refused():
    with pytest.raises(VoteConventionError):
        load_semantic_votes([{"vote": raw(SEMANTIC_AGREE, TODAY), ROW_AGREE_KEY: None}])


def test_a_declaration_contradicting_the_row_is_refused():
    rows = [{"vote": raw(SEMANTIC_AGREE, OTHER), ROW_AGREE_KEY: OTHER}]
    with pytest.raises(VoteConventionError):
        load_semantic_votes(rows, storage_agree_value=TODAY)


# --- NULL ------------------------------------------------------------------------


def test_null_policies():
    rows = [{"pid": 1, "vote": raw(SEMANTIC_AGREE, TODAY)}, {"pid": 2, "vote": None}]
    assert load_semantic_votes(rows, null_policy="keep")[1] == {"pid": 2, "vote": None}
    with pytest.raises(VoteConventionError):
        load_semantic_votes(rows, null_policy="refuse")
    with pytest.raises(VoteConventionError):
        load_semantic_votes(rows, null_policy="zero")
    # No policy silently drops NULL rows (the existing behaviour is kept;
    # skipping NULL is an open question, not decided here).
    with pytest.raises(VoteConventionError):
        load_semantic_votes(rows, null_policy="skip")
    # semantic_vote itself never invents a pass.
    with pytest.raises(VoteConventionError):
        semantic_vote(None)


# --- the geometry pair -----------------------------------------------------------


def test_served_axis_is_the_wire_axis_and_not_storage():
    assert GEOMETRY_AXIS_AGREE_VALUE == WIRE_AGREE_VALUE
    # Installing the other storage sign moves nothing in the served axis.
    center = [0.5, -0.25]
    today = emit_axis(center)
    with using_convention_source(ConstantConventionSource(OTHER)):
        assert emit_axis(center) == today


@pytest.mark.parametrize("axis", [TODAY, OTHER])
def test_geometry_pair_round_trips_under_both_signs(axis):
    nested = [[0.5, -0.25, 0.0], [1.5, 2.0, -3.0]]
    arr = np.array(nested)
    assert restore_axis(emit_axis(nested, axis), axis) == nested
    assert np.array_equal(restore_axis(emit_axis(arr, axis), axis), arr)
    assert restore_axis(emit_axis(0.75, axis), axis) == 0.75
    # The axis a matrix with agree = +1 has is the semantic one; the other
    # axis is its mirror image.
    expected = nested if axis * SEMANTIC_AGREE == SEMANTIC_AGREE else [[-v for v in r] for r in nested]
    assert emit_axis(nested, axis) == expected


def test_a_blob_from_the_other_axis_restores_by_its_declaration():
    semantic = [0.5, -0.25]
    other_axis = vc.flipped(GEOMETRY_AXIS_AGREE_VALUE)
    blob = emit_axis(semantic, other_axis)
    assert restore_axis(blob, other_axis) == semantic
    assert restore_axis(blob) != semantic


def test_geometry_pair_refuses_an_unknown_axis():
    with pytest.raises(VoteConventionError):
        emit_axis([1.0], 0)
