#!/usr/bin/env python3
"""Run the public zero7 restart witness and a nonrestart projection control.

Run with the existing Delphi interpreter, from any directory:
  python -B ci/private_cert/public_legacy_restart.py --out <fresh-directory>
Requires the existing local Clojure replay runtime. No installation or images.
All inputs are generated public votes; outputs stay in the supplied directory.
"""
import argparse
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'ci/private_cert/images'), str(ROOT/'ci/probe_box'), str(ROOT/'delphi')]
import numpy as np
import gate
import probe
from polismath.replay import fixture_generate as fg, fixture_extract as fx, fixture_samples


def record(dest, *, zero_prefix):
    dest.mkdir(parents=True)
    matrix = np.random.default_rng(7).choice([-1., 0., 1.], (72, 30))
    if zero_prefix:
        matrix[:36, :] = 0.
    stream = dest/'stream'; stream.mkdir()
    _, comments, participants = fg.build_case_rows(
        dict(shape='sparse-strip', participants=72, comments=30, votes_per_participant=30), random.Random(1))
    votes = [dict(pid=p, tid=t, vote=int(matrix[p, t]), weight_x_32767=0,
                  created=fg.BASE_MS+10000+p*30+t) for p in range(72) for t in range(30)]
    events = fx.build_events(votes, comments)
    fx.write_events_jsonl(stream/'events.jsonl', events)
    if zero_prefix:
        # Exact original zero7 public stream, independent of NumPy's RNG API.
        assert gate.file_digest(stream/'events.jsonl') == 'cbd079234cb95a8addfd624f782ea6b580e9c22d948909f4500054fbf0c4e45f'
    gate.dump(stream/'events.meta.json', fx.stream_meta(slug='public-fixture', role='public-fixture',
        tie_key=fg.GENERATED_TIE_KEY, events=events, n_participants=72))
    fx.write_participants_csv(stream/'participants.csv', participants)
    alias = fixture_samples.slug(1)
    gate.dump(dest/'input-map.json', {alias: str(stream)})
    os.environ['POLIS_REPLAY_INPUT_MAP'] = str(dest/'input-map.json')
    spec = fixture_samples.resolved_spec(alias, gate.real_data.load_export_votes(alias))
    spec = gate.schedule.ScheduleSpec.from_dict({**spec.to_dict(), 'source': 'events-jsonl'})
    spec.write_json(dest/'schedule.json')
    expected = gate.certify.prepare_entry(gate.certify.BatteryEntry(alias, spec.schedule_id,
        schedule_path=dest/'schedule.json', role=alias))
    expected.spec.write_json(dest/'schedule.json')
    rec = gate.store.recording_dir(alias, spec.schedule_id, root=dest/'recordings')
    rec.mkdir(parents=True)
    commands = [
        ('clj', ['clojure', '-M:replay', '--schedule', str(dest/'schedule.json'),
                 '--events', str(stream/'events.jsonl'), '--out', str(rec), '--attribution-json'], ROOT/'math'),
        ('py', [sys.executable, '-B', 'scripts/replay_driver.py', 'run', '--schedule', str(dest/'schedule.json'),
                '--events', str(stream/'events.jsonl'), '--out', str(dest/'recordings'), '--attribution-json'], ROOT/'delphi'),
    ]
    runs = []
    for engine, argv, cwd in commands:
        with (dest/(engine+'.log')).open('wb') as log:
            result = subprocess.run(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=600)
        runs.append(dict(engine=engine, argv=argv, cwd=str(cwd), exit=result.returncode))
        (dest/'commands.json').write_bytes(gate.encoded(runs))
        assert result.returncode == 0, (engine, result.returncode)
    return expected, rec


def verify(dest, expected, name, *, attribution=True):
    with tempfile.TemporaryDirectory() as tmp:
        result = gate.verify_pairs([expected], dest/'recordings', Path(tmp), attribution=attribution)
    gate.dump(dest/(name+'.json'), result)
    controls = result['negative_controls']
    assert controls['g12'] == {'rejected': 17, 'expected': 17}
    assert set(controls['checkpoint'].values()) == {'REJECTED'}
    return result


