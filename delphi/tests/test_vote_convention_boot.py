"""The startup check every Python vote reader runs (P-078 PR-A).

A build made for one storage sign refuses a database that declares none, a
contract it does not know, or the other sign, with a message naming the exact
operator command. Signs are derived from the chokepoint, never written here.
"""
from __future__ import annotations

import pytest

import polismath.utils.vote_convention as vc
from polismath.utils.vote_convention import STORAGE_AGREE_VALUE, StorageConvention
from polismath.utils.vote_convention_boot import (
    DECLARED,
    NO_ROW,
    NO_TABLE,
    PRESENT_SQL,
    ROW_SQL,
    SUPPORTED_VOTE_CONTRACTS,
    VOTE_CONVENTION_GUIDE,
    DatabaseConvention,
    VoteConventionRefusal,
    declare_command,
    judge_database_convention,
    read_database_convention,
    refuse_and_exit,
    require_declared_convention,
)

TODAY = STORAGE_AGREE_VALUE
OTHER = vc.flipped(STORAGE_AGREE_VALUE)
CONTRACT = SUPPORTED_VOTE_CONTRACTS[0]


class FakeDatabase:
    """Answers the presence probe and the row query; records every SQL."""

    def __init__(self, present, rows):
        self.present, self.rows, self.sql = present, rows, []

    def __call__(self, sql):
        self.sql.append(sql)
        if sql == PRESENT_SQL:
            return [{"present": self.present}]
        if sql == ROW_SQL:
            return list(self.rows)
        raise AssertionError(f"unexpected SQL: {sql}")


def row(version, agree_value, contract_version=CONTRACT):
    return {"version": version, "agree_value": agree_value, "contract_version": contract_version}


def test_no_table_means_the_migration_is_not_applied():
    db = FakeDatabase(False, [])
    assert read_database_convention(db) == DatabaseConvention(NO_TABLE)
    assert db.sql == [PRESENT_SQL]


def test_a_table_without_a_row_is_undeclared():
    assert read_database_convention(FakeDatabase(True, [])) == DatabaseConvention(NO_ROW)


def test_the_declared_row_is_read_as_integers():
    found = read_database_convention(FakeDatabase(True, [row("0", str(TODAY), "1")]))
    assert found == DatabaseConvention(DECLARED, 0, TODAY, 1)


def test_two_rows_refuse_rather_than_guess():
    with pytest.raises(VoteConventionRefusal) as e:
        read_database_convention(FakeDatabase(True, [row(0, TODAY), row(1, OTHER)]))
    assert e.value.code == "vote_convention_mismatch"


def test_the_sign_this_build_is_built_for_starts():
    assert judge_database_convention(DatabaseConvention(DECLARED, 0, TODAY, CONTRACT), "math poller") is None
    assert require_declared_convention(FakeDatabase(True, [row(0, TODAY)]), "math poller") == \
        StorageConvention(TODAY, 0, "database")


def test_no_table_names_the_migration_the_declare_command_and_the_guide():
    refusal = judge_database_convention(DatabaseConvention(NO_TABLE), "math poller")
    assert refusal.code == "vote_convention_not_installed"
    assert refusal.message.startswith("Polis cannot start (math poller):")
    assert "000025_vote_convention.sql" in refusal.message
    assert declare_command() in refusal.message
    assert "Nothing has been changed" in refusal.message
    assert f"{VOTE_CONVENTION_GUIDE}#guard" in refusal.message


def test_no_row_names_the_exact_declare_command():
    refusal = judge_database_convention(DatabaseConvention(NO_ROW), "Delphi job")
    assert refusal.code == "vote_convention_undeclared"
    assert refusal.message.startswith("Polis cannot start (Delphi job):")
    assert f'"{declare_command()}"' in refusal.message
    assert "Nothing has been changed" in refusal.message
    assert f"{VOTE_CONVENTION_GUIDE}#declare" in refusal.message


def test_the_other_sign_refuses_because_this_build_would_invert_every_vote():
    refusal = judge_database_convention(DatabaseConvention(DECLARED, 1, OTHER, CONTRACT), "math poller")
    assert refusal.code == "vote_convention_mismatch"
    assert "declares vote convention version 1" in refusal.message
    assert "every vote inverted" in refusal.message
    assert f"{VOTE_CONVENTION_GUIDE}#mismatch" in refusal.message
    with pytest.raises(VoteConventionRefusal):
        require_declared_convention(FakeDatabase(True, [row(1, OTHER)]), "math poller")


def test_a_build_declared_for_the_other_sign_accepts_that_sign():
    """The gate's v1 leg: a client declared +1 against a +1 database."""
    assert judge_database_convention(DatabaseConvention(DECLARED, 1, OTHER, CONTRACT), "engine leg",
                                     built_for=OTHER) is None


def test_an_unknown_contract_refuses_before_the_sign_is_judged():
    refusal = judge_database_convention(DatabaseConvention(DECLARED, 0, TODAY, CONTRACT + 1), "math poller")
    assert refusal.code == "vote_convention_contract_unsupported"
    assert f"contract {CONTRACT + 1}" in refusal.message
    assert f"{VOTE_CONVENTION_GUIDE}#a-newer-database" in refusal.message


def test_the_declare_command_names_this_builds_sign():
    assert declare_command() == f"make vote-convention-declare AGREE={TODAY:+d}"
    assert declare_command(OTHER) == f"make vote-convention-declare AGREE={OTHER:+d}"


def test_refuse_and_exit_prints_the_message_and_exits_non_zero(capsys):
    refusal = judge_database_convention(DatabaseConvention(NO_ROW), "math pipeline")
    with pytest.raises(SystemExit) as e:
        refuse_and_exit(refusal, exit_code=2)
    assert e.value.code == 2
    assert declare_command() in capsys.readouterr().err
