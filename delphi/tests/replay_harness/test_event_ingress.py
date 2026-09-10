"""Lossless ingress rejects corrupt streams and preserves engine-boundary facts."""
import copy
import json
from pathlib import Path

import pytest

from polismath.replay import event_ingress as ei, real_data, schedule
from polismath.replay.driver import _votes_dict
from polismath.replay.fixture_extract import build_events, logical_digest


def write_stream(directory, events=None, sign=-1):
    directory.mkdir(parents=True, exist_ok=True)
    if events is None:
        events = build_events([
            dict(created=1001, pid=1, tid=2, vote=-1, weight_x_32767=0),
            dict(created=1001, pid=1, tid=2, vote=1, weight_x_32767=None),
            dict(created=1999, pid=1, tid=2, vote=None, weight_x_32767=123),
        ], [dict(created=900, modified=1500, pid=1, tid=2, mod=-1, is_meta=True)])
    path = directory / 'events.jsonl'
    path.write_text(''.join(json.dumps(e) + '\n' for e in events))
    meta = {'schema_version': 'certify-events/2', 'polarity': {'storage_agree_value': sign},
            'logical_digest_sha256': logical_digest(events), 'counts': {
                'events': len(events), 'vote_events': sum(e['kind'] == 'vote' for e in events),
                'comment_events': sum(e['kind'] == 'comment' for e in events)}}
    path.with_name('events.meta.json').write_text(json.dumps(meta))
    return path


def test_lossless_boundary_and_cut_indices(tmp_path):
    path = write_stream(tmp_path)
    ds = ei.load_events(path)
    assert [(v.k, v.t_ms, v.sign, v.weight_x_32767, v.is_revote, v.source_ord) for v in ds.votes] == [
        (1, 1001, 1, 0, False, 0), (2, 1001, -1, None, True, 1), (3, 1999, None, 123, True, 2)]
    assert ds.input_events == tuple(json.loads(line) for line in path.read_text().splitlines())
    spec = schedule.ScheduleSpec('fixture', 'cuts', {'mode': 'vote-count', 'at': [1, 2, 3]},
                                 moderation='interleave-by-timestamp')
    steps = schedule.slice_schedule(ds, spec)
    assert [len(s.mod_events) for s in steps] == [0, 0, 1]
    assert _votes_dict(steps[2]) == {'votes': [dict(pid=1, tid=2, vote=None, created=1999,
                                                 weight_x_32767=123)], 'lastVoteTimestamp': 1999}
    assert _votes_dict(steps[0])['votes'][0]['weight_x_32767'] == 0
    assert schedule.resolve_cut_slots(ds, {'mode': 'timestamp', 'at': [1001, 1999]}) == (2, 3)


@pytest.mark.parametrize('mutation', [
    lambda e: e[0].update(ord=True), lambda e: e[1].update(ord=0),
    lambda e: e[0].update(created=1.5), lambda e: e[0].update(created=2**63),
    lambda e: e[0].update(pid=True), lambda e: e[0].update(vote=False),
    lambda e: e[0].update(vote=2), lambda e: e[0].pop('weight_x_32767'),
    lambda e: e[0].update(weight_x_32767=False), lambda e: e[1].update(created=999),
    lambda e: e[0].update(src={'table': 'votes', 'row': 1}),
    lambda e: e[3].update(is_meta=1), lambda e: e[3].update(mod=None),
    lambda e: e[0].update(extra='unknown'), lambda e: e[3].update(kind='other'),
])
def test_reject_corrupt_events(tmp_path, mutation):
    p = write_stream(tmp_path)
    events, _ = ei.read_events(p)
    mutation(events)
    write_stream(tmp_path, events)
    with pytest.raises(ValueError):
        ei.load_events(p)


@pytest.mark.parametrize('sign', [True, 0, '-1', -1.0, None])
def test_reject_undeclared_convention(tmp_path, sign):
    with pytest.raises(ValueError):
        ei.load_events(write_stream(tmp_path, sign=sign))


def test_compensated_polarity_preserves_nulls_weights(tmp_path):
    p = write_stream(tmp_path / 'a')
    events, _ = ei.read_events(p)
    flipped = copy.deepcopy(events)
    for e in flipped:
        if e['kind'] == 'vote' and e['vote'] is not None:
            e['vote'] *= -1
    q = write_stream(tmp_path / 'b', flipped, sign=1)
    assert ei.load_events(p).votes == ei.load_events(q).votes


def test_empty_stream_and_hashes(tmp_path):
    p = write_stream(tmp_path, [])
    assert ei.load_events(p).n == 0
    h = ei.input_hashes(p)
    p.with_name('events.meta.json').write_text('{}')
    assert ei.input_hashes(p)['events_meta_sha256'] != h['events_meta_sha256']
    with pytest.raises(ValueError):
        ei.load_events(p)


