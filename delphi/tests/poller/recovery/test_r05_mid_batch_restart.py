"""R05 — mid-batch restart of the ACTUAL Python process (REAL Postgres).

P-022 §C required matrix:

    Kill the actual Python process after poll/watermark advance, during compute,
    after main commit, before final table commit and after all writes before
    cache publication.  Restart with no new vote; recover from DB, complete the
    missing work and serve coherent state.  Include a dormant zid older than
    lookback.

The subject is ``restart_child.py``: a real ``MathPollerService`` in a real
subprocess, which announces the named stage on stdout and then blocks so the
TEST delivers ``SIGKILL``.  Nothing is simulated in-process.

The production writer now commits all three rows together. The legacy-writes
child option intentionally restores separate commits ONLY for negative controls
and the dormant-zid repair regression: old partial rows still need repair even
though new publications can no longer produce them.
"""

import os
import signal
import subprocess
import sys
import threading
import time

import pytest
import sqlalchemy as sa

from .conftest import (
    dbname_of,
    eventually,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"
_CHILD = os.path.join(os.path.dirname(__file__), "restart_child.py")
_DELPHI_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__),
                                            "..", "..", ".."))
_MS_PER_DAY = 24 * 60 * 60 * 1000

STAGES = [
    "after_poll",
    "during_compute",
    "after_main_write",
    "before_final_table_write",
    "after_all_writes_before_cache",
]


class Child:
    """A real poller subprocess whose stdout stage markers the test can await."""

    def __init__(self, pg_url, stage, days=1.0, tmp_path=None, legacy_writes=False):
        env = dict(os.environ)
        env["PYTHONPATH"] = _DELPHI_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        if tmp_path is not None:
            env["POLIS_RECOVERY_DUMP_DIR"] = str(tmp_path / "errorconv")
        self.proc = subprocess.Popen(
            [sys.executable, _CHILD, "--pg-url", pg_url,
             "--math-env", MATH_ENV, "--kill-stage", stage,
             "--poll-from-days-ago", str(days)] +
            (["--legacy-writes"] if legacy_writes else []),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            bufsize=1, env=env, cwd=_DELPHI_ROOT,
        )
        self.stages = []
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if line.startswith("STAGE "):
                self.stages.append(line.split(" ", 1)[1])

    def await_stage(self, stage, timeout=90.0):
        eventually(
            lambda: stage in self.stages,
            timeout=timeout,
            message=(f"child never reported stage {stage!r} "
                     f"(saw {self.stages}); stderr:\n{self._peek_stderr()}"),
        )

    def _peek_stderr(self):
        try:
            self.proc.stderr.flush()
        except Exception:  # pragma: no cover
            pass
        return "(see child stderr on failure)"

    def kill(self):
        """A genuinely EXTERNAL, uncatchable kill."""
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(timeout=30)
        assert self.proc.returncode in (-signal.SIGKILL, 137), (
            f"child exited {self.proc.returncode}, expected a SIGKILL"
        )

    def wait_done(self, timeout=180.0):
        rc = self.proc.wait(timeout=timeout)
        assert rc == 0, (
            f"restart child exited {rc}; stderr:\n{self.proc.stderr.read()}"
        )
        assert "DONE" in self.stages

    def cleanup(self):
        if self.proc.poll() is None:  # pragma: no cover - safety net
            self.proc.kill()
            self.proc.wait(timeout=10)


@pytest.fixture
def children():
    made = []
    yield made
    for c in made:
        c.cleanup()


def _spawn(children, pg_url, stage, days=1.0, tmp_path=None, legacy_writes=False):
    c = Child(pg_url, stage, days=days, tmp_path=tmp_path,
              legacy_writes=legacy_writes)
    children.append(c)
    return c


# --------------------------------------------------------------------------- #
# Recent conversation: a restart within the lookback recovers
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("stage", STAGES)
def test_kill_at_stage_then_restart_recovers(engine, pg_url, children,
                                             tmp_path, stage):
    """Kill the real process at each named stage, then restart it with NO new
    vote.  The restarted process must recover from the DB and serve a coherent
    generation that matches the independent fold."""
    seeded = seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)

    victim = _spawn(children, pg_url, stage, tmp_path=tmp_path)
    victim.await_stage(stage)
    victim.kill()

    # Restart. No new votes are committed between the kill and the restart.
    survivor = _spawn(children, pg_url, "none", tmp_path=tmp_path)
    survivor.wait_done()

    tables = read_math_tables(engine, 1, MATH_ENV)
    problems = tables_are_coherent(tables)
    assert problems == [], (
        f"after a kill at {stage!r} and a restart, the published generation is "
        f"still incoherent: {problems}"
    )
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []
    assert fold.event_count == len(seeded.vote_events)


