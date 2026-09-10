#!/usr/bin/env python3
"""Compare both ingress paths on every public battery entry.

The public source is CSV-only. Lifting it proves no change to its known content;
it cannot recover private/original subsecond timestamps, weights or NULL rows.
Python's recording-only math_tick clock and Clojure rand are fixed in both runs.
Provenance/schedule files intentionally differ and are not numerical recordings.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from polismath.replay import certify, event_ingress, fixture_extract, real_data


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def lift(slug, target):
    """Lift only known CSV facts; NULL weight means unavailable, not recovered."""
    csv = certify.votes_csv_path(slug)
    rows = sorted(real_data.read_export_vote_rows(csv), key=lambda v: v[0])
    events = fixture_extract.build_events([
        dict(created=t, pid=p, tid=c, vote=-v, weight_x_32767=None) for t, p, c, v in rows
    ], [])
    target.mkdir(parents=True, exist_ok=True)
    fixture_extract.write_events_jsonl(target / 'events.jsonl', events)
    meta = {'schema_version': 'certify-events/2', 'polarity': {'storage_agree_value': -1},
            'counts': {'events': len(events), 'vote_events': len(events), 'comment_events': 0},
            'logical_digest_sha256': fixture_extract.logical_digest(events),
            'derivation': {'source': 'public-csv-lift', 'csv_sha256': sha(csv),
                           'unavailable': ['original milliseconds', 'original weights', 'dropped NULL votes']}}
    (target / 'events.meta.json').write_text(json.dumps(meta, sort_keys=True) + '\n')
    ds = event_ingress.load_events(target / 'events.jsonl')
    old = real_data.load_export_votes(slug)
    assert [(v.t_ms, v.pid, v.tid, v.sign, v.is_revote) for v in old.votes] == [
        (v.t_ms, v.pid, v.tid, v.sign, v.is_revote) for v in ds.votes]
    return csv, target / 'events.jsonl'


def run_proof(out):
    delphi = Path(__file__).resolve().parents[1]
    config = json.loads((delphi / 'scripts/certify_datasets.json').read_text())
    # Use the battery's established public classification, not slug substrings.
    public = {entry["slug"] for entry in config["public_fixtures"]}
    entries = [e for e in certify.load_battery() if e.dataset in public]
    sources = {slug: lift(slug, out / 'inputs' / slug) for slug in sorted({e.dataset for e in entries})}
    env = dict(os.environ, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1',
               PYTHONPATH=str(delphi), PYTHONHASHSEED='0')
    env.pop('POLIS_REPLAY_INPUT_MAP', None)
    wrapper = out / 'fixed-clj.clj'
    wrapper.write_text("(load-file \"dev/replay.clj\")\n"
                       "(let [rng (java.util.Random. 671)]\n"
                       "  (with-redefs [clojure.core/rand (fn ([] (.nextDouble rng)) ([n] (* n (.nextDouble rng))))]\n"
                       "    (apply replay/-main *command-line-args*)))\n")
    tasks = []
    for entry in entries:
        expected = certify.prepare_entry(entry)
        spec = out / 'schedules' / entry.dataset / (entry.schedule_id + '.json')
        spec.parent.mkdir(parents=True, exist_ok=True)
        expected.spec.write_json(spec)
        for mode in ('csv', 'events'):
            root = out / mode
            rec = root / entry.dataset / entry.schedule_id
            source = sources[entry.dataset][mode == 'events']
            clj = ['clojure', '-M', str(wrapper), '--schedule', str(spec), '--out', str(rec),
                   '--events' if mode == 'events' else '--votes', str(source)]
            py = [sys.executable, '-c',
                  "import runpy,time; time.time=lambda:1700000000.0; runpy.run_path('scripts/replay_driver.py',run_name='__main__')",
                  'run', '--schedule', str(spec), '--out', str(root)]
            if mode == 'events':
                py += ['--events', str(source)]
            for engine, cmd, cwd in [('clj', clj, delphi.parent / 'math'), ('py', py, delphi)]:
                log = out / 'logs' / f'{entry.dataset}-{entry.schedule_id}-{mode}-{engine}.log'
                tasks.append((cmd, cwd, log, env))
    def execute(task):
        cmd, cwd, log, env = task
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open('w') as fh:
            p = subprocess.run(cmd, cwd=cwd, env=env, stdout=fh, stderr=subprocess.STDOUT, timeout=3600)
        print(f'{log.stem}: exit {p.returncode}', flush=True)
        if p.returncode:
            raise RuntimeError(f'driver failed; see {log}')
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(execute, tasks))
    results = []
    for e in entries:
        for engine in ('py', 'clj'):
            a = out / 'csv' / e.dataset / e.schedule_id / engine
            b = out / 'events' / e.dataset / e.schedule_id / engine
            files_a = {p.name: sha(p) for p in a.glob('step-*.json')}
            files_b = {p.name: sha(p) for p in b.glob('step-*.json')}
            different = sorted(k for k in files_a.keys() | files_b.keys() if files_a.get(k) != files_b.get(k))
            results.append(dict(dataset=e.dataset, schedule_id=e.schedule_id, engine=engine,
                                files=len(files_a), byte_identical=not different, different=different,
                                csv_sha256=files_a, events_sha256=files_b))
    report = dict(schema='polis-event-ingress-proof/1',
                  scope='CSV-only public lift; fixed Python wall clock and Clojure rand seed 671; raw step files compared',
                  entries=len(entries), engine_runs=len(tasks), results=results,
                  passed=all(r['byte_identical'] for r in results))
    (out / 'proof.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    raise SystemExit(0 if run_proof(args.out.resolve()) else 1)
