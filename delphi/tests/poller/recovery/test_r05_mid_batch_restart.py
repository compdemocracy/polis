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

P-022's "after main commit / before final table commit" stages are expressed as
``after_first_table_write`` and ``before_final_table_write``, because the writer
now emits ``math_main`` LAST (it is the statement that allocates caching_tick,
so it is kept adjacent to the COMMIT — see math_writer.py). The two stages still
bracket the same seam: one table written, and all-but-the-last written.
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
    "after_first_table_write",
    "before_final_table_write",
    "after_all_writes_before_cache",
]


class Child:
    """A real poller subprocess whose stdout markers the test can await.

    ``stages`` holds the ``STAGE <name>`` markers; ``lines`` holds EVERY stdout
    line in order, so a test can assert the ORDER of the child's own
    acknowledgements (``GATE run_engine`` before ``WM_ACK``, and so on).
    """

    def __init__(self, pg_url, stage, days=1.0, tmp_path=None,
                 ownership_latch_dir=None, math_env=MATH_ENV,
                 legacy_writes=False):
        env = dict(os.environ)
        env["PYTHONPATH"] = _DELPHI_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        if tmp_path is not None:
            env["POLIS_RECOVERY_DUMP_DIR"] = str(tmp_path / "errorconv")
        argv = [sys.executable, _CHILD, "--pg-url", pg_url,
                "--math-env", math_env, "--kill-stage", stage,
                "--poll-from-days-ago", str(days)]
        if ownership_latch_dir is not None:
            argv += ["--ownership-latch-dir", str(ownership_latch_dir)]
        if legacy_writes:
            argv += ["--legacy-writes"]
        self.proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            bufsize=1, env=env, cwd=_DELPHI_ROOT,
        )
        self.stages = []
        self.lines = []
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            self.lines.append(line)
            if line.startswith("STAGE "):
                self.stages.append(line.split(" ", 1)[1])

    def await_stage(self, stage, timeout=90.0):
        eventually(
            lambda: stage in self.stages,
            timeout=timeout,
            message=(f"child never reported stage {stage!r} "
                     f"(saw {self.stages}); stderr:\n{self._peek_stderr()}"),
        )

    def await_line(self, prefix, timeout=90.0):
        """Wait for a non-STAGE acknowledgement line and return it."""
        eventually(
            lambda: any(l.startswith(prefix) for l in self.lines),
            timeout=timeout,
            message=(f"child never printed a line starting {prefix!r} "
                     f"(saw {self.lines})"),
        )
        return next(l for l in self.lines if l.startswith(prefix))

    def line_index(self, prefix):
        for i, line in enumerate(self.lines):
            if line.startswith(prefix):
                return i
        raise AssertionError(f"no line starting {prefix!r} in {self.lines}")

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


def _spawn(children, pg_url, stage, days=1.0, tmp_path=None, **kwargs):
    c = Child(pg_url, stage, days=days, tmp_path=tmp_path, **kwargs)
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
    if stage == "after_poll":
        # The stage name claims the watermark ALREADY advanced.  The child
        # proves it (restart_child._install_after_poll_latch) and this is the
        # control that fails loudly if that acknowledgement was skipped.
        assert any(l.startswith("WM_ACK ") for l in victim.lines), (
            "after_poll must not be claimed without the watermark "
            f"acknowledgement: {victim.lines}"
        )
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


