"""Scan pacing, throttle backoff and per-table resume for the one-shot census."""
import importlib.util
import os
from pathlib import Path
import sqlite3

import pytest
from botocore.exceptions import ClientError

from polismath.delphi_storage import production_import as imp
from polismath.delphi_storage import scan_pacing
from test_production_import import Source, row, FAMILY, no_pacing_sleep  # noqa: F401 (autouse)


class Clock:
    """Fake monotonic clock advanced only by the pacer's own sleeps."""
    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def throttle(code='ProvisionedThroughputExceededException'):
    return ClientError({'Error': {'Code': code, 'Message': 'generated'}}, 'Scan')


class Metered:
    """Scan double that reports ConsumedCapacity and can throttle on demand."""
    def __init__(self, units=5.0, failures=()):
        self.units = units
        self.failures = list(failures)
        self.calls = []

    def scan(self, **kwargs):
        self.calls.append(kwargs)
        if self.failures:
            raise self.failures.pop(0)
        return {'Items': [], 'ConsumedCapacity': {'TableName': kwargs['TableName'], 'CapacityUnits': self.units}}


def pacer(clock, rate=2.0, **kwargs):
    return scan_pacing.ScanPacer(rate, clock=clock, sleep=clock.sleep, rng=lambda: 0.5, **kwargs)


def test_pacing_holds_consumed_units_under_the_ceiling():
    clock = Clock()
    p = pacer(clock)
    client = Metered(units=5.0)
    for _ in range(4):
        p.scan(client, TableName=FAMILY)
    # 5 units at 2 units/s: each later request waits 2.5 s after the previous start.
    assert clock.sleeps == [2.5, 2.5, 2.5]
    assert p.units == 20.0 and p.pages == 4 and p.unmetered_pages == 0
    elapsed = clock.now - 100.0
    assert p.units / (elapsed + 5.0 / 2.0) <= 2.0
    assert all(c['ConsistentRead'] is False and c['Limit'] == 25 and c['ReturnConsumedCapacity'] == 'TOTAL'
               for c in client.calls)


def test_pacing_credits_time_already_spent_elsewhere():
    clock = Clock()
    p = pacer(clock)
    client = Metered(units=4.0)
    p.scan(client, TableName=FAMILY)
    clock.now += 1.5  # caller work between pages counts toward the wait
    p.scan(client, TableName=FAMILY)
    assert clock.sleeps == [0.5]


def test_unmetered_response_is_charged_the_minimum_page_cost():
    clock = Clock()
    p = pacer(clock, rate=1.0)
    source = Source({FAMILY: [row(), row(cid=2)]})
    p.scan(source, TableName=FAMILY)
    p.scan(source, TableName=FAMILY)
    assert p.unmetered_pages == 2 and clock.sleeps == [scan_pacing.FALLBACK_PAGE_UNITS]


@pytest.mark.parametrize('code', sorted(scan_pacing.THROTTLE_CODES))
def test_throttle_backs_off_exponentially_with_jitter_then_succeeds(code):
    clock = Clock()
    p = pacer(clock, base_delay=0.5)
    client = Metered(units=0.0, failures=[throttle(code)] * 3)
    response = p.scan(client, TableName=FAMILY)
    assert 'ConsumedCapacity' in response
    # rng=0.5 -> 3/4 of each doubling ceiling: 0.5, 1, 2 seconds.
    assert clock.sleeps == [0.375, 0.75, 1.5]
    assert p.throttles == 3 and len(client.calls) == 4


def test_jitter_stays_within_half_to_full_ceiling():
    for value in (0.0, 0.999):
        p = scan_pacing.ScanPacer(rng=lambda: value, base_delay=1.0, max_delay=8.0)
        for attempt, ceiling in enumerate([1, 2, 4, 8, 8, 8]):
            assert ceiling / 2 <= p.backoff(attempt) <= ceiling


def test_throttle_beyond_bound_pauses_and_other_errors_propagate():
    clock = Clock()
    p = pacer(clock, max_throttle_retries=2)
    client = Metered(failures=[throttle()] * 5)
    with pytest.raises(scan_pacing.ScanPaused):
        p.scan(client, TableName=FAMILY)
    assert len(client.calls) == 3 and p.throttles == 3
    denied = Metered(failures=[ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'Scan')])
    with pytest.raises(ClientError):
        p.scan(denied, TableName=FAMILY)
    assert len(denied.calls) == 1


