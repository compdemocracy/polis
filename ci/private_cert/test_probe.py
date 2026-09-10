"""Snapshot-relative schedules retain the admitted full-stream recipe."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent/'images'))
import probe
from polismath.replay.schedule import ScheduleSpec


class ProbeTests(unittest.TestCase):
    def test_explicit_schedule_scales_to_snapshot_preserving_semantics(self):
        raw=dict(dataset='public-fixture',schedule_id='two',cuts={'mode':'vote-count','at':[25,100]},
                 coverage='full-stream',restart_after=0,moderation='interleave-by-timestamp',clojure={'warm_start':'chain'})
        with patch.object(probe.gate.certify,'build_effective_spec',return_value=ScheduleSpec.from_dict(raw)):
            actual=probe.resolve_private_spec(SimpleNamespace(schedule_path=True),SimpleNamespace(votes=[None]*40)).to_dict()
        self.assertEqual(actual,{**raw,'cuts':{'mode':'vote-count','at':[10,40]}})

    def test_empty_and_presets_not_reinterpreted(self):
        for path,slots in [(True,[0]),(False,[10,20])]:
            raw=dict(dataset='public-fixture',schedule_id='empty',cuts={'mode':'vote-count','at':slots,'empty_checkpoint':True})
            with patch.object(probe.gate.certify,'build_effective_spec',return_value=ScheduleSpec.from_dict(raw)):
                self.assertEqual(probe.resolve_private_spec(SimpleNamespace(schedule_path=path),SimpleNamespace(votes=[])).to_dict(),raw)

