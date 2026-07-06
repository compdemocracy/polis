"""DynamoDB-backend-specific tests: crash-safety of chunked blob writes.

The chunking protocol (generation-tagged chunk rows, main item as commit
point) is a Dynamo-only concern hidden behind the interface, so these run on
moto rather than through the shared conformance cases.
"""

import uuid

import pytest

moto = pytest.importorskip("moto")

from delphi_storage.backends.dynamodb import (  # noqa: E402 - after importorskip
    CHUNK_SIZE,
    DynamoDelphiStore,
    _chunk_prefix,
    _chunk_sk,
)
from delphi_storage.models import StoreItem  # noqa: E402


@pytest.fixture()
def store():
    with moto.mock_aws():
        yield DynamoDelphiStore(
            table_prefix=f"ChunkT{uuid.uuid4().hex[:8]}_",
            region="us-east-1",
            ensure_tables=True,
        )


def _big_blob(seed: int, n_chunks: int = 2) -> bytes:
    unit = bytes([seed % 256]) * 1000
    return unit * ((CHUNK_SIZE * n_chunks) // 1000 + 1)


def _chunk_row_sks(store: DynamoDelphiStore, pk: str, sk: str) -> list[str]:
    rows = store._query_all(
        TableName=f"{store.table_prefix}RunInputs",
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={":pk": {"S": pk}, ":prefix": {"S": _chunk_prefix(sk)}},
        ProjectionExpression="pk, sk",
        ConsistentRead=True,
    )
    return [row["sk"]["S"] for row in rows]


class TestChunkGenerations:
    def test_stale_generation_rows_are_ignored_on_read(self, store):
        blob = _big_blob(1)
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=blob))
        # Inject a bogus chunk row from a phantom generation.
        store._client.put_item(
            TableName=f"{store.table_prefix}RunInputs",
            Item={
                "pk": {"S": "j1"},
                "sk": {"S": _chunk_sk("votes#0", "deadbeef0000", 0)},
                "part": {"B": b"garbage"},
            },
        )
        item = store.get("run_inputs", "j1", "votes#0")
        assert item is not None and item.blob == blob

    def test_crashed_write_leaves_previous_value_readable(self, store):
        old = _big_blob(1)
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=old))
        # Simulate a writer that crashed after writing its new-generation
        # chunk rows but BEFORE the main-item commit point.
        new = _big_blob(2)
        crashed_gen = uuid.uuid4().hex[:12]
        for i in range(0, len(new), CHUNK_SIZE):
            store._client.put_item(
                TableName=f"{store.table_prefix}RunInputs",
                Item={
                    "pk": {"S": "j1"},
                    "sk": {"S": _chunk_sk("votes#0", crashed_gen, i // CHUNK_SIZE)},
                    "part": {"B": new[i : i + CHUNK_SIZE]},
                },
            )
        item = store.get("run_inputs", "j1", "votes#0")
        assert item is not None and item.blob == old, "old value must survive a crashed write"
        # The next successful put sweeps the orphaned generation.
        final = _big_blob(3)
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=final))
        item = store.get("run_inputs", "j1", "votes#0")
        assert item is not None and item.blob == final
        remaining = _chunk_row_sks(store, "j1", "votes#0")
        gens = {sk.split("\x7f")[2] for sk in remaining}
        assert len(gens) == 1 and crashed_gen not in gens

    def test_shrinking_overwrite_removes_all_chunk_rows(self, store):
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=_big_blob(1)))
        assert len(_chunk_row_sks(store, "j1", "votes#0")) >= 2
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=b"tiny"))
        assert _chunk_row_sks(store, "j1", "votes#0") == []
        item = store.get("run_inputs", "j1", "votes#0")
        assert item is not None and item.blob == b"tiny"

    def test_same_size_overwrite_reads_consistently(self, store):
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=_big_blob(1)))
        replacement = _big_blob(2)
        store.put("run_inputs", StoreItem(pk="j1", sk="votes#0", blob=replacement))
        item = store.get("run_inputs", "j1", "votes#0")
        assert item is not None and item.blob == replacement
