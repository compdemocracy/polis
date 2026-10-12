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
from test_production_import import Source, row, FAMILY, no_pacing_sleep  # noqa: F401 (autouse)


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
    assert 'type=bind,src=/reviewed/delphi,dst=/opt/polis-import-source,readonly' in cmd
    assert cmd[cmd.index('--workdir') + 1] == '/opt/polis-import-source'
    assert not any('dst=/app' in arg for arg in cmd)
    assert 'DATABASE_URL' in cmd and '--apply' not in cmd
    assert cmd[-3:] == ['scripts/report_dynamo_import.py', '--region', 'us-east-1']
    assert '--network' in cmd and 'host' in cmd
    with pytest.raises(SystemExit) as exc:
        launcher.main(['--container','generated','--output','/private/generated','--apply'])
    assert exc.value.code == 2


class ScanOnlySource(Source):
    """Existing-box permission boundary, including Scan's missing-table error."""
    def describe_table(self, **kwargs):
        from botocore.exceptions import ClientError
        raise ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'DescribeTable')

    def scan(self, **kwargs):
        if kwargs['TableName'] in self.missing:
            raise self.Missing()
        return super().scan(**kwargs)


def test_scan_only_census_matches_checked_importer(tmp_path):
    rows = {FAMILY: [row(), row(cid=2), row('999')],
            'Delphi_JobQueue': [{'job_id': {'S': 'generated'}}]}
    source = ScanOnlySource(rows)
    expected = imp.census(Source(rows), tmp_path/'checked', {'1': 1}, {})
    actual = imp.census(source, tmp_path/'scan', {'1': 1}, {}, validate_schema=False)
    assert actual == expected
    assert len(source.calls) == len(imp.codec.FAMILIES) + 2
    assert all(call['ConsistentRead'] is False for call in source.calls)
    assert any('ExclusiveStartKey' in call for call in source.calls)


def test_scan_only_empty_inventory(tmp_path):
    summary = imp.census(ScanOnlySource(), tmp_path/'scan', {}, {}, validate_schema=False)
    assert len(summary['inventory']) == 20 and summary['missing'] == []
    assert all(counts['source'] == 0 for counts in summary['counts'].values())


def test_scan_only_missing_requires_explicit_inventory(tmp_path):
    source = ScanOnlySource(missing=[FAMILY])
    with pytest.raises(ValueError, match='unapproved missing'):
        imp.census(source, tmp_path/'refused', {}, {}, validate_schema=False)
    summary = imp.census(source, tmp_path/'allowed', {}, {}, [FAMILY], validate_schema=False)
    assert summary['missing'] == [FAMILY]
    assert summary['counts'][FAMILY]['source'] == 0


@pytest.mark.parametrize('code', ['AccessDeniedException', 'InternalServerError'])
def test_scan_only_errors_are_not_missing(tmp_path, code):
    from botocore.exceptions import ClientError
    source = ScanOnlySource()
    def fail(**kwargs):
        raise ClientError({'Error': {'Code': code}}, 'Scan')
    source.scan = fail
    with pytest.raises(ClientError) as exc:
        imp.census(source, tmp_path/'refused', {}, {}, list(imp.codec.FAMILIES), validate_schema=False)
    assert exc.value.response['Error']['Code'] == code


def test_skipped_family_is_never_read(tmp_path):
    """An explicitly skipped source table is never scanned, even when the role is denied on it."""
    from botocore.exceptions import ClientError
    rows = {'Delphi_JobQueue': [{'job_id': {'S': 'generated'}}]}
    source = ScanOnlySource(rows)
    original = source.scan
    def scan(**kwargs):
        if kwargs['TableName'] == FAMILY:
            raise ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'Scan')
        return original(**kwargs)
    source.scan = scan
    with pytest.raises(ClientError):
        imp.census(source, tmp_path/'refused', {}, {}, validate_schema=False)
    summary = imp.census(source, tmp_path/'skipped', {}, {}, validate_schema=False, skipped=[FAMILY])
    assert summary['skipped'] == [FAMILY] and summary['missing'] == []
    assert summary['counts'][FAMILY]['source'] == 0
    assert all(call['TableName'] != FAMILY for call in source.calls)
    # The skip is part of the census identity, so a run with and without it never compares equal.
    plain = imp.census(ScanOnlySource(rows), tmp_path/'plain', {}, {}, validate_schema=False)
    assert plain['source_sha256'] != summary['source_sha256']
    # Resuming the same census must keep the skip; dropping it is refused.
    with pytest.raises(ValueError, match='previously skipped'):
        imp.census(source, tmp_path/'skipped', {}, {}, validate_schema=False, resume=True)


