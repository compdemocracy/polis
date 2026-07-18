"""
Pytest configuration and fixtures for delphi tests.

This module provides:
- Command line options --include-local and --datasets for dataset selection
- Fixtures for accessing dataset information
- @pytest.mark.use_discovered_datasets for dynamic dataset parametrization
- require_dynamodb() and require_s3() helpers for failing fast when services are unavailable
- Session-scoped conversation cache for efficient test execution
"""

import contextlib
import os
from copy import deepcopy

import pytest

from polismath.conversation.conversation import Conversation
from polismath.regression import get_dataset_files
from polismath.regression.datasets import (
    discover_datasets,
    list_regression_datasets,
    get_blob_variants,
)
from tests.common_utils import load_votes, load_comments


@pytest.fixture(autouse=True)
def _guard_engine_mode_env():
    """Restore POLISMATH_ENGINE_MODE around every test.

    Production code (e.g. MathPollerService.apply_engine_mode) writes this var
    straight into os.environ; without this guard a single test exercising that
    path leaks clojure-legacy mode into every later test in the same worker,
    flipping in-conv/warm-start semantics suite-wide (bit us in CI on #2637).
    """
    prev = os.environ.get("POLISMATH_ENGINE_MODE")
    yield
    if prev is None:
        os.environ.pop("POLISMATH_ENGINE_MODE", None)
    else:
        os.environ["POLISMATH_ENGINE_MODE"] = prev


def require_dynamodb(
    endpoint: str | None = None,
    timeout: float = 3.0,
) -> None:
    """Fail the test immediately if DynamoDB is not responding.

    Performs a ``list_tables`` call with short timeouts and zero retries
    so the test fails in seconds rather than hanging indefinitely.
    """
    import os

    import boto3
    from botocore.config import Config

    endpoint = endpoint or os.environ.get(
        "DYNAMODB_ENDPOINT", "http://localhost:8000"
    )
    cfg = Config(
        connect_timeout=timeout,
        read_timeout=timeout,
        retries={"max_attempts": 0},
    )
    client = boto3.client(
        "dynamodb",
        endpoint_url=endpoint,
        region_name="us-east-1",
        aws_access_key_id="dummy",
        aws_secret_access_key="dummy",
        config=cfg,
    )
    try:
        client.list_tables(Limit=1)
    except Exception as exc:
        # In CI, DynamoDB is a provisioned service — its absence is an
        # infrastructure failure that must fail LOUDLY (a silent skip would
        # disable the only end-to-end gate; the 2026-07-05 consensus-float
        # crash was caught precisely because CI runs this).
        # Locally, DynamoDB is opt-in (e.g.
        # `docker run --rm -d -p 8002:8000 amazon/dynamodb-local` +
        # `DYNAMODB_ENDPOINT=http://localhost:8002`) — skip gracefully so
        # the e2e test no longer needs a blanket --ignore in local runs.
        # GITHUB_ACTIONS, not CI: local supply-chain wrappers (pmg) inject
        # CI=true into wrapped package-manager runs, which would force the
        # loud-fail path on developer machines (observed 2026-07-05).
        msg = f"DynamoDB is not available at {endpoint}: {exc}"
        if os.environ.get("GITHUB_ACTIONS"):
            pytest.fail(msg)
        pytest.skip(
            f"{msg} — to run this test locally, start DynamoDB and point the "
            "test at it:\n"
            "  docker run --rm -d --name delphi-test-dynamo -p 8002:8000 "
            "amazon/dynamodb-local\n"
            "  DYNAMODB_ENDPOINT=http://localhost:8002 uv run pytest <this test>"
        )


def require_s3(
    endpoint: str | None = None,
    timeout: float = 3.0,
) -> None:
    """Skip the test if S3/MinIO is not responding.

    Uses pytest.skip (not fail) because MinIO is a dev/CI dependency
    started via docker-compose; in environments where it isn't running
    (some local runs, or CI jobs that don't bring up the MinIO service),
    we skip rather than fail the test outright.
    """
    import os

    import boto3
    from botocore.config import Config

    endpoint = endpoint or os.environ.get(
        "AWS_S3_ENDPOINT", "http://host.docker.internal:9000"
    )
    cfg = Config(
        connect_timeout=timeout,
        read_timeout=timeout,
        retries={"max_attempts": 0},
        signature_version="s3v4",
    )
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="us-east-1",
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "minioadmin"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "minioadmin"),
        config=cfg,
        verify=False,
    )
    try:
        client.list_buckets()
    except Exception as exc:
        pytest.skip(f"S3/MinIO is not available at {endpoint}: {exc}")


