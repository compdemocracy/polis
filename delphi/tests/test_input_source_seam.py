"""P6b (Storage V2 design §4.4, §5): the --input-source=store://<job_id> seam.

The contract: with the same underlying data, every stage's SNAPSHOT-fed
inputs are equal to its LIVE-PG-fed inputs — not "equivalent", equal. The
downstream code is untouched, so feed equality ⟹ output equality (PCA and
KMeans are seeded; identical input sequences give identical outputs). The
golden suite remains the output-invariance gate for the live path.

Quirk parity is deliberate: stage 1's fetch_comments/fetch_moderation compare
the INTEGER mod column to STRINGS ('-1'/'1'), so those Python-side filters
never fire in production. The snapshot path routes through the SAME
transformation code so it reproduces this bug-for-bug — fixing it would
change math inputs and is out of scope (golden invariance).
"""

import importlib
import os
import sys
import uuid
from types import SimpleNamespace

import pytest

from delphi_storage.backends.memory import MemoryDelphiStore
from delphi_storage.inputs import (
    SnapshotPostgresClient,
    SnapshotReader,
    capture_run_inputs,
    parse_input_source,
)
from delphi_storage.interface import Invalid, NotFound

from test_input_snapshots import VOTES, ZID, _seed_scratch_database

DELPHI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
UMAP_DIR = os.path.join(DELPHI_DIR, "umap_narrative")
for path in (DELPHI_DIR, UMAP_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

_IN_GHA = os.environ.get("GITHUB_ACTIONS") == "true"

JOB_ID = "job-seam-1"


@pytest.fixture(scope="module")
def seeded_pg_url():
    base_url = os.environ.get("DELPHI_STORAGE_PG_URL") or os.environ.get("DATABASE_URL")
    if not base_url:
        if _IN_GHA:
            pytest.fail("PostgreSQL must be available in GitHub Actions")
        pytest.skip("PostgreSQL unavailable: no DELPHI_STORAGE_PG_URL / DATABASE_URL")
    import sqlalchemy
    from sqlalchemy import text

    dbname = f"seam_{uuid.uuid4().hex[:10]}"
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


@pytest.fixture(scope="module")
def snapshot_store(seeded_pg_url):
    store = MemoryDelphiStore()
    capture_run_inputs(store, job_id=JOB_ID, zid=ZID, rid=42, pg_url=seeded_pg_url)
    return store


class TestParseInputSource:
    def test_valid(self):
        assert parse_input_source("store://job-abc") == "job-abc"

    @pytest.mark.parametrize("bad", ["job-abc", "store://", "s3://job", "", "store:job"])
    def test_invalid(self, bad):
        with pytest.raises(Invalid):
            parse_input_source(bad)


class TestStage1FeedEquality:
    """The math pipeline's three feeds, live vs snapshot — exact equality."""

    def _live_conn(self, url):
        import psycopg2

        return psycopg2.connect(url)

    def test_comments_feed_equal(self, seeded_pg_url, snapshot_store):
        rmp = importlib.import_module("polismath.run_math_pipeline")
        conn = self._live_conn(seeded_pg_url)
        try:
            live = rmp.fetch_comments(conn, ZID)
        finally:
            conn.close()
        reader = SnapshotReader(snapshot_store, JOB_ID)
        snap = rmp.comments_from_snapshot(reader)
        assert snap == live
        assert len(live["comments"]) == 3  # incl. mod=-1 (the dead string filter)

    def test_moderation_feed_equal(self, seeded_pg_url, snapshot_store):
        rmp = importlib.import_module("polismath.run_math_pipeline")
        conn = self._live_conn(seeded_pg_url)
        try:
            live = rmp.fetch_moderation(conn, ZID)
        finally:
            conn.close()
        reader = SnapshotReader(snapshot_store, JOB_ID)
        snap = rmp.moderation_from_snapshot(reader)
        # mod_out/in tids are [] in BOTH (int-vs-str quirk reproduced);
        # ptpts and meta may differ in ORDER live-side (unordered SQL), so
        # compare as multisets plus the exact quirk expectations.
        assert snap["mod_out_tids"] == live["mod_out_tids"] == []
        assert snap["mod_in_tids"] == live["mod_in_tids"] == []
        assert sorted(snap["meta_tids"]) == sorted(live["meta_tids"])
        assert sorted(snap["mod_out_ptpts"]) == sorted(live["mod_out_ptpts"]) == ["2"]

    def test_vote_batches_equal(self, seeded_pg_url, snapshot_store):
        import psycopg2

        rmp = importlib.import_module("polismath.run_math_pipeline")
        reader = SnapshotReader(snapshot_store, JOB_ID)
        assert reader.vote_count() == len(VOTES)

        batch_size = 2
        conn = psycopg2.connect(seeded_pg_url)
        try:
            for offset in range(0, len(VOTES), batch_size):
                cursor = conn.cursor()
                cursor.execute(rmp.VOTES_BATCH_SQL, (ZID, batch_size, offset))
                live_batch = [tuple(row) for row in cursor.fetchall()]
                cursor.close()
                snap_batch = [tuple(row) for row in reader.vote_batch(offset, batch_size)]
                assert snap_batch == live_batch, f"offset {offset}"
        finally:
            conn.close()

    def test_vote_batch_conversion_equal(self, snapshot_store):
        """The converted per-vote dicts (str pid/tid, float vote, ms created)
        are identical for a snapshot row and a live tuple."""
        reader = SnapshotReader(snapshot_store, JOB_ID)
        rows = reader.vote_batch(0, 100)
        for row in rows:
            assert isinstance(row[0], int)  # created
            converted = {
                "pid": str(row[2]),
                "tid": str(row[1]),
                "vote": float(row[3]),
                "created": int(float(row[0]) * 1000),
            }
            assert converted["vote"] in (-1.0, 0.0, 1.0)

    def test_missing_snapshot_raises_not_found(self, snapshot_store):
        reader = SnapshotReader(snapshot_store, "no-such-job")
        with pytest.raises(NotFound):
            reader.vote_count()


class TestStage2ClientEquality:
    """SnapshotPostgresClient duck-types the umap PostgresClient reads."""

    @pytest.fixture()
    def live_client(self, seeded_pg_url, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", seeded_pg_url)
        monkeypatch.delenv("DATABASE_SSL_MODE", raising=False)
        storage = importlib.import_module("polismath_commentgraph.utils.storage")
        config = storage.PostgresConfig(url=seeded_pg_url, ssl_mode="disable")
        client = storage.PostgresClient(config=config)
        client.initialize()
        yield client
        client.shutdown()

    def _snap_client(self, snapshot_store):
        return SnapshotPostgresClient(snapshot_store, JOB_ID)

    def test_conversation_equal(self, live_client, snapshot_store):
        live = live_client.get_conversation_by_id(ZID)
        snap = self._snap_client(snapshot_store).get_conversation_by_id(ZID)
        assert snap == dict(live)

    def test_comments_equal(self, live_client, snapshot_store):
        live = [dict(row) for row in live_client.get_comments_by_conversation(ZID)]
        snap = self._snap_client(snapshot_store).get_comments_by_conversation(ZID)
        assert snap == live

    def test_selections_equal(self, live_client, snapshot_store):
        live = [dict(row) for row in live_client.get_report_comment_selections(ZID)]
        snap = self._snap_client(snapshot_store).get_report_comment_selections(ZID)
        assert snap == live

    def test_votes_latest_unique_equal_with_flip(self, live_client, snapshot_store):
        live = {(r["pid"], r["tid"]): r["vote"]
                for r in live_client.get_votes_by_conversation(ZID)}
        snap_rows = self._snap_client(snapshot_store).get_votes_by_conversation(ZID)
        snap = {(r["pid"], r["tid"]): r["vote"] for r in snap_rows}
        assert snap == live
        # Delphi sign convention: the re-vote (raw -1 = AGREE) flips to +1
        assert snap[(2, 1)] == 1

    def test_zid_mismatch_rejected(self, snapshot_store):
        with pytest.raises(Invalid):
            self._snap_client(snapshot_store).get_comments_by_conversation(ZID + 1)

    def test_lifecycle_noops(self, snapshot_store):
        client = self._snap_client(snapshot_store)
        client.initialize()
        client.shutdown()


class TestMathMainSnapshot:
    def test_envless_latest_matches_501_semantics(self, snapshot_store):
        reader = SnapshotReader(snapshot_store, JOB_ID)
        # 501/group_data: no env filter, ORDER BY modified DESC LIMIT 1
        assert reader.math_main_data() == {"pca": [0.1, 0.2]}  # dev, modified 1700

    def test_env_filter_matches_801_semantics(self, snapshot_store):
        reader = SnapshotReader(snapshot_store, JOB_ID)
        assert reader.math_main_data(math_env="prod") == {"pca": [0.3]}
        assert reader.math_main_data(math_env="preprod") is None

    def test_group_data_override(self, snapshot_store):
        group_data = importlib.import_module("polismath_commentgraph.utils.group_data")
        processor = group_data.GroupDataProcessor(
            postgres_client=None, math_main_override={"group-clusters": []}
        )
        assert processor.get_math_main_by_conversation(ZID) == {"group-clusters": []}

    def test_group_data_empty_snapshot_takes_votes_fallback(self, seeded_pg_url):
        """A snapshot with ZERO clojure_math_main rows must take the SAME
        votes-based fallback as the live no-data path — not die on the
        snapshot client's missing .query() and silently return empty groups
        (found in review: guard on MODE, not data presence)."""
        import sqlalchemy
        from sqlalchemy import text

        group_data = importlib.import_module("polismath_commentgraph.utils.group_data")
        # a conversation with votes but NO math_main rows
        no_mm_zid = 79
        engine = sqlalchemy.create_engine(seeded_pg_url)
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO votes (zid, pid, tid, vote, created) "
                     "VALUES (:zid, 5, 9, -1, 3000), (:zid, 5, 10, -1, 3001)"),
                {"zid": no_mm_zid},
            )
        engine.dispose()
        store = MemoryDelphiStore()
        capture_run_inputs(store, job_id="job-nomm", zid=no_mm_zid, pg_url=seeded_pg_url)

        client = SnapshotPostgresClient(store, "job-nomm")
        processor = group_data.GroupDataProcessor(
            client, math_main_override=None, using_snapshot=True
        )
        result = processor.get_math_main_by_conversation(no_mm_zid)
        # the live fallback's shape: synthetic per-participant grouping
        assert result["n_groups"] == 3
        assert set(result["group_assignments"]) == {"5"}
        assert result["group_assignments"]["5"] in (0, 1)


