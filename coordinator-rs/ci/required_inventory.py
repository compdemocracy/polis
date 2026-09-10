"""Fail collection before a selected subset can masquerade as the campaign."""
import json
from pathlib import Path

import pytest

from verify import exact


def pytest_collection_finish(session):
    inventory = json.loads((Path(__file__).with_name("inventory-v1.json")).read_text())
    try:
        exact([item.nodeid for item in session.items], inventory["python_nodeids"], "collection")
    except ValueError as error:
        raise pytest.UsageError(str(error)) from error