def test_legacy_kill_after_main_write_leaves_a_mixed_generation(
    engine, pg_url, children, tmp_path
):
    """The seam itself, asserted directly: a kill between the three writes DOES
    leave math_main ahead of the other two tables.  (Recovery is the test
    above; this one pins the intermediate state so the defect is documented
    rather than inferred.)"""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)

    victim = _spawn(children, pg_url, "after_main_write", tmp_path=tmp_path,
                    legacy_writes=True)
    victim.await_stage("after_main_write")
    victim.kill()

    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables["main"] is not None, "math_main committed on its own"
    assert tables["bidtopid"] is None and tables["ptptstats"] is None, (
        "the other two tables must not exist yet — that is the non-atomic "
        "three-table write (math_writer.py:238)"
    )
    assert tables_are_coherent(tables) != []


# --------------------------------------------------------------------------- #
# Dormant zid older than the lookback — the predicted defect
# --------------------------------------------------------------------------- #
def _seed_dormant(engine, zid=2):
    """A conversation whose newest vote is 10 days old: outside a 1-day boot
    lookback, so a restarted poller never polls it."""
    now = int(time.time() * 1000)
    return seed_conversation(
        engine, zid=zid, n_ptpts=6, n_cmts=4,
        base_created=now - 10 * _MS_PER_DAY,
    )


def test_dormant_zid_is_outside_the_lookback(engine, pg_url, children,
                                             tmp_path):
    """Control: with a 1-day lookback a dormant conversation is genuinely never
    polled, so the regression below is about repair and not about a mis-seeded
    fixture."""
    _seed_dormant(engine, zid=2)
    child = _spawn(children, pg_url, "none", days=1.0, tmp_path=tmp_path)
    child.wait_done()
    assert read_math_tables(engine, 2, MATH_ENV)["main"] is None, (
        "a dormant zid must not be polled with a 1-day lookback"
    )


def test_dormant_zid_partial_write_is_repaired_after_restart(
    engine, pg_url, children, tmp_path
):
    """Kill the process after the main commit for a DORMANT conversation using the legacy writer, then
    restart the production writer with no new votes. It must discover and repair
    the preexisting mixed generation outside its lookback."""
    _seed_dormant(engine, zid=2)

    # The conversation was active when the poller last ran (wide lookback).
    victim = _spawn(children, pg_url, "after_main_write", days=30.0,
                    tmp_path=tmp_path, legacy_writes=True)
    victim.await_stage("after_main_write")
    victim.kill()
    assert read_math_tables(engine, 2, MATH_ENV)["main"] is not None

    # It has since gone quiet for longer than the boot lookback.
    survivor = _spawn(children, pg_url, "none", days=1.0, tmp_path=tmp_path)
    survivor.wait_done()

    tables = read_math_tables(engine, 2, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, 2))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []


def test_dormant_zid_partial_write_is_repaired_with_a_wide_lookback(
    engine, pg_url, children, tmp_path
):
    """The same partial write DOES repair when the restarted process's lookback
    still covers the conversation — isolating the defect above to the missing
    durable repair path rather than to the write seam alone."""
    _seed_dormant(engine, zid=2)

    victim = _spawn(children, pg_url, "after_main_write", days=30.0,
                    tmp_path=tmp_path, legacy_writes=True)
    victim.await_stage("after_main_write")
    victim.kill()

    survivor = _spawn(children, pg_url, "none", days=30.0, tmp_path=tmp_path)
    survivor.wait_done()

    tables = read_math_tables(engine, 2, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, 2))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []


# --------------------------------------------------------------------------- #
# Negative control for the restart failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_a_child_that_never_reaches_the_stage_is_detected(self, engine,
                                                              pg_url, children,
                                                              tmp_path):
        """If the stage hook silently failed to fire, the R05 tests must not
        pass vacuously: awaiting a stage that cannot happen has to time out."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        child = _spawn(children, pg_url, "none", tmp_path=tmp_path)
        with pytest.raises(AssertionError):
            child.await_stage("after_main_write", timeout=5.0)

    def test_the_kill_is_real(self, engine, pg_url, children, tmp_path):
        """The victim must die by signal, not exit cleanly — otherwise the
        'restart' would just be a graceful shutdown."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        victim = _spawn(children, pg_url, "during_compute", tmp_path=tmp_path)
        victim.await_stage("during_compute")
        victim.kill()
        assert victim.proc.returncode in (-signal.SIGKILL, 137)
        assert "DONE" not in victim.stages, (
            "NEGATIVE CONTROL FAILED: the victim completed its poll cycle, so "
            "the kill did not interrupt anything"
        )


@pytest.mark.parametrize("stage", ["after_main_write", "before_final_table_write"])
@pytest.mark.parametrize("published_before", [False, True])
def test_atomic_publish_kill_rolls_back_every_table(
    engine, pg_url, children, tmp_path, stage, published_before
):
    """SIGKILL inside the shared transaction preserves ALL prior rows, including
    both ticks; a first publication leaves no partial rows at all."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    if published_before:
        initial = _spawn(children, pg_url, "none", tmp_path=tmp_path)
        initial.wait_done()
    before = read_math_tables(engine, 1, MATH_ENV)
    victim = _spawn(children, pg_url, stage, tmp_path=tmp_path)
    victim.await_stage(stage)
    # Uncommitted writes are invisible even before the backend notices the kill.
    assert read_math_tables(engine, 1, MATH_ENV) == before
    victim.kill()
    assert read_math_tables(engine, 1, MATH_ENV) == before
