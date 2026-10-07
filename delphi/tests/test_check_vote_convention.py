"""The job-boundary check script (P-078): run_delphi.py's first stage.

It uses the same decision as the pollers' startup check and exits 1 with the
operator message before any job stage runs. Signs come from the chokepoint.
"""
from __future__ import annotations

import pytest

from polismath import check_vote_convention as script
from polismath.utils.vote_convention import STORAGE_AGREE_VALUE, flipped
from polismath.utils.vote_convention_boot import PRESENT_SQL, ROW_SQL, SUPPORTED_VOTE_CONTRACTS


class FakeClient:
    def __init__(self, present, rows):
        self.present, self.rows, self.shut = present, rows, False

    def initialize(self):
        pass

    def query(self, sql):
        if sql == PRESENT_SQL:
            return [{"present": self.present}]
        if sql == ROW_SQL:
            return list(self.rows)
        raise AssertionError(sql)

    def shutdown(self):
        self.shut = True


def declared(agree, version=0):
    return [{"version": version, "agree_value": agree, "contract_version": SUPPORTED_VOTE_CONTRACTS[0]}]


def test_a_declared_database_passes_and_prints_the_convention(monkeypatch, capsys):
    client = FakeClient(True, declared(STORAGE_AGREE_VALUE))
    monkeypatch.setattr(script, "open_client", lambda: client)
    assert script.main([]) == 0
    assert f"agree stored as {STORAGE_AGREE_VALUE}" in capsys.readouterr().out
    assert client.shut


@pytest.mark.parametrize("present, rows, needle", [
    (False, [], "Migration 000025 has not been applied"),
    (True, [], "does not record which stored vote value means"),
    (True, declared(flipped(STORAGE_AGREE_VALUE), version=1), "would read and write every vote inverted"),
])
def test_a_refused_database_exits_1_with_the_operator_message(monkeypatch, capsys, present, rows, needle):
    client = FakeClient(present, rows)
    monkeypatch.setattr(script, "open_client", lambda: client)
    with pytest.raises(SystemExit) as exc:
        script.main([])
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith("Polis cannot start (Delphi job):"), err
    assert needle in err
    assert client.shut
