"""The recompute line (``math_poller.recompute/1``): one structured line per
published recompute of a conversation, with how long each part took.

The poller's own path runs on the public vw fixture: the worker pool,
``MathPollerService._handle_zid`` / ``_run_engine``, ``Conversation.recompute``
and ``MathWriter``, first cold (a rebuild from the whole history) and then warm
(the cached conversation updated by a batch of the fixture's last votes). A
MagicMock stands in for the Postgres client, so nothing is written anywhere.
The fixture's votes are the public export's (agree = +1), converted through
the vote convention module, as the load test does.

The line is handed to a bounded queue and written by one background thread,
so a sink that stalls, fails or dies never holds a pool thread: those cases,
a full queue and interpreter exit are tested here with a sink the test owns.
"""

import csv
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from polismath.poller import recompute_line
from polismath.poller.admission import MemoryAdmission
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import REBUILD, VOTES, CoalescedBatch, ConversationWorkerPool
from polismath.utils.vote_convention import EXPORT_AGREE_VALUE, semantic_vote

DELPHI = Path(__file__).resolve().parents[2]
FIXTURE = DELPHI / "real_data" / "r6vbnhffkxbd7ifmfbdrd-vw"
ZID = 9301
HELD_BACK = 200  # the fixture's last votes, delivered as the warm batch

#: Every field the line carries, and nothing else: counts, seconds, a tick,
#: times, closed words and the conversation id. No comment text, no
#: participant id.
KEYS = {
    "schema", "label", "zid", "load", "math_tick", "queue_wait_s", "prepare_s",
    "recompute_s", "recompute_cpu_s", "encode_s", "write_s", "payload_bytes",
    "participants", "comments", "total_votes", "batch_votes", "batch_moderation",
    "published_ms", "lines_dropped",
}
SECONDS = ("prepare_s", "recompute_s", "recompute_cpu_s", "encode_s", "write_s")


def _fixture_votes():
    (path,) = sorted(FIXTURE.glob("*-votes.csv"))
    with open(path) as f:
        rows = list(csv.DictReader(f))
    votes = [{
        "zid": ZID,
        "pid": int(r["voter-id"]),
        "tid": int(r["comment-id"]),
        # The export's convention, declared: agree = EXPORT_AGREE_VALUE.
        "vote": semantic_vote(int(r["vote"]), EXPORT_AGREE_VALUE),
        "created": int(r["timestamp"]) * 1000,
    } for r in rows]
    votes.sort(key=lambda v: v["created"])
    return votes


def _sizes(votes):
    return (len({v["pid"] for v in votes}), len({v["tid"] for v in votes}),
            len({(v["pid"], v["tid"]) for v in votes}))


class _Sink:
    """Stands in for standard error: collects lines, and can block every
    write until released, fail, or kill the thread that writes."""

    def __init__(self):
        self.lines = []
        self.entered = threading.Event()
        self.released = threading.Event()
        self.released.set()
        self.failure = None

    def block(self):
        self.released.clear()

    def release(self):
        self.released.set()

    def write(self, data):
        self.entered.set()
        assert self.released.wait(60), "the test never released its sink"
        if self.failure is not None:
            failure, self.failure = self.failure, None
            raise failure
        self.lines.append(data.decode())


@pytest.fixture
def sink(monkeypatch):
    recompute_line._reset()
    s = _Sink()
    monkeypatch.setattr(recompute_line, "_write", s.write)
    try:
        yield s
    finally:
        s.release()
        recompute_line.drain(5)
        recompute_line._reset()


def _bodies(sink):
    assert recompute_line.drain(10), "the lines were not written"
    out = []
    for text in sink.lines:
        assert text.startswith("{") and text.endswith("}\n"), text  # bare JSON, one line
        body = json.loads(text)
        assert set(body) == KEYS
        assert body["schema"] == "math_poller.recompute/1"
        out.append(body)
    return out


