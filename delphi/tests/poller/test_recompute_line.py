"""The recompute line (``math_poller.recompute/1``): one structured line per
published recompute of a conversation, with how long each part took.

The poller's own path runs on the public vw fixture: the worker pool,
``MathPollerService._handle_zid`` / ``_run_engine``, ``Conversation.recompute``
and ``MathWriter``, first cold (a rebuild from the whole history) and then warm
(the cached conversation updated by a batch of the fixture's last votes). A
MagicMock stands in for the Postgres client, so nothing is written anywhere.
The fixture's votes are the public export's (agree = +1), converted through
the vote convention module, as the load test does.
"""

import csv
import json
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from polismath.poller import recompute_line
from polismath.poller.admission import MemoryAdmission
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import VOTES, CoalescedBatch
from polismath.utils.vote_convention import EXPORT_AGREE_VALUE, semantic_vote

FIXTURE = Path(__file__).resolve().parents[2] / "real_data" / "r6vbnhffkxbd7ifmfbdrd-vw"
ZID = 9301
HELD_BACK = 200  # the fixture's last votes, delivered as the warm batch

#: Every field the line carries, and nothing else: counts, seconds, a tick,
#: closed words and the conversation id. No comment text, no participant id.
KEYS = {
    "schema", "label", "zid", "load", "math_tick", "queue_wait_s", "prepare_s",
    "recompute_s", "recompute_cpu_s", "encode_s", "write_s", "payload_bytes",
    "participants", "comments", "total_votes", "batch_votes", "batch_moderation",
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


class _Lines(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)


@pytest.fixture
def lines():
    handler = _Lines()
    log = recompute_line._line_logger()
    log.addHandler(handler)
    try:
        yield handler.records
    finally:
        log.removeHandler(handler)


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


def _parse(record):
    assert record.levelno == logging.INFO
    text = record.getMessage()
    assert text.startswith("{") and text.endswith("}"), text  # bare JSON, nothing else
    body = json.loads(text)
    assert set(body) == KEYS
    assert body["schema"] == "math_poller.recompute/1"
    return body


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


def test_one_line_per_published_recompute_cold_then_warm(lines, tmp_path):
    votes = _fixture_votes()
    history, batch = votes[:-HELD_BACK], votes[-HELD_BACK:]
    svc, pg = _service(history, tmp_path)
    try:
        assert svc.submit_rebuild(ZID)
        assert svc._pool.join(timeout=300)
        assert len(lines) == 1
        cold = _parse(lines[0])
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
        assert len(lines) == 2
        warm = _parse(lines[1])
        participants, comments, cells = _sizes(votes)
        assert warm["zid"] == ZID and warm["load"] == "warm"
        assert warm["math_tick"] == 42
        assert (warm["participants"], warm["comments"], warm["total_votes"]) == (
            participants, comments, cells)
        assert warm["total_votes"] == svc._convs[ZID].vote_stats["n_votes"]
        assert warm["batch_votes"] == HELD_BACK and warm["batch_moderation"] == 0
        _check_timing(warm, pooled=True)
        assert pg.write_math_main.call_count == 2
    finally:
        svc._pool.shutdown()


def test_a_direct_rebuild_has_no_queue_wait(lines, tmp_path):
    svc, pg = _service(_fixture_votes(), tmp_path)
    svc.rebuild_one(ZID)  # the large worker's path: no pool, so no queue
    (record,) = lines
    body = _parse(record)
    assert body["load"] == "cold" and body["math_tick"] == 41
    _check_timing(body, pooled=False)


class _Broken:
    def info(self, *args, **kwargs):
        raise RuntimeError("the line logger is broken")


@pytest.mark.parametrize("where", ["logger", "line"])
def test_a_logging_failure_never_fails_the_recompute(where, lines, tmp_path, monkeypatch):
    if where == "logger":
        monkeypatch.setattr(recompute_line, "_line_logger", lambda: _Broken())
    else:
        def broken(*args, **kwargs):
            raise ValueError("the line cannot be built")
        monkeypatch.setattr(recompute_line, "build_line", broken)
    svc, pg = _service(_fixture_votes(), tmp_path)
    assert svc._handle_zid(ZID, CoalescedBatch(rebuild=True)) is True
    assert pg.write_math_main.call_count == 1  # published
    assert ZID in svc._convs  # and cached
    assert svc._retry_counts == {}
    assert list(tmp_path.iterdir()) == []  # no error dump
    assert lines == []


def test_no_line_when_the_publication_fails(lines, tmp_path):
    svc, pg = _service(_fixture_votes(), tmp_path)
    pg.write_math_main.side_effect = RuntimeError("write failed")
    assert svc._handle_zid(ZID, CoalescedBatch(rebuild=True)) is False
    assert lines == []