@pytest.mark.parametrize('empty_first_page', [False, True])
def test_scan_only_disappearance_during_pagination_refuses(tmp_path, empty_first_page):
    source = ScanOnlySource({FAMILY: [row(), row(cid=2)]})
    original = source.scan
    def disappear(**kwargs):
        if 'ExclusiveStartKey' in kwargs:
            raise source.Missing()
        response = original(**kwargs)
        if empty_first_page:
            response['Items'] = []
        return response
    source.scan = disappear
    with pytest.raises(ValueError, match='disappeared'):
        imp.census(source, tmp_path/'refused', {'1': 1}, {}, [FAMILY], validate_schema=False)


@pytest.mark.parametrize('item', [
    {'conversation_id': {'S': '1'}},
    {'conversation_id': {'S': '1'}, 'comment_id': {'S': 'wrong-type'}},
])
def test_scan_only_row_keys_still_validated(tmp_path, item):
    with pytest.raises(imp.codec.CodecError):
        imp.census(ScanOnlySource({FAMILY: [item]}), tmp_path/'refused', {'1': 1}, {}, validate_schema=False)


def test_scan_only_duplicate_keys_refuse(tmp_path):
    with pytest.raises(ValueError, match='duplicate'):
        imp.census(ScanOnlySource({FAMILY: [row(), row()]}), tmp_path/'refused', {'1': 1}, {}, validate_schema=False)


def test_importer_still_requires_describe_table(tmp_path):
    from botocore.exceptions import ClientError
    with pytest.raises(ClientError) as exc:
        imp.census(ScanOnlySource(), tmp_path/'refused', {}, {})
    assert exc.value.operation_name == 'DescribeTable'


def test_importer_still_refuses_table_lost_after_schema_preflight(tmp_path):
    source = Source()
    def missing(**kwargs):
        raise source.Missing()
    source.scan = missing
    with pytest.raises(source.Missing):
        imp.census(source, tmp_path/'refused', {}, {}, list(imp.codec.FAMILIES))


@pytest.fixture
def keep_umask():
    # Both entry points set a private umask for their process; restore it here.
    previous = os.umask(0o022)
    os.umask(previous)
    yield
    os.umask(previous)


def report_cli():
    return load('report_cli', Path(__file__).resolve().parents[1]/'scripts/report_dynamo_import.py')


