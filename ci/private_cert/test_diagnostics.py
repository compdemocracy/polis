"""Typed comparison and admitted selection controls on public data only."""
import copy
import contextlib
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / 'images'))
import gate
import g12
import probe
import diagnostic_projection as projection
import selection_context
from polismath.replay import diagnostics as diag, fixture_config as fc, fixture_selection as selection
from polismath.replay.stepcompare import StepComparer
from receipt import RECIPE_TOKENS


class DiagnosticTests(unittest.TestCase):
    def collect(self, key, a, b, checkpoint=0):
        c = g12.Collector(diagnostics=True)
        c.checkpoint = checkpoint
        g12._walk_keyed(key, a, b, key, c)
        rows = diag.ordered(dict(zip(diag.ROW_KEYS, r)) for r in c.diagnostics)
        return c, rows

    def test_acceptance_family_inventory_is_exhaustive(self):
        import receipt
        self.assertEqual(diag.FAMILIES, receipt.DIAGNOSTIC_FAMILIES)
        self.assertEqual(diag.KINDS, receipt.DIAGNOSTIC_KINDS)
        self.assertEqual(diag.MAGNITUDES, receipt.DIAGNOSTIC_MAGNITUDES)
        self.assertEqual(set(diag.TOP_FAMILIES), gate.certify.ACCEPTANCE_KEYS)
        for key, family in diag.TOP_FAMILIES.items():
            self.assertEqual(diag.child_family(None, key), family)
        for key, family in diag.CHILD_FAMILIES.items():
            for parent in diag.FAMILIES:
                self.assertEqual(diag.child_family(parent, key), family)

    def test_nested_fields_keep_typed_context(self):
        cases = [ ('group-clusters', [{'id': 1, 'center': [1., 2.]}], [{'id': 1, 'center': [9., 2.]}], 'projection'),
                  ('base-clusters', {'id': [1], 'x': [1.]}, {'id': [1], 'x': [2.]}, 'projection'),
                  ('group-votes', {'1': {'2': 1}}, {'1': {'2': 2}}, 'clusters'),
                  ('repness', {'1': [{'tid': 2, 'p': 0.5}]}, {'1': [{'tid': 2, 'p': 0.7}]}, 'repness') ]
        for key, a, b, family in cases:
            with self.subTest(key=key):
                _, rows = self.collect(key, a, b)
                self.assertEqual({r['family'] for r in rows}, {family})
                strict = gate.certify._acceptance_projecting_comparer().compare_step({key:a},{key:b},4)
                self.assertEqual({r['family'] for r in strict['diagnostics']}, {family})

    def test_unknown_context_grades_without_echoing_input(self):
        for a,b,kind in ((1,2,'exact-value'),(None,[1],'shape')):
            c,rows=self.collect('PRIVATE_FIELD',a,b)
            self.assertFalse(g12.summarize(c)['rollup']['g12_pass'])
            self.assertEqual(rows,[dict(checkpoint=0,family='meta',detail='other',kind=kind,magnitude='not-applicable')])
            strict=StepComparer(diagnostics=True).compare_step({'PRIVATE_FIELD':a},{'PRIVATE_FIELD':b},0)
            self.assertFalse(strict['match'])
            self.assertEqual(strict['diagnostics'],[dict(family='meta',detail='other',kind=kind,magnitude='not-applicable')])

    def test_diagnostic_exception_is_a_graded_shape_fault(self):
        for family in (None,'projection','PRIVATE_FIELD'):
            c=g12.Collector(diagnostics=True);c.family=family
            with patch.object(g12,'_dispatch',side_effect=diag.DiagnosticContextError('PRIVATE_FIELD')):
                g12.compare_field(1,2,'private-path',c,g12.DEFAULT_AXIS,g12.spec_for('n'))
            self.assertFalse(g12.summarize(c)['rollup']['g12_pass'])
            self.assertEqual(c.diagnostics,{(0,'meta','other','shape','not-applicable')})
            self.assertEqual(c.family,family)

    def test_unexpected_exception_resets_and_restores_diagnostic_context(self):
        c = g12.Collector(diagnostics=True)
        c.family, c.context = 'projection', 'components'
        with patch.object(g12, '_dispatch', side_effect=TypeError('PRIVATE_FIELD')):
            g12.compare_field(1, 2, 'private-path', c, g12.DEFAULT_AXIS, g12.spec_for('n'))
        self.assertFalse(g12.summarize(c)['rollup']['g12_pass'])
        self.assertEqual(c.diagnostics, {(0, 'meta', 'other', 'shape', 'not-applicable')})
        self.assertEqual((c.family, c.context), ('projection', 'components'))
        self.assertEqual(c.shape, {'private-path [error:TypeError]': 1})

    def test_root_inventory_families_agree_without_changing_divergence_count(self):
        for keys in (['pca'],['mod-in'],['group-votes','repness','mod-out','n'],['PRIVATE_FIELD']):
            a=dict.fromkeys(keys,None)
            for left,right in ((a,{}),({},a)):
                strict=StepComparer(diagnostics=True).compare_step(left,right,0)
                self.assertFalse(strict['match']);self.assertEqual(strict['n_divergences'],1)
                expected={diag.TOP_FAMILIES.get(k,'meta') for k in keys}
                self.assertEqual({r['family'] for r in strict['diagnostics']},expected)
                self.assertTrue(all(r['kind']=='shape' for r in strict['diagnostics']))

    def test_step_count_mismatch_has_rollup_and_closed_diagnostic(self):
        from polismath.replay import crosslang
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'py').mkdir()
            with patch.object(crosslang,'load_clj_blobs',return_value=[{'n':1}]), \
                 patch.object(crosslang,'clj_recording_to_py_store'), \
                 patch('polismath.replay.stepcompare.compare_recordings',return_value={'overall_match':False}):
                metric=g12.measure_main_blob(root,gate.REPO/'delphi')
        self.assertEqual(metric['status'],'STEP_COUNT_MISMATCH')
        self.assertFalse(metric['authoritative_g12'])
        self.assertFalse(metric['rollup']['g12_pass'])
        expected=[dict(checkpoint=0,family='meta',detail='other',kind='shape',magnitude='not-applicable')]
        self.assertEqual(metric['diagnostics'],expected)
        self.assertEqual(projection.comparison_diagnostics({'per_step':[{'match':True}]},metric),expected)
        self.assertEqual(projection.comparison_diagnostics({'per_step':[{'match':True}]},
                         {'status':'STEP_COUNT_MISMATCH'}),expected)

    def test_exact_and_nullable_shape_witnesses_have_zero_outliers(self):
        for key, a, b, family, kind in [('n', 1, 2, 'meta', 'exact-value'),
                                       ('mod-in', None, [987], 'moderation', 'shape')]:
            c, rows = self.collect(key,a,b)
            self.assertFalse(g12.summarize(c)['rollup']['g12_pass'])
            self.assertEqual(g12.summarize(c)['rollup']['g12_outliers'], 0)
            self.assertEqual(rows, [dict(checkpoint=0,family=family,detail='other',kind=kind,magnitude='not-applicable')])

    def test_magnitude_buckets_boundaries_and_overflow(self):
        # a=0 makes an exact ratio construction convenient.
        for ratio, bucket in [(1.5,'over1-to2'), (3,'over2-to10'), (11,'over10')]:
            b = ratio*g12.ABS/(1-ratio*g12.G12_REL)
            _, rows = self.collect('comment-priorities', [0.], [b])
            self.assertEqual(rows[0]['magnitude'],bucket)
        c = g12.Collector(diagnostics=True);c.family='projection'
        c.add_float('private-path', 1.79e308, -1.79e308)
        self.assertEqual(next(iter(c.diagnostics))[-1], 'over10')
        self.assertTrue(g12.g12_fail(1.79e308,-1.79e308))

    def test_nonfinite_category_and_pass_boundary(self):
        for number in (math.inf, -math.inf, math.nan):
            c,rows=self.collect('comment-priorities',[1.],[number])
            self.assertEqual(rows[0]['kind'],'nonfinite')
            self.assertFalse(g12.summarize(c)['rollup']['g12_pass'])
        _,rows=self.collect('comment-priorities',[1.],[1.+1e-7])
        self.assertEqual(rows,[])

    def test_strict_only_tolerance_context_preserves_decision(self):
        # Strict scaling detection can fail below the absolute numeric allowance.
        a={'pca':{'comps':[[1e-8, 2e-8]]}}
        b={'pca':{'comps':[[2e-8, 4e-8]]}}
        c=g12.Collector(diagnostics=True)
        g12._walk_keyed('pca',a['pca'],b['pca'],'pca',c,g12.Axis([1],1))
        self.assertTrue(g12.summarize(c)['rollup']['g12_pass'])
        strict=gate.certify._acceptance_projecting_comparer().compare_step(a,b,0)
        self.assertFalse(strict['match'])
        rows=projection.comparison_diagnostics({'per_step':[strict]}, {'diagnostics':[]})
        self.assertEqual({r['kind'] for r in rows},{'strict-tolerance'})
        self.assertEqual({r['magnitude'] for r in rows},{'not-applicable'})

    def test_strict_numeric_token_is_only_added_without_g12_numeric_at_that_family(self):
        strict={'per_step':[{'match':False,'diagnostics':[
            dict(family='projection',detail='other',kind='strict-tolerance',magnitude='not-applicable')]}]}
        numeric=dict(checkpoint=0,family='projection',detail='other',kind='numeric-tolerance',magnitude='over10')
        self.assertEqual(projection.comparison_diagnostics(strict,{'diagnostics':[numeric]}),[numeric])

    def test_magnitude_upper_bounds_are_inclusive(self):
        for rel, expected in [(0.25,'over1-to2'), (0.05,'over2-to10')]:
            with patch.object(g12,'ABS',0.),patch.object(g12,'G12_REL',rel):
                _,rows=self.collect('comment-priorities',[1.],[2.])
            self.assertEqual(rows[0]['magnitude'],expected)

    def test_localization_uses_ordinal_not_cached_step_or_values(self):
        ds={'family':'meta','detail':'other','kind':'exact-value','magnitude':'not-applicable'}
        strict={'per_step':[{'match':True}, {'match':False, 'step':9999,'diagnostics':[ds]}]}
        self.assertEqual(projection.comparison_diagnostics(strict,{'diagnostics':[]}),[dict(checkpoint=1,**ds)])

    def test_all_committed_recipes_and_independent_vocabulary_agree(self):
        config=fc.load_config(probe.PROBE_CONFIG_PATH)
        tokens=[]
        for entry in gate.certify.load_battery():
            role=next((r['role'] for r in config['public_fixtures'] if r['slug']==entry.dataset),config['coverage_role_map'].get(entry.dataset))
            tokens.append(projection.recipe_token(NS(role=role,dataset=entry.dataset,schedule_id=entry.schedule_id)))
        self.assertEqual(len(set(tokens)),20)
        self.assertEqual(set(tokens)|{'sample-uniform6'}, RECIPE_TOKENS)
        for i in range(1,21):
            name=gate.fixture_samples.slug(i)
            self.assertEqual(projection.recipe_token(NS(role=name,dataset=name,schedule_id=gate.fixture_samples.SCHEDULE_ID)),'sample-uniform6')
        self.assertNotEqual(projection.ROLE_RECIPES['mid-mix','uniform6-clojure-legacy'],projection.ROLE_RECIPES['mid-mix','uniform6-restart3-clojure-legacy'])

    def test_unknown_recipe_or_forged_sample_refused(self):
        for entry in [NS(role='private',dataset='private',schedule_id='uniform6-clojure-legacy'),
                      NS(role='sample-021',dataset='sample-021',schedule_id=gate.fixture_samples.SCHEDULE_ID),
                      NS(role='sample-001',dataset='other',schedule_id=gate.fixture_samples.SCHEDULE_ID)]:
            with self.assertRaisesRegex(ValueError,'^DIAGNOSTIC_RECIPE$'):projection.recipe_token(entry)

    def test_global_budget_reserves_a_tuple_for_every_failure(self):
        rows=[dict(checkpoint=i,family='meta',detail='other',kind='shape',magnitude='not-applicable') for i in range(10)]
        entries=[dict(verdict='FAIL',checks=10,diagnostics=rows) for _ in range(256)]
        result=projection.bounded_diagnostics(entries)
        self.assertEqual(sum(len(r['diagnostics']) for r in result),256)
        self.assertTrue(all(len(r['diagnostics'])==1 and r['diagnostics_truncated'] for r in result))
        result=projection.bounded_diagnostics(entries[:34])
        self.assertEqual(sum(len(r['diagnostics']) for r in result),256)
        self.assertTrue(all(1<=len(r['diagnostics'])<=8 for r in result))

    def test_dedup_sort_caps_do_not_change_inputs(self):
        rows=[dict(checkpoint=i,family='meta',detail='other',kind='shape',magnitude='not-applicable') for i in reversed(range(10))]
        entries=[dict(verdict='FAIL',checks=10,diagnostics=rows+rows),dict(verdict='PASS',checks=10,diagnostics=[])]
        before=copy.deepcopy(entries);result=projection.bounded_diagnostics(entries)
        self.assertEqual(entries,before)
        self.assertEqual([r['checkpoint'] for r in result[0]['diagnostics']],list(range(8)))
        self.assertTrue(result[0]['diagnostics_truncated']);self.assertFalse(result[1]['diagnostics_truncated'])

    def test_false_pass_missing_context_and_raw_injection_refuse(self):
        row=dict(checkpoint=0,family='meta',detail='other',kind='shape',magnitude='not-applicable')
        for entry in [dict(verdict='PASS',checks=1,diagnostics=[row]),dict(verdict='FAIL',checks=1,diagnostics=[]),dict(verdict='FAIL',checks=1,diagnostics=[{**row,'path':'PRIVATE'}])]:
            with self.assertRaises(ValueError):projection.bounded_diagnostics([entry])
        self.assertEqual(projection.comparison_diagnostics({'per_step':[{'match':False}]},{'diagnostics':[]}),
                         [dict(checkpoint=0,family='meta',detail='other',kind='shape',magnitude='not-applicable')])

    def test_restart_policy_pin_and_unchanged_controls(self):
        import contextlib,io
        self.assertEqual(gate.sha(gate.POLICY),'9a26a056d1b80ff10705e19e2e3fda137a59b6d24ece27cdc3b06cd4acbc4272')
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(g12.self_test(),0)


