"""P6a (Storage V2 design §4.4): per-run input snapshots — capture side.

Contract under test:

- capture_run_inputs writes the six snapshot kinds (votes, comments,
  participants, conversation_meta, report_comment_selections,
  clojure_math_main) as run_inputs items keyed by job_id, using the codec
  envelopes, and returns per-kind fingerprints (sha256 of the uncompressed
  payload, row counts, max vote created).
- The votes snapshot is the RAW stream EXACTLY as stage 1 reads it:
  ORDER BY created, raw PG signs (NO flip — the production math path never
  flips; the flipping fetch_votes() helper is dead code), superseded votes
  included.
- Comments are captured in full, INCLUDING moderated-out rows (mod = -1) —
  moderation filtering is pipeline behavior, not snapshot behavior.
- derive_votes_latest_unique reproduces PG's RULE-maintained
  votes_latest_unique table from the raw stream (last vote per (pid, tid)
  in stream order).
- The capture SQL is the SAME string stage 1 executes (imported constants,
  parity by construction).
- purge_job deletes every snapshot partition for a job (GDPR path, §9).
- run_delphi.py invokes capture (with the resolved job id) before any stage
  when --snapshot-inputs / DELPHI_SNAPSHOT_INPUTS is set, and not otherwise.
"""

import importlib
import os
import sys
import uuid
from types import SimpleNamespace

import pytest

from delphi_storage.backends.memory import MemoryDelphiStore
from delphi_storage.codec import decode_payload
from delphi_storage.inputs import (
    SNAPSHOT_KINDS,
    VOTES_BATCH_SQL,
    VOTES_COUNT_SQL,
    capture_run_inputs,
    derive_votes_latest_unique,
    load_run_input,
)
from delphi_storage.purge import purge_job

DELPHI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if DELPHI_DIR not in sys.path:
    sys.path.insert(0, DELPHI_DIR)

_IN_GHA = os.environ.get("GITHUB_ACTIONS") == "true"

ZID = 77

# (created, tid, pid, vote) — inserted out of created-order on purpose;
# pid 2 re-votes on tid 1 (raw sign convention: PG stores AGREE as -1).
VOTES = [
    (1000, 1, 1, -1),
    (1400, 2, 1, 1),
    (1100, 1, 2, 1),
    (1600, 1, 2, -1),  # re-vote: supersedes (pid=2, tid=1)
    (1200, 2, 2, 0),
]
VOTES_BY_CREATED = sorted(VOTES)


