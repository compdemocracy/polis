"""DynamoDB backend for Delphi Storage V2.

Physical layout (table prefix configurable, default ``Delphi2_``):

- ``<prefix>Runs``                 — PK job_id; sparse GSI ``claim-index``
  (claim_status, claim_order) for queue claims; sparse GSIs ``zid-index`` /
  ``rid-index`` (zid_key/rid_key, enqueued_at) for list_runs.
- ``<prefix>Latest``               — PK scope.
- ``<prefix>RunInputs`` / ``<prefix>Artifacts`` / ``<prefix>TopicModeration``
  / ``<prefix>CollectiveStatements`` — PK pk, SK sk.

Blobs larger than ``CHUNK_SIZE`` are split across chunk rows whose sort keys
start with U+007F (forbidden in user keys); they are reassembled on read and
invisible to queries. Claim/lease/version mutations are conditional writes on
``version`` (the lift of the working job_poller optimistic-lock pattern,
design §4.3); candidate discovery uses the GSI but every mutation conditions
on the base table. Uses the low-level boto3 client (thread-safe, unlike the
resource API) with TypeSerializer/TypeDeserializer.
"""

import os
import uuid
from typing import Any, Iterable, Optional, Union

import boto3
from boto3.dynamodb.types import Binary, TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

from delphi_storage.codec import from_dynamo, to_dynamo
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
    CHUNK_MARKER,
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

#: Max blob bytes stored inline in one item (DynamoDB item limit is 400KB
#: including attribute names; 300KB leaves ample headroom for attributes).
CHUNK_SIZE = 300_000

_ENTITY_TABLES = {
    "run_inputs": "RunInputs",
    "artifacts": "Artifacts",
    "topic_moderation": "TopicModeration",
    "collective_statements": "CollectiveStatements",
}

_KV_TABLE_NAMES = tuple(_ENTITY_TABLES.values())

#: Fields stored as top-level item attributes purely for indexing; stripped
#: before manifest deserialization.
_RUNS_INDEX_ATTRS = ("claim_status", "claim_order", "zid_key", "rid_key")

_MUTATION_RETRIES = 8


