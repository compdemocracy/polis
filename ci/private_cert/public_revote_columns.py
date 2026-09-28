#!/usr/bin/env python3
"""Replay public cross-cut revotes with late first votes on older comments.

The checked-in vote/golden fixture was generated independently of production
and recorded with the real Clojure driver. Re-record both engines and compare
with the real strict/G12 verifier; no policy or tolerance overrides.
"""
import argparse
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'ci/private_cert/images'), str(ROOT / 'delphi')]
import gate
from polismath.replay import fixture_generate as fg, fixture_extract as fx


def record_case(case, dest):
    stream = dest / 'stream'
    stream.mkdir(parents=True)
    n = max(row[0] for row in case['votes']) + 1
    d = max(row[1] for row in case['votes']) + 1
    _, comments, participants = fg.build_case_rows(
        dict(shape='sparse-strip', participants=n, comments=d, votes_per_participant=1), random.Random(1))
    votes = [dict(pid=p, tid=t, vote=v, created=ms, weight_x_32767=0)
             for p, t, v, ms in case['votes']]
    events = fx.build_events(votes, comments)
    fx.write_events_jsonl(stream / 'events.jsonl', events)
    gate.dump(stream / 'events.meta.json', fx.stream_meta(
        slug='public-fixture', role='public-fixture', tie_key=fg.GENERATED_TIE_KEY,
        events=events, n_participants=n))
    fx.write_participants_csv(stream / 'participants.csv', participants)
    gate.dump(dest / 'input-map.json', {'pc-revote-02': str(stream)})
    os.environ['POLIS_REPLAY_INPUT_MAP'] = str(dest / 'input-map.json')
    spec = gate.schedule.ScheduleSpec.from_dict(dict(dataset='pc-revote-02',
        schedule_id='uniform6-clojure-legacy', source='events-jsonl',
        cuts=dict(mode='vote-count', at=case['cuts']), moderation='none',
        clojure=dict(warm_start='chain')))
    spec.write_json(dest / 'schedule.json')
    expected = gate.certify.prepare_entry(gate.certify.BatteryEntry(
        spec.dataset, spec.schedule_id, schedule_path=dest / 'schedule.json', role='revote-heavy'))
    expected.spec.write_json(dest / 'schedule.json')
    rec = gate.store.recording_dir(spec.dataset, spec.schedule_id, root=dest / 'recordings')
    rec.mkdir(parents=True)
    commands = [
        ('clj', ['clojure', '-M:replay', '--schedule', str(dest / 'schedule.json'),
                 '--events', str(stream / 'events.jsonl'), '--out', str(rec), '--attribution-json'], ROOT / 'math'),
        ('py', [sys.executable, '-B', 'scripts/replay_driver.py', 'run', '--schedule', str(dest / 'schedule.json'),
                '--events', str(stream / 'events.jsonl'), '--out', str(dest / 'recordings'), '--attribution-json'], ROOT / 'delphi')]
    runs = []
    for engine, argv, cwd in commands:
        with (dest / (engine + '.log')).open('wb') as log:
            result = subprocess.run(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=600)
        runs.append(dict(engine=engine, argv=argv, cwd=str(cwd), exit=result.returncode))
        (dest / 'commands.json').write_bytes(gate.encoded(runs))
        assert result.returncode == 0, engine
    with tempfile.TemporaryDirectory() as temporary:
        report = gate.verify_pairs([expected], dest / 'recordings', Path(temporary), attribution=True)
    gate.dump(dest / 'report.json', report)
    assert report['checks'] == 6
    controls = report['negative_controls']
    assert controls['g12'] == dict(expected=17, rejected=17)
    assert set(controls['checkpoint'].values()) == {'REJECTED'}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--expect', choices=('PASS', 'FAIL'), default='PASS')
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir()
    os.environ['PYTHONPATH'] = str(ROOT / 'delphi')
    for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
        os.environ[key] = '1'
    fixture = json.loads((ROOT / 'delphi/tests/replay_harness/fixtures/revote_column_order.json').read_text())
    results = []
    for case in fixture['cases']:
        report = record_case(case, out / str(case['seed']))
        results.append(dict(seed=case['seed'], verdict=report['verdict'], checks=report['checks']))
        assert report['verdict'] == args.expect, results[-1]
    gate.dump(out / 'summary.json', results)
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
