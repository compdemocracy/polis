"""Public one-cut regression: moderation after the final vote reaches both drivers."""
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys

import pytest

from polismath.replay import fixture_extract as fx, fixture_generate as fg
from polismath.replay import schedule

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.skipif(os.environ.get('RUN_CLJ_INTEGRATION') != '1' or not shutil.which('clojure'),
                    reason='requires Clojure and RUN_CLJ_INTEGRATION=1')
@pytest.mark.parametrize('coverage', ['full-stream', 'prefix-diagnostic'])
def test_one_cut_public_moderation_tail(tmp_path, monkeypatch, coverage):
    sys.path.insert(0, str(ROOT / 'ci/private_cert/images'))
    import gate
    stream = tmp_path / 'stream';stream.mkdir()
    votes, comments, participants = fg.build_case_rows(
        dict(shape='sparse-strip', participants=24, comments=30, votes_per_participant=20),
        random.Random(20260923))
    for c in comments:
        c['mod'] = -1 if c['tid'] == 0 else 0
        c['modified'] = fg.BASE_MS + (20000 if c['tid'] == 0 else 10100)
    events = fx.build_events(votes, comments)
    fx.write_events_jsonl(stream / 'events.jsonl', events)
    (stream / 'events.meta.json').write_text(json.dumps(fx.stream_meta(
        slug='public-fixture', role='public-fixture', tie_key=fg.GENERATED_TIE_KEY,
        events=events, n_participants=len(participants))))
    fx.write_participants_csv(stream / 'participants.csv', participants)
    alias, schedule_id = 'pc-modheavy-01', 'single-cut-mod-clojure-legacy'
    input_map = tmp_path / 'input-map.json'
    input_map.write_text(json.dumps({alias:str(stream)}))
    monkeypatch.setenv('POLIS_REPLAY_INPUT_MAP',str(input_map))
    spec = schedule.ScheduleSpec.from_dict(dict(dataset=alias,schedule_id=schedule_id,
        source='events-jsonl',cuts=dict(mode='vote-count',at=[480]),
        moderation='interleave-by-timestamp',coverage=coverage,clojure=dict(warm_start='chain')))
    spec_path=tmp_path/'schedule.json';spec.write_json(spec_path)
    rec=gate.store.recording_dir(alias,schedule_id,root=tmp_path/'recordings');rec.mkdir(parents=True)
    commands=[('clj',['clojure','-M:replay','--schedule',str(spec_path),'--events',str(stream/'events.jsonl'),
                     '--out',str(rec)],ROOT/'math'),
              ('py',[sys.executable,'-B','scripts/replay_driver.py','run','--schedule',str(spec_path),
                     '--events',str(stream/'events.jsonl'),'--out',str(tmp_path/'recordings')],ROOT/'delphi')]
    for engine,cmd,cwd in commands:
        with (tmp_path/(engine+'.log')).open('w') as log:
            result=subprocess.run(cmd,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,timeout=180)
        assert result.returncode==0,(tmp_path/(engine+'.log')).read_text()
    clj=json.loads((rec/'clj/step-000.blob.json').read_text())
    py=json.loads((rec/'py/step-000.json').read_text())['blob']
    expected_mods=[0] if coverage=='full-stream' else []
    expected_timestamp=fg.BASE_MS+(20000 if coverage=='full-stream' else 10100)
    for blob in (clj,py):
        assert blob['mod-out']==expected_mods
        assert blob['lastModTimestamp']==expected_timestamp
        assert blob['lastVoteTimestamp']==fg.BASE_MS+10479
    strict=gate.certify._acceptance_projecting_comparer().compare_step(clj,py,0)
    assert strict['match'],strict
    metric=gate.g12.measure_main_blob(rec,ROOT/'delphi')
    assert metric['authoritative_g12'],metric
    if coverage=='full-stream':
        entry=gate.certify.BatteryEntry(alias,schedule_id,schedule_path=spec_path,role='moderation-heavy')
        report=gate.verify_pairs([gate.certify.prepare_entry(entry)],tmp_path/'recordings',tmp_path)
        assert report['verdict']=='PASS'
        assert report['checks']==1
        assert report['negative_controls']['g12']['rejected']==17
        assert len(report['negative_controls']['checkpoint'])==4
