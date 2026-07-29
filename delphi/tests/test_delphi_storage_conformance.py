"""Conformance suite for Delphi Storage V2 backends.

Executes the shared JSON operation-scripts in delphi_storage/conformance/cases/
against every backend. The same case files are executed by jest against the
TypeScript implementations (server/src/storage/delphi/) — see
delphi_storage/conformance/README.md for the normative spec.

Backends:
- memory          — always runs (pure in-process reference implementation)
- moto            — always runs (DynamoDB backend against moto's mock)
- dynamodb        — real DynamoDB endpoint (DYNAMODB_ENDPOINT, default
                    http://localhost:8000); skipped locally when unreachable,
                    fails loudly in GitHub Actions where the service is up
- postgres        — real PostgreSQL (DELPHI_STORAGE_PG_URL or DATABASE_URL);
                    same skip/fail convention; isolated per-test schema
"""

import os
import threading
import uuid

import pytest

from delphi_storage.conformance.runner import (
    load_cases,
    load_codec_cases,
    run_case,
    run_codec_case,
)
from delphi_storage.models import JobType, RunManifest

CASES = load_cases()
CODEC_CASES = load_codec_cases()

STORE_BACKENDS = ["memory", "moto", "dynamodb", "postgres"]
# moto's in-process mock is not safe under concurrent conditional writes, and
# the race test is about real atomicity anyway.
RACE_BACKENDS = ["memory", "dynamodb", "postgres"]

_IN_GHA = os.environ.get("GITHUB_ACTIONS") == "true"


def _unavailable(what: str, detail: str):
    """Skip locally; fail loudly in CI where the service is guaranteed up."""
    if _IN_GHA:
        pytest.fail(f"{what} must be available in GitHub Actions: {detail}")
    pytest.skip(f"{what} unavailable: {detail}")


def _dynamo_endpoint() -> str:
    return os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000")


def _check_dynamo(endpoint: str):
    import boto3
    from botocore.config import Config as BotoConfig

    try:
        client = boto3.client(
            "dynamodb",
            endpoint_url=endpoint,
            region_name="us-east-1",
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "dummy"),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "dummy"),
            config=BotoConfig(
                connect_timeout=3, read_timeout=3, retries={"max_attempts": 0}
            ),
        )
        client.list_tables(Limit=1)
    except Exception as e:  # noqa: BLE001 - any failure means "not reachable"
        _unavailable("DynamoDB", f"{endpoint}: {e}")


def _pg_url() -> str | None:
    return os.environ.get("DELPHI_STORAGE_PG_URL") or os.environ.get("DATABASE_URL")


def _check_postgres(url: str | None):
    if not url:
        _unavailable("PostgreSQL", "neither DELPHI_STORAGE_PG_URL nor DATABASE_URL is set")
    import sqlalchemy

    try:
        engine = sqlalchemy.create_engine(
            url, connect_args={"connect_timeout": 3}, pool_pre_ping=True
        )
        with engine.connect():
            pass
        engine.dispose()
    except Exception as e:  # noqa: BLE001
        _unavailable("PostgreSQL", f"{url}: {e}")


def _make_store(kind: str):
    """Yield a fresh, empty store of the requested kind, tearing it down after."""
    if kind == "memory":
        from delphi_storage.backends.memory import MemoryDelphiStore

        yield MemoryDelphiStore()
        return

    if kind == "moto":
        moto = pytest.importorskip("moto")
        from delphi_storage.backends.dynamodb import DynamoDelphiStore

        with moto.mock_aws():
            os.environ.setdefault("AWS_ACCESS_KEY_ID", "dummy")
            os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "dummy")
            store = DynamoDelphiStore(
                table_prefix=f"ConfM{uuid.uuid4().hex[:8]}_",
                region="us-east-1",
                ensure_tables=True,
            )
            yield store
        return

    if kind == "dynamodb":
        endpoint = _dynamo_endpoint()
        _check_dynamo(endpoint)
        from delphi_storage.backends.dynamodb import DynamoDelphiStore

        store = DynamoDelphiStore(
            table_prefix=f"ConfT{uuid.uuid4().hex[:8]}_",
            endpoint_url=endpoint,
            region="us-east-1",
            ensure_tables=True,
        )
        try:
            yield store
        finally:
            store.drop_tables()
        return

    if kind == "postgres":
        url = _pg_url()
        _check_postgres(url)
        from delphi_storage.backends.postgres import PostgresDelphiStore

        store = PostgresDelphiStore(
            url=url,
            schema=f"conf_{uuid.uuid4().hex[:10]}",
            ensure_schema=True,
        )
        try:
            yield store
        finally:
            store.drop_schema()
        return

    raise ValueError(f"unknown backend kind {kind!r}")


@pytest.fixture(params=STORE_BACKENDS)
def store(request):
    yield from _make_store(request.param)


@pytest.fixture(params=RACE_BACKENDS)
def race_store(request):
    yield from _make_store(request.param)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_conformance_case(store, case):
    run_case(store, case)


@pytest.mark.parametrize("case", CODEC_CASES, ids=lambda c: c.name)
def test_codec_case(case):
    run_codec_case(case)


def test_cases_present():
    """The shared contract must not silently shrink."""
    names = {c.name for c in CASES}
    assert {
        "roundtrip_basic",
        "query_ordering",
        "blob_chunking",
        "queue_claim",
        "latest_pointer",
        "run_manifest_fields",
        "validation",
    } <= names
    assert CODEC_CASES, "codec fixture cases missing"


def test_two_claimants_one_wins(race_store):
    """Design §4.3: queue claim race — concurrent claimants never share a run."""
    store = race_store
    n_jobs, n_workers = 4, 10
    for i in range(n_jobs):
        store.enqueue_run(
            RunManifest(
                job_id=f"race-{i}",
                job_type=JobType.FULL_PIPELINE,
                zid=1,
                enqueued_at=f"2026-07-06T10:00:0{i}.000Z",
            )
        )

    results: list[str | None] = [None] * n_workers
    barrier = threading.Barrier(n_workers)

    def worker(idx: int):
        barrier.wait()
        run = store.claim_next_run(worker_id=f"w{idx}", lease_seconds=300)
        results[idx] = run.job_id if run else None

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    claimed = [r for r in results if r is not None]
    assert len(claimed) == n_jobs, f"expected all {n_jobs} runs claimed, got {claimed}"
    assert len(set(claimed)) == n_jobs, f"a run was claimed twice: {claimed}"
    # queue is drained
    assert store.claim_next_run(worker_id="late", lease_seconds=300) is None