@pytest.mark.parametrize('kwargs', [dict(max_read_units_per_second=0), dict(page_limit=0),
                                    dict(page_limit=5000), dict(max_throttle_retries=-1)])
def test_invalid_bounds_refuse(kwargs):
    with pytest.raises(ValueError):
        scan_pacing.ScanPacer(**kwargs)


class Flaky(Source):
    """Scan-only source that throttles every request after `budget` successful pages."""
    def __init__(self, rows, budget):
        super().__init__(rows)
        self.budget = budget

    def describe_table(self, **kwargs):
        raise AssertionError('DescribeTable must not be called')

    def scan(self, **args):
        if self.budget is not None and self.budget <= 0:
            self.calls.append(args)
            raise throttle()
        if self.budget is not None:
            self.budget -= 1
        return super().scan(**args)


# Successful pages before FAMILY's first page (each earlier table is one empty page).
BEFORE = sorted(imp.codec.FAMILIES).index(FAMILY)
ROWS = {FAMILY: [row(cid=i) for i in range(6)] + [row('999', cid=99)],
        'Delphi_JobQueue': [{'job_id': {'S': 'generated-%d' % i}} for i in range(3)]}


def run(source, path, mapping=({'1': 1}, {}), **kwargs):
    kwargs.setdefault('pacer', scan_pacing.ScanPacer(max_throttle_retries=1, rng=lambda: 0.0))
    return imp.census(source, path, *mapping, validate_schema=False, **kwargs)


def progress(path):
    with sqlite3.connect(path) as db:
        return dict((f, (s, k)) for f, s, k in db.execute('SELECT family,state,start FROM scan_progress'))


@pytest.mark.parametrize('offset', [None, 0, 1, 3, 6, 7, 9])
def test_paused_census_resumes_from_last_evaluated_key(tmp_path, offset):
    expected = run(Source(ROWS), tmp_path/'fresh')
    flaky = Flaky(ROWS, 0 if offset is None else BEFORE + offset)
    with pytest.raises(scan_pacing.ScanPaused):
        run(flaky, tmp_path/'paused')
    saved = progress(tmp_path/'paused')
    assert sum(state == 'scanning' for state, _ in saved.values()) == (1 if offset in (1, 3, 6) else 0)
    resumed = Source(ROWS)
    with pytest.raises(ValueError, match='already exists'):
        run(resumed, tmp_path/'paused')
    assert run(resumed, tmp_path/'paused', resume=True) == expected
    # Finished tables are never scanned again; the interrupted one continues
    # from its checkpointed key rather than its first page.
    done = {f for f, (state, _) in saved.items() if state == 'done'}
    assert not done & {c['TableName'] for c in resumed.calls}
    for family, (state, start) in saved.items():
        if state == 'scanning':
            first = next(c for c in resumed.calls if c['TableName'] == family)
            assert first['ExclusiveStartKey'] == imp._start_key(start)
    assert all(c['ConsistentRead'] is False for c in resumed.calls)


def test_resume_total_scans_equal_one_full_pass(tmp_path):
    full = Source(ROWS)
    run(full, tmp_path/'fresh')
    flaky = Flaky(ROWS, BEFORE + 3)
    with pytest.raises(scan_pacing.ScanPaused):
        run(flaky, tmp_path/'paused')
    resumed = Source(ROWS)
    run(resumed, tmp_path/'paused', resume=True)
    succeeded = len(flaky.calls) - 2  # max_throttle_retries=1: two throttled attempts
    assert succeeded == BEFORE + 3
    assert succeeded + len(resumed.calls) == len(full.calls)


def test_failed_page_is_not_half_committed(tmp_path):
    bad = dict(ROWS, **{FAMILY: ROWS[FAMILY][:3] + [{'conversation_id': {'S': '1'}}] + ROWS[FAMILY][3:]})
    with pytest.raises(imp.codec.CodecError):
        run(Source(bad), tmp_path/'failed')
    with sqlite3.connect(tmp_path/'failed') as db:
        assert db.execute('SELECT COUNT(*) FROM rows WHERE family=?', (FAMILY,)).fetchone()[0] == 3
    assert progress(tmp_path/'failed')[FAMILY][0] == 'scanning'


