"""The large-class rebuild child (``math_poller --job``) checks the declared
vote convention before it builds the service that reads votes, as the poller
does at startup (P-078). A refusal exits 2 (the job's environment is invalid)
with the operator message; the service is never built."""

import logging

import pytest

import polismath.poller.rebuild_child as rebuild_child
from polismath.job_child import EXIT_JOB_ENV_INVALID
from polismath.poller.service import PollerConfig
from polismath.utils.vote_convention import STORAGE_AGREE_VALUE, flipped
from polismath.utils.vote_convention_boot import PRESENT_SQL, ROW_SQL, SUPPORTED_VOTE_CONTRACTS
from scripts import math_poller


class FakeClient:
    """A PostgresClient that answers only the convention reads."""

    present = True
    rows = []

    def __init__(self, config):
        pass

    def initialize(self):
        pass

    def query(self, sql, params=None):
        if sql == PRESENT_SQL:
            return [{"present": self.present}]
        if sql == ROW_SQL:
            return list(self.rows)
        raise AssertionError(f"a vote was read before the convention check: {sql}")


@pytest.fixture
def child(monkeypatch):
    built = []

    class Service:
        def __init__(self, *args, **kwargs):
            built.append(kwargs)

        def set_dynamic_allowlist(self, allow):
            pass

    monkeypatch.setattr(math_poller, "PostgresClient", FakeClient)
    monkeypatch.setattr(math_poller, "MathPollerService", Service)
    monkeypatch.setattr(math_poller, "CapacityRouter", lambda *a, **k: None)
    # Everything before build_fn (frame, skew, budget, lock) is the child's own
    # and tested there; here run() hands straight to build_fn.
    monkeypatch.setattr(rebuild_child, "run", lambda job_arg, **kw: kw["build_fn"](object()) and 0)

    def go(present, rows):
        FakeClient.present, FakeClient.rows = present, rows
        return math_poller._run_job("", PollerConfig(database_url="postgresql://fixture/none"),
                                    logging.getLogger("test"))
    go.built = built
    return go


def row(agree_value):
    return {"version": 0 if agree_value == STORAGE_AGREE_VALUE else 1, "agree_value": agree_value,
            "contract_version": SUPPORTED_VOTE_CONTRACTS[0]}


@pytest.mark.parametrize("present, rows, says", [
    (False, [], "has no vote_convention table"),
    (True, [], "does not record which stored vote value"),
    (True, [row(flipped(STORAGE_AGREE_VALUE))], "would read and write every vote inverted"),
])
def test_the_rebuild_child_refuses_before_it_builds(child, capsys, present, rows, says):
    with pytest.raises(SystemExit) as e:
        child(present, rows)
    assert e.value.code == EXIT_JOB_ENV_INVALID
    err = capsys.readouterr().err
    assert "Polis cannot start (math rebuild job)" in err and says in err
    assert child.built == []


def test_the_declared_sign_this_build_is_built_for_builds_the_service(child):
    assert child(True, [row(STORAGE_AGREE_VALUE)]) == 0
    assert len(child.built) == 1
