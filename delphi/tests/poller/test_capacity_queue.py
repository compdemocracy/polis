"""Oversized conversations are jobs (P-073 r2): the small poller's queue
client (polismath/poller/capacity_queue.py), the enqueue on a would-not-fit
decision (service.py, promotion.py), its idempotence, the queue child
(polismath/poller/rebuild_child.py) and the capacity line's two queue counts.

Generated fixtures only; the queue is a fake that answers the closed
contract (the real SQL is covered in test_capacity_queue_postgres.py)."""

import json
import logging
import uuid
from unittest.mock import MagicMock

import psycopg2
import pytest

from polismath.database.postgres import Fingerprint
from polismath.job_child import EXIT_JOB_ENV_INVALID, EXIT_MANIFEST_UNBUILDABLE, EXIT_OK, EXIT_STAGE_FAILED
from polismath.poller import capacity_queue as cq
from polismath.poller.admission import MemoryAdmission, MemoryModel, OverBudget
from polismath.poller.capacity import (
    COUNT_KEYS,
    LARGE,
    NULLABLE_COUNT_KEYS,
    CapacityConfigError,
    CapacityRouter,
    CapacitySettings,
    Disposition,
    build_line,
    parse_line,
    validate_counts,
)
from polismath.poller.promotion import MAX_ENQUEUE_PER_TICK, SmallCapacityLoop
from polismath.poller.rebuild_child import (
    ChildRefused,
    check_child_label,
    check_math_config,
    check_skew,
    run,
)
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import CoalescedBatch

MB = 1024 * 1024
T0 = 1_790_000_000_000
SMALL_LABEL, STAGED = "python", "python-large"
HEARTBEAT_PHRASE = "math_poller readiness/1 role=primary progress=ok"
MODEL = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                    job_floor_mb=0)
COMMIT = "a" * 40


@pytest.fixture(autouse=True)
def _source_commit(monkeypatch):
    """The poller's own source commit: the admission config carries it and
    the child refuses any other (or none)."""
    from polismath.poller.readiness import COMMIT_ENV

    monkeypatch.setenv(COMMIT_ENV, COMMIT)


def sizes(need_mb):
    return (need_mb, 7, 3)


def cq_child_keys():
    from polismath.poller.rebuild_child import MATH_CONFIG_KEYS

    return MATH_CONFIG_KEYS


class FakeQueue:
    """The closed contract, in memory: one active job per scope, the
    existing one returned until it is finished (a finished job's scope is
    released, as the daemon does); the poison latch; the class depth in
    000024's shape; the receipt of a finished job."""

    def __init__(self):
        self.calls = []
        self.jobs = {}          # job_id -> {"scope", "state", "config", "staged_label"}
        self.fail = None
        self.depth = {"queued": 0, "leased": 0, "parked": 0, "dead": 0}
        self.receipts = {}      # job_id -> Receipt, once finalized
        self.poisoned = {}      # scope -> the latest dead job id

    def enqueue_math_rebuild(self, zid, *, config, staged_label, target_label):
        self.calls.append((zid, dict(config), staged_label, target_label))
        if self.fail is not None:
            raise self.fail
        scope = cq.scope_key(target_label, zid)
        for job_id, job in self.jobs.items():
            if job["scope"] == scope and job["state"] in cq.ACTIVE_STATES:
                return ("existing" if job["config"] == config else "conflict"), job_id
        if scope in self.poisoned:
            return "poisoned", self.poisoned[scope]
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = {"scope": scope, "state": "queued", "config": dict(config),
                             "staged_label": staged_label}
        self.depth["queued"] += 1
        return "enqueued", job_id

    def finish(self, job_id, fp=None):
        """The job succeeded and was finalized; ``fp`` is the staged bundle's
        fingerprint the manifest names (none: a receipt that binds nothing)."""
        job = self.jobs[job_id]
        job["state"] = "succeeded"
        self.depth["queued"] -= 1
        self.receipts[job_id] = cq.Receipt(
            job_id=job_id, state="succeeded", output_sha256="0" * 64,
            math_env=job["staged_label"], math_tick=getattr(fp, "math_tick", None),
            vote_hwm=getattr(fp, "lvt", None))

    def die(self, job_id):
        self.jobs[job_id]["state"] = "dead"
        self.depth["queued"] -= 1
        self.depth["dead"] += 1
        scope = self.jobs[job_id]["scope"]
        if sum(1 for j in self.jobs.values() if j["scope"] == scope and j["state"] == "dead") >= 3:
            self.poisoned[scope] = job_id

    def receipt(self, job_id):
        if job_id in self.receipts:
            return self.receipts[job_id]
        return cq.Receipt(job_id=job_id, state=self.jobs[job_id]["state"], output_sha256=None)

    def class_depth(self, worker_class="large"):
        return {"schema_version": "polis-queue/3", "outcome": "class_depth", "env": "test",
                "worker_class": worker_class, "oldest_unresolved_created_at": None,
                **self.depth}


class FakePg:
    def __init__(self):
        self.fps = {}
        self.promoted = []

    def query(self, sql, params=None):
        return [{"now": T0 + 10**6}]

    def math_fingerprints(self, zids, envs):
        return {k: v for k, v in self.fps.items() if k[0] in set(zids) and k[1] in set(envs)}

    def promote_bundle(self, zid, *, from_env, to_env, expected_target, expected_staged):
        self.fps[(zid, to_env)] = Fingerprint(1, expected_staged.lvt, expected_staged.modified + 1)
        self.promoted.append(zid)
        return 1