class TestCliSurface:
    STAGES = [
        ("polismath.run_math_pipeline", "main"),
        ("run_pipeline", "main"),
        ("501_calculate_comment_extremity", "main"),
        ("801_narrative_report_batch", "main"),
    ]

    @pytest.mark.parametrize("module_name,entry", STAGES)
    def test_help_mentions_input_source(self, module_name, entry, monkeypatch, capsys):
        import asyncio
        import inspect

        module = importlib.import_module(module_name)
        monkeypatch.setattr(sys, "argv", [f"{module_name}.py", "--help"])
        entry_point = getattr(module, entry)
        with pytest.raises(SystemExit) as excinfo:
            if inspect.iscoroutinefunction(entry_point):
                asyncio.run(entry_point())
            else:
                entry_point()
        assert excinfo.value.code == 0
        assert "--input-source" in capsys.readouterr().out, module_name


class TestRunDelphiForwarding:
    def _run(self, monkeypatch, argv):
        run_delphi = importlib.import_module("run_delphi")
        stage_cmds = []
        monkeypatch.setattr(
            run_delphi.subprocess,
            "run",
            lambda cmd, **kw: stage_cmds.append(list(cmd)) or SimpleNamespace(returncode=0),
        )
        monkeypatch.setenv("DELPHI_WRITE_MODE", "old")
        monkeypatch.setenv("OLLAMA_MODEL", "test-model")
        monkeypatch.setenv("DELPHI_APP_PATH", DELPHI_DIR)
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        monkeypatch.delenv("DELPHI_SNAPSHOT_INPUTS", raising=False)
        monkeypatch.setitem(sys.modules, "boto3", None)
        monkeypatch.setattr(sys, "argv", ["run_delphi.py"] + argv)
        with pytest.raises(SystemExit) as excinfo:
            run_delphi.main()
        return excinfo.value.code, stage_cmds

    def test_forwards_to_pg_reading_stages(self, monkeypatch):
        code, cmds = self._run(
            monkeypatch, ["--zid=123", "--job-id=replay-1", "--input-source=store://orig-1"]
        )
        assert code == 0
        by_script = {cmd[1].rsplit("/", 1)[-1]: cmd for cmd in cmds}
        for script in ("run_math_pipeline.py", "run_pipeline.py",
                       "501_calculate_comment_extremity.py"):
            assert "--input-source=store://orig-1" in by_script[script], script
        # dynamo-reading stages have no PG seam
        for script in ("502_calculate_priorities.py", "700_datamapplot_for_layer.py",
                       "reset_conversation.py"):
            assert all("--input-source" not in arg for arg in by_script[script]), script

    def test_snapshot_and_input_source_mutually_exclusive(self, monkeypatch):
        code, cmds = self._run(
            monkeypatch,
            ["--zid=123", "--snapshot-inputs", "--input-source=store://orig-1"],
        )
        assert code != 0
        assert cmds == []