def test_after_poll_kill_point_is_latched_after_the_watermark_advance(
    engine, pg_url, children, tmp_path
):
    """The R05 "after poll/watermark advance, before any compute" kill point is
    ORDERED, not hoped for (review finding 4).

    ``_poll_votes_once`` submits to the pool BEFORE assigning ``_vote_wm``
    (``polismath/poller/service.py:437-448``) and ``_run_engine`` runs on a pool
    thread, so a hook on ``_run_engine`` alone can fire before the assignment.
    The child now gates ``_run_engine``, lets ``_poll_votes_once`` return,
    acknowledges the watermark it actually assigned, and only then names the
    stage.  Assert that whole sequence, including the exact watermark value.

    The ordering is DETERMINISTIC, not merely likely: the gate writes and
    flushes ``GATE run_engine`` before setting the event that unblocks
    ``WM_ACK``/``STAGE`` (``restart_child._install_after_poll_latch``).  Setting
    the event first — which it used to do — allowed the polling thread to
    interleave its two lines between the ``set()`` and the ``write()``, making
    this assertion flake on a harness detail rather than on the barrier it is
    testing (second-round review)."""
    seeded = seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    expected_wm = max(e["created"] for e in seeded.vote_events)

    victim = _spawn(children, pg_url, "after_poll", tmp_path=tmp_path)
    victim.await_stage("after_poll")

    # 1. work was really dispatched (so "before any compute" is not vacuous),
    # 2. the watermark was assigned and acknowledged AFTER that,
    # 3. only then was the stage named.
    ordered = [l for l in victim.lines
               if l.startswith(("GATE run_engine", "WM_ACK ",
                                "STAGE after_poll"))]
    assert [l.split(" ", 1)[0] for l in ordered] == ["GATE", "WM_ACK", "STAGE"], (
        f"expected dispatch -> watermark ack -> stage marker exactly once each, "
        f"saw {victim.lines}"
    )
    gate = victim.line_index("GATE run_engine")
    ack = victim.line_index("WM_ACK ")
    marker = victim.line_index("STAGE after_poll")
    assert gate < ack < marker, (
        f"expected dispatch -> watermark ack -> stage marker, saw "
        f"{victim.lines}"
    )
    # ...and neither bail-out path fired, so the acknowledgement is real.
    assert not any(l.startswith(("WM_NOT_ADVANCED", "NO_DISPATCH"))
                   for l in victim.lines), victim.lines
    acked = int(victim.await_line("WM_ACK ").split(" ", 1)[1])
    assert acked == expected_wm, (
        f"the child acknowledged watermark {acked}, but the newest seeded vote "
        f"is {expected_wm}: the poll cycle did not advance the watermark over "
        "the whole batch before the kill point"
    )

    victim.kill()

    # "before any compute": nothing was published at all.
    assert read_math_tables(engine, 1, MATH_ENV)["main"] is None, (
        "the kill point is before compute, so no generation may exist"
    )
    assert "DONE" not in victim.stages

    survivor = _spawn(children, pg_url, "none", tmp_path=tmp_path)
    survivor.wait_done()
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []


def test_legacy_kill_after_first_table_write_leaves_a_mixed_generation(
    engine, pg_url, children, tmp_path
):
    """The seam itself, asserted directly: a kill between the three writes DOES
    leave the first table ahead of the other two.  (Recovery is the test
    above; this one pins the intermediate state so the defect is documented
    rather than inferred.)"""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)

    victim = _spawn(children, pg_url, "after_first_table_write", tmp_path=tmp_path,
                    legacy_writes=True)
    victim.await_stage("after_first_table_write")
    victim.kill()

    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables["bidtopid"] is not None, "math_bidtopid committed on its own"
    assert tables["main"] is None and tables["ptptstats"] is None, (
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
    """Kill the process after the first table commit for a DORMANT conversation
    using the legacy writer, then restart the production writer with no new
    votes. It must discover and repair the preexisting mixed generation outside
    its lookback."""
    _seed_dormant(engine, zid=2)

    # The conversation was active when the poller last ran (wide lookback).
    victim = _spawn(children, pg_url, "after_first_table_write", days=30.0,
                    tmp_path=tmp_path, legacy_writes=True)
    victim.await_stage("after_first_table_write")
    victim.kill()
    assert read_math_tables(engine, 2, MATH_ENV)["bidtopid"] is not None

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

    victim = _spawn(children, pg_url, "after_first_table_write", days=30.0,
                    tmp_path=tmp_path, legacy_writes=True)
    victim.await_stage("after_first_table_write")
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
            child.await_stage("after_first_table_write", timeout=5.0)

    def test_the_after_poll_latch_refuses_to_claim_an_unadvanced_watermark(
        self, engine, pg_url, children, tmp_path
    ):
        """The after_poll latch's own control: point it at a database whose
        only conversation is OUTSIDE the lookback, so the poll returns no rows
        and the watermark cannot advance.  The child must exit with the
        watermark code and must NOT name the stage — otherwise the stage name
        would mean nothing."""
        _seed_dormant(engine, zid=2)
        child = _spawn(children, pg_url, "after_poll", days=1.0,
                       tmp_path=tmp_path)
        rc = child.proc.wait(timeout=90)
        assert rc == 5, (
            f"expected EXIT_WATERMARK_NOT_ADVANCED (5), got {rc}; "
            f"stdout: {child.lines}"
        )
        assert "after_poll" not in child.stages, (
            "NEGATIVE CONTROL FAILED: the child named the after_poll stage "
            "even though the watermark never advanced"
        )
        assert any(l.startswith("WM_NOT_ADVANCED") for l in child.lines), (
            child.lines
        )

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


@pytest.mark.parametrize("stage", ["after_first_table_write", "before_final_table_write"])
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
