"""P4 DDL tests: the deployable table definitions must be the SAME schemas the
backends define (design §4.2: "DDL: new migration 000019 + additions to
create_dynamodb_tables.py").

Two deployment paths exist and neither can import delphi_storage:
- create_dynamodb_tables.py runs standalone (bare python:3.11-slim + boto3)
  in the dynamodb-init container, so its Delphi2 schemas are inlined — the
  sync tests here are what make delphi_storage the single source of truth.
- Migration 000019 is applied by psql (bin/run-migrations.sh), so its SQL is
  compared statement-by-statement against the backend's DDL, and applied to a
  scratch database that must then pass the full conformance suite WITHOUT
  ensure_schema.
"""

import os
import re
import uuid
from pathlib import Path

import pytest

import create_dynamodb_tables as cdt
from delphi_storage.backends.dynamodb import table_schemas
from delphi_storage.backends.postgres import schema_ddl

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "server"
    / "postgres"
    / "migrations"
    / "000019_create_delphi_storage.sql"
)

_IN_GHA = os.environ.get("GITHUB_ACTIONS") == "true"


def _normalize_sql(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip().lower()


class TestDynamoSchemaSync:
    def test_delphi2_schemas_match_backend(self):
        expected = {
            schema["TableName"]: {k: v for k, v in schema.items() if k != "TableName"}
            for schema in table_schemas("Delphi2_")
        }
        assert cdt.DELPHI2_TABLE_SCHEMAS == expected, (
            "create_dynamodb_tables.DELPHI2_TABLE_SCHEMAS has drifted from "
            "delphi_storage.backends.dynamodb.table_schemas('Delphi2_') — "
            "the backend is the source of truth; update the inlined copy"
        )

    def test_create_delphi2_tables_is_wired_into_create_tables(self):
        import inspect

        source = inspect.getsource(cdt.create_tables)
        assert "create_delphi2_tables" in source

    def test_create_delphi2_tables_honors_prefix_env(self, monkeypatch):
        """Provisioning must honor DELPHI_STORAGE_TABLE_PREFIX exactly like the
        runtime store, or the app and the init script silently diverge."""
        moto = pytest.importorskip("moto")
        import boto3

        monkeypatch.setenv("DELPHI_STORAGE_TABLE_PREFIX", "Custom_")
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "dummy")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "dummy")
        with moto.mock_aws():
            resource = boto3.Session(region_name="us-east-1").resource("dynamodb")
            created = cdt.create_delphi2_tables(resource)
            assert created and all(name.startswith("Custom_") for name in created)
            assert set(created) == {
                name.replace("Delphi2_", "Custom_", 1) for name in cdt.DELPHI2_TABLE_SCHEMAS
            }


class TestMigrationSync:
    def test_migration_file_exists(self):
        assert MIGRATION.exists(), f"missing {MIGRATION}"

    def test_migration_contains_every_backend_statement(self):
        migration = _normalize_sql(MIGRATION.read_text(encoding="utf-8"))
        for statement in schema_ddl("delphi"):
            normalized = _normalize_sql(statement)
            assert normalized in migration, (
                f"migration 000019 is missing (or has drifted from) this backend "
                f"DDL statement:\n{statement}"
            )


def _pg_url() -> str | None:
    return os.environ.get("DELPHI_STORAGE_PG_URL") or os.environ.get("DATABASE_URL")


class TestDeployedStoresPassConformance:
    """The deployment artifacts (not ensure_* helpers) must yield conformant stores."""

    def test_migration_applied_by_sql_passes_conformance(self):
        url = _pg_url()
        if not url:
            if _IN_GHA:
                pytest.fail("PostgreSQL must be available in GitHub Actions")
            pytest.skip("PostgreSQL unavailable: no DELPHI_STORAGE_PG_URL / DATABASE_URL")
        import sqlalchemy
        from sqlalchemy import text

        from delphi_storage.backends.postgres import PostgresDelphiStore
        from delphi_storage.conformance.runner import load_cases, run_case

        dbname = f"conf_mig_{uuid.uuid4().hex[:10]}"
        admin = sqlalchemy.create_engine(
            url, isolation_level="AUTOCOMMIT", connect_args={"connect_timeout": 3}
        )
        try:
            with admin.connect() as conn:
                conn.execute(text(f'CREATE DATABASE "{dbname}"'))
        except Exception as e:  # noqa: BLE001
            admin.dispose()
            if _IN_GHA:
                raise
            pytest.skip(f"PostgreSQL unavailable: {e}")

        scratch_url = url.rsplit("/", 1)[0] + f"/{dbname}"
        try:
            scratch = sqlalchemy.create_engine(scratch_url)
            with scratch.begin() as conn:
                for statement in MIGRATION.read_text(encoding="utf-8").split(";"):
                    without_comments = "\n".join(
                        line for line in statement.splitlines()
                        if not line.lstrip().startswith("--")
                    )
                    if without_comments.strip():
                        conn.execute(text(statement))
            scratch.dispose()
            for case in load_cases():
                store = PostgresDelphiStore(url=scratch_url, schema="delphi")
                try:
                    run_case(store, case)
                finally:
                    # fresh state per case without dropping the migrated schema
                    with sqlalchemy.create_engine(scratch_url).begin() as conn:
                        for entity in ("runs", "latest", "run_inputs", "artifacts",
                                       "topic_moderation", "collective_statements"):
                            conn.execute(text(f"TRUNCATE delphi.{entity}"))
        finally:
            with admin.connect() as conn:
                conn.execute(
                    text(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
                )
            admin.dispose()

    def test_create_script_tables_pass_conformance(self):
        endpoint = os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000")
        import boto3
        from botocore.config import Config as BotoConfig

        try:
            probe = boto3.client(
                "dynamodb",
                endpoint_url=endpoint,
                region_name="us-east-1",
                aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "dummy"),
                aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "dummy"),
                config=BotoConfig(connect_timeout=3, read_timeout=3, retries={"max_attempts": 0}),
            )
            probe.list_tables(Limit=1)
        except Exception as e:  # noqa: BLE001
            if _IN_GHA:
                pytest.fail(f"DynamoDB must be available in GitHub Actions: {e}")
            pytest.skip(f"DynamoDB unavailable: {endpoint}: {e}")

        from delphi_storage.backends.dynamodb import DynamoDelphiStore
        from delphi_storage.conformance.runner import load_cases, run_case

        os.environ.setdefault("AWS_ACCESS_KEY_ID", "dummy")
        os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "dummy")
        session = boto3.Session(region_name="us-east-1")
        resource = session.resource("dynamodb", endpoint_url=endpoint)
        try:
            created = cdt.create_delphi2_tables(resource, delete_existing=True)
            assert set(created) == set(cdt.DELPHI2_TABLE_SCHEMAS)
            for case in load_cases():
                # ensure_tables=False: the script's tables must suffice as-is.
                store = DynamoDelphiStore(
                    table_prefix="Delphi2_", endpoint_url=endpoint, region="us-east-1"
                )
                run_case(store, case)
                # fresh state per case: the script's delete_existing path
                # waits on the table_not_exists/table_exists waiters
                cdt.create_delphi2_tables(resource, delete_existing=True)
        finally:
            DynamoDelphiStore(
                table_prefix="Delphi2_", endpoint_url=endpoint, region="us-east-1"
            ).drop_tables()
