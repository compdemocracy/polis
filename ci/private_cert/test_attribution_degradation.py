"""Observer faults cannot prevent a valid closed receipt or alter its verdict."""
from contextlib import nullcontext
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).parent/'images'))
import probe
import attribution
from contracts import validate_job
from receipt import canonical
from polismath.replay.driver import run_replay
from polismath.replay.schedule import ScheduleSpec
from polismath.replay.types import ReplayDataset
from polismath.replay.attribution_capture import folded_digest
import pandas as pd


class DegradationTests(unittest.TestCase):
    def test_faults_produce_valid_receipts_with_unchanged_verdict(self):
        import worker, run
        gate=probe.gate
        job=validate_job(dict(schema='polis-probe-job/1',run_id='a'*32,max_seconds=3600,
            producer={'image':'localhost/producer@sha256:'+'1'*64,'args':['produce']},
            verifier={'image':'localhost/verifier@sha256:'+'2'*64,'args':['verify']}))
        inputs={'policySha256':gate.sha(gate.POLICY)}
        for fault in ('sink','bad-cell','orphan','measurement','disabled'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);recordings=root/'recordings'
                spec=ScheduleSpec.from_json_file(gate.REPO/'delphi/scripts/schedules/pc-zerovote-01-empty.json')
                spec=ScheduleSpec.from_dict({**spec.to_dict(),'schedule_id':spec.schedule_id+'-clojure-legacy'})
                checkpoint={'index':0,'prev_slot':0,'cut_slot':0,'batch_size':0,'cut_time_ms':0}
                expected=gate.certify.ExpectedEntry(
                    gate.certify.BatteryEntry(spec.dataset,spec.schedule_id,role='zero-vote'),spec,
                    root/'public-events.jsonl','a'*64,None,None,0,[checkpoint])
                rec=gate.store.recording_dir(spec.dataset,spec.schedule_id,root=recordings)
                blob={'pca':{'comps':[[1.0],[1.0]]},'mod-in':[],'mod-out':[]}
                for key,value in spec.empty_output.items():
                    if key.startswith('pca.'):blob['pca'][key.split('.')[1]]=value
                    else:blob[key]=value
                gate.dump(rec/'schedule.json',spec.to_dict())
                gate.dump(rec/'clj/step-000.meta.json',checkpoint)
                gate.dump(rec/'clj/step-000.blob.json',dict(blob,lastVoteTimestamp=0))
                gate.dump(rec/'py/step-000.json',dict(checkpoint,blob=blob))
                doc=dict(schema='polis-replay-attribution/1',checkpoint=0,pids=[],tids=[],
                    fold='a'*64,rating_fold='a'*64,starts=['not-computed']*2,
                    center=None,comps=None,comments=None,person=[],partitions=[])
                gate.dump(rec/'clj-attribution/step-000.json',doc)
                if fault in ('sink','bad-cell'):
                    def bad_cell(*args):folded_digest(pd.DataFrame([[2.]]))
                    failure=RuntimeError('private sink') if fault=='sink' else bad_cell
                    with patch('polismath.replay.attribution_capture.capture',side_effect=failure) as sink:
                        records=run_replay(ReplayDataset(votes=[],comments={}),spec,
                                           attribution_dir=rec/'py-attribution')
                    self.assertEqual(len(records),1);self.assertEqual(sink.call_count,1)
                else:
                    if fault=='orphan':doc=dict(doc,partitions=[['g0',['orphan']]])
                    gate.dump(rec/'py-attribution/step-000.json',doc)
                def verify_recordings(evidence,admitted,scratch,fixture):
                    return gate.verify_pairs([expected],recordings,scratch,attribution=fault!='disabled')
                read,dump,tree=gate.read,gate.dump,gate.regular_tree
                def read_input(path):
                    admitted={'/job/job.json':job,'/run-spec/inputs.json':inputs,
                              '/fixture/manifest.json':{},'/fixture/plan.json':{'scope':'public'}}
                    return admitted[str(path)] if str(path) in admitted else read(path)
                observer=(patch.object(attribution,'measure_recording',side_effect=RuntimeError('private measure'))
                          if fault=='measurement' else nullcontext())
                with observer,patch.object(gate,'read',side_effect=read_input), \
                     patch.object(gate,'verify_recordings',side_effect=verify_recordings), \
                     patch.object(gate,'regular_tree',side_effect=lambda _:tree(recordings)), \
                     patch.object(gate,'dump',side_effect=lambda path,value:dump(root/path.name,value)):
                    probe.verify()
                data=(root/'receipt.json').read_bytes()
                for decoder in (worker.decode_receipt,run.decode_receipt):
                    result=decoder(data,job)
                    self.assertEqual(result['verdict'],'PASS')
                    self.assertEqual(result['entries'][0]['attribution'],[attribution.unavailable(0)])
                    self.assertFalse(result['entries'][0]['attribution_truncated'])
                    self.assertNotIn(b'private',canonical(result))
