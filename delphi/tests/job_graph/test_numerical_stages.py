"""Fast adapter boundary checks; full numeric execution belongs to mm5 proof."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0,str(SCRIPTS))
import delphi_graph_stages as stages
import job_graph_stage
from delphi_narrative_snapshot import unfold_group_assignments


class NumericalBoundary(unittest.TestCase):
    def test_folded_groups_expand_base_ids_to_actual_participants(self):
        math = {'base-clusters': {'id': [7, 42], 'members': [[90, 0], [351]]},
                'group-clusters': [{'id': 8, 'members': [42]}, {'id': 3, 'members': [7]}],
                'group_clusters': [{'id': 8, 'members': [351]}, {'id': 3, 'members': [90, 0]}]}
        original = json.dumps(math)
        self.assertEqual(unfold_group_assignments(math), {'351': 8, '90': 3, '0': 3})
        self.assertEqual(json.dumps(math), original)
        self.assertNotIn('42', unfold_group_assignments(math))

    def test_malformed_folded_groups_refuse_instead_of_using_ids_as_participants(self):
        valid = {'base-clusters': {'id': [7, 42], 'members': [[90, 0], [351]]},
                 'group-clusters': [{'id': 8, 'members': [42]}, {'id': 3, 'members': [7]}],
                 'group_clusters': [{'id': 8, 'members': [351]}, {'id': 3, 'members': [90, 0]}]}
        mutations = [
            lambda m: m.pop('base-clusters'),
            lambda m: m['base-clusters']['id'].__setitem__(1, 7),
            lambda m: m['base-clusters']['members'][1].append(90),
            lambda m: m['group-clusters'][0]['members'].__setitem__(0, 999),
            lambda m: m['group-clusters'][1]['members'].append(42),
            lambda m: m['group-clusters'][1].__setitem__('id', 8),
            lambda m: m['group_clusters'][0]['members'].__setitem__(0, 42),
            lambda m: m['group_clusters'][0]['members'].__setitem__(0, True),
            lambda m: m['base-clusters']['id'].__setitem__(0, 7.0),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                math = json.loads(json.dumps(valid)); mutate(math)
                with self.assertRaises(ValueError):
                    unfold_group_assignments(math)

    def frame(self):
        topics = {'topics':[dict(cluster_id=0,layer_id=0,topic_label='Trees',size=5)]}
        payload = json.dumps(topics)
        declared = dict(model=stages.MODELS['graph_narrative'],mode='full',
            code=hashlib.sha256((SCRIPTS/'job_graph_stage.py').read_bytes()).hexdigest(),
            runtime='python-'+sys.version.split()[0],seed=42,
            snapshot=dict(data=dict(texts=['constructed text']*5)),
            config=dict(comment_ids=list(range(5)),report_id='constructed-report',adapter_sha256=stages.code_digest()))
        inp = dict(schema='polis-job-input/1',declared=declared,
            artifacts=dict(topics=dict(payload=payload,sha256=hashlib.sha256(payload.encode()).hexdigest())))
        frame = dict(schema='polis-job-stage-frame/1',stage='graph_narrative',zid=9001,
            job_id='00000000-0000-4000-8000-000000009001',run_id='run',attempt_id='attempt',input=inp)
        return self.digest(frame)

    def digest(self, frame):
        wire=json.dumps(frame['input'])
        frame.update(input_json=wire,input_sha256=hashlib.sha256(wire.encode()).hexdigest())
        return frame

    def test_fixture_is_visible_and_codec_roundtrips(self):
        result=job_graph_stage.run(self.frame())
        output=json.loads(result['output']['payload'])
        self.assertTrue(output['provider_fixture'])
        rows=stages.read_family(output,'Delphi_NarrativeReports')
        self.assertTrue(json.loads(rows[0]['report_data'])['provider_fixture'])
        self.assertEqual(rows[0]['model'],'local-narrative-fixture/1')
        self.assertEqual(result['output']['sha256'],hashlib.sha256(result['output']['payload'].encode()).hexdigest())

    def test_signed_wire_is_authoritative_over_reserialized_duplicate(self):
        frame=self.frame()
        frame['input']['declared']['config']['summary_metric']=0.12345678901234568
        self.digest(frame)
        # Model serde_json's redundant f64 reserialization without changing wire.
        frame['input']=json.loads(frame['input_json'])
        frame['input']['declared']['config']['summary_metric']=0.12345678901234567
        output=json.loads(job_graph_stage.run(frame)['output']['payload'])
        self.assertTrue(output['provider_fixture'])

    def test_changed_signed_wire_refused(self):
        frame=self.frame(); frame['input_json'] += ' '
        with self.assertRaisesRegex(ValueError,'resolved input digest'):
            job_graph_stage.run(frame)

    def test_upstream_digest_refused(self):
        frame=self.frame(); frame['input']['artifacts']['topics']['payload']='{}'
        with self.assertRaisesRegex(ValueError,'upstream artifact digest'):
            job_graph_stage.run(self.digest(frame))

    def test_code_change_refused(self):
        frame=self.frame(); frame['input']['declared']['config']['adapter_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'provenance'):
            job_graph_stage.run(self.digest(frame))

    def test_duplicate_comment_ids_refused(self):
        frame=self.frame(); frame['input']['declared']['config']['comment_ids']=[0]*5
        with self.assertRaisesRegex(ValueError,'comment ids'):
            job_graph_stage.run(self.digest(frame))

    def test_too_many_texts_refused_without_truncation(self):
        frame=self.frame(); frame['input']['declared']['snapshot']['data']['texts']=['text']*2001
        with self.assertRaisesRegex(ValueError,'bounded texts'):
            job_graph_stage.run(self.digest(frame))

    def test_real_summary_selects_topic_and_all_eligible_global_sections(self):
        # Aggregate semantic counts, never raw storage votes or DB inserts.
        ids=list(range(1,6)); texts=['generated statement '+str(i) for i in ids]
        records=[dict(comment_id=i,**{'comment-id':i,'total-votes':10,'total-agrees':6,
            'total-disagrees':1,'total-passes':3},votes=10,agrees=6,disagrees=1,passes=3,
            comment_extremity=1.5,group_aware_consensus=0.9,num_groups=2) for i in ids]
        context=dict(schema='delphi-narrative-context/1',comments=records)
        topic=dict(layer_id=0,cluster_id=1,comment_ids=ids,topic_label='Generated',size=5)
        selected=stages.narrative_sections([topic],context,ids,texts)
        self.assertEqual(len(selected),4)
        self.assertEqual({p.get('_global') for p in selected},
            {None,'groups','group_informed_consensus','uncertainty'})
        self.assertTrue(all(p['_allowed_ids']==ids for p in selected))
        self.assertTrue(all('generated statement 1' in p['_prompt'] for p in selected))

    def test_citation_ids_match_actual_xml_after_legacy_comment_limit(self):
        import xml.etree.ElementTree as ET
        import xmltodict
        ids=list(range(1,121));texts=['generated statement '+str(i) for i in ids]
        records=[dict(comment_id=i,**{'comment-id':i,'total-votes':10,'total-agrees':6,
            'total-disagrees':1,'total-passes':3},votes=10,agrees=6,disagrees=1,passes=3,
            comment_extremity=1.5,group_aware_consensus=0.9,num_groups=2) for i in ids]
        sections=stages.narrative_sections([],dict(schema='delphi-narrative-context/1',comments=records),ids,texts)
        self.assertEqual(len(sections),3)
        for section in sections:
            structured=xmltodict.parse(section['_prompt'])['polisAnalysisPrompt']['data']['content']['structured_comments']
            actual=[int(row.attrib['id']) for row in ET.fromstring(structured).findall('comment')]
            self.assertEqual(section['_allowed_ids'],actual)
            self.assertLess(len(actual),len(ids))

    def test_model_digest_changes_with_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.safetensors'; path.write_bytes(b'generated model bytes')
            old=stages.model_digest(directory)
            path.write_bytes(b'changed generated bytes')
            self.assertNotEqual(old,stages.model_digest(directory))

    def test_float_codec_conversion_is_explicit(self):
        output=dict(family_files=stages.family_files({'Delphi_UMAPGraph':[
            dict(conversation_id='9001',edge_id='0_0',position={'x':0.25,'y':0.5})]}))
        from decimal import Decimal
        self.assertEqual(stages.read_family(output,'Delphi_UMAPGraph')[0]['position']['x'],Decimal('0.25'))

if __name__=='__main__':
    unittest.main()
