"""The certification reader holds ONE repeatable-read, read-only snapshot.

Regression for the probe reader that switched its connection to autocommit
before the extractor opened its transaction. In autocommit, ``SET TRANSACTION``
runs outside a transaction block: PostgreSQL warns, ignores it, and every later
statement takes a fresh snapshot, so a concurrent writer's row became visible
between two reads of one capture while the manifest still claimed a single
repeatable-read transaction.

The real-Postgres cases enter through ``probe.capture`` (the box entrypoint's
connection setup: read-only guard, autocommit off, extractor) with only the
``service='probe'`` socket redirected to a throwaway database, and the real
``fixture_survey.open_readonly_repeatable_read`` opening the transaction. A
second connection commits an insert between two reads; the reader must not see
it. They self-skip without Postgres (see ``require_polis_postgres``). Every row
here is invented for this file.
"""
from __future__ import annotations

import datetime
import os
from pathlib import Path
import sys
import uuid

import pytest

from polismath.replay import fixture_extract as fx
from polismath.replay import fixture_survey as fs
from tests.conftest import require_polis_postgres

ROOT = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT / 'ci/private_cert/images'))
import probe  # noqa: E402

READ_ONLY_LOGIN = '-c default_transaction_read_only=on'


@pytest.fixture(scope='module')
def database():
    import psycopg2
    from psycopg2 import sql

    with require_polis_postgres() as url:
        table = f'probe_reader_snapshot_{uuid.uuid4().hex[:8]}'
        admin = psycopg2.connect(url)
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute(sql.SQL('CREATE TABLE {} (value integer NOT NULL)').format(sql.Identifier(table)))
        try:
            yield url, table, admin
        finally:
            with admin.cursor() as cur:
                cur.execute(sql.SQL('DROP TABLE IF EXISTS {}').format(sql.Identifier(table)))
            admin.close()


@pytest.fixture
def source(database, monkeypatch):
    """Route the box's socket-only service connection to the throwaway database."""
    import psycopg2
    from psycopg2 import sql

    url, table, admin = database
    with admin.cursor() as cur:
        cur.execute(sql.SQL('TRUNCATE {}').format(sql.Identifier(table)))
        cur.execute(sql.SQL('INSERT INTO {} VALUES (1)').format(sql.Identifier(table)))
    real_connect = psycopg2.connect
    opened = []
    login = {'options': READ_ONLY_LOGIN}

    def connect(*args, **kwargs):
        assert args == () and kwargs == {'service': 'probe'}, 'the reader must use only its service file'
        conn = real_connect(url, **login)
        opened.append(conn)
        return conn

    monkeypatch.setattr(psycopg2, 'connect', connect)

    def insert():
        with admin.cursor() as cur:
            cur.execute(sql.SQL('INSERT INTO {} VALUES (2)').format(sql.Identifier(table)))

    def count(conn):
        with conn.cursor() as cur:
            cur.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table)))
            return cur.fetchone()[0]

    return dict(login=login, opened=opened, insert=insert, count=count, real_connect=real_connect, url=url)


def extractor_reading_twice(source, snapshot_id=None):
    """Stand-in for the extractor body: the real helper, a read, a concurrent commit, a read."""
    seen = {}

    def extract_from_config(conn, **kwargs):
        seen['kwargs'] = kwargs
        seen['guarantee'] = fs.open_readonly_repeatable_read(conn, snapshot_id=snapshot_id)
        seen['before'] = source['count'](conn)
        source['insert']()
        seen['after'] = source['count'](conn)
        with conn.cursor() as cur:
            cur.execute("SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')")
            seen['settings'] = cur.fetchone()
        seen['notices'] = list(conn.notices)
        return seen

    return extract_from_config


@pytest.mark.integration
@pytest.mark.parametrize('default_isolation', [None, 'serializable', 'repeatable\\ read'])
def test_capture_keeps_one_snapshot_while_another_session_writes(source, monkeypatch, tmp_path, default_isolation):
    if default_isolation:
        source['login']['options'] = f'{READ_ONLY_LOGIN} -c default_transaction_isolation={default_isolation}'
    monkeypatch.setattr(fx, 'extract_from_config', extractor_reading_twice(source))

    seen = probe.capture({'accepted_public_fixture_replacements': ['pc-v1-dense']}, tmp_path / 'payload', tmp_path)

    assert (seen['before'], seen['after']) == (1, 1), 'a concurrent commit leaked into the capture'
    assert seen['settings'] == ('repeatable read', 'on')
    assert not any('SET TRANSACTION' in n for n in seen['notices'])
    assert seen['guarantee']['isolation_level'] == 'repeatable read'
    assert seen['guarantee']['single_transaction'] is True
    assert seen['kwargs']['accept_public_fixture'] == ('pc-v1-dense',)
    # The row is committed and visible to a fresh transaction; the reader closed.
    fresh = source['real_connect'](source['url'])
    try:
        assert source['count'](fresh) == 2
    finally:
        fresh.close()
    assert [c.closed for c in source['opened']] == [1]


