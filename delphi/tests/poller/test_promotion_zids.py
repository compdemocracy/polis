"""Conversation ids in test_promotion_postgres.py, one pytest-xdist worker against another.

Each worker imports that module on its own. Seeding a conversation there first
deletes whatever already has its id, and every test's cleanup deletes its
conversations' rows in every table, so two workers handed one id delete each
other's fixtures mid-test. Here the module is loaded twice, as two workers whose
random draws agree, and each asks for more ids than the whole file uses on one
worker. No database is needed: the ids a module hands out are the ids its
cleanup deletes.
"""

import importlib.util
import uuid
from pathlib import Path

import pytest

MODULE = Path(__file__).with_name("test_promotion_postgres.py")
ALLOCATIONS = 40  # more than every test in the file asks for, json and jsonb, on one worker


def as_worker(monkeypatch, worker):
    with monkeypatch.context() as m:
        m.setenv("PYTEST_XDIST_WORKER", worker)
        m.setattr(uuid, "uuid4", lambda: uuid.UUID(int=7))  # the same draw for every worker
        spec = importlib.util.spec_from_file_location(f"promotion_as_{worker}", MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


def test_two_workers_never_delete_each_others_conversations(monkeypatch):
    first, second = as_worker(monkeypatch, "gw0"), as_worker(monkeypatch, "gw1")
    for _ in range(ALLOCATIONS):
        first.fresh_zids(2)
        second.fresh_zids(2)
    shared = sorted(set(first._used) & set(second._used))
    assert not shared, f"gw1's cleanup deletes gw0's conversations {shared[:4]} ({len(shared)})"


def test_a_worker_stops_at_the_end_of_its_ids(monkeypatch):
    """A worker that runs out refuses the test rather than take the next worker's ids."""
    first, second = as_worker(monkeypatch, "gw0"), as_worker(monkeypatch, "gw1")
    (theirs,) = second.fresh_zids(1)
    with pytest.raises(RuntimeError, match="gw0"):
        while True:
            (mine,) = first.fresh_zids(1)
            assert mine < theirs
