"""PostgreSQL backend for Delphi Storage V2.

Physical layout: one PG schema (default ``delphi``, configurable via
``DELPHI_STORAGE_PG_SCHEMA``) holding

- ``runs``    — typed queue columns (job_id, status, claim_order, zid, rid,
  enqueued_at, version) + the full manifest as JSONB, following the legacy
  Clojure ``math_main`` JSONB pattern (design §3.6);
- ``latest``  — scope-keyed pointer rows;
- four KV tables (``run_inputs``, ``artifacts``, ``topic_moderation``,
  ``collective_statements``) — (pk, sk COLLATE "C") + JSONB attributes +
  BYTEA blob. COLLATE "C" gives UTF-8 byte order, matching DynamoDB's native
  range-key order (conformance §Ordering).

Queue claim uses ``FOR UPDATE SKIP LOCKED`` (design §4.3); no chunking is
needed (BYTEA has no 400KB limit). The DDL here is the single Python-side
source; migration 000019 (P4) materializes the same schema for server-managed
deployments.
"""

import json
import os
import re
from typing import Any, Optional, Sequence, Union

import sqlalchemy
from sqlalchemy import text

from delphi_storage.codec import canonical_json_dumps
from delphi_storage.interface import (
    AlreadyExists,
    coerce_job_type,
    coerce_run_status,
    DelphiStore,
    Invalid,
    NotFound,
    StorageError,
    validate_enqueueable,
    validate_generic_read,
    validate_generic_write,
)
from delphi_storage.keys import (
    GENERIC_ENTITIES,
    claim_order,
    now_ts,
    ts_add_seconds,
    validate_ts,
)
from delphi_storage.models import (
    AdvanceResult,
    JobType,
    LatestPointer,
    RunManifest,
    RunStatus,
    StoreItem,
    TERMINAL_STATUSES,
)
from delphi_storage.backends.memory import merge_manifest_fields

_IDENTIFIER_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")

_MUTATION_RETRIES = 8


def kv_tables_ddl(schema: str) -> list[str]:
    return [
        f"""
        CREATE TABLE IF NOT EXISTS {schema}.{entity} (
            pk text NOT NULL,
            sk text COLLATE "C" NOT NULL,
            attributes jsonb NOT NULL DEFAULT '{{}}'::jsonb,
            blob bytea,
            PRIMARY KEY (pk, sk)
        )
        """
        for entity in GENERIC_ENTITIES
    ]


def runs_ddl(schema: str) -> list[str]:
    return [
        f"""
        CREATE TABLE IF NOT EXISTS {schema}.runs (
            job_id text PRIMARY KEY,
            status text NOT NULL,
            claim_order text COLLATE "C",
            zid bigint,
            rid bigint,
            enqueued_at text NOT NULL,
            version bigint NOT NULL,
            manifest jsonb NOT NULL
        )
        """,
        f"""
        CREATE INDEX IF NOT EXISTS runs_claim_idx
            ON {schema}.runs (claim_order) WHERE status = 'QUEUED'
        """,
        f"CREATE INDEX IF NOT EXISTS runs_zid_idx ON {schema}.runs (zid, enqueued_at)",
        f"CREATE INDEX IF NOT EXISTS runs_rid_idx ON {schema}.runs (rid, enqueued_at)",
    ]


def latest_ddl(schema: str) -> list[str]:
    return [
        f"""
        CREATE TABLE IF NOT EXISTS {schema}.latest (
            scope text PRIMARY KEY,
            job_id text NOT NULL,
            seq bigint NOT NULL,
            job_type text NOT NULL,
            updated_at text NOT NULL
        )
        """
    ]


def schema_ddl(schema: str) -> list[str]:
    """Full DDL — single Python-side source, mirrored by migration 000019."""
    statements = [f"CREATE SCHEMA IF NOT EXISTS {schema}"]
    statements.extend(runs_ddl(schema))
    statements.extend(latest_ddl(schema))
    statements.extend(kv_tables_ddl(schema))
    return statements


