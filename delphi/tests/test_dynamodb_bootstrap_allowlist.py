"""`create_dynamodb_tables.py` must never recreate a retired table.

The script runs inside the delphi container CMD, in every environment, and
creates any table that is missing. So a table listed there is a table that
comes back the next time delphi starts -- empty, and with a different shape
than the original, which looks like a successful rollback and is not. This is
why the nine retired tables had to leave the bootstrap before they could be
deleted in AWS, and this test is what keeps them out.

Deterministic and offline: it drives the real constructor functions against a
recording fake, so no DynamoDB, no credentials and no network are involved.
"""

import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import create_dynamodb_tables  # noqa: E402

from tests.retired_tables import (  # noqa: E402
    EXPECTED_BOOTSTRAP_TABLES,
    ON_DEMAND_REQUIRED_TABLES,
    RETIRED_TABLES,
)


@pytest.fixture
def created_tables():
    """Run every real bootstrap constructor and record what it would create."""
    dynamodb = mock.MagicMock()
    dynamodb.tables.all.return_value = []  # nothing exists yet

    create_dynamodb_tables.create_job_queue_table(dynamodb)
    create_dynamodb_tables.create_evoc_tables(dynamodb)

    return {
        call.kwargs["TableName"]: call.kwargs
        for call in dynamodb.create_table.call_args_list
    }


def test_bootstrap_creates_exactly_the_allowlist(created_tables):
    assert set(created_tables) == set(EXPECTED_BOOTSTRAP_TABLES)


def test_bootstrap_creates_no_retired_table(created_tables):
    resurrected = sorted(set(created_tables).intersection(RETIRED_TABLES))
    assert not resurrected, (
        f"the bootstrap would recreate retired tables: {resurrected}. "
        "Deleting them in AWS will not stick while this script creates them; "
        "see delphi/docs/RETIRED_DYNAMODB_TABLES.md."
    )


def test_no_constructor_function_survives_for_the_pca_tables():
    """The whole six-table PCA constructor was removed, not just its entries."""
    assert not hasattr(create_dynamodb_tables, "create_polis_math_tables")


@pytest.mark.parametrize("table_name", ON_DEMAND_REQUIRED_TABLES)
def test_throttled_tables_stay_on_demand(created_tables, table_name):
    """These two throttled badly at provisioned 5/5; they must not drift back."""
    schema = created_tables[table_name]
    assert schema.get("BillingMode") == "PAY_PER_REQUEST"
    assert "ProvisionedThroughput" not in schema