def service(*, routing=True, queue="fake", limit_mb=1000, dsn=None):
    """A small poller with a 900 MiB compute capacity; conversations above
    0.9 of it route."""
    adm = MemoryAdmission(limit_mb * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
    s = CapacitySettings(routing=routing, staged_label=STAGED, queue_dsn=dsn,
                         queue_env="test" if dsn else None)
    pg = FakePg()
    svc = MathPollerService(pg, PollerConfig(math_env=SMALL_LABEL), admission=adm,
                            capacity=CapacityRouter(adm, s))
    if queue == "fake":
        svc.capacity_queue = FakeQueue()
        if svc.capacity_loop is not None:
            svc.capacity_loop._queue = svc.capacity_queue
    return svc


def cold_touch(svc, zid, need_mb, monkeypatch):
    """A cold touch of ``zid`` sized at ``need_mb``: routed or computed."""
    monkeypatch.setattr("polismath.poller.service.read_conversation_sizes",
                        lambda pg, z: sizes(need_mb))
    svc._compute_and_publish = MagicMock()
    return svc._run_engine(zid, CoalescedBatch(votes=[{"created": T0}]))


# --------------------------------------------------------------------------- #
# 1. The enqueue on a would-not-fit decision
# --------------------------------------------------------------------------- #
class TestEnqueueOnWouldNotFit:
    def test_a_cold_large_touch_becomes_one_job(self, monkeypatch):
        svc = service()
        assert cold_touch(svc, 7, 850, monkeypatch) is True       # routed, not computed
        svc._compute_and_publish.assert_not_called()
        q = svc.capacity_queue
        assert len(q.calls) == 1
        zid, config, staged, target = q.calls[0]
        assert (zid, staged, target) == (7, STAGED, SMALL_LABEL)
        assert config["need_bytes"] == 850 * MB and config["input_through_ms"] == T0
        assert config["staged_label"] == STAGED and config["target_label"] == SMALL_LABEL
        assert config["binding"] == svc.capacity.binding()
        (job_id,) = q.jobs
        assert svc.capacity.record(7).job_id == job_id          # kept on the record
        assert q.jobs[job_id]["scope"] == "math:python:7"

    def test_a_memory_refusal_classified_large_becomes_one_job(self, monkeypatch):
        svc = service()
        monkeypatch.setattr("polismath.poller.service.read_conversation_sizes",
                            lambda pg, z: sizes(850))
        routed = svc._capacity_refusal(7, CoalescedBatch(votes=[{"created": T0}]),
                                       OverBudget("refused", need_bytes=850 * MB))
        assert routed is True
        assert [c[0] for c in svc.capacity_queue.calls] == [7]
        assert svc.capacity.record(7).job_id in svc.capacity_queue.jobs

    def test_a_small_touch_is_computed_and_never_enqueued(self, monkeypatch):
        svc = service()
        assert cold_touch(svc, 7, 100, monkeypatch) is False
        svc._compute_and_publish.assert_called_once()
        assert svc.capacity_queue.calls == []

    def test_exceeds_largest_is_routed_but_never_a_job(self, monkeypatch):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        svc = MathPollerService(FakePg(), PollerConfig(math_env=SMALL_LABEL), admission=adm,
                                capacity=CapacityRouter(adm, CapacitySettings(
                                    routing=True, staged_label=STAGED, large_budget_mb=600)))
        svc.capacity_queue = FakeQueue()
        assert cold_touch(svc, 7, 850, monkeypatch) is True
        assert svc.capacity_queue.calls == []
        assert svc.capacity.counts()["exceeds_largest"] == 1

    def test_routing_off_never_touches_the_queue(self, monkeypatch):
        svc = service(routing=False, queue=None)
        assert svc.capacity_queue is None and svc.capacity_loop is None
        svc.capacity_queue = FakeQueue()
        assert cold_touch(svc, 7, 850, monkeypatch) is False       # computed as before
        svc._compute_and_publish.assert_called_once()
        assert svc.capacity_queue.calls == []

    def test_a_queue_failure_never_changes_the_routing_outcome(self, monkeypatch, caplog):
        svc = service()
        svc.capacity_queue.fail = psycopg2.OperationalError("down")
        with caplog.at_level(logging.ERROR):
            assert cold_touch(svc, 7, 850, monkeypatch) is True
        svc._compute_and_publish.assert_not_called()
        assert svc.capacity.is_routed(7) and svc.capacity.record(7).job_id is None
        assert "enqueue of zid=7 failed (OperationalError)" in caplog.text
        assert "down" not in caplog.text                          # the class only

    def test_without_a_queue_dsn_routing_still_works_and_says_so(self, monkeypatch, caplog):
        with caplog.at_level(logging.ERROR):
            svc = service(queue=None)
        assert svc.capacity_queue is None and svc.capacity_loop is not None
        assert "routing is on without MATH_CAPACITY_QUEUE_DSN" in caplog.text
        assert cold_touch(svc, 7, 850, monkeypatch) is True
        assert svc.capacity.record(7).job_id is None

    def test_a_queue_dsn_builds_a_client_that_never_connects_at_construction(self):
        svc = service(queue=None, dsn="postgresql://generated:generated@127.0.0.1:1/generated")
        assert isinstance(svc.capacity_queue, cq.QueueClient)
        assert svc.capacity_queue.describe() == "env=test"
        assert svc.capacity_loop._queue is svc.capacity_queue


# --------------------------------------------------------------------------- #
# 2. Idempotence
# --------------------------------------------------------------------------- #
class TestIdempotence:
    def test_new_input_while_a_job_is_active_finds_the_same_job(self, monkeypatch):
        svc = service()
        cold_touch(svc, 7, 850, monkeypatch)
        (job_id,) = svc.capacity_queue.jobs
        # New input: the record advances, the queue is asked again, the
        # active job is found, not duplicated.
        svc._run_engine(7, CoalescedBatch(votes=[{"created": T0 + 5}]))
        assert len(svc.capacity_queue.calls) == 2 and set(svc.capacity_queue.jobs) == {job_id}
        assert svc.capacity.record(7).job_id == job_id
        assert svc.capacity.record(7).input_through_ms == T0 + 5

    def test_the_promotion_pass_asks_again_only_while_nothing_covers_the_input(self):
        svc = service()
        router, q, pg = svc.capacity, svc.capacity_queue, svc._pg
        router.observe(7, sizes=sizes(850), input_ms=T0)
        svc.capacity_loop.tick()                                   # nothing staged: a job
        assert len(q.calls) == 1
        (job_id,) = q.jobs
        svc.capacity_loop.tick()                                   # still active: found again
        assert len(q.calls) == 2 and set(q.jobs) == {job_id}
        # The child staged it covering the input and the daemon finalized
        # the job: no job is asked for.
        pg.fps[(7, STAGED)] = Fingerprint(1, T0, T0 + 5)
        q.finish(job_id, pg.fps[(7, STAGED)])
        svc.capacity_loop.tick()
        assert len(q.calls) == 2
        # Promotion is off here: the covering bundle waits (pending), not demand.
        assert router.counts()["pending_promotion"] == 1 and pg.promoted == []
        # New input after the job finished: a new job, under the same scope.
        router.advance(7, T0 + 50)
        svc.capacity_loop.tick()
        assert len(q.calls) == 3 and len(q.jobs) == 2
        assert router.record(7).job_id != job_id

    def test_the_restage_nonce_leads_to_one_fresh_job(self):
        svc = service()
        router, q, pg = svc.capacity, svc.capacity_queue, svc._pg
        router.observe(7, sizes=sizes(850), input_ms=T0)
        pg.fps[(7, STAGED)] = Fingerprint(1, T0, T0 + 5)
        svc.capacity_loop.tick()
        assert q.calls == []                                       # covered: no job
        svc.capacity.settings = CapacitySettings(routing=True, staged_label=STAGED,
                                                 restage="ab" * 8)
        svc.capacity_loop.settings = svc.capacity.settings
        svc.capacity_loop.tick()                                   # mark on the DB clock
        assert len(q.calls) == 1 and router.record(7).input_through_ms == T0 + 10**6
        svc.capacity_loop.tick()                                   # the same nonce: no re-mark
        assert len(q.calls) == 2 and len(q.jobs) == 1

    def test_the_pass_asks_for_at_most_a_page_per_tick(self):
        svc = service()
        for zid in range(1, MAX_ENQUEUE_PER_TICK + 6):
            svc.capacity.observe(zid, sizes=sizes(850), input_ms=T0)
        svc.capacity_loop.tick()
        assert len(svc.capacity_queue.calls) == MAX_ENQUEUE_PER_TICK
        svc.capacity_loop.tick()
        assert len(svc.capacity_queue.jobs) == MAX_ENQUEUE_PER_TICK + 5

    def test_the_loop_contains_a_queue_failure(self, caplog):
        svc = service()
        svc.capacity.observe(7, sizes=sizes(850), input_ms=T0)
        svc.capacity_queue.fail = RuntimeError("queue down")
        with caplog.at_level(logging.ERROR):
            svc.capacity_loop.tick()
        assert "enqueue of zid=7 failed (RuntimeError)" in caplog.text
        assert svc.capacity_loop.state() == {"queue": True, "enqueued_total": 0}

    def test_the_job_id_survives_the_state_file(self, tmp_path):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        path = str(tmp_path / "capacity.json")
        router = CapacityRouter(adm, CapacitySettings(routing=True, state_path=path))
        router.observe(7, sizes=sizes(850), input_ms=T0)
        router.set_job(7, "0" * 32)
        again = CapacityRouter(adm, CapacitySettings(routing=True, state_path=path))
        assert again.record(7).job_id == "0" * 32
        with pytest.raises(ValueError):
            Disposition.from_dict({"zid": 7, "disposition": LARGE, "need_bytes": 1, "job_id": 5})


# --------------------------------------------------------------------------- #
# 3. The child: exactly one conversation, staged
# --------------------------------------------------------------------------- #
class FakeDaemon:
    """Mints one attempt's environment and frame the way the polis-jobs
    daemon does for a math_rebuild job."""

    def __init__(self, root, *, zid=7, config=None, math_env=STAGED, stage="math_rebuild"):
        self.job_id, self.run_id, self.attempt_id = (str(uuid.uuid4()) for _ in range(3))
        self.attempt_dir = root / f"attempt-{self.attempt_id}"
        self.attempt_dir.mkdir(parents=True)
        self.manifest = self.attempt_dir / "output-manifest.json"
        self.frame_path = self.attempt_dir / "frame.json"
        self.frame = {
            "schema": "polis-jobs.frame/1", "env": "test", "zid": zid, "report_id": None,
            "job_id": self.job_id, "run_id": self.run_id, "attempt_id": self.attempt_id,
            "lease_epoch": "3", "stage": stage, "phase": "run",
            "config": {"staged_label": STAGED, "target_label": SMALL_LABEL, "need_bytes": 850 * MB,
                       "input_through_ms": T0, "binding": "0" * 16, "source_commit": COMMIT}
            if config is None else config,
            "inputs": {"math_env": math_env, "requested_math_tick": None},
            "provider": {"batch_id": None},
        }
        self.frame_path.write_text(json.dumps(self.frame))

    def env(self, **extra):
        env = {"DELPHI_JOB_ID": self.job_id, "DELPHI_RUN_ID": self.run_id,
               "DELPHI_ATTEMPT_ID": self.attempt_id, "DELPHI_LEASE_EPOCH": "3",
               "DELPHI_STAGE": self.frame["stage"], "DELPHI_OUTPUT_MANIFEST": str(self.manifest),
               "DELPHI_FRAME": str(self.frame_path), "MATH_ENV": STAGED}
        env.update(extra)
        return env


class FakeService:
    def __init__(self, pg, *, fail=None):
        self.pg = pg
        self.rebuilt = []
        self.fail = fail

    def rebuild_one(self, zid):
        if self.fail is not None:
            raise self.fail
        self.rebuilt.append(zid)
        self.pg.fps[(zid, STAGED)] = Fingerprint(4, T0 + 1, T0 + 9)


def child(daemon, *, env=None, job_arg="", commit=COMMIT, limit_mb=4096, service_fail=None,
          settings=None, label=STAGED):
    pg = FakePg()
    svc = FakeService(pg, fail=service_fail)
    adm = MemoryAdmission(limit_mb * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
    locks = []
    code = run(job_arg, label=label, environ=env if env is not None else daemon.env(),
               source_commit=commit, admission_fn=lambda: adm,
               build_fn=lambda a: (svc, pg), lock_fn=lambda: locks.append("held") or "conn",
               settings=settings)
    return code, svc, locks


class TestTheChild:
    def test_computes_exactly_the_frames_conversation_and_stages_it(self, tmp_path, capsys):
        d = FakeDaemon(tmp_path, zid=7)
        code, svc, locks = child(d)
        assert code == EXIT_OK and svc.rebuilt == [7] and locks == ["held"]
        m = json.loads(d.manifest.read_text())
        assert (m["stage"], m["phase"], m["outcome"]) == ("math_rebuild", "run", "succeeded")
        assert m["job_id"] == d.job_id and m["attempt_id"] == d.attempt_id
        assert m["inputs"] == {"math_env": STAGED, "math_tick": 4, "math_caching_tick": None,
                               "comment_set_sha256": None, "vote_hwm": T0 + 1}
        assert m["outputs"] == [] and m["recheck_after"] is None
        err = capsys.readouterr().err
        assert "staged zid=7 under python-large: tick=4" in err
        assert HEARTBEAT_PHRASE not in err and "discovery_stale" not in err

    def test_the_job_argument_must_name_the_daemons_job(self, tmp_path):
        d = FakeDaemon(tmp_path)
        code, svc, locks = child(d, job_arg=str(uuid.uuid4()))
        assert code == EXIT_JOB_ENV_INVALID and svc.rebuilt == [] and locks == []
        assert child(d, job_arg=d.job_id)[0] == EXIT_OK

    def test_a_frame_of_another_stage_is_refused(self, tmp_path):
        d = FakeDaemon(tmp_path, stage="delphi_full_pipeline")
        code, svc, _ = child(d)
        assert code == EXIT_JOB_ENV_INVALID and svc.rebuilt == []

    def test_version_skew_is_refused_before_anything_runs(self, tmp_path, capsys):
        d = FakeDaemon(tmp_path)
        code, svc, locks = child(d, commit="b" * 40)
        assert code == EXIT_JOB_ENV_INVALID and svc.rebuilt == [] and locks == []
        assert "version skew" in capsys.readouterr().err
        assert child(d, commit=None)[0] == EXIT_JOB_ENV_INVALID      # set vs unset is skew
        with pytest.raises(ChildRefused):
            check_skew({"source_commit": None}, COMMIT)
        with pytest.raises(ChildRefused, match="no source_commit"):
            check_skew({}, COMMIT)                                 # absent: refused (finding 3)

    @pytest.mark.parametrize("mutation", [
        ("drop", "source_commit"), ("drop", "target_label"), ("drop", "need_bytes"),
        ("drop", "binding"), ("drop", "input_through_ms"), ("set", "need_bytes", 0),
        ("set", "need_bytes", "850"), ("set", "input_through_ms", -1), ("set", "binding", ""),
        ("set", "source_commit", "not-a-commit"), ("set", "target_label", STAGED),
        ("set", "staged_label", "other"), ("add", "manifest_uri", "s3://x"),
        ("delphi",), ("untyped",),
    ])
    def test_the_typed_math_config_is_checked_whole_before_anything_runs(self, tmp_path,
                                                                          mutation, capsys):
        """Finding 3: every key the daemon carries is checked by the child;
        a frame without the typed config never computes."""
        base = {"staged_label": STAGED, "target_label": SMALL_LABEL, "need_bytes": 850 * MB,
                "input_through_ms": T0, "binding": "0" * 16, "source_commit": COMMIT}
        config = dict(base)
        if mutation[0] == "drop":
            del config[mutation[1]]
        elif mutation[0] == "set":
            config[mutation[1]] = mutation[2]
        elif mutation[0] == "add":
            config[mutation[1]] = mutation[2]
        elif mutation[0] == "delphi":
            config = {"include_moderation": False, "exclude_comment_selections": True,
                      "model": None, "batch_size": None}
        else:
            config = {"need_bytes": 1, "staged_label": STAGED}
        d = FakeDaemon(tmp_path, config=config)
        code, svc, locks = child(d)
        assert code == EXIT_JOB_ENV_INVALID and svc.rebuilt == [] and locks == []
        assert "refused:" in capsys.readouterr().err and not d.manifest.exists()
        with pytest.raises(ChildRefused):
            check_math_config(config, label=STAGED, input_label=STAGED)
        ok = check_math_config(base, label=STAGED, input_label=STAGED)
        assert (ok.need_bytes, ok.source_commit, ok.target_label) == (850 * MB, COMMIT, SMALL_LABEL)
        with pytest.raises(ChildRefused, match="inputs.math_env"):
            check_math_config(base, label=STAGED, input_label="python")
        null_mark = check_math_config({**base, "input_through_ms": None}, label=STAGED,
                                      input_label=STAGED)
        assert null_mark.input_through_ms is None

    def test_the_frame_the_daemon_writes_drives_the_child(self, tmp_path):
        """The golden frame (fixtures/queue/math_rebuild_frame.json) is what
        queue-rs ``child::frame`` writes for a rebuild (its unit test pins it
        to the same file): the child accepts it as is."""
        from pathlib import Path

        golden = json.loads((Path(__file__).parent / "fixtures" / "queue"
                             / "math_rebuild_frame.json").read_text())
        assert set(golden["config"]) == set(cq_child_keys())
        d = FakeDaemon(tmp_path, zid=golden["zid"], config=golden["config"])
        code, svc, _ = child(d, commit=golden["config"]["source_commit"])
        assert code == EXIT_OK and svc.rebuilt == [golden["zid"]]

    def test_the_label_is_bound_to_the_frame_and_never_a_served_one(self, tmp_path):
        d = FakeDaemon(tmp_path, math_env="python-large")
        assert child(d, env=d.env(MATH_ENV="other"), label="other")[0] == EXIT_JOB_ENV_INVALID
        for bad in ("prod", "python", ""):
            with pytest.raises(ChildRefused):
                check_child_label(bad, served_env="prod", target_label=None, env={})
        with pytest.raises(ChildRefused, match="target label"):
            check_child_label("python-large", served_env="prod", target_label="python-large",
                              env={})
        with pytest.raises(ChildRefused):
            check_child_label("python-large", served_env="prod", target_label=None,
                              env={"MATH_POLLER_ALLOW_SERVED_ENV": "1"})
        check_child_label("python-large", served_env="prod", target_label="python", env={})

    @pytest.mark.parametrize("extra", [{"MATH_CAPACITY_ROUTING": "1"}, {"MATH_CAPACITY_PROMOTE": "1"},
                                       {"MATH_CAPACITY_RESTAGE": "ab" * 8}, {"MATH_BACKFILL": "1"}])
    def test_the_small_pollers_settings_are_refused(self, tmp_path, extra):
        d = FakeDaemon(tmp_path)
        code, svc, _ = child(d, env=d.env(**extra))
        assert code == EXIT_JOB_ENV_INVALID and svc.rebuilt == []

    def test_a_declared_budget_above_its_own_is_refused(self, tmp_path):
        d = FakeDaemon(tmp_path)
        code, svc, locks = child(d, settings=CapacitySettings(large_budget_mb=8192), limit_mb=4096)
        assert code == EXIT_JOB_ENV_INVALID and svc.rebuilt == [] and locks == []
        assert child(d, settings=CapacitySettings(large_budget_mb=2048), limit_mb=4096)[0] == EXIT_OK

    def test_a_conversation_above_its_capacity_is_a_failed_attempt(self, tmp_path, capsys):
        d = FakeDaemon(tmp_path)
        code, svc, locks = child(d, limit_mb=500)                 # capacity 400 MiB < 850
        assert code == EXIT_STAGE_FAILED and svc.rebuilt == [] and locks == []
        assert "does not fit" in capsys.readouterr().err

    def test_an_engine_failure_is_a_failed_attempt_without_a_manifest(self, tmp_path):
        d = FakeDaemon(tmp_path)
        code, svc, _ = child(d, service_fail=OverBudget("refused"))
        assert code == EXIT_STAGE_FAILED and not d.manifest.exists()

    def test_an_incomplete_staged_bundle_cannot_be_a_manifest(self, tmp_path):
        d = FakeDaemon(tmp_path)
        pg = FakePg()
        svc = FakeService(pg)
        svc.rebuild_one = lambda zid: pg.fps.__setitem__((zid, STAGED), Fingerprint(4, T0, T0, False))
        adm = MemoryAdmission(4096 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        code = run("", label=STAGED, environ=d.env(), source_commit=COMMIT,
                   admission_fn=lambda: adm, build_fn=lambda a: (svc, pg), lock_fn=lambda: "conn")
        assert code == EXIT_MANIFEST_UNBUILDABLE and not d.manifest.exists()

    def test_the_cli_refuses_the_resident_large_class(self, monkeypatch, capsys):
        from scripts import math_poller

        monkeypatch.setenv("MATH_CAPACITY_CLASS", "large")
        with pytest.raises(SystemExit) as exc:
            math_poller._refuse_large_class()
        assert exc.value.code == 2 and "--job" in capsys.readouterr().err
        monkeypatch.setenv("MATH_CAPACITY_CLASS", "huge")
        with pytest.raises(SystemExit):
            math_poller._refuse_large_class()
        monkeypatch.setenv("MATH_CAPACITY_CLASS", "small")
        math_poller._refuse_large_class()
        monkeypatch.delenv("MATH_CAPACITY_CLASS")
        math_poller._refuse_large_class()


# --------------------------------------------------------------------------- #
# 4. The capacity line's two counts
# --------------------------------------------------------------------------- #
class TestCapacityLineCounts:
    def test_the_counts_come_from_the_queue_when_there_is_one(self):
        svc = service()
        svc.capacity.observe(7, sizes=sizes(850), input_ms=T0)   # one record, demand 1
        svc.capacity_queue.depth = {"queued": 3, "leased": 2, "parked": 1, "dead": 4}
        snap = svc.readiness_snapshot()
        c = snap["capacity"]
        assert (c["large_demand"], c["large_leased"], c["large_poisoned"]) == (3, 2, 0)
        assert set(c) == set(COUNT_KEYS) and "capacity_line" not in snap
        validate_counts(c)
        line = parse_line(build_line("primary", SMALL_LABEL, c))
        assert (line["large_demand"], line["large_leased"]) == (3, 2)

    def test_the_real_depth_reply_is_decoded_and_counted(self):
        """Finding 1: the reply 000024's pq_class_depth actually returns
        (leased, parked, oldest_unresolved_created_at), decoded and
        published; the stand-in's shape (running, oldest_created_at) is
        refused as a protocol error."""
        real = {"schema_version": "polis-queue/3", "outcome": "class_depth", "env": "test",
                "worker_class": "large", "queued": 2, "leased": 1, "parked": 0, "dead": 3,
                "oldest_unresolved_created_at": "2026-10-06T18:00:00+00:00"}
        assert cq.validate_depth(real) is real
        stand_in = {"schema_version": "polis-queue/2", "outcome": "class_depth", "env": "test",
                    "worker_class": "large", "queued": 2, "running": 1, "dead": 3,
                    "oldest_created_at": "2026-10-06T18:00:00+00:00"}
        with pytest.raises(cq.QueueProtocolError, match="queue_wire_depth_fields"):
            cq.validate_depth(stand_in)
        svc = service()
        svc.capacity.observe(7, sizes=sizes(850), input_ms=T0)
        svc.capacity_queue.class_depth = lambda worker_class="large": cq.validate_depth(real)
        c = svc.readiness_snapshot()["capacity"]
        assert (c["large_demand"], c["large_leased"]) == (2, 1)

    def test_a_poisoned_record_is_parked_and_counted(self, caplog):
        svc = service()
        router, q = svc.capacity, svc.capacity_queue
        svc.capacity_loop._source_commit = COMMIT            # the deploy this poller runs
        router.observe(7, sizes=sizes(850), input_ms=T0)
        for _ in range(3):
            svc.capacity_loop.tick()
            (job_id,) = [j for j, job in q.jobs.items() if job["state"] == "queued"]
            q.die(job_id)
        with caplog.at_level(logging.WARNING):
            svc.capacity_loop.tick()                               # the fourth ask: poisoned
        assert "zid=7 is poisoned" in caplog.text
        rec = router.record(7)
        assert rec.poisoned_commit == COMMIT and rec.job_id == job_id
        assert router.poisoned(7, COMMIT) and not router.poisoned(7, "b" * 40)
        asked = len(q.calls)
        svc.capacity_loop.tick()                                   # parked: not asked again
        assert len(q.calls) == asked and len(q.jobs) == 3
        c = svc.readiness_snapshot()["capacity"]
        assert (c["large_poisoned"], c["large_demand"]) == (1, 0)
        validate_counts(c)
        # A new deploy (another source commit) asks the queue again; the
        # queue still says poisoned: parked again, under the new commit.
        svc.capacity_loop._source_commit = "b" * 40
        svc.capacity_loop.tick()
        assert len(q.calls) == asked + 1 and router.record(7).poisoned_commit == "b" * 40
        svc.capacity_loop.tick()
        assert len(q.calls) == asked + 1
        # An operator's ruling: the restage nonce un-parks it; a job
        # admitted clears the park for good.
        q.poisoned.clear()
        svc.capacity.settings = CapacitySettings(routing=True, staged_label=STAGED,
                                                 restage="cd" * 8)
        svc.capacity_loop.settings = svc.capacity.settings
        svc.capacity_loop.tick()
        assert router.record(7).poisoned_commit is None and len(q.jobs) == 4
        assert svc.readiness_snapshot()["capacity"]["large_poisoned"] == 0

    def test_the_poison_park_survives_the_state_file(self, tmp_path):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        path = str(tmp_path / "capacity.json")
        router = CapacityRouter(adm, CapacitySettings(routing=True, state_path=path))
        router.observe(7, sizes=sizes(850), input_ms=T0)
        router.park_poisoned(7, "1" * 32, COMMIT)
        again = CapacityRouter(adm, CapacitySettings(routing=True, state_path=path))
        assert again.poisoned(7, COMMIT) and again.record(7).job_id == "1" * 32
        assert again.counts()["large_poisoned"] == 1
        with pytest.raises(ValueError):
            Disposition.from_dict({"zid": 7, "disposition": LARGE, "need_bytes": 1,
                                   "poisoned_commit": 5})

    def test_without_a_queue_demand_is_the_records_and_leased_is_null(self):
        svc = service(queue=None)
        svc.capacity.observe(7, sizes=sizes(850), input_ms=T0)
        c = svc.readiness_snapshot()["capacity"]
        assert (c["large_demand"], c["large_leased"]) == (1, None)
        validate_counts(c)
        parse_line(build_line("primary", SMALL_LABEL, c))

    def test_a_failed_depth_read_is_missing_data_never_zero(self, caplog):
        svc = service()
        svc.capacity.observe(7, sizes=sizes(850), input_ms=T0)
        svc.capacity_queue.depth = {"queued": 3, "leased": 2, "parked": 0, "dead": 0}
        assert svc.readiness_snapshot()["capacity"]["large_leased"] == 2
        svc.capacity_queue.class_depth = MagicMock(side_effect=RuntimeError("down"))
        with caplog.at_level(logging.ERROR):
            c = svc.readiness_snapshot()["capacity"]
        assert (c["large_demand"], c["large_leased"]) == (1, None)
        assert "queue depth unavailable (RuntimeError)" in caplog.text

    def test_routing_off_reports_as_before_plus_the_null_key(self):
        svc = service(routing=False, queue=None)
        svc.capacity.observe(7, sizes=sizes(850), refused=True)
        c = svc.readiness_snapshot()["capacity"]
        assert c["routing"] == 0 and c["large_demand"] == 1 and c["large_leased"] is None
        body = json.loads(build_line("primary", SMALL_LABEL, c))
        assert body["large_leased"] is None and "large_leased" in NULLABLE_COUNT_KEYS
        standby = parse_line(build_line("standby", SMALL_LABEL, None))
        assert standby["large_leased"] is None and standby["large_demand"] is None

    def test_a_line_without_the_new_key_no_longer_parses(self):
        c = CapacityRouter(MemoryAdmission(1000 * MB, MODEL), CapacitySettings()).counts()
        old = json.loads(build_line("primary", SMALL_LABEL, c))
        del old["large_leased"]
        with pytest.raises(ValueError):
            parse_line(json.dumps(old, sort_keys=True))


# --------------------------------------------------------------------------- #
# 5. The client's wire: closed inventory, settings, frame encoding
# --------------------------------------------------------------------------- #
class TestClientWire:
    def test_the_inventory_is_closed(self):
        assert set(cq.RPC) == {"pd_enqueue", "pd_release_scope", "pq_class_depth",
                               "pq_job_status", "pq_cancel", "pq_attempt_logs"}
        assert len(cq.RPC["pd_enqueue"]) == 18 and set(cq.TABLE_RPC) == {"pq_attempt_logs"}
        client = cq.QueueClient(cq.QueueSettings("postgresql://x@127.0.0.1:1/x", "test"))
        with pytest.raises(KeyError):
            client.call("pq_claim", [])
        with pytest.raises(ValueError):
            client.call("pq_class_depth", ["test"])

    def test_settings(self):
        with pytest.raises(cq.QueueRefused):
            cq.QueueClient(cq.QueueSettings("", "test"))
        with pytest.raises(cq.QueueRefused):
            cq.QueueClient(cq.QueueSettings("postgresql://x", "Prod!"))
        assert cq.QueueClient.from_capacity(CapacitySettings()) is None
        with pytest.raises(CapacityConfigError):
            CapacitySettings(queue_dsn="postgresql://x")
        s = CapacitySettings.from_env({"MATH_CAPACITY_QUEUE_DSN": "postgresql://x",
                                       "MATH_CAPACITY_QUEUE_ENV": "prod"})
        assert (s.queue_dsn, s.queue_env) == ("postgresql://x", "prod")
        assert CapacitySettings.from_env_or_off({"MATH_CAPACITY_ROUTING": "1",
                                                 "MATH_CAPACITY_QUEUE_DSN": "postgresql://x"}
                                                ).routing is False   # DSN without env: off

    def test_the_statement_and_the_boundary(self, monkeypatch):
        """The statement sent is the closed form with fixed casts; a login
        outside the boundary is refused before the call."""
        seen = []

        class Cur:
            def __init__(self, boundary):
                self.boundary = boundary

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def execute(self, sql, params=None):
                seen.append((sql, params))

            def fetchone(self):
                if len(seen) == 2:
                    return self.boundary
                return [{"schema_version": "polis-queue/3", "outcome": "class_depth",
                         "env": "test", "worker_class": "large", "queued": 1, "leased": 0,
                         "parked": 0, "dead": 0,
                         "oldest_unresolved_created_at": "2026-10-06T00:00:00+00:00"}]

        class Conn:
            def __init__(self, boundary):
                self.boundary = boundary
                self.committed = False

            def set_session(self, **kw):
                pass

            def cursor(self):
                return Cur(self.boundary)

            def commit(self):
                self.committed = True

            def close(self):
                pass

        conns = []

        def connect(dsn, **kw):
            assert "generated-secret" in dsn and kw["application_name"] == "math-poller-capacity-queue"
            conns.append(Conn(boundary))
            return conns[-1]

        monkeypatch.setattr(cq.psycopg2, "connect", connect)
        client = cq.QueueClient(cq.QueueSettings("postgresql://u:generated-secret@h/d", "test"))
        boundary = (True, False, False)
        depth = client.class_depth()
        assert depth["queued"] == 1 and conns[-1].committed
        assert seen[2] == ("SELECT public.pq_class_depth(%s::text,%s::text)", ["test", "large"])
        assert seen[1][1] == [list(cq.QUEUE_TABLES)]
        for boundary, code in (((False, False, False), "membership"),
                               ((True, True, False), "direct_table_access"),
                               ((True, False, True), "queue_owner")):
            seen.clear()
            with pytest.raises(cq.QueueRefused, match=code):
                client.class_depth()
            assert len(seen) == 2                                  # refused before the call

    def test_the_enqueue_arguments_and_the_frame(self, monkeypatch):
        calls = []

        def call(name, args):
            calls.append((name, args))
            return {k: None for k in cq.JOB_FIELDS} | {
                "schema_version": "polis-queue/2", "outcome": "enqueued", "env": "test",
                "job_id": args[7], "state": "queued", "stage": "math_rebuild"}

        client = cq.QueueClient(cq.QueueSettings("postgresql://x@127.0.0.1:1/x", "test"))
        monkeypatch.setattr(client, "call", call)
        config = {"staged_label": STAGED, "target_label": SMALL_LABEL, "need_bytes": 5,
                  "input_through_ms": T0, "binding": "0" * 16, "source_commit": COMMIT}
        outcome, job_id = client.enqueue_math_rebuild(7, config=config, staged_label=STAGED,
                                                      target_label=SMALL_LABEL)
        assert outcome == "enqueued"
        (name, args) = calls[0]
        env, zid, product, actor, key, request_sha, run, job, uri, input_sha, config_sha, \
            image, priority, attempts, stage, report, scope, config_json = args
        assert (name, env, zid, product, scope) == ("pd_enqueue", "test", 7, "math:python:7",
                                                    "math:python:7")
        assert actor == "math-poller:python" and key == job == job_id and run != job
        assert (stage, report, priority, attempts, image) == ("math_rebuild", None, 1, 3, COMMIT)
        body = cq.decode_frame_uri(uri)
        assert cq.sha256_hex(body) == input_sha == request_sha
        frame = json.loads(body)
        assert frame == {"schema": "polis-jobs.admission/1", "zid": 7, "report_id": None,
                         "config": config,
                         "inputs": {"math_env": STAGED, "requested_math_tick": None}}
        assert json.loads(config_json) == config
        assert config_sha == cq.sha256_hex(cq.canonical_bytes(config))
        assert uuid.UUID(job_id)

    def test_replies_are_validated(self):
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_job({"outcome": "enqueued"})
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_depth({k: None for k in cq.DEPTH_FIELDS})
        good = {"schema_version": "polis-queue/3", "outcome": "class_depth", "env": "t",
                "worker_class": "large", "queued": 0, "leased": 0, "parked": 0, "dead": 0,
                "oldest_unresolved_created_at": None}
        assert cq.validate_depth(good) is good
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_depth({**good, "queued": -1})
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_depth({**good, "schema_version": "polis-queue/2"})
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_depth({**good, "worker_class": "noop"})
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_release("t")
        assert cq.validate_release(True) is True
        with pytest.raises(cq.QueueProtocolError):
            cq.validate_log_rows([{"seq": "1", "stream": "manifest", "line": "{}"}])

    def test_the_receipt_binds_the_manifest_to_the_job_and_the_bundle(self):
        job = str(uuid.uuid4())
        staged = Fingerprint(7, T0 + 1, T0 + 9)
        manifest = json.dumps({"schema": cq.MANIFEST_SCHEMA, "job_id": job,
                               "stage": "math_rebuild", "outcome": "succeeded",
                               "inputs": {"math_env": STAGED, "math_tick": 7,
                                          "vote_hwm": T0 + 1}}, sort_keys=True)
        sha = cq.sha256_hex(manifest.encode())
        status = {"state": "succeeded", "output_sha256": sha, "attempt_id": str(uuid.uuid4())}
        r = cq.receipt_of(job, status, manifest)
        assert r.finalized and r.binds(staged, STAGED)
        assert not r.binds(Fingerprint(8, T0 + 1, T0 + 9), STAGED)     # another tick
        assert not r.binds(staged, "python")                           # another label
        # No manifest row, a row that does not hash to the digest, a row
        # naming another job: no receipt.
        assert not cq.receipt_of(job, status, None).finalized
        assert not cq.receipt_of(job, status, manifest + " ").finalized
        other = manifest.replace(job, str(uuid.uuid4()))
        assert not cq.receipt_of(job, {**status, "output_sha256": cq.sha256_hex(other.encode())},
                                 other).finalized
        for state in ("running", "queued", "dead", "cancelled"):
            r = cq.receipt_of(job, {**status, "state": state}, manifest)
            assert r.state == state and not r.finalized and not r.binds(staged, STAGED)

    def test_the_client_pages_the_attempt_logs_for_the_manifest_row(self, monkeypatch):
        job, attempt = str(uuid.uuid4()), str(uuid.uuid4())
        line = json.dumps({"schema": cq.MANIFEST_SCHEMA, "job_id": job, "stage": "math_rebuild",
                           "outcome": "succeeded", "inputs": {"math_env": STAGED, "math_tick": 3,
                                                              "vote_hwm": T0}})
        sha = cq.sha256_hex(line.encode())
        calls = []

        def call(name, args):
            calls.append((name, args))
            if name == "pq_job_status":
                return {k: None for k in cq.JOB_FIELDS} | {
                    "schema_version": "polis-queue/3", "outcome": "job_status", "env": "test",
                    "job_id": job, "state": "succeeded", "stage": "math_rebuild",
                    "attempt_id": attempt, "output_sha256": sha}
            after = args[2]
            if after is None:
                return [{"seq": i, "stream": "stdout", "line": "x"} for i in range(cq.LOG_PAGE)]
            return [{"seq": cq.LOG_PAGE, "stream": "stderr", "line": "y"},
                    {"seq": cq.LOG_PAGE + 1, "stream": "manifest", "line": line}]

        client = cq.QueueClient(cq.QueueSettings("postgresql://x@127.0.0.1:1/x", "test"))
        monkeypatch.setattr(client, "call", call)
        r = client.receipt(job)
        assert r.binds(Fingerprint(3, T0, T0 + 1), STAGED)
        assert [c[0] for c in calls] == ["pq_job_status", "pq_attempt_logs", "pq_attempt_logs"]
        assert calls[2][1] == ["test", attempt, cq.LOG_PAGE - 1, cq.LOG_PAGE]

    def test_a_terminal_job_holding_its_guard_is_released_and_asked_again(self, monkeypatch):
        """Finding 2, the poller's side: the admission finds a cancelled job
        still holding the scope; the guarded release is called and the
        admission asked once more. A refused release leaves it alone."""
        calls = []
        held = {"state": "cancelled", "release": True}

        def call(name, args):
            calls.append(name)
            if name == "pd_release_scope":
                assert args == ["test", "math:python:7"]
                return held["release"]
            fresh = held["state"] is None or calls.count("pd_enqueue") > 1
            return {k: None for k in cq.JOB_FIELDS} | {
                "schema_version": "polis-queue/3", "env": "test", "stage": "math_rebuild",
                "outcome": "enqueued" if fresh else "existing",
                "job_id": args[7] if fresh else "0" * 32,
                "state": "queued" if fresh else held["state"]}

        client = cq.QueueClient(cq.QueueSettings("postgresql://x@127.0.0.1:1/x", "test"))
        monkeypatch.setattr(client, "call", call)
        config = {"staged_label": STAGED, "target_label": SMALL_LABEL, "need_bytes": 5,
                  "input_through_ms": T0, "binding": "0" * 16, "source_commit": COMMIT}
        outcome, job_id = client.enqueue_math_rebuild(7, config=config, staged_label=STAGED,
                                                      target_label=SMALL_LABEL)
        assert (outcome, calls) == ("enqueued", ["pd_enqueue", "pd_release_scope", "pd_enqueue"])
        assert job_id != "0" * 32
        calls.clear()
        held["release"] = False                                  # exit unproven: refused
        outcome, job_id = client.enqueue_math_rebuild(7, config=config, staged_label=STAGED,
                                                      target_label=SMALL_LABEL)
        assert (outcome, job_id, calls) == ("existing", "0" * 32, ["pd_enqueue", "pd_release_scope"])
        calls.clear()
        held["state"] = "running"                                # active: no release asked
        outcome, _ = client.enqueue_math_rebuild(7, config=config, staged_label=STAGED,
                                                 target_label=SMALL_LABEL)
        assert (outcome, calls) == ("existing", ["pd_enqueue"])

    def test_the_frame_uri_round_trips_unpadded(self):
        for n in range(1, 8):
            body = b"x" * n
            uri = cq.encode_frame_uri(body)
            assert "=" not in uri and cq.decode_frame_uri(uri) == body
        with pytest.raises(cq.QueueProtocolError):
            cq.decode_frame_uri("s3://not-a-frame")


# --------------------------------------------------------------------------- #
# 6. Promotion is gated by the job's receipt (finding 4)
# --------------------------------------------------------------------------- #
def loop_with(queue):
    adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
    s = CapacitySettings(routing=True, promote=True, staged_label=STAGED)
    router = CapacityRouter(adm, s)
    pg = FakePg()
    svc = MagicMock()
    svc.config = PollerConfig(math_env=SMALL_LABEL)
    svc._pg = pg
    svc._pool = None
    loop = SmallCapacityLoop(svc, router, s, queue=queue, source_commit=COMMIT)
    router.observe(7, sizes=sizes(850), input_ms=T0)
    return loop, router, pg


def test_without_a_queue_nothing_is_promoted(caplog):
    loop, router, pg = loop_with(None)
    pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
    with caplog.at_level(logging.INFO):
        loop.tick()
    assert pg.promoted == [] and "no queue, so no receipt" in caplog.text
    c = router.counts()
    assert (c["large_demand"], c["pending_promotion"], c["promoted_total"]) == (0, 1, 0)


def test_a_staged_bundle_is_promoted_only_on_its_jobs_receipt(caplog):
    q = FakeQueue()
    loop, router, pg = loop_with(q)
    loop.tick()                                                # nothing staged: a job
    (job_id,) = q.jobs
    # The child committed the staged bundle; the daemon has not finalized
    # the attempt (the job is still running): no receipt, no promotion.
    pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
    q.jobs[job_id]["state"] = "running"
    with caplog.at_level(logging.INFO):
        loop.tick()
    assert pg.promoted == [] and "is running, not finalized" in caplog.text
    assert router.counts()["pending_promotion"] == 1
    # Finalized naming another tick (a stale manifest): not this bundle.
    q.finish(job_id, Fingerprint(2, T0, T0 + 4))
    with caplog.at_level(logging.WARNING):
        loop.tick()
    assert pg.promoted == [] and "finalized tick=2" in caplog.text
    # Finalized naming the staged bundle: promoted.
    q.finish(job_id, pg.fps[(7, STAGED)])
    q.depth["queued"] += 2                                       # finish decremented twice
    loop.tick()
    assert pg.promoted == [7] and router.counts()["promoted_total"] == 1


def test_a_receipt_read_failure_is_contained(caplog):
    q = FakeQueue()
    loop, router, pg = loop_with(q)
    loop.tick()
    (job_id,) = q.jobs
    pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
    q.finish(job_id, pg.fps[(7, STAGED)])
    q.receipt = MagicMock(side_effect=RuntimeError("down"))
    with caplog.at_level(logging.ERROR):
        loop.tick()
    assert pg.promoted == [] and "unavailable (RuntimeError)" in caplog.text
    assert router.disposition(7) == LARGE