@pytest.mark.parametrize('corruption', ['digest', 'count', 'duplicate'])
def test_meta_and_json_binding(tmp_path, corruption):
    p = write_stream(tmp_path)
    meta_path = p.with_name('events.meta.json')
    meta = json.loads(meta_path.read_text())
    if corruption == 'digest':
        meta['logical_digest_sha256'] = '0' * 64
    elif corruption == 'count':
        meta['counts']['vote_events'] = 2
    else:
        p.write_text(p.read_text().replace('"ord": 0', '"ord": 0, "ord": 0'))
    meta_path.write_text(json.dumps(meta))
    with pytest.raises(ValueError):
        ei.load_events(p)


def test_exact_input_map_and_prefer_events(tmp_path, monkeypatch):
    p = write_stream(tmp_path / 'opaque')
    bindings = tmp_path / 'map.json'
    bindings.write_text(json.dumps({'fixture': str(p.parent)}))
    monkeypatch.setenv('POLIS_REPLAY_INPUT_MAP', str(bindings))
    assert real_data.load_export_votes('fixture').n == 3
    with pytest.raises(ValueError, match='every requested'):
        real_data.dataset_dir('unbound')
    # A malformed authoritative input must never fall back to compatibility CSV.
    p.write_text('{}\n')
    with pytest.raises(ValueError):
        real_data.load_export_votes('fixture')


def test_compatibility_loss_is_exact_and_detects_stale_csv(tmp_path):
    from polismath.replay.fixture_extract import compat_rows_from_events
    from polismath.replay.prodclone import write_votes_csv
    p = write_stream(tmp_path)
    events, _ = ei.read_events(p)
    rows, _, _ = compat_rows_from_events(events)
    csv_path = tmp_path / 'fixture-votes.csv'
    write_votes_csv(csv_path, rows)
    report = ei.compatibility_accounting(p, csv_path)
    assert report['csv_matches_declared_projection']
    assert (report['events'], report['csv_rows'], report['null_votes_dropped'],
            report['subsecond_rows'], report['non_null_weights_lost']) == (3, 2, 1, 3, 2)
    assert [r['csv_vote_slot'] for r in report['rows']] == [1, 2, None]
    assert [r['milliseconds_lost'] for r in report['rows']] == [1, 1, 999]
    csv_path.write_text(csv_path.read_text().replace(',1\n', ',-1\n'))
    # Explicitly truncate, independent of CSV newline conventions.
    write_votes_csv(csv_path, rows[:1])
    assert not ei.compatibility_accounting(p, csv_path)['csv_matches_declared_projection']


def test_event_metadata_is_bound_to_prepared_inventory(tmp_path, monkeypatch):
    from polismath.replay import certify
    p = write_stream(tmp_path)
    monkeypatch.setattr(real_data, 'dataset_dir', lambda _: tmp_path)
    e = certify.BatteryEntry('fixture', 'one', preset='single-cut')
    prepared = certify.prepare_entry(e)
    assert prepared.votes_csv == p
    assert prepared.events_meta_sha == ei.input_hashes(p)['events_meta_sha256']
    assert prepared.spec.source == 'events-jsonl'
    assert prepared.stream_end == 3
    assert prepared.checkpoints[-1]['cut_time_ms'] == 1999


def test_subprocesses_receive_exact_events_file(tmp_path, monkeypatch):
    from polismath.replay import certify
    import subprocess
    seen = []
    def invoke(cmd, **kwargs):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, '', '')
    monkeypatch.setattr(certify, '_run_subprocess', invoke)
    events = tmp_path / 'events.jsonl'
    certify.run_py_driver(tmp_path / 'schedule.json', out_root=tmp_path, events=events)
    certify.run_clj_driver(tmp_path / 'schedule.json', events, out_dir=tmp_path)
    for cmd in seen:
        assert cmd[cmd.index('--events') + 1] == str(events)
        assert '--votes' not in cmd


def test_restart_keeps_null_and_zero_weight(tmp_path, monkeypatch):
    from polismath.replay import driver
    ds = ei.load_events(write_stream(tmp_path))
    seen = []
    class Restored:
        def update_votes(self, payload, recompute):
            seen.append(payload)
            return self
        def mod_update(self, rows):
            return self
    monkeypatch.setattr(driver.Conversation, 'from_dict', lambda _: Restored())
    driver._restart_conversation(ds, cut_slot=3, cut_time_ms=1999, blob={}, mod_events=())
    assert [v['weight_x_32767'] for v in seen[0]['votes']] == [0, None, 123]
    assert [v['vote'] for v in seen[0]['votes']] == [1, -1, None]