def _seed_scratch_database(url):
    import sqlalchemy
    from sqlalchemy import text

    engine = sqlalchemy.create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE votes (zid integer, pid integer, tid integer,
                                vote smallint, weight_x_32767 smallint,
                                created bigint)"""))
        conn.execute(text("""
            CREATE TABLE votes_latest_unique (zid integer, pid integer,
                                tid integer, vote smallint,
                                weight_x_32767 smallint, modified bigint,
                                UNIQUE (zid, pid, tid))"""))
        conn.execute(text("""
            CREATE TABLE comments (zid integer, tid integer, pid integer,
                                txt varchar, created bigint, mod integer,
                                is_seed boolean, is_meta boolean,
                                active boolean)"""))
        conn.execute(text("""
            CREATE TABLE participants (zid integer, pid integer, uid integer,
                                mod integer, created bigint)"""))
        conn.execute(text("""
            CREATE TABLE conversations (zid integer, topic varchar,
                                description varchar, owner integer,
                                created bigint, modified bigint)"""))
        conn.execute(text("""
            CREATE TABLE report_comment_selections (rid integer, tid integer,
                                selection integer, zid integer,
                                modified bigint)"""))
        conn.execute(text("""
            CREATE TABLE math_main (zid integer, math_env varchar, data jsonb,
                                last_vote_timestamp bigint, caching_tick bigint,
                                math_tick bigint, modified bigint)"""))

        for created, tid, pid, vote in VOTES:
            conn.execute(
                text("INSERT INTO votes (zid, pid, tid, vote, created) "
                     "VALUES (:zid, :pid, :tid, :vote, :created)"),
                {"zid": ZID, "pid": pid, "tid": tid, "vote": vote, "created": created},
            )
            # mimic PG's on_vote_insert_update_unique_table RULE
            conn.execute(
                text("""INSERT INTO votes_latest_unique (zid, pid, tid, vote, modified)
                        VALUES (:zid, :pid, :tid, :vote, :created)
                        ON CONFLICT (zid, pid, tid)
                        DO UPDATE SET vote = excluded.vote, modified = excluded.modified"""),
                {"zid": ZID, "pid": pid, "tid": tid, "vote": vote, "created": created},
            )
        # another conversation's vote must not leak into the snapshot
        conn.execute(
            text("INSERT INTO votes (zid, pid, tid, vote, created) "
                 "VALUES (999, 1, 1, 1, 500)"))

        conn.execute(text(
            "INSERT INTO comments (zid, tid, pid, txt, created, mod, is_seed, is_meta, active) VALUES "
            f"({ZID}, 1, 1, 'kept comment', 900, 1, false, false, true), "
            f"({ZID}, 2, 2, 'moderated-out comment', 950, -1, false, false, true), "
            f"({ZID}, 3, 1, 'unmoderated comment', 980, 0, true, false, true)"))
        conn.execute(text(
            f"INSERT INTO participants (zid, pid, uid, mod, created) VALUES "
            f"({ZID}, 1, 101, 0, 800), ({ZID}, 2, 102, -1, 810)"))
        conn.execute(text(
            f"INSERT INTO conversations (zid, topic, description, owner, created, modified) "
            f"VALUES ({ZID}, 'Test topic', 'Test description', 7, 700, 701)"))
        conn.execute(text(
            f"INSERT INTO report_comment_selections (rid, tid, selection, zid, modified) "
            f"VALUES (42, 2, -1, {ZID}, 990)"))
        conn.execute(text(
            f"INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, "
            f"caching_tick, math_tick, modified) VALUES "
            f"({ZID}, 'dev', '{{\"pca\": [0.1, 0.2]}}'::jsonb, 1600, 3, 5, 1700), "
            f"({ZID}, 'prod', '{{\"pca\": [0.3]}}'::jsonb, 1500, 2, 4, 1690)"))
    engine.dispose()


@pytest.fixture(scope="module")
def seeded_pg_url():
    base_url = os.environ.get("DELPHI_STORAGE_PG_URL") or os.environ.get("DATABASE_URL")
    if not base_url:
        if _IN_GHA:
            pytest.fail("PostgreSQL must be available in GitHub Actions")
        pytest.skip("PostgreSQL unavailable: no DELPHI_STORAGE_PG_URL / DATABASE_URL")
    import sqlalchemy
    from sqlalchemy import text

    dbname = f"snap_{uuid.uuid4().hex[:10]}"
    admin = sqlalchemy.create_engine(
        base_url, isolation_level="AUTOCOMMIT", connect_args={"connect_timeout": 3}
    )
    try:
        with admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{dbname}"'))
    except Exception as e:  # noqa: BLE001
        admin.dispose()
        if _IN_GHA:
            raise
        pytest.skip(f"PostgreSQL unavailable: {e}")
    scratch_url = base_url.rsplit("/", 1)[0] + f"/{dbname}"
    _seed_scratch_database(scratch_url)
    yield scratch_url
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture()
def captured(seeded_pg_url):
    store = MemoryDelphiStore()
    fingerprints = capture_run_inputs(
        store, job_id="job-snap-1", zid=ZID, rid=42, pg_url=seeded_pg_url
    )
    return store, fingerprints


class TestVotesSnapshot:
    def test_raw_stream_order_and_signs(self, captured):
        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "votes")
        assert payload["columns"] == ["created", "tid", "pid", "vote"]
        assert payload["rows"] == [list(row) for row in VOTES_BY_CREATED]

    def test_votes_always_compressed(self, captured):
        store, _ = captured
        item = store.get("run_inputs", "job-snap-1", "votes")
        assert item is not None and item.attributes["enc"] == "json+zstd"
        assert item.blob is not None

    def test_fingerprints(self, captured):
        _, fingerprints = captured
        votes_fp = fingerprints["votes"]
        assert votes_fp["row_count"] == len(VOTES)
        assert len(votes_fp["sha256"]) == 64
        assert votes_fp["max_created"] == max(created for created, *_ in VOTES)

    def test_derive_votes_latest_unique_matches_pg_rule(self, captured, seeded_pg_url):
        import sqlalchemy
        from sqlalchemy import text

        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "votes")
        derived = derive_votes_latest_unique(payload["rows"])
        engine = sqlalchemy.create_engine(seeded_pg_url)
        with engine.begin() as conn:
            rows = conn.execute(
                text("SELECT pid, tid, vote FROM votes_latest_unique WHERE zid = :zid"),
                {"zid": ZID},
            ).fetchall()
        engine.dispose()
        assert derived == {(row.pid, row.tid): row.vote for row in rows}
        # the re-vote won: raw sign of the LAST vote in stream order
        assert derived[(2, 1)] == -1


class TestTieSemantics:
    """Same-millisecond re-votes: ORDER BY created has no tiebreaker (the
    votes table has no serial/PK column), so the PG RULE's insertion-order
    winner and the snapshot-stream winner may legitimately differ. The
    derivation must still be deterministic w.r.t. the snapshot — that is
    what replay requires — and the caveat is documented, not hidden."""

    TIE_ZID = 78

    def test_derivation_is_deterministic_wrt_snapshot(self, seeded_pg_url):
        import sqlalchemy
        from sqlalchemy import text

        engine = sqlalchemy.create_engine(seeded_pg_url)
        with engine.begin() as conn:
            for vote in (1, -1):  # same (pid, tid), SAME created
                conn.execute(
                    text("INSERT INTO votes (zid, pid, tid, vote, created) "
                         "VALUES (:zid, 5, 9, :vote, 2000)"),
                    {"zid": self.TIE_ZID, "vote": vote},
                )
        engine.dispose()

        store = MemoryDelphiStore()
        capture_run_inputs(store, job_id="job-tie", zid=self.TIE_ZID, pg_url=seeded_pg_url)
        payload = load_run_input(store, "job-tie", "votes")
        assert len(payload["rows"]) == 2
        derived = derive_votes_latest_unique(payload["rows"])
        vote_index = payload["columns"].index("vote")
        # last-in-stream wins: pinned to the snapshot itself, whichever
        # order PG returned the tied rows in
        assert derived[(5, 9)] == payload["rows"][-1][vote_index]


class TestOtherSnapshots:
    def test_provenance_stamped_on_every_item(self, captured):
        store, _ = captured
        for item in store.query_prefix("run_inputs", "job-snap-1"):
            assert item.attributes["zid"] == ZID, item.sk
            assert item.attributes["rid"] == 42, item.sk

    def test_all_kinds_present(self, captured):
        store, fingerprints = captured
        sks = [item.sk for item in store.query_prefix("run_inputs", "job-snap-1")]
        assert sks == sorted(SNAPSHOT_KINDS)
        assert set(fingerprints) == set(SNAPSHOT_KINDS)

    def test_comments_full_rows_including_moderated_out(self, captured):
        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "comments")
        by_tid = {row[payload["columns"].index("tid")]: row for row in payload["rows"]}
        assert set(by_tid) == {1, 2, 3}
        mod_index = payload["columns"].index("mod")
        assert by_tid[2][mod_index] == -1

    def test_conversation_meta(self, captured):
        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "conversation_meta")
        (row,) = payload["rows"]
        assert row[payload["columns"].index("topic")] == "Test topic"

    def test_participants_include_banned(self, captured):
        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "participants")
        mods = {row[payload["columns"].index("pid")]: row[payload["columns"].index("mod")]
                for row in payload["rows"]}
        assert mods == {1: 0, 2: -1}

    def test_report_comment_selections(self, captured):
        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "report_comment_selections")
        (row,) = payload["rows"]
        assert row[payload["columns"].index("selection")] == -1

    def test_clojure_math_main_all_envs(self, captured):
        store, _ = captured
        payload = load_run_input(store, "job-snap-1", "clojure_math_main")
        envs = {row[payload["columns"].index("math_env")] for row in payload["rows"]}
        assert envs == {"dev", "prod"}
        data_index = payload["columns"].index("data")
        by_env = {row[payload["columns"].index("math_env")]: row[data_index]
                  for row in payload["rows"]}
        assert by_env["dev"] == {"pca": [0.1, 0.2]}


class TestSqlParity:
    """The capture SQL must be the SAME strings stage 1 executes."""

    def test_stage1_imports_the_constants(self):
        run_math_pipeline = importlib.import_module("polismath.run_math_pipeline")
        assert run_math_pipeline.VOTES_BATCH_SQL is VOTES_BATCH_SQL
        assert run_math_pipeline.VOTES_COUNT_SQL is VOTES_COUNT_SQL

    def test_batch_sql_shape(self):
        assert "ORDER BY v.created" in VOTES_BATCH_SQL
        assert "SELECT v.created, v.tid, v.pid, v.vote FROM votes" in VOTES_BATCH_SQL


class TestPurge:
    def test_purge_job_deletes_all_partitions(self, captured):
        store, _ = captured
        store.put(
            "artifacts",
            __import__("delphi_storage").StoreItem(
                pk="job-snap-1", sk="math#pca", attributes={"enc": "json", "body": {}}
            ),
        )
        deleted = purge_job(store, "job-snap-1")
        assert deleted >= len(SNAPSHOT_KINDS) + 1
        assert store.query_prefix("run_inputs", "job-snap-1") == []
        assert store.query_prefix("artifacts", "job-snap-1") == []


class TestRunDelphiHook:
    def _run(self, monkeypatch, argv, env_flag=None):
        run_delphi = importlib.import_module("run_delphi")
        stage_cmds = []
        captures = []

        monkeypatch.setattr(
            run_delphi.subprocess,
            "run",
            lambda cmd, **kw: stage_cmds.append(list(cmd)) or SimpleNamespace(returncode=0),
        )
        monkeypatch.setattr(
            run_delphi,
            "_capture_run_inputs",
            lambda job_id, zid, rid: captures.append((job_id, zid, rid)),
        )
        monkeypatch.setenv("DELPHI_WRITE_MODE", "old")
        monkeypatch.setenv("OLLAMA_MODEL", "test-model")
        monkeypatch.setenv("DELPHI_APP_PATH", DELPHI_DIR)
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        if env_flag is None:
            monkeypatch.delenv("DELPHI_SNAPSHOT_INPUTS", raising=False)
        else:
            monkeypatch.setenv("DELPHI_SNAPSHOT_INPUTS", env_flag)
        monkeypatch.setitem(sys.modules, "boto3", None)
        monkeypatch.setattr(sys, "argv", ["run_delphi.py"] + argv)
        with pytest.raises(SystemExit) as excinfo:
            run_delphi.main()
        assert excinfo.value.code == 0
        return stage_cmds, captures

    def test_flag_captures_before_stages(self, monkeypatch):
        stage_cmds, captures = self._run(
            monkeypatch, ["--zid=123", "--job-id=snap-run", "--snapshot-inputs"]
        )
        assert captures == [("snap-run", "123", None)]
        assert len(stage_cmds) == 6

    def test_env_flag_works(self, monkeypatch):
        _, captures = self._run(monkeypatch, ["--zid=123", "--job-id=snap-env"], env_flag="1")
        assert captures == [("snap-env", "123", None)]

    def test_off_by_default(self, monkeypatch):
        _, captures = self._run(monkeypatch, ["--zid=123", "--job-id=no-snap"])
        assert captures == []

    def test_capture_failure_aborts_before_any_stage(self, monkeypatch):
        """A run without recorded inputs defeats the point when enabled —
        capture failure must exit nonzero with NO stage subprocess run."""
        run_delphi = importlib.import_module("run_delphi")
        stage_cmds = []

        monkeypatch.setattr(
            run_delphi.subprocess,
            "run",
            lambda cmd, **kw: stage_cmds.append(list(cmd)) or SimpleNamespace(returncode=0),
        )

        def boom(job_id, zid, rid):
            raise RuntimeError("snapshot store unreachable")

        monkeypatch.setattr(run_delphi, "_capture_run_inputs", boom)
        monkeypatch.setenv("DELPHI_WRITE_MODE", "old")
        monkeypatch.setenv("OLLAMA_MODEL", "test-model")
        monkeypatch.setenv("DELPHI_APP_PATH", DELPHI_DIR)
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        monkeypatch.setitem(sys.modules, "boto3", None)
        monkeypatch.setattr(
            sys, "argv", ["run_delphi.py", "--zid=123", "--job-id=j-fail", "--snapshot-inputs"]
        )
        with pytest.raises(SystemExit) as excinfo:
            run_delphi.main()
        assert excinfo.value.code == 1
        assert stage_cmds == []