def kv_table_schema(table_name: str) -> dict[str, Any]:
    return {
        "TableName": table_name,
        "KeySchema": [
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        "BillingMode": "PAY_PER_REQUEST",
    }


def runs_table_schema(table_name: str) -> dict[str, Any]:
    return {
        "TableName": table_name,
        "KeySchema": [{"AttributeName": "job_id", "KeyType": "HASH"}],
        "AttributeDefinitions": [
            {"AttributeName": "job_id", "AttributeType": "S"},
            {"AttributeName": "claim_status", "AttributeType": "S"},
            {"AttributeName": "claim_order", "AttributeType": "S"},
            {"AttributeName": "zid_key", "AttributeType": "S"},
            {"AttributeName": "rid_key", "AttributeType": "S"},
            {"AttributeName": "enqueued_at", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "claim-index",
                "KeySchema": [
                    {"AttributeName": "claim_status", "KeyType": "HASH"},
                    {"AttributeName": "claim_order", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "KEYS_ONLY"},
            },
            {
                "IndexName": "zid-index",
                "KeySchema": [
                    {"AttributeName": "zid_key", "KeyType": "HASH"},
                    {"AttributeName": "enqueued_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
            {
                "IndexName": "rid-index",
                "KeySchema": [
                    {"AttributeName": "rid_key", "KeyType": "HASH"},
                    {"AttributeName": "enqueued_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
        "BillingMode": "PAY_PER_REQUEST",
    }


def latest_table_schema(table_name: str) -> dict[str, Any]:
    return {
        "TableName": table_name,
        "KeySchema": [{"AttributeName": "scope", "KeyType": "HASH"}],
        "AttributeDefinitions": [{"AttributeName": "scope", "AttributeType": "S"}],
        "BillingMode": "PAY_PER_REQUEST",
    }


def table_schemas(prefix: str) -> list[dict[str, Any]]:
    """All V2 table definitions — single source for ensure_tables() and for
    create_dynamodb_tables.py (P4)."""
    schemas = [
        runs_table_schema(f"{prefix}Runs"),
        latest_table_schema(f"{prefix}Latest"),
    ]
    schemas.extend(kv_table_schema(f"{prefix}{name}") for name in _KV_TABLE_NAMES)
    return schemas


def _chunk_prefix(sk: str) -> str:
    return f"{CHUNK_MARKER}{sk}{CHUNK_MARKER}"


def _chunk_sk(sk: str, gen: str, index: int) -> str:
    return f"{_chunk_prefix(sk)}{gen}{CHUNK_MARKER}{index:05d}"


def _is_chunk_sk(sk: str) -> bool:
    return sk.startswith(CHUNK_MARKER)


class DynamoDelphiStore(DelphiStore):
    def __init__(
        self,
        table_prefix: Optional[str] = None,
        endpoint_url: Optional[str] = None,
        region: Optional[str] = None,
        ensure_tables: bool = False,
    ) -> None:
        self.table_prefix = table_prefix or os.environ.get(
            "DELPHI_STORAGE_TABLE_PREFIX", "Delphi2_"
        )
        endpoint_url = endpoint_url or os.environ.get("DYNAMODB_ENDPOINT") or None
        region = region or os.environ.get("AWS_REGION", "us-east-1")
        kwargs: dict[str, Any] = {"region_name": region}
        if endpoint_url:
            kwargs["endpoint_url"] = endpoint_url
        self._client = boto3.client("dynamodb", **kwargs)
        self._ser = TypeSerializer()
        self._deser = TypeDeserializer()
        if ensure_tables:
            self.ensure_tables()

    # ---- table management (used by tests and P4 tooling) ----

    def ensure_tables(self) -> None:
        existing = set(self._list_table_names())
        for schema in table_schemas(self.table_prefix):
            if schema["TableName"] not in existing:
                self._client.create_table(**schema)
        waiter = self._client.get_waiter("table_exists")
        for schema in table_schemas(self.table_prefix):
            waiter.wait(TableName=schema["TableName"], WaiterConfig={"Delay": 1, "MaxAttempts": 60})

    def drop_tables(self) -> None:
        existing = set(self._list_table_names())
        for schema in table_schemas(self.table_prefix):
            if schema["TableName"] in existing:
                self._client.delete_table(TableName=schema["TableName"])

    def _list_table_names(self) -> Iterable[str]:
        paginator = self._client.get_paginator("list_tables")
        for page in paginator.paginate():
            yield from page["TableNames"]

    # ---- marshalling helpers ----

    def _table(self, entity: str) -> str:
        return f"{self.table_prefix}{_ENTITY_TABLES[entity]}"

    def _marshal(self, obj: dict[str, Any]) -> dict[str, Any]:
        return {k: self._ser.serialize(v) for k, v in to_dynamo(obj).items()}

    def _unmarshal(self, item: dict[str, Any]) -> dict[str, Any]:
        return from_dynamo({k: self._deser.deserialize(v) for k, v in item.items()})

    def _query_all(self, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            page = self._client.query(**kwargs)
            items.extend(page.get("Items", []))
            last = page.get("LastEvaluatedKey")
            if not last:
                return items
            kwargs["ExclusiveStartKey"] = last

    # ---- generic ----

    def put(self, entity: str, item: StoreItem) -> None:
        """Crash-safe write order for chunked blobs: new-generation chunk rows
        first (invisible — the main item still references the old generation),
        THEN the main item (the commit point flips readers atomically), THEN
        stale-generation cleanup. A crash at any point leaves the previous
        value fully readable; orphaned generations are swept by the next
        successful put."""
        validate_generic_write(entity, item)
        table = self._table(entity)
        blob = item.blob or b""
        n_chunks = 0
        if item.blob is not None and len(blob) > CHUNK_SIZE:
            n_chunks = (len(blob) + CHUNK_SIZE - 1) // CHUNK_SIZE
        gen = uuid.uuid4().hex[:12]
        for i in range(n_chunks):
            part = blob[i * CHUNK_SIZE : (i + 1) * CHUNK_SIZE]
            self._client.put_item(
                TableName=table,
                Item={
                    "pk": {"S": item.pk},
                    "sk": {"S": _chunk_sk(item.sk, gen, i)},
                    "part": {"B": part},
                },
            )
        record: dict[str, Any] = {
            "pk": {"S": item.pk},
            "sk": {"S": item.sk},
            "attributes": self._ser.serialize(to_dynamo(item.attributes)),
        }
        if item.blob is not None:
            if n_chunks:
                record["_chunks"] = {"N": str(n_chunks)}
                record["_blob_len"] = {"N": str(len(blob))}
                record["_blob_gen"] = {"S": gen}
            else:
                record["blob"] = {"B": blob}
        self._client.put_item(TableName=table, Item=record)
        self._delete_chunk_rows(table, item.pk, item.sk, keep_gen=gen if n_chunks else None)

    def _delete_chunk_rows(
        self, table: str, pk: str, sk: str, keep_gen: Optional[str] = None
    ) -> None:
        prefix = _chunk_prefix(sk)
        keep_prefix = f"{prefix}{keep_gen}{CHUNK_MARKER}" if keep_gen is not None else None
        rows = self._query_all(
            TableName=table,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={":pk": {"S": pk}, ":prefix": {"S": prefix}},
            ProjectionExpression="pk, sk",
            ConsistentRead=True,
        )
        for row in rows:
            if keep_prefix is not None and row["sk"]["S"].startswith(keep_prefix):
                continue
            self._client.delete_item(TableName=table, Key={"pk": row["pk"], "sk": row["sk"]})

    def _read_blob(self, table: str, raw_item: dict[str, Any]) -> Optional[bytes]:
        if "blob" in raw_item:
            value = raw_item["blob"]["B"]
            return bytes(value.value if isinstance(value, Binary) else value)
        if "_chunks" not in raw_item:
            return None
        pk = raw_item["pk"]["S"]
        sk = raw_item["sk"]["S"]
        n_chunks = int(raw_item["_chunks"]["N"])
        blob_len = int(raw_item["_blob_len"]["N"])
        gen = raw_item["_blob_gen"]["S"]
        # Fetch exactly the deterministic chunk keys of the committed
        # generation — stale rows from other generations can never interfere.
        parts: list[bytes] = []
        for i in range(n_chunks):
            response = self._client.get_item(
                TableName=table,
                Key={"pk": {"S": pk}, "sk": {"S": _chunk_sk(sk, gen, i)}},
                ConsistentRead=True,
            )
            row = response.get("Item")
            if row is None:
                raise StorageError(
                    f"corrupt chunked blob at {pk!r}/{sk!r}: missing chunk {i}/{n_chunks} "
                    f"of generation {gen}"
                )
            value = row["part"]["B"]
            parts.append(bytes(value.value if isinstance(value, Binary) else value))
        blob = b"".join(parts)
        if len(blob) != blob_len:
            raise StorageError(
                f"corrupt chunked blob at {pk!r}/{sk!r}: {len(blob)}/{blob_len} bytes"
            )
        return blob

    def _to_store_item(self, table: str, raw_item: dict[str, Any]) -> StoreItem:
        attributes = from_dynamo(self._deser.deserialize(raw_item["attributes"]))
        return StoreItem(
            pk=raw_item["pk"]["S"],
            sk=raw_item["sk"]["S"],
            attributes=attributes,
            blob=self._read_blob(table, raw_item),
        )

    def get(self, entity: str, pk: str, sk: str) -> Optional[StoreItem]:
        validate_generic_read(entity)
        table = self._table(entity)
        response = self._client.get_item(
            TableName=table, Key={"pk": {"S": pk}, "sk": {"S": sk}}, ConsistentRead=True
        )
        raw_item = response.get("Item")
        if raw_item is None:
            return None
        return self._to_store_item(table, raw_item)

    def query_prefix(self, entity: str, pk: str, sk_prefix: str = "") -> list[StoreItem]:
        validate_generic_read(entity)
        table = self._table(entity)
        kwargs: dict[str, Any] = {
            "TableName": table,
            "ConsistentRead": True,
            "ExpressionAttributeValues": {":pk": {"S": pk}},
            "KeyConditionExpression": "pk = :pk",
        }
        if sk_prefix:
            kwargs["KeyConditionExpression"] += " AND begins_with(sk, :prefix)"
            kwargs["ExpressionAttributeValues"][":prefix"] = {"S": sk_prefix}
        rows = self._query_all(**kwargs)
        return [
            self._to_store_item(table, row) for row in rows if not _is_chunk_sk(row["sk"]["S"])
        ]

    def query_between(self, entity: str, pk: str, sk_from: str, sk_to: str) -> list[StoreItem]:
        validate_generic_read(entity)
        table = self._table(entity)
        rows = self._query_all(
            TableName=table,
            ConsistentRead=True,
            KeyConditionExpression="pk = :pk AND sk BETWEEN :lo AND :hi",
            ExpressionAttributeValues={
                ":pk": {"S": pk},
                ":lo": {"S": sk_from},
                ":hi": {"S": sk_to},
            },
        )
        return [
            self._to_store_item(table, row) for row in rows if not _is_chunk_sk(row["sk"]["S"])
        ]

    def delete_partition(self, entity: str, pk: str) -> int:
        validate_generic_read(entity)
        table = self._table(entity)
        rows = self._query_all(
            TableName=table,
            ConsistentRead=True,
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": {"S": pk}},
            ProjectionExpression="pk, sk",
        )
        logical = 0
        for row in rows:
            if not _is_chunk_sk(row["sk"]["S"]):
                logical += 1
            self._client.delete_item(TableName=table, Key={"pk": row["pk"], "sk": row["sk"]})
        return logical

    # ---- runs / queue ----

    @property
    def _runs_table(self) -> str:
        return f"{self.table_prefix}Runs"

    @property
    def _latest_table(self) -> str:
        return f"{self.table_prefix}Latest"

    def _run_record(self, run: RunManifest) -> dict[str, Any]:
        fields = run.model_dump(mode="json")
        record = self._marshal(fields)
        if run.status == RunStatus.QUEUED:
            record["claim_status"] = {"S": RunStatus.QUEUED.value}
            record["claim_order"] = {"S": claim_order(run.priority, run.enqueued_at, run.job_id)}
        if run.zid is not None:
            record["zid_key"] = {"S": str(run.zid)}
        if run.rid is not None:
            record["rid_key"] = {"S": str(run.rid)}
        return record

    def _record_to_run(self, raw_item: dict[str, Any]) -> RunManifest:
        fields = self._unmarshal(raw_item)
        for attr in _RUNS_INDEX_ATTRS:
            fields.pop(attr, None)
        return RunManifest(**fields)

    def _get_run_raw(self, job_id: str) -> Optional[dict[str, Any]]:
        response = self._client.get_item(
            TableName=self._runs_table, Key={"job_id": {"S": job_id}}, ConsistentRead=True
        )
        return response.get("Item")

    def _put_run_versioned(self, run: RunManifest, expected_version: int) -> bool:
        """Full-item replace conditional on the version we read; False on a
        lost race."""
        try:
            self._client.put_item(
                TableName=self._runs_table,
                Item=self._run_record(run),
                ConditionExpression="#version = :v",
                ExpressionAttributeNames={"#version": "version"},
                ExpressionAttributeValues={":v": {"N": str(expected_version)}},
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise

    def enqueue_run(self, run: RunManifest) -> None:
        validate_enqueueable(run)
        try:
            self._client.put_item(
                TableName=self._runs_table,
                Item=self._run_record(run),
                ConditionExpression="attribute_not_exists(job_id)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise AlreadyExists(f"run {run.job_id!r} already exists") from e
            raise

    def get_run(self, job_id: str) -> Optional[RunManifest]:
        raw_item = self._get_run_raw(job_id)
        return self._record_to_run(raw_item) if raw_item else None

    def claim_next_run(
        self, worker_id: str, lease_seconds: int, now: Optional[str] = None
    ) -> Optional[RunManifest]:
        now = validate_ts(now) if now is not None else now_ts()
        # Candidates come from the (eventually consistent) sparse GSI; the
        # claim itself is a conditional write on the base table, so staleness
        # only costs a wasted attempt, never a double claim.
        kwargs: dict[str, Any] = {
            "TableName": self._runs_table,
            "IndexName": "claim-index",
            "KeyConditionExpression": "claim_status = :queued",
            "ExpressionAttributeValues": {":queued": {"S": RunStatus.QUEUED.value}},
            "ScanIndexForward": True,
            "Limit": 10,
        }
        while True:
            page = self._client.query(**kwargs)
            for candidate in page.get("Items", []):
                job_id = candidate["job_id"]["S"]
                raw_item = self._get_run_raw(job_id)
                if raw_item is None or raw_item["status"]["S"] != RunStatus.QUEUED.value:
                    continue
                run = self._record_to_run(raw_item)
                claimed = run.model_copy(
                    update={
                        "status": RunStatus.RUNNING,
                        "worker_id": worker_id,
                        "started_at": now,
                        "lease_expires_at": ts_add_seconds(now, lease_seconds),
                        "version": run.version + 1,
                    }
                )
                if self._put_run_versioned(claimed, expected_version=run.version):
                    return claimed
            last = page.get("LastEvaluatedKey")
            if not last:
                return None
            kwargs["ExclusiveStartKey"] = last

    def extend_lease(
        self, job_id: str, worker_id: str, lease_seconds: int, now: Optional[str] = None
    ) -> bool:
        now = validate_ts(now) if now is not None else now_ts()
        for _ in range(_MUTATION_RETRIES):
            raw_item = self._get_run_raw(job_id)
            if raw_item is None:
                return False
            run = self._record_to_run(raw_item)
            if run.status != RunStatus.RUNNING or run.worker_id != worker_id:
                return False
            extended = run.model_copy(
                update={
                    "lease_expires_at": ts_add_seconds(now, lease_seconds),
                    "version": run.version + 1,
                }
            )
            if self._put_run_versioned(extended, expected_version=run.version):
                return True
        return False

    def _mutate_run(self, job_id: str, mutate) -> RunManifest:
        """Read-mutate-conditionally-write loop shared by status/field updates."""
        for _ in range(_MUTATION_RETRIES):
            raw_item = self._get_run_raw(job_id)
            if raw_item is None:
                raise NotFound(f"run {job_id!r} not found")
            run = self._record_to_run(raw_item)
            updated = mutate(run).model_copy(update={"version": run.version + 1})
            if self._put_run_versioned(updated, expected_version=run.version):
                return updated
        raise StorageError(f"run {job_id!r}: lost {_MUTATION_RETRIES} optimistic-lock races")

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
        try:
            response = self._client.update_item(
                TableName=self._runs_table,
                Key={"job_id": {"S": job_id}},
                UpdateExpression="SET log_seq = log_seq + :one, #version = #version + :one",
                ConditionExpression="attribute_exists(job_id)",
                ExpressionAttributeNames={"#version": "version"},
                ExpressionAttributeValues={":one": {"N": "1"}},
                ReturnValues="UPDATED_NEW",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise NotFound(f"run {job_id!r} not found") from e
            raise
        return int(response["Attributes"]["log_seq"]["N"])

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
            current = self.get_latest(scope)
            if current is not None:
                if current.job_id == job_id:
                    return AdvanceResult(advanced=False, pointer=current)
                if only_if_absent_or_imported and current.job_type != JobType.IMPORTED:
                    return AdvanceResult(advanced=False, pointer=current)
            pointer = LatestPointer(
                scope=scope,
                job_id=job_id,
                seq=(current.seq + 1 if current else 1),
                job_type=job_type,
                updated_at=now,
            )
            item = self._marshal(pointer.model_dump(mode="json"))
            try:
                if current is None:
                    self._client.put_item(
                        TableName=self._latest_table,
                        Item=item,
                        ConditionExpression="attribute_not_exists(#scope)",
                        ExpressionAttributeNames={"#scope": "scope"},
                    )
                else:
                    self._client.put_item(
                        TableName=self._latest_table,
                        Item=item,
                        ConditionExpression="#seq = :old",
                        ExpressionAttributeNames={"#seq": "seq"},
                        ExpressionAttributeValues={":old": {"N": str(current.seq)}},
                    )
                return AdvanceResult(advanced=True, pointer=pointer)
            except ClientError as e:
                if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                    continue  # concurrent advance — re-read and re-decide
                raise
        raise StorageError(f"latest {scope!r}: lost {_MUTATION_RETRIES} optimistic-lock races")

    def get_latest(self, scope: str) -> Optional[LatestPointer]:
        response = self._client.get_item(
            TableName=self._latest_table, Key={"scope": {"S": scope}}, ConsistentRead=True
        )
        raw_item = response.get("Item")
        if raw_item is None:
            return None
        return LatestPointer(**self._unmarshal(raw_item))

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
        if zid is not None:
            index, attr, value = "zid-index", "zid_key", str(zid)
        else:
            index, attr, value = "rid-index", "rid_key", str(rid)
        rows = self._query_all(
            TableName=self._runs_table,
            IndexName=index,
            KeyConditionExpression=f"{attr} = :key",
            ExpressionAttributeValues={":key": {"S": value}},
            ScanIndexForward=False,
        )
        runs = [self._record_to_run(row) for row in rows]
        if status is not None:
            runs = [r for r in runs if r.status == status]
        runs.sort(key=lambda r: (r.enqueued_at, r.job_id), reverse=True)
        return runs[:limit]