_POLIS_PG_MIGRATIONS_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "server", "postgres", "migrations",
)
# Migrations that establish the votes + votes_latest_unique schema and the
# on_vote_insert_update_unique_table RULE. 000006 holds the LIVE rule
# redefinition (idempotent DROP/CREATE) — apply both, in order.
_POLIS_PG_MIGRATIONS = ("000000_initial.sql", "000006_update_votes_rule.sql")


def _free_tcp_port() -> int:
    """Grab an ephemeral free TCP port (avoids clashing on a fixed port under
    xdist / when several integration modules run concurrently)."""
    import socket

    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def require_polis_postgres():
    """Yield a Postgres URL with the polis votes schema applied — for opt-in
    integration tests — or ``pytest.skip()`` if no Postgres is reachable.

    Resolution order:

      1. **CI service** — if ``POLIS_TEST_POSTGRES_URL`` is set (a reachable
         Postgres whose image already bakes the polis migrations, e.g. the
         ``postgres`` service in ``docker-compose.test.yml`` which loads
         ``server/postgres/migrations/*.sql`` via docker-entrypoint-initdb.d),
         use it. The schema is verified; the caller skips loudly if it is
         missing (a provisioned CI service is expected to have it).
      2. **Local throwaway docker** — a fresh ``postgres:17`` on an EPHEMERAL
         port (NEVER the host's live 5432), with 000000 + 000006 applied via
         ``psql``.
      3. Otherwise skip with a clear reason.

    Migrations applied: ``000000_initial.sql`` (votes + votes_latest_unique +
    the ``on_vote_insert_update_unique_table`` rule) and
    ``000006_update_votes_rule.sql`` (the LIVE rule redefinition).

    Shared by ``tests/poller/test_integration_postgres.py`` and
    ``tests/test_generator_vote_copy.py``.
    """
    import shutil
    import subprocess
    import time
    import uuid

    import psycopg2

    ci_url = os.environ.get("POLIS_TEST_POSTGRES_URL")
    if ci_url:
        try:
            conn = psycopg2.connect(ci_url)
        except Exception as exc:  # pragma: no cover - infra guard
            pytest.skip(f"POLIS_TEST_POSTGRES_URL set but unreachable: {exc}")
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.votes_latest_unique')")
                present = cur.fetchone()[0] is not None
        finally:
            conn.close()
        if not present:
            pytest.skip(
                "POLIS_TEST_POSTGRES_URL points at a Postgres without the polis "
                "votes schema (expected the migrations baked into the service image)"
            )
        yield ci_url
        return

    docker = shutil.which("docker")
    if not docker:
        pytest.skip("no POLIS_TEST_POSTGRES_URL and docker not available")

    migrations = [
        os.path.abspath(os.path.join(_POLIS_PG_MIGRATIONS_DIR, m))
        for m in _POLIS_PG_MIGRATIONS
    ]
    for path in migrations:
        if not os.path.exists(path):
            pytest.skip(f"polis migration not found: {path}")

    port = _free_tcp_port()
    name = f"delphi-polis-pg-it-{uuid.uuid4().hex[:8]}"
    started = subprocess.run(
        [docker, "run", "--rm", "-d", "--name", name,
         "-p", f"{port}:5432", "-e", "POSTGRES_PASSWORD=test", "postgres:17"],
        capture_output=True, text=True,
    )
    if started.returncode != 0:
        pytest.skip(f"could not start postgres container: {started.stderr.strip()}")
    cid = started.stdout.strip()
    try:
        deadline = time.time() + 40
        ready = False
        while time.time() < deadline:
            if subprocess.run(
                [docker, "exec", cid, "pg_isready", "-U", "postgres"],
                capture_output=True, text=True,
            ).returncode == 0:
                ready = True
                break
            time.sleep(1)
        if not ready:
            pytest.skip("postgres container did not become ready in time")

        for path in migrations:
            with open(path, "rb") as fh:
                applied = subprocess.run(
                    [docker, "exec", "-i", cid, "psql", "-v", "ON_ERROR_STOP=1",
                     "-U", "postgres", "-d", "postgres"],
                    stdin=fh, capture_output=True, text=True,
                )
            if applied.returncode != 0:
                pytest.skip(
                    f"migration {os.path.basename(path)} failed to apply: "
                    f"{applied.stderr[-500:]}"
                )

        yield f"postgresql://postgres:test@localhost:{port}/postgres"
    finally:
        subprocess.run([docker, "stop", cid], capture_output=True, text=True)


