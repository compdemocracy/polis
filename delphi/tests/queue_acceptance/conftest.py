"""Fail-closed dedicated local queue campaign; never auto-select a shared DB."""
import os
import uuid
from pathlib import Path

import psycopg2
import pytest
from .support import Driver, ROOT

# Normal Delphi CI does not carry the standalone Rust adapter or the dedicated
# cluster. Opt-in is explicit; its absence never becomes a campaign PASS.
if not os.environ.get("QUEUE_ACCEPTANCE_URL"):
    collect_ignore_glob = ["test*.py"]

    def pytest_report_collectionfinish(config):
        return "queue acceptance not collected: run queue-rs/run-acceptance.sh with its dedicated local cluster"


def connect(url):
    conn = psycopg2.connect(url)
    conn.autocommit = True
    return conn


@pytest.fixture(scope="session")
def template():
    url = os.environ["QUEUE_ACCEPTANCE_URL"]
    assert os.environ["COMPOSE_PROJECT_NAME"].startswith("p027-")
    name = "queue_template_" + uuid.uuid4().hex[:10]
    admin = connect(url)
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    admin.close()
    template_url = url.rsplit("/", 1)[0] + "/" + name
    conn = connect(template_url)
    try:
        with conn.cursor() as cur:
            for path in sorted((ROOT / "server/postgres/migrations").glob("*.sql")):
                if path.name[:6] <= "000019":
                    cur.execute(path.read_text())
            cur.execute("CREATE ROLE queue_acceptance LOGIN IN ROLE polis_queue_executor")
            cur.execute("INSERT INTO conversations(zid,topic) VALUES(1,'public queue fixture'),(2,'unreferenced')")
        conn.close()
        yield url, name
    finally:
        conn.close()
        admin = connect(url)
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
            cur.execute("DROP ROLE queue_acceptance")
        admin.close()


@pytest.fixture(params=["psycopg", "rust"])
def language(request):
    return request.param


@pytest.fixture
def db(template, monkeypatch):
    url, source = template
    name = "queue_case_" + uuid.uuid4().hex[:10]
    admin = connect(url)
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}" TEMPLATE "{source}"')
    url = url.rsplit("/", 1)[0] + "/" + name
    monkeypatch.setenv("POLIS_QUEUE_SUBSTRATE_ENABLED", "true")
    monkeypatch.setenv("NODE_ENV", "test")
    state = {"url": url, "dsn": url.replace("postgres@", "queue_acceptance@"), "env": "test-acceptance"}
    yield state
    with admin.cursor() as cur:
        cur.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    admin.close()


@pytest.fixture
def driver(db, language):
    client = Driver(language, db["dsn"], db["env"])
    yield client
    client.close()
