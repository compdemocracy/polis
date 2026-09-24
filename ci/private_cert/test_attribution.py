"""Closed attribution controls; all labels and geometry are generated public values."""
import copy
import json
import tempfile
import math
from pathlib import Path
import sys
import unittest
import numpy as np
sys.path[:0] = [str(Path(__file__).parent/'images'), str(Path(__file__).resolve().parents[2]/'delphi')]
import attribution
from polismath.replay.attribution_capture import folded_digest, start_kinds
import pandas as pd


def document(width=2):
    comps = [[.02]*width, [.03]*width]
    center = [1.]*width
    return dict(schema='polis-replay-attribution/1',checkpoint=0,pids=['p0','p1'],
                tids=[f'c{i:04d}' for i in range(width)],fold='a'*64,rating_fold='b'*64,
                starts=['nonzero-warm']*2,center=center,comps=comps,
                comments=(np.array(comps)*-2*math.sqrt(width)).tolist(),
                person=[[1.,2.],[3.,4.]],partitions=[['g0',['p0']],['g1',['p1']]])


class AttributionTests(unittest.TestCase):
    def test_equal_observations_and_coupled_sign(self):
        a=document();b=copy.deepcopy(a)
        for key in ('comps','comments'):b[key][0]=[-v for v in b[key][0]]
        for row in b['person']:row[0]*=-1
        r=attribution.measure(a,b,0)
        self.assertEqual(r['person_projection'],'pass')
        self.assertEqual(r['base_partition'],'same-ids')
        self.assertEqual(r['comment_center_swap'],'not-applicable')

    def test_base_ids_are_separate_from_real_person_coordinates(self):
        a=document();b=copy.deepcopy(a);b['partitions'][0][0]='other'
        r=attribution.measure(a,b,0)
        self.assertEqual(r['base_partition'],'different-ids')
        self.assertEqual(r['person_projection'],'pass')
        b['partitions']=[['g0',['p0','p1']]]
        self.assertEqual(attribution.measure(a,b,0)['base_partition'],'different')
        b['person'][0][0]+=.1
        self.assertEqual(attribution.measure(a,b,0)['person_projection'],'fail')

    def test_component_only_error_amplified_at_comment_projection(self):
        a=document(900);b=copy.deepcopy(a)
        b['comps'][0][0]+=2.833333333333e-6
        b['comments']=(np.array(b['comps'])*-2*30).tolist()
        self.assertTrue(attribution.matches(np.array(a['comps']),np.array(b['comps'])))
        r=attribution.measure(a,b,0)
        self.assertEqual(r['comment_center_swap'],'not-reproduced')
        self.assertEqual(r['comment_components_swap'],'reproduced')
        self.assertEqual(r['comment_joint_swap'],'reproduced')

    def test_center_only_and_joint_replacement(self):
        a=document();b=copy.deepcopy(a);b['center'][0]=2.
        b['comments']=((np.array(b['center'])+1)*-np.array(b['comps'])*math.sqrt(2)).tolist()
        r=attribution.measure(a,b,0)
        self.assertEqual(r['comment_center_swap'],'reproduced')
        self.assertEqual(r['comment_components_swap'],'not-reproduced')
        b['comps'][1][1]+=.1
        b['comments']=((np.array(b['center'])+1)*-np.array(b['comps'])*math.sqrt(2)).tolist()
        r=attribution.measure(a,b,0)
        self.assertEqual(r['comment_center_swap'],'not-reproduced')
        self.assertEqual(r['comment_components_swap'],'not-reproduced')
        self.assertEqual(r['comment_joint_swap'],'reproduced')

    def test_counterfactual_requires_reconstruction_of_both_kernels(self):
        a=document();b=copy.deepcopy(a);a['comments'][0][0]+=.1
        result=attribution.measure(a,b,0)
        self.assertEqual(result['comment_center_swap'],'unavailable')
        self.assertEqual(result['comment_components_swap'],'unavailable')
        self.assertEqual(result['comment_joint_swap'],'unavailable')

    def test_bad_shapes_never_report_a_projection_pass(self):
        for value in (None,[],[[float('nan')]],[[1,2,3]]):
            a=document();b=copy.deepcopy(a);b['comps']=value
            self.assertEqual(attribution.measure(a,b,0)['person_projection'],'unavailable')
        a=document();b=copy.deepcopy(a);b['pids']=['p0','p2'];b['partitions'][1][1]=['p2']
        self.assertEqual(attribution.measure(a,b,0)['person_projection'],'fail')

    def test_fold_is_aligned_and_null_differs_from_zero(self):
        a=pd.DataFrame([[1.,np.nan],[0.,-1.]],index=[4,2],columns=[9,3])
        self.assertEqual(folded_digest(a),folded_digest(a.loc[[2,4],[3,9]]))
        b=a.copy();b.loc[4,3]=0.
        self.assertNotEqual(folded_digest(a),folded_digest(b))
        b=a.copy();b.index=['4','2']
        self.assertNotEqual(folded_digest(a),folded_digest(b))

    def test_start_categories_include_missing_zero_and_padding(self):
        self.assertEqual(start_kinds(None,3,3),['missing-fallback']*2)
        self.assertEqual(start_kinds([[0.],None],3,3),['zero-fallback','missing-fallback'])
        self.assertEqual(start_kinds([[1.],[1.,2.,3.]],3,3),['padded-warm','nonzero-warm'])
        self.assertEqual(start_kinds([[1.],[1.]],1,3),['not-computed']*2)

    def test_inventory_and_internal_shape_refusals(self):
        a=document();a['checkpoint']=True
        with self.assertRaises(ValueError):attribution.measure(a,document(),0)
        a=document();a['partitions'].append(a['partitions'][0])
        with self.assertRaises(ValueError):attribution.measure(a,document(),0)
        a=document();a['pids']=['p1','p0']
        with self.assertRaises(ValueError):attribution.measure(a,document(),0)

    def test_person_identity_mismatch_fails_even_without_components(self):
        a=document();b=copy.deepcopy(a);b['pids']=['p0','p2']
        b['partitions'][1][1]=['p2'];b['comps']=None
        self.assertEqual(attribution.measure(a,b,0)['person_projection'],'fail')

    def test_bad_private_evidence_degrades_one_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for engine in ('clj','py'):
                (root/(engine+'-attribution')).mkdir()
                for i in range(2):
                    doc=document();doc['checkpoint']=i
                    (root/(engine+'-attribution')/f'step-{i:03d}.json').write_text(json.dumps(doc))
            target=root/'py-attribution/step-000.json'
            for value in (None, '{bad json', json.dumps(dict(document(),schema='invalid')),
                          json.dumps(dict(document(),partitions=[['g0',['orphan']]]))):
                if value is None: target.unlink(missing_ok=True)
                else: target.write_text(value)
                rows=attribution.measure_recording(root,2)
                self.assertEqual(rows[0],attribution.unavailable(0))
                self.assertEqual(rows[1]['person_projection'],'pass')
            (root/'py-attribution/step-099.json').write_text('{}')
            self.assertEqual(attribution.measure_recording(root,2),[attribution.unavailable(i) for i in range(2)])

    def test_disabled_and_short_capture_use_authoritative_checkpoint_count(self):
        for observations in ({},{'attribution':[attribution.unavailable(0)]}):
            entry={'pass':True,'strict':{'per_step':[{'match':True}]*3},**observations}
            projected=attribution.bounded([entry])[0]
            self.assertEqual(projected['attribution'],[attribution.unavailable(i) for i in range(3)])
            self.assertFalse(projected['attribution_truncated'])

    def test_global_budget_prioritizes_failure(self):
        row=attribution.measure(document(),document(),0)
        entries=[{'pass':i!=19,'strict':{'per_step':[{'match':True}]*8},
                  'attribution':[dict(row,checkpoint=c) for c in range(8)]} for i in range(20)]
        out=attribution.bounded(entries)
        self.assertEqual(len(out[-1]['attribution']),8)
        self.assertEqual(sum(len(x['attribution']) for x in out),64)
        self.assertTrue(out[18]['attribution_truncated'])


if __name__=='__main__':unittest.main()