def test_resume_rebinds_rows_under_a_changed_mapping(tmp_path):
    with pytest.raises(scan_pacing.ScanPaused):
        run(Flaky(ROWS, BEFORE + 4), tmp_path/'paused')
    grown = ({'1': 1, '999': 999}, {})
    expected = run(Source(ROWS), tmp_path/'fresh', grown)
    assert run(Source(ROWS), tmp_path/'paused', grown, resume=True) == expected
    assert expected['counts'][FAMILY]['quarantined'] == 0


def test_missing_table_state_survives_resume(tmp_path):
    class Gone(Flaky):
        def scan(self, **args):
            if args['TableName'] == FAMILY:
                raise self.Missing()
            return super().scan(**args)
    with pytest.raises(scan_pacing.ScanPaused):
        run(Gone(ROWS, 12), tmp_path/'paused', allowed_missing=[FAMILY])
    assert progress(tmp_path/'paused')[FAMILY] == ('missing', None)
    with pytest.raises(ValueError, match='unapproved missing'):
        run(Source(ROWS), tmp_path/'paused', resume=True)
    summary = run(Source(ROWS), tmp_path/'paused', allowed_missing=[FAMILY], resume=True)
    assert summary['missing'] == [FAMILY]


def test_tampered_checkpoint_refuses(tmp_path):
    with pytest.raises(scan_pacing.ScanPaused):
        run(Flaky(ROWS, BEFORE + 2), tmp_path/'paused')
    with sqlite3.connect(tmp_path/'paused') as db:
        assert db.execute("UPDATE scan_progress SET start='[1]' WHERE state='scanning'").rowcount == 1
    with pytest.raises(ValueError, match='invalid scan checkpoint'):
        run(Source(ROWS), tmp_path/'paused', resume=True)


def test_attempt_directory_resumes_only_one_incomplete_attempt(tmp_path):
    with pytest.raises(ValueError, match='exactly one'):
        imp.attempt_directory(tmp_path, 'report-', True)
    first = imp.attempt_directory(tmp_path, 'report-', False)
    (first/'snapshot').mkdir()
    (first/'snapshot'/'derived').write_text('x')
    (first/'report.jsonl').write_text('partial')
    (first/'first.sqlite').write_text('kept')
    assert imp.attempt_directory(tmp_path, 'report-', True) == first
    assert not (first/'snapshot').exists() and not (first/'report.jsonl').exists()
    assert (first/'first.sqlite').read_text() == 'kept'
    imp.finish_attempt(first)
    with pytest.raises(ValueError, match='exactly one'):
        imp.attempt_directory(tmp_path, 'report-', True)
    second, third = (imp.attempt_directory(tmp_path, 'report-', False) for _ in range(2))
    with pytest.raises(ValueError, match='exactly one'):
        imp.attempt_directory(tmp_path, 'report-', True)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_pacing_flags_reach_the_pacer():
    import argparse
    parser = argparse.ArgumentParser()
    imp.pacing_arguments(parser)
    defaults = imp.pacer_from(parser.parse_args([]))
    assert (defaults.rate, defaults.page_limit, defaults.max_throttle_retries) == (2.0, 25, 8)
    args = parser.parse_args(['--max-read-units-per-second', '1.5', '--scan-page-limit', '10',
                              '--max-throttle-retries', '3', '--resume'])
    tuned = imp.pacer_from(args)
    assert (tuned.rate, tuned.page_limit, tuned.max_throttle_retries, args.resume) == (1.5, 10, 3, True)


def test_launcher_passes_pacing_and_resume_through():
    checkout = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
    launcher = load('launcher_pacing', checkout / 'scripts/run-import-dry-run.py')
    import argparse
    args = argparse.Namespace(max_read_units_per_second=1.0, scan_page_limit=None,
                              max_throttle_retries=4, resume=True)
    cmd = launcher.command('generated-delphi', 'generated-image', Path('/private/generated'),
                           Path('/reviewed/delphi'), 'us-east-1', {}, [], launcher.report_extra(args))
    tail = cmd[cmd.index('scripts/report_dynamo_import.py'):]
    assert tail == ['scripts/report_dynamo_import.py', '--region', 'us-east-1',
                    '--max-read-units-per-second', '1.0', '--max-throttle-retries', '4', '--resume']
    # A fresh run needs a new directory; --resume needs the paused one.
    assert launcher.main(['--container', 'generated', '--output', '/']) == 2
    assert launcher.main(['--container', 'generated', '--output', '/nonexistent/generated', '--resume']) == 2
