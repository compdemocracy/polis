"""Report readers must isolate engines in the migrated, real Postgres schema.

Uses POLIS_TEST_POSTGRES_URL (the docker-compose.test.yml postgres service),
with the existing throwaway-Postgres helper as a local fallback. Only synthetic
conversations are inserted; each test removes its own rows. DynamoDB and LLM
work are bypassed, while the production readers execute their SQL unchanged.
"""

import importlib
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import psycopg2
from psycopg2.extras import Json
import pytest

from polismath.components.config import ConfigManager
from tests.conftest import require_polis_postgres


QUOTED_ENV = "python' OR '1'='1"
ENV_VALUES = {"prod": (11, 0.2), "python": (99, 0.8), QUOTED_ENV: (55, 0.5)}
READERS = ("groups", "batch", "ptptstats", "repness", "pca")


@pytest.fixture(scope="module")
def postgres_url():
    if url := os.environ.get("POLIS_TEST_POSTGRES_URL"):
        # A provisioned database must fail loudly if unreachable or unmigrated.
        conn = psycopg2.connect(url)
        try:
            with conn.cursor() as cursor:
                cursor.execute("SELECT to_regclass('math_main'), to_regclass('math_ptptstats')")
                assert all(cursor.fetchone()), "Postgres is missing the Polis math migrations"
        finally:
            conn.close()
        yield url
        return
    with require_polis_postgres() as url:
        yield url


@pytest.fixture(scope="module")
def report_modules(tmp_path_factory):
    # The numbered CLI scripts use imports relative to umap_narrative and the
    # visualization script opens its log on import. Keep both local to tests.
    narrative_dir = Path(__file__).resolve().parents[1] / "umap_narrative"
    with pytest.MonkeyPatch.context() as patch:
        patch.syspath_prepend(str(narrative_dir))
        patch.setenv("VIZ_OUTPUT_DIR", str(tmp_path_factory.mktemp("report-viz")))
        patch.setenv("MPLBACKEND", "Agg")
        yield SimpleNamespace(
            groups=importlib.import_module("polismath_commentgraph.utils.group_data"),
            storage=importlib.import_module("polismath_commentgraph.utils.storage"),
            batch=importlib.import_module("umap_narrative.801_narrative_report_batch"),
            viz=importlib.import_module("umap_narrative.702_consensus_divisive_datamapplot"),
        )


@pytest.fixture
def configured_env(request, monkeypatch):
    requested = request.param
    if requested is None:
        monkeypatch.delenv("MATH_ENV", raising=False)
    else:
        monkeypatch.setenv("MATH_ENV", requested)
    # Recreate the same singleton a fresh report worker gets on startup, and
    # restore the prior instance so other tests' overrides remain untouched.
    monkeypatch.setattr(ConfigManager, "_instance", None)
    expected = "prod" if requested is None else requested
    assert ConfigManager.get_config().get("math-env") == expected
    return expected


@pytest.fixture
def seeded_conversation(postgres_url):
    conn = psycopg2.connect(postgres_url)
    # Initial migrations seed positive IDs without advancing their sequence.
    zid = -(uuid4().int % 1_000_000_000 + 1)
    with conn, conn.cursor() as cursor:
        cursor.execute("INSERT INTO conversations (zid, topic) VALUES (%s, %s)",
                       (zid, "Synthetic report environment isolation"))

    def seed(reader, reverse):
        envs = list(ENV_VALUES)
        if reverse:
            envs.reverse()
        with conn, conn.cursor() as cursor:
            for env in envs:
                tick, value = ENV_VALUES[env]
                main = {"engine": env, "tick": tick}
                stats = {"ptptstats": {}}
                if reader == "ptptstats":
                    stats = {"ptptstats": {"tid": [0], "extremeness": [value]}}
                elif reader == "repness":
                    main["repness"] = {"0": {"0": value}}
                elif reader == "pca":
                    main.update({"tids": [0], "pca": {"comment-extremity": [value]}})
                cursor.execute(
                    "INSERT INTO math_main "
                    "(zid, math_env, data, last_vote_timestamp, caching_tick, math_tick, modified) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (zid, env, Json(main), tick, tick, tick, tick),
                )
                cursor.execute(
                    "INSERT INTO math_ptptstats (zid, math_env, math_tick, data, modified) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (zid, env, tick, Json(stats), tick),
                )

    try:
        yield zid, seed
    finally:
        with conn, conn.cursor() as cursor:
            cursor.execute("DELETE FROM math_ptptstats WHERE zid = %s", (zid,))
            cursor.execute("DELETE FROM math_main WHERE zid = %s", (zid,))
            cursor.execute("DELETE FROM conversations WHERE zid = %s", (zid,))
        conn.close()


@pytest.fixture
def read_report(postgres_url, report_modules, monkeypatch):
    modules = report_modules
    client = modules.storage.PostgresClient(
        modules.storage.PostgresConfig(url=postgres_url, ssl_mode="disable")
    )
    # No external services: these tests cover the Postgres report read path.
    monkeypatch.setattr(modules.groups.GroupDataProcessor, "init_dynamodb", lambda self: None)
    monkeypatch.setattr(modules.groups.GroupDataProcessor, "get_all_comment_extremity_values",
                        lambda self, zid: {})
    monkeypatch.setattr(modules.viz, "PostgresClient", lambda: client)
    monkeypatch.setattr(modules.viz, "get_postgres_connection",
                        lambda: psycopg2.connect(postgres_url))
    monkeypatch.setitem(modules.viz.VIZ_CONFIG, "extremity_threshold", 1.0)
    monkeypatch.setitem(modules.viz.VIZ_CONFIG, "invert_extremity", False)

    def read(reader, zid):
        if reader == "groups":
            return modules.groups.GroupDataProcessor(client).get_math_main_by_conversation(zid)
        if reader == "batch":
            # Skip constructor work for LLM/report storage; use the real method.
            generator = modules.batch.BatchReportGenerator.__new__(modules.batch.BatchReportGenerator)
            generator.postgres_client = client
            return generator._get_math_main_data(zid)
        return modules.viz.load_comment_texts_and_extremity(zid)[1]

    try:
        yield read
    finally:
        client.shutdown()


@pytest.mark.integration
@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("reverse", [False, True], ids=["prod-inserted-first", "prod-inserted-last"])
@pytest.mark.parametrize("configured_env", [None, "prod", "python", QUOTED_ENV],
                         indirect=True, ids=["default-prod", "prod", "python", "quoted-env"])
def test_report_reads_only_configured_env(
    reader, reverse, configured_env, seeded_conversation, read_report,
):
    zid, seed = seeded_conversation
    seed(reader, reverse)
    result = read_report(reader, zid)
    tick, value = ENV_VALUES[configured_env]
    if reader in ("groups", "batch"):
        assert result == {"engine": configured_env, "tick": tick}
    else:
        assert result == {0: pytest.approx(value)}


@pytest.mark.integration
@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("configured_env", ["missing"], indirect=True)
def test_report_does_not_fall_back_to_another_engine(
    reader, configured_env, seeded_conversation, read_report,
):
    zid, seed = seeded_conversation
    seed(reader, False)
    if reader == "groups":
        # Existing raw-vote fallback remains valid; it must not use shadow math.
        assert read_report(reader, zid) == {"group_assignments": {}, "n_groups": 3}
    elif reader == "batch":
        assert read_report(reader, zid) is None
    else:
        with pytest.raises(ValueError, match="No extremity values"):
            read_report(reader, zid)