class PostgresDelphiStore(DelphiStore):
    def __init__(
        self,
        url: Optional[str] = None,
        schema: Optional[str] = None,
        ensure_schema: bool = False,
    ) -> None:
        url = url or os.environ.get("DELPHI_STORAGE_PG_URL") or os.environ.get("DATABASE_URL")
        if not url:
            raise Invalid("PostgresDelphiStore needs DELPHI_STORAGE_PG_URL or DATABASE_URL")
        # SQLAlchemy 2.0 dropped the legacy ``postgres://`` alias and raises
        # NoSuchModuleError on it, but that's still what many platforms (Heroku
        # et al.) put in DATABASE_URL. Normalize just the scheme; any +driver
        # suffix and the rest of the URL are left untouched.
        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://"):]
        schema = schema or os.environ.get("DELPHI_STORAGE_PG_SCHEMA", "delphi")
        if not _IDENTIFIER_RE.match(schema):
            raise Invalid(f"schema name {schema!r} must match {_IDENTIFIER_RE.pattern}")
        self.schema = schema
        self._engine = sqlalchemy.create_engine(
            url,
            pool_pre_ping=True,
            connect_args={"connect_timeout": int(os.environ.get("POSTGRES_CONNECT_TIMEOUT", "30"))},
        )
        if ensure_schema:
            self.ensure_schema()

    # ---- schema management (used by tests and P4 tooling) ----

    def ensure_schema(self) -> None:
        with self._engine.begin() as conn:
            for statement in schema_ddl(self.schema):
                conn.execute(text(statement))

    def drop_schema(self) -> None:
        with self._engine.begin() as conn:
            conn.execute(text(f"DROP SCHEMA IF EXISTS {self.schema} CASCADE"))
        self._engine.dispose()

    def _kv(self, entity: str) -> str:
        validate_generic_read(entity)
        return f"{self.schema}.{entity}"

    # ---- generic ----

    def put(self, entity: str, item: StoreItem) -> None:
        validate_generic_write(entity, item)
        table = self._kv(entity)
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    f"""
                    INSERT INTO {table} (pk, sk, attributes, blob)
                    VALUES (:pk, :sk, CAST(:attributes AS jsonb), :blob)
                    ON CONFLICT (pk, sk)
                    DO UPDATE SET attributes = EXCLUDED.attributes, blob = EXCLUDED.blob
                    """
                ),
                {
                    "pk": item.pk,
                    "sk": item.sk,
                    "attributes": canonical_json_dumps(item.attributes),
                    "blob": item.blob,
                },
            )

    def put_batch(self, entity: str, items: Sequence[StoreItem]) -> None:
        for item in items:
            validate_generic_write(entity, item)
        table = self._kv(entity)
        with self._engine.begin() as conn:
            for item in items:
                conn.execute(
                    text(
                        f"""
                        INSERT INTO {table} (pk, sk, attributes, blob)
                        VALUES (:pk, :sk, CAST(:attributes AS jsonb), :blob)
                        ON CONFLICT (pk, sk)
                        DO UPDATE SET attributes = EXCLUDED.attributes, blob = EXCLUDED.blob
                        """
                    ),
                    {
                        "pk": item.pk,
                        "sk": item.sk,
                        "attributes": canonical_json_dumps(item.attributes),
                        "blob": item.blob,
                    },
                )

    @staticmethod
    def _row_to_item(row: Any) -> StoreItem:
        attributes = row.attributes
        if isinstance(attributes, str):  # psycopg2 may hand JSONB back parsed or raw
            attributes = json.loads(attributes)
        blob = bytes(row.blob) if row.blob is not None else None
        return StoreItem(pk=row.pk, sk=row.sk, attributes=attributes, blob=blob)

    def get(self, entity: str, pk: str, sk: str) -> Optional[StoreItem]:
        table = self._kv(entity)
        with self._engine.begin() as conn:
            row = conn.execute(
                text(f"SELECT pk, sk, attributes, blob FROM {table} WHERE pk = :pk AND sk = :sk"),
                {"pk": pk, "sk": sk},
            ).fetchone()
        return self._row_to_item(row) if row else None

    def query_prefix(self, entity: str, pk: str, sk_prefix: str = "") -> list[StoreItem]:
        table = self._kv(entity)
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    f"""
                    SELECT pk, sk, attributes, blob FROM {table}
                    WHERE pk = :pk AND left(sk, :n) = :prefix
                    ORDER BY sk COLLATE "C"
                    """
                ),
                {"pk": pk, "n": len(sk_prefix), "prefix": sk_prefix},
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def query_between(self, entity: str, pk: str, sk_from: str, sk_to: str) -> list[StoreItem]:
        table = self._kv(entity)
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    f"""
                    SELECT pk, sk, attributes, blob FROM {table}
                    WHERE pk = :pk AND sk >= :lo AND sk <= :hi
                    ORDER BY sk COLLATE "C"
                    """
                ),
                {"pk": pk, "lo": sk_from, "hi": sk_to},
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def delete_partition(self, entity: str, pk: str) -> int:
        table = self._kv(entity)
        with self._engine.begin() as conn:
            result = conn.execute(text(f"DELETE FROM {table} WHERE pk = :pk"), {"pk": pk})
        return result.rowcount or 0

    # ---- runs / queue ----

    @property
    def _runs(self) -> str:
        return f"{self.schema}.runs"

    @property
    def _latest(self) -> str:
        return f"{self.schema}.latest"

    def _run_params(self, run: RunManifest) -> dict[str, Any]:
        return {
            "job_id": run.job_id,
            "status": run.status.value,
            "claim_order": (
                claim_order(run.priority, run.enqueued_at, run.job_id)
                if run.status == RunStatus.QUEUED
                else None
            ),
            "zid": run.zid,
            "rid": run.rid,
            "enqueued_at": run.enqueued_at,
            "version": run.version,
            "manifest": canonical_json_dumps(run.model_dump(mode="json")),
        }

    @staticmethod
    def _manifest_from(value: Any) -> RunManifest:
        if isinstance(value, str):
            value = json.loads(value)
        return RunManifest(**value)

    def enqueue_run(self, run: RunManifest) -> None:
        validate_enqueueable(run)
        with self._engine.begin() as conn:
            result = conn.execute(
                text(
                    f"""
                    INSERT INTO {self._runs}
                        (job_id, status, claim_order, zid, rid, enqueued_at, version, manifest)
                    VALUES (:job_id, :status, :claim_order, :zid, :rid, :enqueued_at,
                            :version, CAST(:manifest AS jsonb))
                    ON CONFLICT (job_id) DO NOTHING
                    """
                ),
                self._run_params(run),
            )
        if not result.rowcount:
            raise AlreadyExists(f"run {run.job_id!r} already exists")

    def get_run(self, job_id: str) -> Optional[RunManifest]:
        with self._engine.begin() as conn:
            row = conn.execute(
                text(f"SELECT manifest FROM {self._runs} WHERE job_id = :job_id"),
                {"job_id": job_id},
            ).fetchone()
        return self._manifest_from(row.manifest) if row else None

    def _write_run(self, conn: Any, run: RunManifest, expected_version: int) -> bool:
        params = self._run_params(run)
        params["expected_version"] = expected_version
        result = conn.execute(
            text(
                f"""
                UPDATE {self._runs}
                SET status = :status, claim_order = :claim_order, version = :version,
                    manifest = CAST(:manifest AS jsonb)
                WHERE job_id = :job_id AND version = :expected_version
                """
            ),
            params,
        )
        return bool(result.rowcount)

    def claim_next_run(
        self, worker_id: str, lease_seconds: int, now: Optional[str] = None
    ) -> Optional[RunManifest]:
        now = validate_ts(now) if now is not None else now_ts()
        with self._engine.begin() as conn:
            row = conn.execute(
                text(
                    f"""
                    SELECT manifest FROM {self._runs}
                    WHERE status = 'QUEUED'
                    ORDER BY claim_order COLLATE "C"
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                    """
                )
            ).fetchone()
            if row is None:
                return None
            run = self._manifest_from(row.manifest)
            claimed = run.model_copy(
                update={
                    "status": RunStatus.RUNNING,
                    "worker_id": worker_id,
                    "started_at": now,
                    "lease_expires_at": ts_add_seconds(now, lease_seconds),
                    "version": run.version + 1,
                }
            )
            if not self._write_run(conn, claimed, expected_version=run.version):
                raise StorageError(f"claim of {run.job_id!r} lost a race despite row lock")
            return claimed

    def extend_lease(
        self, job_id: str, worker_id: str, lease_seconds: int, now: Optional[str] = None
    ) -> bool:
        now = validate_ts(now) if now is not None else now_ts()
        with self._engine.begin() as conn:
            row = conn.execute(
                text(f"SELECT manifest FROM {self._runs} WHERE job_id = :job_id FOR UPDATE"),
                {"job_id": job_id},
            ).fetchone()
            if row is None:
                return False
            run = self._manifest_from(row.manifest)
            if run.status != RunStatus.RUNNING or run.worker_id != worker_id:
                return False
            extended = run.model_copy(
                update={
                    "lease_expires_at": ts_add_seconds(now, lease_seconds),
                    "version": run.version + 1,
                }
            )
            return self._write_run(conn, extended, expected_version=run.version)

    def _mutate_run(self, job_id: str, mutate) -> RunManifest:
        with self._engine.begin() as conn:
            row = conn.execute(
                text(f"SELECT manifest FROM {self._runs} WHERE job_id = :job_id FOR UPDATE"),
                {"job_id": job_id},
            ).fetchone()
            if row is None:
                raise NotFound(f"run {job_id!r} not found")
            run = self._manifest_from(row.manifest)
            updated = mutate(run).model_copy(update={"version": run.version + 1})
            if not self._write_run(conn, updated, expected_version=run.version):
                raise StorageError(f"update of {job_id!r} lost a race despite row lock")
            return updated

    def update_run_status(
        self,
        job_id: str,
        status: Union[RunStatus, str],
        error: Optional[str] = None,
        now: Optional[str] = None,
    ) -> RunManifest:
        status = coerce_run_status(status)
        now = validate_ts(now) if now is not None else now_ts()

        def mutate(run: RunManifest) -> RunManifest:
            updates: dict[str, Any] = {"status": status}
            if error is not None:
                updates["error"] = error
            if status in TERMINAL_STATUSES and run.completed_at is None:
                updates["completed_at"] = now
            return run.model_copy(update=updates)

        return self._mutate_run(job_id, mutate)

    def merge_run_fields(self, job_id: str, fields: dict[str, Any]) -> RunManifest:
        return self._mutate_run(job_id, lambda run: merge_manifest_fields(run, fields))

    def _increment_log_seq(self, job_id: str) -> int:
        with self._engine.begin() as conn:
            row = conn.execute(
                text(
                    f"""
                    UPDATE {self._runs}
                    SET version = version + 1,
                        manifest = jsonb_set(
                            jsonb_set(manifest, '{{log_seq}}',
                                to_jsonb(COALESCE((manifest->>'log_seq')::bigint, 0) + 1)),
                            '{{version}}', to_jsonb(version + 1))
                    WHERE job_id = :job_id
                    RETURNING (manifest->>'log_seq')::bigint AS log_seq
                    """
                ),
                {"job_id": job_id},
            ).fetchone()
        if row is None:
            raise NotFound(f"run {job_id!r} not found")
        return int(row.log_seq)

    # ---- latest ----

    def advance_latest(
        self,
        scope: str,
        job_id: str,
        job_type: Union[JobType, str],
        only_if_absent_or_imported: bool = False,
        now: Optional[str] = None,
    ) -> AdvanceResult:
        job_type = coerce_job_type(job_type)
        now = validate_ts(now) if now is not None else now_ts()
        for _ in range(_MUTATION_RETRIES):
            with self._engine.begin() as conn:
                row = conn.execute(
                    text(f"SELECT * FROM {self._latest} WHERE scope = :scope FOR UPDATE"),
                    {"scope": scope},
                ).fetchone()
                if row is not None:
                    current = LatestPointer(
                        scope=row.scope,
                        job_id=row.job_id,
                        seq=row.seq,
                        job_type=row.job_type,
                        updated_at=row.updated_at,
                    )
                    if current.job_id == job_id:
                        return AdvanceResult(advanced=False, pointer=current)
                    if only_if_absent_or_imported and current.job_type != JobType.IMPORTED:
                        return AdvanceResult(advanced=False, pointer=current)
                    pointer = LatestPointer(
                        scope=scope,
                        job_id=job_id,
                        seq=current.seq + 1,
                        job_type=job_type,
                        updated_at=now,
                    )
                    conn.execute(
                        text(
                            f"""
                            UPDATE {self._latest}
                            SET job_id = :job_id, seq = :seq, job_type = :job_type,
                                updated_at = :updated_at
                            WHERE scope = :scope
                            """
                        ),
                        pointer.model_dump(mode="json"),
                    )
                    return AdvanceResult(advanced=True, pointer=pointer)
                pointer = LatestPointer(
                    scope=scope, job_id=job_id, seq=1, job_type=job_type, updated_at=now
                )
                result = conn.execute(
                    text(
                        f"""
                        INSERT INTO {self._latest} (scope, job_id, seq, job_type, updated_at)
                        VALUES (:scope, :job_id, :seq, :job_type, :updated_at)
                        ON CONFLICT (scope) DO NOTHING
                        """
                    ),
                    pointer.model_dump(mode="json"),
                )
                if result.rowcount:
                    return AdvanceResult(advanced=True, pointer=pointer)
                # lost the empty-scope insert race — re-read and re-decide
        raise StorageError(f"latest {scope!r}: lost {_MUTATION_RETRIES} insert races")

    def get_latest(self, scope: str) -> Optional[LatestPointer]:
        with self._engine.begin() as conn:
            row = conn.execute(
                text(f"SELECT * FROM {self._latest} WHERE scope = :scope"), {"scope": scope}
            ).fetchone()
        if row is None:
            return None
        return LatestPointer(
            scope=row.scope,
            job_id=row.job_id,
            seq=row.seq,
            job_type=row.job_type,
            updated_at=row.updated_at,
        )

    def list_runs(
        self,
        zid: Optional[int] = None,
        rid: Optional[int] = None,
        status: Optional[Union[RunStatus, str]] = None,
        limit: int = 100,
    ) -> list[RunManifest]:
        if (zid is None) == (rid is None):
            raise Invalid("exactly one of zid/rid is required")
        status = coerce_run_status(status) if status is not None else None
        column, value = ("zid", zid) if zid is not None else ("rid", rid)
        clauses = f"{column} = :value"
        params: dict[str, Any] = {"value": value, "limit": limit}
        if status is not None:
            clauses += " AND status = :status"
            params["status"] = status.value
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    f"""
                    SELECT manifest FROM {self._runs}
                    WHERE {clauses}
                    ORDER BY enqueued_at DESC, job_id DESC
                    LIMIT :limit
                    """
                ),
                params,
            ).fetchall()
        return [self._manifest_from(row.manifest) for row in rows]