def refusal_run(monkeypatch, tmp_path, source, census=None):
    """Drive the real report entry point against a generated source; no AWS or database."""
    cli = report_cli()
    scratch = tmp_path/'import'
    scratch.mkdir()
    monkeypatch.setattr(cli, 'Path', lambda value: scratch if value == '/import' else Path(value))
    monkeypatch.setattr(imp, 'source_client', lambda region, endpoint=None: source)
    monkeypatch.setattr(report, 'connect_existing', lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(imp, 'mapping', lambda connection: ({'1': 1}, {}))
    if census:
        monkeypatch.setattr(imp, 'census', census)
    return cli.main(['--region', 'us-east-1', '--local-endpoint', 'http://127.0.0.1:9'])


def test_refusal_prints_fixed_reason_for_source_change(monkeypatch, tmp_path, capfd, keep_umask):
    """A source written between the two census passes refuses and says so in stderr."""
    source = ScanOnlySource({FAMILY: [row()], 'Delphi_JobQueue': [{'job_id': {'S': 'generated'}}]})
    census, passes = imp.census, []
    def census_then_write(*args, **kwargs):
        summary = census(*args, **kwargs)
        passes.append(summary)
        # A live writer touches a control row after the first pass.
        source.rows['Delphi_JobQueue'] = [{'job_id': {'S': 'generated'}, 'status': {'S': 'PRIVATE-ROW-VALUE'}}]
        return summary
    assert refusal_run(monkeypatch, tmp_path, source, census_then_write) == 2
    err = capfd.readouterr().err
    assert len(passes) == 2
    assert err.splitlines()[-1] == 'import dry-run refused (ValueError: source changed between census passes)'
    assert 'PRIVATE-ROW-VALUE' not in err and 'generated' not in err
    assert err.splitlines()[0].startswith('scan pacing {')


def test_refusal_withholds_codec_and_unlisted_text(monkeypatch, tmp_path, capfd, keep_umask):
    """Codec errors quote item values, so only their class reaches stderr."""
    item = {'conversation_id': {'S': '1'}, 'comment_id': {'N': 'PRIVATE-ROW-VALUE'}}
    assert refusal_run(monkeypatch, tmp_path, ScanOnlySource({FAMILY: [item]})) == 2
    err = capfd.readouterr().err
    assert err.splitlines()[-1] == 'import dry-run refused (CodecError)'
    assert 'PRIVATE-ROW-VALUE' not in err
    cli = report_cli()
    assert cli.refusal(ValueError('invalid literal for int(): PRIVATE')) == 'import dry-run refused (ValueError)'
    assert cli.refusal(ValueError('source changed between census passes', 'PRIVATE')) == 'import dry-run refused (ValueError)'
    assert cli.refusal(imp.codec.CodecError('source changed between census passes')) == 'import dry-run refused (CodecError)'
    assert cli.refusal(KeyError('PRIVATE')) == 'import dry-run refused (KeyError)'


def literal_value_errors(path):
    """Every `raise ValueError(...)` text in a file; a non-literal text fails the test."""
    import ast
    found = set()
    for node in ast.walk(ast.parse(Path(path).read_text())):
        if (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)
                and getattr(node.exc.func, 'id', None) == 'ValueError'):
            args = node.exc.args
            assert len(args) == 1 and isinstance(args[0], ast.Constant) and isinstance(args[0].value, str), \
                '%s:%d raises ValueError with non-literal text' % (path, node.lineno)
            found.add(args[0].value)
    return found


def test_refusal_list_matches_every_raise_site():
    """Each listed text is a fixed literal (reviewed for source values) and none is missing."""
    cli = report_cli()
    files = [imp.__file__, report.__file__, imp.scan_pacing.__file__, cli.__file__]
    assert set().union(*map(literal_value_errors, files)) == cli.REFUSALS
    checkout = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
    launcher = load('launcher', checkout / 'scripts/run-import-dry-run.py')
    assert literal_value_errors(launcher.__file__) == launcher.REFUSALS


def test_launcher_relays_report_refusal(tmp_path, capfd, keep_umask):
    checkout = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
    launcher = load('launcher', checkout / 'scripts/run-import-dry-run.py')
    log = tmp_path/'stderr.log'
    line = 'import dry-run refused (ValueError: source changed between census passes)'
    log.write_text('scan pacing {"pages": 2}\n' + line + '\n')
    assert launcher.report_refusal(log) == line
    log.write_text('import dry-run refused (CodecError)\n')
    assert launcher.report_refusal(log) == 'import dry-run refused (CodecError)'
    log.write_text('import dry-run refused (ValueError: {"S": "PRIVATE"})\n')
    assert launcher.report_refusal(log) is None
    assert launcher.report_refusal(tmp_path/'absent.log') is None
    assert launcher.reason(KeyError('PRIVATE')) == 'KeyError'
    assert launcher.main(['--container', 'generated', '--output', 'relative/generated']) == 2
    assert capfd.readouterr().err == ('import report launcher refused (ValueError: absolute output '
                                      'directory required); inspect private output directory\n')