# =============================================================================
# Session-scoped Conversation Cache
# =============================================================================

_SESSION_CONV_CACHE: dict = {}


@pytest.fixture(scope="session")
def get_or_compute_conversation():
    """Session-wide conversation cache shared across all test files.

    Returns a function that computes a Conversation once per dataset and
    returns a deepcopy each time to preserve test isolation.

    Only ONE dataset is kept in memory at a time. When a different dataset
    is requested, the previous one is evicted. This works because tests are
    reordered by pytest_collection_modifyitems to group all tests for a
    dataset together (across all test files).
    """
    import gc

    def _get(dataset_name: str) -> dict:
        if dataset_name not in _SESSION_CONV_CACHE:
            # Evict previous dataset (we only keep one at a time)
            for ds in list(_SESSION_CONV_CACHE.keys()):
                _SESSION_CONV_CACHE.pop(ds, None)
            Conversation._reset_conversion_cache()
            gc.collect()

            files = get_dataset_files(dataset_name, blob_type='incremental')
            votes = load_votes(files['votes'])
            comments = load_comments(files['comments'])

            conv = Conversation(dataset_name)
            conv = conv.update_votes(votes)
            conv = conv.recompute()

            _SESSION_CONV_CACHE[dataset_name] = {
                'conv': conv,
                'dataset_name': dataset_name,
                'files': files,
                'comments': comments,
            }

        return deepcopy(_SESSION_CONV_CACHE[dataset_name])

    return _get


# =============================================================================
# Dataset Parametrization Helpers
# =============================================================================

def make_dataset_params(datasets: list[str]) -> list:
    """
    Create pytest.param objects for dataset parametrization.

    Args:
        datasets: List of dataset names (or "dataset-blob_type" composite IDs)

    Returns:
        List of pytest.param objects

    Example:
        @pytest.mark.parametrize("dataset_name", make_dataset_params(["biodiversity", "vw"]))
        def test_something(dataset_name):
            ...
    """
    return [pytest.param(ds) for ds in datasets]


def parse_dataset_blob_id(composite_id: str) -> tuple[str, str]:
    """Parse a 'dataset-blob_type' composite ID into (dataset_name, blob_type).

    Examples:
        'biodiversity-incremental' -> ('biodiversity', 'incremental')
        'bg2050-cold_start' -> ('bg2050', 'cold_start')
    """
    if composite_id.endswith('-cold_start'):
        return composite_id[:-len('-cold_start')], 'cold_start'
    elif composite_id.endswith('-incremental'):
        return composite_id[:-len('-incremental')], 'incremental'
    else:
        raise ValueError(
            f"Invalid composite dataset ID: {composite_id}. "
            f"Expected format: 'dataset-incremental' or 'dataset-cold_start'"
        )


def pytest_addoption(parser):
    """Add custom command line options to pytest."""
    parser.addoption(
        "--include-local",
        action="store_true",
        default=False,
        help="Include datasets from real_data/.local/ in tests"
    )
    parser.addoption(
        "--datasets",
        action="store",
        default=None,
        help="Comma-separated list of datasets to run (e.g., --datasets=biodiversity,vw)"
    )


def _get_requested_datasets(config) -> set[str] | None:
    """Get the set of datasets requested via --datasets, or None for all."""
    datasets_opt = config.getoption("--datasets")
    if not datasets_opt:
        return None

    # Split on commas, strip whitespace, and drop empty entries to avoid
    # treating trailing/repeated commas as empty dataset names.
    requested = {d.strip() for d in datasets_opt.split(",") if d.strip()}

    if not requested:
        raise pytest.UsageError(
            "No valid dataset names specified in --datasets option. "
            "Provide a comma-separated list, e.g. --datasets=biodiversity,vw."
        )

    return requested


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers",
        "use_discovered_datasets(use_blobs=False): dynamically parametrize with discovered "
        "datasets, respecting --include-local and --datasets CLI options. "
        "With use_blobs=True, parametrize with 'dataset-blob_type' composite IDs "
        "(e.g., 'biodiversity-incremental', 'engage-cold_start') for each filled blob variant."
    )


@pytest.fixture(scope="session")
def include_local(request):
    """Fixture that returns True if --include-local flag was passed."""
    return request.config.getoption("--include-local")


@pytest.fixture(scope="session")
def all_datasets(include_local):
    """Fixture that returns all discovered datasets based on --include-local flag."""
    return discover_datasets(include_local=include_local)