class SelectionContextTests(unittest.TestCase):
    def setUp(self):
        self.config=fc.load_config(probe.PROBE_CONFIG_PATH)
        self.context={'run_id':'a'*32}

    def test_same_run_resolves_independently_and_different_run_changes_seed(self):
        producer,source=selection_context.resolve(self.config,self.context)
        verifier,_=selection_context.resolve(copy.deepcopy(self.config),dict(self.context))
        other,_=selection_context.resolve(self.config,{'run_id':'b'*32})
        self.assertEqual(producer,verifier);self.assertEqual(source,'run-id')
        seed=fc.representative_seed(producer)
        self.assertEqual(seed,hashlib.sha256(b'a'*32).hexdigest())
        self.assertNotEqual(seed,fc.representative_seed(other))
        # Selection still uses the unmodified 20-slot stratifier.
        rows=[dict(zid=i,P=3,V=7,C=2,U=6,matrix_area=6,registered_participants=4,all_comments=2) for i in range(100)]
        a=selection.select_representative(rows,seed)
        b=selection.select_representative(rows,fc.representative_seed(verifier))
        self.assertEqual(a,b);self.assertEqual(a.report['bucket_counts']['selected'],20)
        self.assertNotEqual(a.provenance,selection.select_representative(rows,fc.representative_seed(other)).provenance)

    def test_job_seed_override_reproduces_selection_across_run_ids(self):
        context={**self.context,'representative_selection':{'seed_source':'config','seed':'1'*64}}
        a,source=selection_context.resolve(self.config,context)
        b,_=selection_context.resolve(self.config,{**context,'run_id':'b'*32})
        self.assertEqual(a,b);self.assertEqual(source,'config');self.assertEqual(fc.representative_seed(a),'1'*64)

    def test_unknown_mode_missing_seed_and_mixed_modes_fail_closed(self):
        for block in [dict(seed_source='unknown'),dict(seed_source='config'),dict(seed_source='run-id',seed='a'*64)]:
            config=copy.deepcopy(self.config);config['representative_selection'].update(block)
            with self.assertRaises(fc.ConfigError):fc.validate_config(config)
        for context in [{}, {'run_id':True}, {**self.context,'raw':'PRIVATE'}, {**self.context,'representative_selection':{'seed_source':'run-id'}}]:
            with self.assertRaises(ValueError):selection_context.resolve(self.config,context)

    def test_candidate_cannot_substitute_seed_config_or_stratification(self):
        good,_=selection_context.resolve(self.config,self.context)
        self.assertEqual(selection_context.admit(good,self.context),'run-id')
        for key,value in [('seed','0'*64),('target',19)]:
            bad=copy.deepcopy(good);bad['representative_selection'][key]=value
            with self.assertRaisesRegex(ValueError,'SELECTION_CONFIG_BINDING'):selection_context.admit(bad,self.context)
        with self.assertRaisesRegex(ValueError,'SELECTION_CONFIG_BINDING'):selection_context.admit(good,{'run_id':'b'*32})

    def test_default_public_config_still_has_no_sample_seed(self):
        self.assertIsNone(fc.representative_seed(fc.load_config()))
        config,source=selection_context.resolve(fc.load_config(),self.context)
        self.assertEqual(config,fc.load_config());self.assertIsNone(source)

    def test_new_modules_are_in_image_source_closure(self):
        import recipe
        files=recipe.source_files(gate.REPO)
        for path in ('ci/private_cert/images/diagnostic_projection.py','ci/private_cert/images/selection_context.py','delphi/polismath/replay/diagnostics.py'):
            self.assertEqual(files[path],hashlib.sha256((gate.REPO/path).read_bytes()).hexdigest())