def _service(history, tmp_path):
    pg = MagicMock()
    pg.load_math_main.return_value = None
    pg.poll_votes.return_value = history
    pg.poll_moderation.return_value = {
        "mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
    pg.increment_math_tick.side_effect = [41, 42, 43]
    config = PollerConfig(math_env="python", retry_cap=0, dump_dir=str(tmp_path))
    # No memory limit: the reservation never waits and never reads sizes.
    admission = MemoryAdmission.from_config(config, cgroup_fn=lambda: None)
    return MathPollerService(pg, config, admission=admission), pg


def _check_timing(body, *, pooled):
    for key in SECONDS:
        assert isinstance(body[key], float), key
        assert 0 < body[key] < 600, (key, body[key])
    # Thread CPU of the worker thread over the recompute, never more than
    # the wall time it ran in (plus clock granularity).
    assert body["recompute_cpu_s"] <= body["recompute_s"] + 0.01
    if pooled:
        assert isinstance(body["queue_wait_s"], float)
        assert 0 <= body["queue_wait_s"] < 600
    else:
        assert body["queue_wait_s"] is None
    assert isinstance(body["payload_bytes"], int) and body["payload_bytes"] > 0
    assert body["lines_dropped"] == 0


def test_one_line_per_published_recompute_cold_then_warm(sink, tmp_path):
    votes = _fixture_votes()
    history, batch = votes[:-HELD_BACK], votes[-HELD_BACK:]
    svc, pg = _service(history, tmp_path)
    before_ms = int(time.time() * 1000)
    try:
        assert svc.submit_rebuild(ZID)
        assert svc._pool.join(timeout=300)
        (cold,) = _bodies(sink)
        participants, comments, cells = _sizes(history)
        assert cold["zid"] == ZID and cold["label"] == "python"
        assert cold["load"] == "cold"
        assert cold["math_tick"] == 41
        assert (cold["participants"], cold["comments"], cold["total_votes"]) == (
            participants, comments, cells)
        assert cold["batch_votes"] == 0 and cold["batch_moderation"] == 0
        _check_timing(cold, pooled=True)

        assert svc._pool.submit(ZID, VOTES, batch)
        assert svc._pool.join(timeout=300)
        _, warm = _bodies(sink)
        participants, comments, cells = _sizes(votes)
        assert warm["zid"] == ZID and warm["load"] == "warm"
        assert warm["math_tick"] == 42
        assert (warm["participants"], warm["comments"], warm["total_votes"]) == (
            participants, comments, cells)
        assert warm["total_votes"] == svc._convs[ZID].vote_stats["n_votes"]
        assert warm["batch_votes"] == HELD_BACK and warm["batch_moderation"] == 0
        _check_timing(warm, pooled=True)
        # The event time is taken when the publication finished, on the pool
        # thread, not when the line is written.
        after_ms = int(time.time() * 1000)
        assert before_ms <= cold["published_ms"] <= warm["published_ms"] <= after_ms
        assert pg.write_math_main.call_count == 2
    finally:
        svc._pool.shutdown()


def test_a_direct_rebuild_has_no_queue_wait(sink, tmp_path):
    svc, pg = _service(_fixture_votes(), tmp_path)
    svc.rebuild_one(ZID)  # the large worker's path: no pool, so no queue
    (body,) = _bodies(sink)
    assert body["load"] == "cold" and body["math_tick"] == 41
    _check_timing(body, pooled=False)


@pytest.mark.parametrize("where", ["sink", "fields"])
def test_a_logging_failure_never_fails_the_recompute(where, sink, tmp_path, monkeypatch):
    if where == "sink":
        sink.failure = OSError("standard error is gone")
    else:
        def broken(*args, **kwargs):
            raise ValueError("the line cannot be built")
        monkeypatch.setattr(recompute_line, "fields", broken)
    svc, pg = _service(_fixture_votes(), tmp_path)
    assert svc._handle_zid(ZID, CoalescedBatch(rebuild=True)) is True
    assert pg.write_math_main.call_count == 1  # published
    assert ZID in svc._convs  # and cached
    assert svc._retry_counts == {}
    assert list(tmp_path.iterdir()) == []  # no error dump
    assert _bodies(sink) == []


def test_no_line_when_the_publication_fails(sink, tmp_path):
    svc, pg = _service(_fixture_votes(), tmp_path)
    pg.write_math_main.side_effect = RuntimeError("write failed")
    assert svc._handle_zid(ZID, CoalescedBatch(rebuild=True)) is False
    assert _bodies(sink) == []


# --------------------------------------------------------------------------- #
# A sink that stalls, a full queue, a sink thread that dies, interpreter exit.
# --------------------------------------------------------------------------- #
class _Conv:
    participant_count, comment_count, vote_stats = 3, 2, {"n_votes": 4}

    def recompute(self):
        return self


def _emit_one(zid):
    with recompute_line.span() as rec:
        recompute_line.timed_recompute(_Conv())
        recompute_line.note(math_tick=zid, encode_s=0.001, write_s=0.002, payload_bytes=100)
    recompute_line.emit(rec, zid=zid, label="python", load="cold", batch=CoalescedBatch())


def _bare_service(published, lock):
    """The real ``_run_engine`` with the computation and the memory
    accounting replaced by small recording stand-ins (cold work only)."""
    class Admission:
        def hold(self, zid):
            raise AssertionError("cold only")

        def unhold(self, zid):
            raise AssertionError("cold only")

        def release(self, reservation):
            pass

    svc = object.__new__(MathPollerService)
    svc.capacity = SimpleNamespace(routing=False)
    svc._convs_lock = threading.Lock()
    svc._convs = {}
    svc.admission = Admission()
    svc.config = SimpleNamespace(math_env="python")
    svc._reserve = lambda zid, conv, batch: zid

    def compute(zid, conv, batch):
        recompute_line.timed_recompute(_Conv())
        recompute_line.note(math_tick=zid, encode_s=0.0, write_s=0.0, payload_bytes=100)
        with lock:
            published.append(zid)

    svc._compute_and_publish = compute
    return svc


def _wait(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_a_blocked_sink_never_holds_the_pool(sink):
    """Four pool threads publish while standard error accepts nothing; a fifth
    conversation and a second batch of the first still run, and the pool
    drains, all while the sink stays blocked."""
    sink.block()
    published, lock = [], threading.Lock()
    svc = _bare_service(published, lock)
    pool = ConversationWorkerPool(lambda z, b: svc._run_engine(z, b), max_workers=4)
    try:
        for zid in range(1, 5):
            assert pool.submit(zid, REBUILD, [])
        assert _wait(lambda: len(published) == 4, 5)
        assert sink.entered.wait(5)  # the writer thread is stuck in the sink
        assert pool.submit(5, REBUILD, [])
        assert pool.submit(1, REBUILD, [])
        assert _wait(lambda: len(published) == 6, 5), published
        assert pool.join(timeout=5)
        assert not sink.released.is_set() and sink.lines == []
    finally:
        sink.release()
        pool.shutdown()
    assert sorted(b["zid"] for b in _bodies(sink)) == [1, 1, 2, 3, 4, 5]


def test_a_full_queue_drops_lines_and_counts_them(sink):
    recompute_line._reset(maxsize=4)
    sink.block()
    _emit_one(1)
    assert sink.entered.wait(5)  # line 1 is in the sink; the queue is empty
    started = time.perf_counter()
    for zid in range(2, 9):  # 4 fit, 3 are dropped
        _emit_one(zid)
    assert time.perf_counter() - started < 1.0  # no wait for space
    assert recompute_line.dropped_total() == 3
    assert recompute_line._queue.qsize() == 4
    sink.release()
    assert recompute_line.drain(5)
    _emit_one(99)
    bodies = _bodies(sink)
    assert [b["zid"] for b in bodies] == [1, 2, 3, 4, 5, 99]
    assert bodies[0]["lines_dropped"] == 0  # written before the drops
    assert all(b["lines_dropped"] == 3 for b in bodies[1:])  # the loss is visible


class _Die(BaseException):
    """Ends the thread that raises it (an Exception would be swallowed)."""


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_the_sink_thread_dying_never_stops_the_engine(sink, tmp_path, monkeypatch):
    monkeypatch.setattr(recompute_line, "RESTART_S", 3600.0)
    sink.failure = _Die("the writer thread ends")
    _emit_one(1)
    writer = recompute_line._consumer
    writer.join(5)
    assert not writer.is_alive()
    svc, pg = _service(_fixture_votes(), tmp_path)
    assert svc._handle_zid(ZID, CoalescedBatch(rebuild=True)) is True  # the engine carries on
    assert pg.write_math_main.call_count == 1
    assert recompute_line._queue.qsize() == 1  # its line waits; nothing raised
    monkeypatch.setattr(recompute_line, "RESTART_S", 0.0)
    _emit_one(2)  # starts a new writer thread
    assert [b["zid"] for b in _bodies(sink)] == [ZID, 2]


_EXIT_SCRIPT = """
import sys, threading
from polismath.poller import recompute_line
from polismath.poller.worker_pool import CoalescedBatch

class Conv:
    participant_count, comment_count, vote_stats = 3, 2, {"n_votes": 4}
    def recompute(self):
        return self

if sys.argv[1] == "blocked":
    recompute_line._write = lambda data: threading.Event().wait()
for zid in (1, 2, 3):
    with recompute_line.span() as rec:
        recompute_line.timed_recompute(Conv())
        recompute_line.note(math_tick=zid, encode_s=0.0, write_s=0.0, payload_bytes=1)
    recompute_line.emit(rec, zid=zid, label="python", load="cold", batch=CoalescedBatch())
"""


@pytest.mark.parametrize("mode", ["blocked", "working"])
def test_interpreter_exit_never_waits_on_the_sink(mode):
    """A process exits at once with its writer thread stuck in standard error
    (a daemon thread; the flush at exit is bounded), and with a working
    standard error the lines queued just before exit are written."""
    env = dict(os.environ, PYTHONPATH=str(DELPHI))
    started = time.monotonic()
    done = subprocess.run([sys.executable, "-c", _EXIT_SCRIPT, mode], cwd=DELPHI, env=env,
                          capture_output=True, text=True, timeout=60)
    elapsed = time.monotonic() - started
    assert done.returncode == 0, done.stderr[-2000:]
    lines = [json.loads(t) for t in done.stderr.splitlines()
             if t.startswith("{") and "math_poller.recompute/1" in t]
    if mode == "blocked":
        assert lines == []
        assert elapsed < recompute_line.EXIT_FLUSH_S + 20
    else:
        assert [b["zid"] for b in lines] == [1, 2, 3]
