"""Opt-in private observations do not change the replay's math outputs."""
import json
import logging
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from polismath.replay.driver import run_replay
from polismath.replay.types import ReplayDataset
from polismath.replay.schedule import ScheduleSpec


class ObserverTests(unittest.TestCase):
    def test_chain_and_restart_observer_preserve_every_blob_field(self):
        data=ReplayDataset.build([(1000+i,p,t,((p*3+t*7)%3)-1)
                                  for i,(p,t) in enumerate((p,t) for p in range(12) for t in range(8))])
        for restart in (None,0):
            with self.subTest(restart=restart), tempfile.TemporaryDirectory() as tmp:
                spec=ScheduleSpec.from_dict(dict(dataset='public-fixture',schedule_id='observer',
                    cuts={'mode':'vote-count','at':[32,64,96]},restart_after=restart,moderation='none'))
                with patch('time.time',return_value=1700000000.):
                    a=run_replay(data,spec)
                    b=run_replay(data,spec,attribution_dir=Path(tmp))
                self.assertEqual(a,b)
                docs=[json.loads(p.read_text()) for p in sorted(Path(tmp).glob('step-*.json'))]
                self.assertEqual([d['checkpoint'] for d in docs],[0,1,2])
                self.assertEqual(docs[0]['starts'],['padded-warm']*2)
                self.assertNotIn('matrix',docs[0])
                self.assertEqual(len(docs[0]['fold']),64)

    def test_sink_and_bad_cell_failures_preserve_every_blob(self):
        import pandas as pd
        from polismath.replay.attribution_capture import folded_digest
        data=ReplayDataset.build([(1000+i,p,t,((p*3+t*7)%3)-1)
                                  for i,(p,t) in enumerate((p,t) for p in range(12) for t in range(8))])
        spec=ScheduleSpec.from_dict(dict(dataset='public-fixture',schedule_id='observer-fault',
            cuts={'mode':'vote-count','at':[32,64,96]},moderation='none'))
        def bad_cell(*args):
            folded_digest(pd.DataFrame([[2.]],index=[0],columns=[0]))
        for failure in (RuntimeError('private sink failure'),bad_cell):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as tmp:
                with patch('time.time',return_value=1700000000.):
                    expected=run_replay(data,spec)
                    with patch('polismath.replay.attribution_capture.capture',side_effect=failure) as sink:
                        actual=run_replay(data,spec,attribution_dir=Path(tmp))
                self.assertEqual(actual,expected)
                self.assertEqual(sink.call_count,3)
                self.assertEqual(list(Path(tmp).glob('step-*.json')),[])

    def test_empty_observer_remains_available(self):
        data=ReplayDataset(votes=[],comments={})
        spec=ScheduleSpec.from_dict(dict(dataset='public-fixture',schedule_id='observer-empty',
            cuts={'mode':'vote-count','at':[0],'empty_checkpoint':True},moderation='none'))
        with tempfile.TemporaryDirectory() as tmp:
            run_replay(data,spec,attribution_dir=Path(tmp))
            doc=json.loads((Path(tmp)/'step-000.json').read_text())
            self.assertEqual(doc['starts'],['not-computed']*2)
            self.assertEqual(doc['person'],[])
            self.assertEqual(doc['partitions'],[])


if __name__=='__main__':
    logging.disable(logging.CRITICAL)
    unittest.main()