def export_receipt(dest, report, name):
    """Exercise the actual exporter and both decoders with public job digests."""
    import worker, run
    from contracts import validate_job
    job = validate_job(dict(schema='polis-probe-job/1', run_id='a'*32, max_seconds=3600,
        producer={'image':'localhost/producer@sha256:'+'1'*64,'args':['produce']},
        verifier={'image':'localhost/verifier@sha256:'+'2'*64,'args':['verify']}))
    read, dump, tree = gate.read, gate.dump, gate.regular_tree
    def read_input(path):
        values = {'/job/job.json':job, '/run-spec/inputs.json':{'policySha256':gate.sha(gate.POLICY)},
                  '/fixture/manifest.json':{}, '/fixture/plan.json':{'scope':'public'}}
        return values[str(path)] if str(path) in values else read(path)
    target = dest/(name+'-receipt.json')
    with patch.object(gate,'read',side_effect=read_input), \
         patch.object(gate,'verify_recordings',return_value=report), \
         patch.object(gate,'regular_tree',side_effect=lambda _:tree(dest/'recordings')), \
         patch.object(gate,'dump',side_effect=lambda path,value:dump(target,value)):
        probe.verify()
    data = target.read_bytes()
    decoded = worker.decode_receipt(data,job)
    assert decoded == run.decode_receipt(data,job)
    assert decoded['verdict'] == report['verdict']
    return decoded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir()
    os.environ['PYTHONPATH'] = str(ROOT/'delphi')
    for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
        os.environ[key] = '1'
    dest = out/'zero7'
    expected, rec = record(dest, zero_prefix=True)
    before = gate.regular_tree(dest/'recordings')
    raw = verify(dest, expected, 'unclassified', attribution=False)
    accepted = verify(dest, expected, 'classified')
    assert raw['verdict'] == 'FAIL'
    assert not raw['entries'][0]['g12']['authoritative_g12']
    assert any(not step['match'] for step in raw['entries'][0]['strict']['per_step'])
    assert accepted['verdict'] == 'PASS'
    entry = accepted['entries'][0]
    assert gate.legacy_pca.restart_checkpoint(entry['attribution']) == 1
    receipt = export_receipt(dest, accepted, 'classified')
    assert receipt['entries'][0]['legacy_defects'] == [{'name':gate.legacy_pca.NAME}]
    assert before == gate.regular_tree(dest/'recordings')

    dest = out/'nonrestart'
    expected, rec = record(dest, zero_prefix=False)
    clean = verify(dest, expected, 'clean')
    assert gate.legacy_pca.restart_checkpoint(clean['entries'][0]['attribution']) is None
    assert clean['verdict'] == 'PASS'
    # Inject only a projection error into a real nonrestart stream.
    path = rec/'py/step-003.json'
    original = path.read_bytes()
    doc = json.loads(original)
    doc['blob']['pca']['comment-projection'][0][0] += 10.0
    path.write_bytes(gate.encoded(doc))
    try:
        negative = verify(dest, expected, 'projection-negative')
        assert negative['verdict'] == 'FAIL'
        assert not negative['entries'][0]['g12']['authoritative_g12']
        assert not negative['entries'][0]['strict']['per_step'][3]['match']
        assert 'legacy_defects' not in negative['entries'][0]
        export_receipt(dest, negative, 'projection-negative')
    finally:
        path.write_bytes(original)
    summary = dict(zero7_before=raw['verdict'], zero7_after=accepted['verdict'],
                   nonrestart_clean=clean['verdict'], projection_negative=negative['verdict'],
                   engine_exits=4, checks_per_verification=6, controls_per_verification=21,
                   decoders=2, policy=gate.sha(gate.POLICY))
    gate.dump(out/'summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
