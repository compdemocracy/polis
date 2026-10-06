"""The commentgraph CLI's ``test-postgres`` command refuses an undeclared
database with a non-zero exit (P-078). Only this command is gated at the CLI;
``lambda-local`` is gated where it reads votes (the UMAP stage's
``fetch_conversation_data``).
"""
from __future__ import annotations

import sys

import pytest

from polismath.utils.vote_convention import STORAGE_AGREE_VALUE, StorageConvention
from polismath.utils.vote_convention_boot import VoteConventionRefusal
from umap_narrative.polismath_commentgraph import cli


class FakePostgres:
    refusal = None

    def __init__(self, config):
        self.config = config

    def initialize(self):
        pass

    def require_declared_convention(self, component):
        assert component == "commentgraph CLI"
        if self.refusal is not None:
            raise self.refusal
        return StorageConvention(STORAGE_AGREE_VALUE, 0, "database")

    def query(self, sql):
        return [{"time": "fixture", "version": "PostgreSQL fixture"}]

    def shutdown(self):
        pass


@pytest.fixture
def fake_cli(monkeypatch):
    monkeypatch.setattr(cli, "PostgresClient", FakePostgres)
    monkeypatch.setattr(sys, "argv", ["cli", "test-postgres", "--pg-host", "fixture", "--pg-port", "1",
                                      "--pg-database", "fixture", "--pg-user", "fixture", "--pg-password", "x"])
    FakePostgres.refusal = None
    return FakePostgres


def test_a_declared_database_completes_normally(fake_cli):
    cli.main()  # no SystemExit: exit code 0


def test_an_undeclared_database_exits_1_with_the_operator_message(fake_cli, capsys):
    message = 'Polis cannot start (commentgraph CLI): this database does not record which stored vote value means "agree".'
    fake_cli.refusal = VoteConventionRefusal("vote_convention_undeclared", message)
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == 1
    assert message in capsys.readouterr().err