@pytest.mark.integration
def test_a_writable_login_is_refused_before_any_extraction(source, monkeypatch, tmp_path):
    source['login']['options'] = '-c default_transaction_read_only=off'
    monkeypatch.setattr(fx, 'extract_from_config', lambda *a, **kw: pytest.fail('extracted from a writable login'))
    with pytest.raises(ValueError, match='READ_ONLY_SOURCE_REQUIRED'):
        probe.capture({}, tmp_path / 'payload', tmp_path)
    assert [c.closed for c in source['opened']] == [1]


@pytest.mark.integration
def test_the_former_autocommit_setup_now_fails_closed(source, monkeypatch, tmp_path):
    """The pre-fix sequence (guard in autocommit, then extract) must not produce a capture."""
    def former_open_reader(conn):
        conn.autocommit = True
        probe.validate_reader_session(conn)

    monkeypatch.setattr(probe, 'open_reader', former_open_reader)
    monkeypatch.setattr(fx, 'extract_from_config', extractor_reading_twice(source))
    with pytest.raises(fs.TransactionGuaranteeError, match='AUTOCOMMIT_READER_REFUSED'):
        probe.capture({}, tmp_path / 'payload', tmp_path)
    assert [c.closed for c in source['opened']] == [1]


@pytest.mark.integration
def test_autocommit_really_does_lose_the_snapshot(source):
    """Why the helper refuses autocommit: SET TRANSACTION is ignored with a warning."""
    import psycopg2

    conn = psycopg2.connect(service='probe')
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        before = source['count'](conn)
        source['insert']()
        after = source['count'](conn)
        assert (before, after) == (1, 2)
        assert any('SET TRANSACTION can only be used in transaction blocks' in n for n in conn.notices)
    finally:
        conn.close()


@pytest.mark.integration
def test_an_imported_snapshot_is_held_by_the_reader(source):
    import psycopg2

    exporter = source['real_connect'](source['url'])
    try:
        exporter.set_session(isolation_level='REPEATABLE READ', readonly=True)
        with exporter.cursor() as cur:
            cur.execute('SELECT pg_export_snapshot()')
            snapshot_id = cur.fetchone()[0]
        source['insert']()  # committed after the export: invisible to the snapshot
        conn = psycopg2.connect(service='probe')
        try:
            probe.open_reader(conn)
            guarantee = fs.open_readonly_repeatable_read(conn, snapshot_id=snapshot_id)
            assert guarantee['imported_snapshot_id'] == snapshot_id
            before = source['count'](conn)
            source['insert']()
            assert (before, source['count'](conn)) == (1, 1)
        finally:
            conn.close()
    finally:
        exporter.close()


# ---------------------------------------------------------------------------
# Fail-closed verification, no database: whatever the server reports is checked.
# ---------------------------------------------------------------------------


class _Cursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, statement, params=None):
        self.conn.statements.append(statement)

    def fetchone(self):
        return self.conn.reported


class _Connection:
    def __init__(self, isolation='repeatable read', read_only='on', status=2, autocommit=False):
        self.reported = (isolation, read_only, None, datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        self.status, self.autocommit = status, autocommit
        self.statements, self.rollbacks = [], 0

    def cursor(self):
        return _Cursor(self)

    def rollback(self):
        self.rollbacks += 1

    def get_transaction_status(self):
        return self.status


def test_the_verified_settings_produce_the_guarantee():
    conn = _Connection()
    guarantee = fs.open_readonly_repeatable_read(conn, snapshot_id='00000003-00000002-1')
    assert guarantee['single_transaction'] is True
    assert conn.statements[0] == 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    assert conn.statements[1] == 'SET TRANSACTION SNAPSHOT %s'
    assert 'transaction_isolation' in conn.statements[2] and 'transaction_read_only' in conn.statements[2]
    assert conn.rollbacks == 1


@pytest.mark.parametrize('reported', [
    dict(isolation='read committed'),
    dict(isolation='serializable'),
    dict(read_only='off'),
    dict(status=0),  # idle: no transaction is open
    dict(status=3),  # in error
])
def test_any_other_transaction_state_fails_closed(reported):
    conn = _Connection(**reported)
    with pytest.raises(fs.TransactionGuaranteeError, match='REPEATABLE_READ_READ_ONLY_NOT_ACTIVE'):
        fs.open_readonly_repeatable_read(conn)
    assert conn.rollbacks == 2


def test_an_autocommit_connection_is_refused_before_any_statement():
    conn = _Connection(autocommit=True)
    with pytest.raises(fs.TransactionGuaranteeError, match='AUTOCOMMIT_READER_REFUSED'):
        fs.open_readonly_repeatable_read(conn)
    assert conn.statements == [] and conn.rollbacks == 0
