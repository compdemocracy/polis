"""Generated report, connection and dry-only launcher boundary tests."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from polismath.delphi_storage import import_report as report
from polismath.delphi_storage import production_import as imp
from test_production_import import Source, row, FAMILY


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_report_covers_import_archive_quarantine_and_unmapped(tmp_path):
    source = Source({FAMILY: [row(), row('2', text='bad\0value'), row('999')],
                     'Delphi_JobQueue': [{'job_id': {'S': 'generated'}, 'zid': {'N': '1'}}]})
    summary = imp.census(source, tmp_path/'rows', {'1': 1, '2': 2}, {})
    details = {i: dict(zid=i, conversation_id=None, conversation_ids=[], topic='Generated\nTopic',
        description=None, participant_count=0) for i in [1, 2]}
    values = report.report(tmp_path/'rows', details, summary)
    assert [x['zid'] for x in values[:-1]] == [None, 1, 2]
    assert values[-1]['totals'] == dict(source=4, would_import=1, archive=1, quarantine=2)
    assert values[2]['families'][FAMILY]['quarantine'] == 1
    assert len(values[1]['families']) == 20
    raw = report.encode(values)
    assert len(raw.splitlines()) == 4
    assert json.loads(raw.splitlines()[1])['topic'] == 'Generated\nTopic'
    summary['counts'][FAMILY]['source'] += 1
    with pytest.raises(ValueError, match='conservation'):
        report.report(tmp_path/'rows', details, summary)


def test_empty_inventory(tmp_path):
    summary = imp.census(Source(), tmp_path/'rows', {}, {})
    result = report.report(tmp_path/'rows', {}, summary)
    assert len(result) == 1 and result[0]['conversations'] == 0
    assert result[0]['totals'] == dict(source=0, would_import=0, archive=0, quarantine=0)


@pytest.mark.parametrize('dsn,mode', [
    ('postgresql://reader@db.invalid/test?sslmode=verify-full', 'verify-full'),
    ('host=db.invalid dbname=test user=reader', 'require')])
def test_connection_retains_tls_and_enforces_readonly(monkeypatch, dsn, mode):
    import psycopg2
    seen = {}
    conn = SimpleNamespace(set_session=lambda **kw: seen.update(session=kw))
    monkeypatch.setenv('DATABASE_URL', dsn)
    monkeypatch.delenv('DATABASE_SSL_MODE', raising=False)
    monkeypatch.setattr(psycopg2, 'connect', lambda **kw: (seen.update(kw), conn)[1])
    assert report.connect_existing() is conn
    assert seen['sslmode'] == mode
    assert seen['options'] == '-c default_transaction_read_only=on -c search_path=public,pg_catalog'
    assert seen['session']['readonly'] is True


def test_component_connection(monkeypatch):
    import psycopg2
    seen = {}
    monkeypatch.delenv('DATABASE_URL', raising=False)
    for key,value in dict(DATABASE_HOST='db.invalid',DATABASE_NAME='test',DATABASE_USER='reader',DATABASE_SSL_MODE='verify-ca').items():
        monkeypatch.setenv(key,value)
    monkeypatch.setattr(psycopg2, 'connect', lambda **kw: (seen.update(kw), SimpleNamespace(set_session=lambda **kw: None))[1])
    report.connect_existing()
    assert seen['sslmode'] == 'verify-ca' and seen['dbname'] == 'test'


def test_missing_database_refuses(monkeypatch):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    monkeypatch.delenv('DATABASE_HOST', raising=False)
    with pytest.raises(ValueError, match='existing'):
        report.connect_existing()


def test_production_report_has_no_apply_option():
    cli = load('report_cli', Path(__file__).resolve().parents[1]/'scripts/report_dynamo_import.py')
    with pytest.raises(SystemExit) as exc:
        cli.main(['--region','us-east-1','--apply'])
    assert exc.value.code == 2


def test_launcher_dry_only_credentials_and_mounts():
    # CI supplies the same checkout root used by the other host-script tests.
    checkout = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
    launcher = load('launcher', checkout / 'scripts/run-import-dry-run.py')
    cmd = launcher.command('generated-delphi', 'generated-image', Path('/private/generated'), Path('/reviewed/delphi'),
        'us-east-1', {'DATABASE_URL': 'SENSITIVE', 'ANTHROPIC_API_KEY': 'NEVER', 'AWS_ACCESS_KEY_ID': 'NEVER'}, [])
    assert 'SENSITIVE' not in ' '.join(cmd) and 'NEVER' not in ' '.join(cmd)
    assert '--read-only' in cmd and 'generated-delphi:ro' in cmd
    assert 'type=bind,src=/reviewed/delphi,dst=/app,readonly' in cmd
    assert 'DATABASE_URL' in cmd and '--apply' not in cmd
    assert cmd[-3:] == ['scripts/report_dynamo_import.py', '--region', 'us-east-1']
    assert '--network' in cmd and 'host' in cmd
    with pytest.raises(SystemExit) as exc:
        launcher.main(['--container','generated','--output','/private/generated','--apply'])
    assert exc.value.code == 2
