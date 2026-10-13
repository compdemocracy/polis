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


def refusal_run(monkeypatch, tmp_path, source, census=None, mapping=None):
    """Drive the real report entry point against a generated source; no AWS or database."""
    cli = report_cli()
    scratch = tmp_path/'import'
    scratch.mkdir()
    monkeypatch.setattr(cli, 'Path', lambda value: scratch if value == '/import' else Path(value))
    monkeypatch.setattr(imp, 'source_client', lambda region, endpoint=None: source)
    monkeypatch.setattr(report, 'connect_existing', lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(imp, 'mapping', mapping or (lambda connection: ({'1': 1}, {})))
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
    drift = 'identity mapping drift {"conversations": {"added": 1, "changed": 0, "removed": 0}}'
    log.write_text(drift + '\n' + line + '\n')
    assert launcher.report_refusal(log, launcher.REPORT_DRIFT) == drift
    log.write_text('identity mapping drift {"conversations": ["PRIVATE-ID"]}\n')
    assert launcher.report_refusal(log, launcher.REPORT_DRIFT) is None
    assert launcher.reason(KeyError('PRIVATE')) == 'KeyError'
    assert launcher.main(['--container', 'generated', '--output', 'relative/generated']) == 2
    assert capfd.readouterr().err == ('import report launcher refused (ValueError: absolute output '
                                      'directory required); inspect private output directory\n')


def metadata_stub(connection, zids):
    return {zid: dict(zid=zid, conversation_id=None, conversation_ids=[], topic='Generated', description=None,
                      participant_count=0) for zid in zids}


def drifting_run(monkeypatch, tmp_path, source, start, change):
    """The Postgres mapping is read before pass one and after pass two; `change` runs between passes."""
    conversations, reports = (dict(part) for part in start)
    census, passes = imp.census, []
    def census_then_change(client, database, *args, **kwargs):
        summary = census(client, database, *args, **kwargs)
        if not kwargs.get('resume'):
            passes.append(Path(database).name)
            if len(passes) == 1:
                change(conversations, reports)
        return summary
    monkeypatch.setattr(report, 'metadata', metadata_stub)
    code = refusal_run(monkeypatch, tmp_path, source, census_then_change,
                       mapping=lambda connection: (dict(conversations), dict(reports)))
    assert passes == ['first.sqlite', 'second.sqlite']
    return code


def drift_counts(err):
    lines = [line for line in err.splitlines() if line.startswith('identity mapping drift ')]
    assert len(lines) == 1
    return json.loads(lines[0][len('identity mapping drift '):])


def follow_up_record(scratch):
    """The single private follow-up.json a drifting run leaves in its attempt directory."""
    files = list(Path(scratch).glob('*/' + imp.FOLLOW_UP))
    assert len(files) == 1
    assert oct(files[0].stat().st_mode)[-3:] == '600'
    return json.loads(files[0].read_text())


def test_conversation_and_report_created_during_run_are_accepted(monkeypatch, tmp_path, capfd, keep_umask):
    # Rows for conversation 7 exist before its conversation row is visible to the first read.
    source = ScanOnlySource({FAMILY: [row(), row('7')]})
    def create(conversations, reports):
        conversations['424242'] = 424242          # created with no Delphi rows yet
        conversations['7'] = 7
        reports['r-created'] = 424242
    assert drifting_run(monkeypatch, tmp_path, source, ({'1': 1}, {'r-1': 1}), create) == 0
    out, err = capfd.readouterr()
    assert drift_counts(err) == dict(conversations=dict(added=2, removed=0, changed=0),
                                     reports=dict(added=1, removed=0, changed=0))
    assert '424242' not in err and 'r-created' not in err
    lines = [json.loads(line) for line in out.splitlines()]
    # The new conversation without rows adds nothing; the rebound row now counts under its conversation.
    assert [line['zid'] for line in lines[:-1]] == [1, 7]
    assert lines[-1]['totals'] == dict(source=2, would_import=2, archive=0, quarantine=0)
    # Every mid-run addition is flagged for a follow-up pass, by identity, on the
    # private mount only (ids never reach stderr). 7 was imported here via the
    # rebind; 424242 arrived with no scanned rows and its conversation makes no
    # report line, yet it is recorded so a later run cannot silently miss it.
    assert follow_up_record(tmp_path/'import') == dict(
        schema='polis-production-import-follow-up/1', conversations=[7, 424242], reports={'r-created': 424242})
    assert 424242 not in [line['zid'] for line in lines[:-1]]


@pytest.mark.parametrize('change,expected', [
    (lambda conversations, reports: conversations.pop('2'),
     dict(conversations=dict(added=0, removed=1, changed=0), reports=dict(added=0, removed=0, changed=0))),
    (lambda conversations, reports: reports.update({'r-1': 2}),
     dict(conversations=dict(added=0, removed=0, changed=0), reports=dict(added=0, removed=0, changed=1))),
])
def test_removed_conversation_or_repointed_report_refuses(monkeypatch, tmp_path, capfd, keep_umask, change, expected):
    source = ScanOnlySource({FAMILY: [row()]})
    assert drifting_run(monkeypatch, tmp_path, source, ({'1': 1, '2': 2}, {'r-1': 1}), change) == 2
    err = capfd.readouterr().err
    assert drift_counts(err) == expected
    assert err.splitlines()[-1] == 'import dry-run refused (ValueError: source identity mapping changed)'


def test_rebind_additions_reads_nothing_and_refuses_removals(tmp_path):
    source = ScanOnlySource({FAMILY: [row(), row('7')]})
    before = ({'1': 1}, {})
    summary = imp.census(source, tmp_path/'first.sqlite', *before, validate_schema=False)
    assert summary['counts'][FAMILY]['quarantined'] == 1
    calls = len(source.calls)
    rebound = imp.rebind_additions(tmp_path/'first.sqlite', before, ({'1': 1, '7': 7}, {}), validate_schema=False)
    assert len(source.calls) == calls
    assert rebound['counts'][FAMILY] == dict(source=2, imported=2, archived=0, quarantined=0)
    assert rebound['source_sha256'] == summary['source_sha256']
    with pytest.raises(ValueError, match='identity mapping changed'):
        imp.rebind_additions(tmp_path/'first.sqlite', ({'1': 1, '7': 7}, {}), ({'7': 7}, {}), validate_schema=False)
    assert imp.mapping_drift(({'1': 1, '2': 2}, {'a': 1, 'b': 2}), ({'1': 1, '3': 3}, {'a': 2, 'c': 1})) == dict(
        conversations=dict(added=1, removed=1, changed=0), reports=dict(added=1, removed=1, changed=1))
    # mapping_additions keeps the added identities (sorted zids; new report_id -> zid);
    # write_follow_up records them privately and returns counts only.
    assert imp.mapping_additions(({'1': 1, '9': 9}, {'a': 1}), ({'1': 1, '9': 9, '4': 4}, {'a': 1, 'b': 9})) == dict(
        conversations=[4], reports={'b': 9})
    assert imp.write_follow_up(tmp_path, ({'1': 1}, {}), ({'1': 1, '9': 9, '4': 4}, {'b': 9})) == dict(
        conversations=2, reports=1)
    assert json.loads((tmp_path/imp.FOLLOW_UP).read_text()) == dict(
        schema='polis-production-import-follow-up/1', conversations=[4, 9], reports={'b': 9})


def test_production_importer_accepts_additions_and_refuses_removals(monkeypatch, tmp_path, capfd, keep_umask):
    """The real importer's dry run applies the same rule."""
    cli = load('importer_cli', Path(__file__).resolve().parents[1]/'scripts/import_dynamo_production.py')
    def run(change, rows):
        scratch = tmp_path/('import-' + str(len(list(tmp_path.iterdir()))))
        scratch.mkdir()
        conversations, reports = {'1': 1, '2': 2}, {'r-1': 1}
        census, passes = imp.census, []
        def census_then_change(client, database, *args, **kwargs):
            summary = census(client, database, *args, **kwargs)
            if not kwargs.get('resume'):
                passes.append(Path(database).name)
                if len(passes) == 1:
                    change(conversations, reports)
            return summary
        monkeypatch.setattr(cli, 'Path', lambda value: scratch if value == '/import' else Path(value))
        monkeypatch.setattr(imp, 'source_client', lambda region, endpoint=None: Source(rows))
        monkeypatch.setattr(imp, 'connect_readonly_source', lambda local=False: SimpleNamespace(close=lambda: None))
        monkeypatch.setattr(imp, 'mapping', lambda connection: (dict(conversations), dict(reports)))
        monkeypatch.setattr(imp, 'census', census_then_change)
        code = cli.main(['--region', 'us-east-1', '--local-endpoint', 'http://127.0.0.1:9'])
        assert passes == ['first.sqlite', 'second.sqlite']
        return code
    def add(conversations, reports):
        conversations['7'] = 7
        reports['r-7'] = 7
    assert run(add, {FAMILY: [row(), row('7')]}) == 0
    out, err = capfd.readouterr()
    result = json.loads(out)
    assert result['conversations'] == 2 and result['counts'][FAMILY]['imported'] == 2
    # Stdout carries counts only; the identities are on the private mount for a follow-up pass.
    assert result['follow_up'] == dict(conversations=1, reports=1)
    assert 'r-7' not in out
    assert follow_up_record(tmp_path/'import-0') == dict(
        schema='polis-production-import-follow-up/1', conversations=[7], reports={'r-7': 7})
    assert run(lambda conversations, reports: conversations.pop('2'), {FAMILY: [row()]}) == 2
    err = capfd.readouterr().err
    assert drift_counts(err)['conversations']['removed'] == 1
    assert err.splitlines()[-1] == 'production import refused (ValueError)'
    # A refused (removal) run accepts nothing and writes no follow-up record.
    assert not list((tmp_path/'import-1').glob('*/' + imp.FOLLOW_UP))


def test_launcher_resume_relays_only_this_runs_lines(monkeypatch, tmp_path, capfd, keep_umask):
    """--resume appends to stderr.log; an earlier attempt's refusal is never relayed as current."""
    checkout = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
    launcher = load('launcher', checkout / 'scripts/run-import-dry-run.py')
    output = tmp_path/'output'
    (output/'scratch').mkdir(parents=True)
    root = Path(launcher.__file__).resolve().parents[1]
    (output/'runtime.json').write_text(json.dumps(dict(image='generated-image', source=str(root/'delphi'))))
    (output/'report.jsonl').write_bytes(b'')
    stale = ('identity mapping drift {"conversations": {"added": 9, "changed": 0, "removed": 0}}\n'
             'import dry-run refused (ValueError: source changed between census passes)\n')
    (output/'stderr.log').write_text(stale)
    inspect = json.dumps([dict(State=dict(Running=True), Image='generated-image',
        Config=dict(Env=[], Labels={'com.docker.compose.service': 'delphi'}))]).encode()
    monkeypatch.setattr(launcher.subprocess, 'check_output', lambda *a, **kw: inspect)
    def resume(written, code):
        def run(command, env, stdout, stderr):
            stderr.write(written.encode())
            return SimpleNamespace(returncode=code)
        monkeypatch.setattr(launcher.subprocess, 'run', run)
        result = launcher.main(['--container', 'generated', '--output', str(output), '--resume'])
        return result, capfd.readouterr().err.splitlines()
    # This attempt fails without a refusal line of its own: nothing earlier is relayed.
    code, err = resume('scan pacing {"pages": 1}\nTraceback-free failure\n', 2)
    assert code == 2 and err == ['import report launcher refused (ValueError: report failed; '
                                 'inspect private stderr); inspect private output directory']
    # This attempt's own refusal is relayed, and the stale drift line is not.
    code, err = resume('import dry-run refused (ValueError: source identity mapping changed)\n', 2)
    assert code == 2 and err[0] == 'import dry-run refused (ValueError: source identity mapping changed)'
    assert len(err) == 2 and 'added": 9' not in ' '.join(err)
    assert (output/'stderr.log').read_text().startswith(stale)


def staging_line(err):
    cli = report_cli()
    lines = [line for line in err.splitlines() if line.startswith(cli.STAGING_LINE)]
    assert len(lines) <= 1
    return json.loads(lines[0][len(cli.STAGING_LINE):]) if lines else None


def test_dry_run_reports_a_family_past_the_staging_bound_and_completes(monkeypatch, tmp_path, capfd, keep_umask):
    """The same seeded source refused with the bound before; the dry run now reports it and continues."""
    source = ScanOnlySource({FAMILY: [row(cid=i, text='x'*400) for i in range(3)] + [row('2', text='small')]})
    monkeypatch.setattr(imp, 'FAMILY_LIMIT', 1000)
    # Before: materialize without a collector (the apply path) refuses on this census.
    summary = imp.census(source, tmp_path/'before.sqlite', {'1': 1, '2': 2}, {}, validate_schema=False)
    with pytest.raises(ValueError, match='conversation family exceeds staged storage bound'):
        imp.materialize(tmp_path/'before.sqlite', tmp_path/'before', summary)
    monkeypatch.setattr(report, 'metadata', metadata_stub)
    code = refusal_run(monkeypatch, tmp_path, source, mapping=lambda connection: ({'1': 1, '2': 2}, {}))
    out, err = capfd.readouterr()
    assert code == 0, err
    assert 'refused (' not in err
    lines = [json.loads(line) for line in out.splitlines()]
    big, small, grand = lines
    assert big['zid'] == 1 and big['topic'] == 'Generated'
    size = big['staging']['oversized_families'][FAMILY]
    assert size > 1000 and big['staging']['within_bound'] is False and big['staging']['batch_over_bound'] is False
    assert small['staging']['within_bound'] is True and small['staging']['oversized_families'] == {}
    expected = dict(conversations=1, family_limit=1000, batch_limit=imp.BATCH_LIMIT,
                    families={FAMILY: dict(conversations=1, bytes_max=size, bytes_total=size)})
    assert grand['staging'] == expected
    assert grand['totals']['would_import'] == 4
    # Stderr carries counts and sizes only.
    assert staging_line(err) == expected
    assert 'Generated' not in err
    # The report and the complete marker are written as for any other run.
    attempts = list((tmp_path/'import').glob('report-*'))
    assert len(attempts) == 1 and (attempts[0]/'report.jsonl').read_bytes() == out.encode()


def test_dry_run_within_bounds_prints_no_staging_line(monkeypatch, tmp_path, capfd, keep_umask):
    monkeypatch.setattr(report, 'metadata', metadata_stub)
    assert refusal_run(monkeypatch, tmp_path, ScanOnlySource({FAMILY: [row()]})) == 0
    out, err = capfd.readouterr()
    assert staging_line(err) is None
    lines = [json.loads(line) for line in out.splitlines()]
    assert lines[0]['staging']['within_bound'] is True
    assert lines[-1]['staging']['conversations'] == 0 and lines[-1]['staging']['families'] == {}


def test_launcher_relays_staging_line_on_success(monkeypatch, tmp_path, capfd, keep_umask):
    checkout = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
    launcher = load('launcher', checkout / 'scripts/run-import-dry-run.py')
    cli = report_cli()
    line = cli.STAGING_LINE + json.dumps(dict(conversations=1, batch_limit=268435456, family_limit=67108864,
        families={FAMILY: dict(conversations=1, bytes_max=70000000, bytes_total=70000000)}), sort_keys=True)
    log = tmp_path/'stderr.log'
    log.write_text('scan pacing {"pages": 2}\n' + line + '\n')
    assert launcher.report_refusal(log, launcher.REPORT_STAGING) == line
    log.write_text(cli.STAGING_LINE + '{"conversations": ["PRIVATE-ID"]}\n')
    assert launcher.report_refusal(log, launcher.REPORT_STAGING) is None
    assert launcher.staging_counts_only(line)
    # Lines that pass the character pattern but carry id-shaped keys or values are not relayed.
    sizes = dict(conversations=1, bytes_max=2, bytes_total=2)
    for shaped in (dict(conversations=1, family_limit=1, batch_limit=1, families={'31337': sizes}),
                   dict(conversations=1, family_limit=1, batch_limit=1, families={FAMILY: dict(sizes, zid=31337)}),
                   dict(conversations=1, family_limit=1, batch_limit=1, families={}, zids={'a': 31337}),
                   dict(conversations='abc', family_limit=1, batch_limit=1, families={}),
                   dict(conversations=True, family_limit=1, batch_limit=1, families={})):
        candidate = cli.STAGING_LINE + json.dumps(shaped, sort_keys=True)
        assert not launcher.staging_counts_only(candidate)
    inspect = json.dumps([dict(State=dict(Running=True), Image='generated-image',
        Config=dict(Env=[], Labels={'com.docker.compose.service': 'delphi'}))]).encode()
    monkeypatch.setattr(launcher.subprocess, 'check_output', lambda *a, **kw: inspect)
    def run(command, env, stdout, stderr):
        stderr.write((line + '\n').encode())
        stdout.write(b'{"type": "grand_totals"}\n')
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    assert launcher.main(['--container', 'generated', '--output', str(tmp_path/'output')]) == 0
    out, err = capfd.readouterr()
    assert err.splitlines() == [line]
    assert out == '{"type": "grand_totals"}\n'
    line = cli.STAGING_LINE + json.dumps(dict(conversations=1, family_limit=1, batch_limit=1,
                                              families={'31337': sizes}), sort_keys=True)
    # `run` writes the current `line`, now id-shaped: the run succeeds and the line stays private.
    assert launcher.main(['--container', 'generated', '--output', str(tmp_path/'output2')]) == 0
    out, err = capfd.readouterr()
    assert err == '' and '31337' not in out


def test_production_importer_dry_run_reports_oversized_and_apply_still_refuses(monkeypatch, tmp_path, capfd, keep_umask):
    cli = load('importer_cli', Path(__file__).resolve().parents[1]/'scripts/import_dynamo_production.py')
    rows = {FAMILY: [row(cid=i, text='x'*400) for i in range(3)] + [row('2', text='small')]}
    monkeypatch.setattr(imp, 'FAMILY_LIMIT', 1000)
    admitted = []
    monkeypatch.setattr(imp, 'import_all', lambda *args: admitted.append(args) or 0)
    monkeypatch.setattr(imp, 'SNAPSHOTS', tmp_path/'snapshots')
    def run(*extra):
        scratch = tmp_path/('import-' + str(len(list(tmp_path.iterdir()))))
        scratch.mkdir()
        monkeypatch.setattr(cli, 'Path', lambda value: scratch if value == '/import' else Path(value))
        monkeypatch.setattr(imp, 'source_client', lambda region, endpoint=None: Source(rows))
        monkeypatch.setattr(imp, 'connect_readonly_source', lambda local=False: SimpleNamespace(close=lambda: None))
        monkeypatch.setattr(imp, 'mapping', lambda connection: ({'1': 1, '2': 2}, {}))
        return cli.main(['--region', 'us-east-1', '--local-endpoint', 'http://127.0.0.1:9', *extra])
    assert run() == 0
    out, err = capfd.readouterr()
    result = json.loads(out)
    assert result['mode'] == 'dry-run' and result['conversations'] == 2
    assert result['staging']['conversations'] == 1
    assert set(result['staging']['families']) == {FAMILY}
    # --apply refuses on the same source before any snapshot is copied or any graph admitted.
    assert run('--apply', '--source-frozen') == 2
    err = capfd.readouterr().err
    assert err.splitlines()[-1] == 'production import refused (ValueError)'
    assert admitted == [] and not (tmp_path/'snapshots').exists()