class PairedDiagnosticWitnesses(unittest.TestCase):
    """Real gate over small public checkpoint files; no engine or private input."""
    def witness(self, kind, ordinal=0, checks=1, control_failure=None):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            spec=gate.schedule.ScheduleSpec.from_dict(dict(dataset='vw',schedule_id='single-cut-clojure-legacy',
                cuts={'mode':'vote-count','at':list(range(1,checks+1))},coverage='full-stream'))
            checkpoints=[dict(index=i,prev_slot=i,cut_slot=i+1,batch_size=1,cut_time_ms=i+1) for i in range(checks)]
            expected=gate.certify.ExpectedEntry(gate.certify.BatteryEntry(spec.dataset,spec.schedule_id,role='public-medium'),
                spec,root/'public-votes.csv','a'*64,None,None,checks,checkpoints)
            rec=gate.store.recording_dir(spec.dataset,spec.schedule_id,root=root/'recordings')
            (rec/'clj').mkdir(parents=True);(rec/'py').mkdir()
            gate.dump(rec/'schedule.json',spec.to_dict())
            for i,checkpoint in enumerate(checkpoints):
                a=dict(n=1,**{'n-cmts':1,'tids':[1],'in-conv':[1],'mod-in':None})
                b=copy.deepcopy(a)
                if kind is not None and i==ordinal:
                    if kind=='exact-value':b['n']=2
                    else:b['mod-in']=[2]
                gate.dump(rec/'clj'/f'step-{i:03d}.meta.json',checkpoint)
                gate.dump(rec/'clj'/f'step-{i:03d}.blob.json',a)
                gate.dump(rec/'py'/f'step-{i:03d}.json',dict(checkpoint,blob=b))
            with contextlib.ExitStack() as stack:
                if control_failure=='g12':
                    # Make only the first public numerical control falsely pass.
                    original=g12.walk
                    def broken_walk(a,b,path,col,axis=g12.DEFAULT_AXIS):
                        if a=={'comps':[[1.,2.]],'proj':[[3.,4.]]} and path=='output':return
                        return original(a,b,path,col,axis)
                    stack.enter_context(patch.object(g12,'walk',side_effect=broken_walk))
                elif control_failure=='checkpoint':
                    original=gate.certify.validate_recording_inventory
                    def broken_inventory(directory,engine,expected):
                        if Path(directory).name=='controls':return
                        return original(directory,engine,expected)
                    stack.enter_context(patch.object(gate.certify,'validate_recording_inventory',side_effect=broken_inventory))
                report=gate.verify_pairs([expected],root/'recordings',root)
                if control_failure:
                    from test_attribution import document
                    from attribution import measure
                    report['entries'][0]['attribution'] = [measure(dict(document(), checkpoint=i), dict(document(), checkpoint=i), i) for i in range(checks)]
            entry=report['entries'][0]
            if control_failure:
                from receipt import decode_receipt
                self.assertEqual(report['verdict'],'FAIL')
                self.assertTrue(entry['pass']);self.assertEqual(entry['diagnostics'],[])
                job=dict(schema='polis-probe-job/1',run_id='a'*32,max_seconds=3600,
                         producer=dict(image='localhost/p@sha256:'+'1'*64,args=['produce']),
                         verifier=dict(image='localhost/v@sha256:'+'2'*64,args=['verify']))
                inputs={'policySha256':gate.sha(gate.POLICY)}
                reads={'/job/job.json':job,'/run-spec/inputs.json':inputs,'/fixture/manifest.json':{}}
                dumped={}
                with patch.object(gate,'read',side_effect=lambda p:reads[str(p)]), \
                     patch.object(probe,'admit_fixture_selection',return_value=None), \
                     patch.object(gate,'verify_recordings',return_value=report), \
                     patch.object(gate,'regular_tree',return_value={}), \
                     patch.object(gate,'dump',side_effect=lambda p,r:dumped.update(receipt=r)):
                    probe.verify()
                receipt=decode_receipt(gate.encoded(dumped['receipt']),job)
                self.assertEqual(receipt['verdict'],'FAIL')
                self.assertEqual(receipt['controls'],dict(passed=20 if control_failure=='g12' else 17,expected=21))
                self.assertEqual(receipt['entries'][0]['verdict'],'PASS')
                return
            self.assertEqual(report['verdict'],'FAIL');self.assertEqual(entry['g12']['rollup']['g12_outliers'],0)
            self.assertEqual(entry['diagnostics'],[dict(checkpoint=ordinal,family='meta' if kind=='exact-value' else 'moderation',detail='other',kind=kind,magnitude='not-applicable')])
            self.assertEqual(report['negative_controls']['g12']['rejected'],17)
            self.assertEqual(len(report['negative_controls']['checkpoint']),4)

    def test_g12_control_failure_exports_decodable_fail(self):self.witness(None,control_failure='g12')
    def test_checkpoint_control_failure_exports_decodable_fail(self):self.witness(None,control_failure='checkpoint')

    def test_single_cut_exact_witness(self):self.witness('exact-value')
    def test_single_cut_shape_witness(self):self.witness('shape')
    def test_multicut_localization(self):self.witness('exact-value',2,4)

    def test_multiple_absent_keys_keep_one_aggregate_shape_fault(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'clj').mkdir();(root/'py').mkdir()
            a=dict(n=1,**{'n-cmts':1,'tids':[1],'in-conv':[1],'mod-in':None,'mod-out':None})
            b={k:v for k,v in a.items() if k not in ('mod-in','mod-out')}
            gate.dump(root/'clj/step-000.blob.json',a)
            gate.dump(root/'py/step-000.json',dict(blob=b))
            result=g12.measure_main_blob(root,gate.REPO/'delphi')
            self.assertEqual(result['rollup']['shape_faults'],1)
            self.assertEqual(result['diagnostics'],[dict(checkpoint=0,family='moderation',detail='other',kind='shape',magnitude='not-applicable')])
            strict=StepComparer(diagnostics=True).compare_step(a,b,0)
            self.assertEqual(strict['n_divergences'],1)
            self.assertEqual(projection.comparison_diagnostics({'per_step':[strict]},result),result['diagnostics'])