@pytest.fixture(scope="session")
def regression_datasets(include_local):
    """Fixture that returns datasets valid for regression testing."""
    return list_regression_datasets(include_local=include_local)


def pytest_generate_tests(metafunc):
    """
    Dynamically parametrize tests marked with @pytest.mark.use_discovered_datasets.

    These tests must declare a 'dataset_name' parameter. They will be parametrized
    with all regression datasets, filtered by --include-local and --datasets.

    With use_blobs=True, parametrize with 'dataset-blob_type' composite IDs
    (e.g., 'biodiversity-incremental', 'engage-cold_start') for each filled blob variant.

    Uses the session-scoped conversation cache for efficient test execution.
    """
    markers = list(metafunc.definition.iter_markers("use_discovered_datasets"))
    if not markers:
        return

    include_local = metafunc.config.getoption("--include-local")
    requested = _get_requested_datasets(metafunc.config)

    # Check if use_blobs=True was passed to the marker
    use_blobs = any(m.kwargs.get('use_blobs', False) for m in markers)

    if use_blobs:
        # Parametrize with composite 'dataset-blob_type' IDs
        datasets = discover_datasets(include_local=include_local)
        blob_ids = []
        for name, info in datasets.items():
            if not (info.has_votes and info.has_comments and info.has_clojure_reference):
                continue
            if requested and name not in requested:
                continue
            for blob_type in get_blob_variants(name):
                blob_ids.append(f"{name}-{blob_type}")
        metafunc.parametrize("dataset_name", make_dataset_params(blob_ids))
    else:
        # Parametrize with plain dataset names
        datasets = list_regression_datasets(include_local=include_local)
        if requested:
            datasets = [d for d in datasets if d in requested]
        metafunc.parametrize("dataset_name", make_dataset_params(datasets))


# =============================================================================
# Test Reordering for Cache Efficiency
# =============================================================================

def _extract_dataset_from_test(item) -> str:
    """Extract the dataset name from a test item's parameters.

    Handles both plain dataset names ('biodiversity') and composite IDs
    ('biodiversity-incremental'). Returns empty string if no dataset parameter.
    """
    # Check callspec for parametrized values
    if hasattr(item, 'callspec') and item.callspec.params:
        for param_name in ('dataset_name', 'dataset_blob_id'):
            if param_name in item.callspec.params:
                value = item.callspec.params[param_name]
                # Extract base dataset name from composite IDs
                if value.endswith('-incremental'):
                    return value[:-len('-incremental')]
                elif value.endswith('-cold_start'):
                    return value[:-len('-cold_start')]
                return value
    return ''


def pytest_collection_modifyitems(session, config, items):
    """Reorder tests to group by dataset for cache efficiency.

    Groups all tests for a dataset together (across all test files) so that
    the session-scoped conversation cache only needs to hold ONE dataset at
    a time. This reduces peak memory from O(N datasets) to O(1 dataset).

    Order: dataset1[file1, file2, ...], dataset2[file1, file2, ...], ...
    Within each dataset, original test order is preserved.
    """
    # Separate tests into dataset-parametrized and non-parametrized
    dataset_tests = []
    other_tests = []

    for item in items:
        ds = _extract_dataset_from_test(item)
        if ds:
            dataset_tests.append((ds, item))
        else:
            other_tests.append(item)

    # Sort dataset tests by dataset name (stable sort preserves order within dataset)
    dataset_tests.sort(key=lambda x: x[0])

    # Rebuild items list: non-parametrized first, then dataset tests grouped
    items[:] = other_tests + [item for _, item in dataset_tests]


# Provide summary of discovered datasets at start of test run
def pytest_report_header(config):
    """Add dataset discovery info to pytest header."""
    include_local = config.getoption("--include-local")
    requested = _get_requested_datasets(config)
    datasets = discover_datasets(include_local=include_local)
    regression_valid = [
        name for name, info in datasets.items()
        if info.is_valid
    ]

    local_count = sum(1 for info in datasets.values() if info.is_local)
    committed_count = len(datasets) - local_count

    lines = [
        f"Datasets discovered: {len(datasets)} total ({committed_count} committed, {local_count} local)",
        f"Valid for regression: {len(regression_valid)} ({', '.join(sorted(regression_valid)) or 'none'})",
    ]

    if requested:
        lines.append(f"Filtered to: {', '.join(sorted(requested))}")

    if not include_local:
        lines.append("Use --include-local to include datasets from real_data/.local/")

    return lines
