"""Closed detail sites agree across typed walkers without changing decisions."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).parent/'images'))
import g12
import gate
import diagnostic_projection as projection
from polismath.replay import diagnostics as diag
from polismath.replay.stepcompare import StepComparer


def rows(key,a,b):
    col=g12.Collector(diagnostics=True)
    g12._walk_keyed(key,a,b,key,col)
    return col,diag.ordered(dict(zip(diag.ROW_KEYS,r)) for r in col.diagnostics)


class DetailTests(unittest.TestCase):
    def test_projection_sites(self):
        cases=[('pca',{'comps':[[1.,2.]]},{'comps':[[1.2,2.]]},'components'),
               ('pca',{'center':[1.,2.]},{'center':[1.2,2.]},'centering'),
               ('pca',{'comment-projection':[[1.,2.]]},{'comment-projection':[[1.2,2.]]},'comment-coordinates'),
               ('pca',{'comment-extremity':[1.]},{'comment-extremity':[1.2]},'extremities'),
               ('pca',{'proj':[[1.,2.]]},{'proj':[[1.2,2.]]},'participant-coordinates'),
               ('group-clusters',[{'id':1,'center':[1.,2.]}],[{'id':1,'center':[1.2,2.]}],'group-centers'),
               ('base-clusters',{'id':[1],'x':[1.]},{'id':[1],'x':[1.2]},'participant-coordinates')]
        for key,a,b,detail in cases:
            with self.subTest(detail=detail,key=key):self.both(key,a,b,detail)

    def both(self,key,a,b,detail):
        col,ds=rows(key,a,b)
        plain=g12.Collector();g12._walk_keyed(key,a,b,key,plain)
        self.assertEqual(g12.summarize(col),g12.summarize(plain))
        strict=StepComparer(diagnostics=True).compare_step({key:a},{key:b},0)
        old=StepComparer().compare_step({key:a},{key:b},0)
        self.assertEqual({k:v for k,v in strict.items() if k!='diagnostics'},
                         {k:v for k,v in old.items() if k!='diagnostics'})
        self.assertEqual({d['detail'] for d in ds},{detail})
        self.assertEqual({d['detail'] for d in strict['diagnostics']},{detail})
        return ds,strict

    def test_representative_sites_and_dynamic_labels(self):
        for label in ('123','456','PRIVATE_LABEL','repness'):
            def wrap(x):return {label:x}
            for a,b,detail in [([{'tid':1}],[{'tid':2}],'representatives-member-set'),
                ([{'tid':1}],[{'tid':1,'p-test':.5}],'representatives-record-keys'),
                (None,[],'representatives-list-shape'),
                ([{'tid':1,'repful-for':'agree'}],[{'tid':1,'repful-for':'disagree'}],'representatives-direction'),
                ([{'tid':1,'n-success':1}],[{'tid':1,'n-success':2}],'representatives-counts'),
                ([{'tid':1,'repness-test':.3}],[{'tid':1,'repness-test':.5}],'representatives-scores')]:
                with self.subTest(label=label,detail=detail):
                    ds,strict=self.both('repness',wrap(a),wrap(b),detail)
                    self.assertEqual({d['family'] for d in ds+strict['diagnostics']},{'repness'})

    def test_other_repness_roots(self):
        for key,detail in [('consensus','consensus'),('group-aware-consensus','group-consensus'),('comment-priorities','priorities')]:
            self.both(key,{'PRIVATE':.3},{'PRIVATE':.5},detail)
        self.both('repness',None,{},'representatives')
        self.both('PRIVATE',1,2,'other')

    def test_strict_suppression_requires_same_detail(self):
        numeric=dict(checkpoint=0,family='projection',detail='components',kind='numeric-tolerance',magnitude='over10')
        strict={'per_step':[{'match':False,'diagnostics':[
            dict(family='projection',detail=d,kind='strict-tolerance',magnitude='not-applicable')
            for d in ('components','centering')]}]}
        ds=projection.comparison_diagnostics(strict,{'diagnostics':[numeric]})
        self.assertEqual({d['detail'] for d in ds},{'components','centering'})

    def test_all_detail_tokens_match_independent_decoder(self):
        import receipt
        self.assertEqual(diag.DETAILS,receipt.DIAGNOSTIC_DETAILS)
        self.assertEqual(diag.DETAIL_FAMILIES,receipt.DIAGNOSTIC_DETAIL_FAMILIES)

    def test_path_shaped_labels_do_not_escape_or_change_existing_dispatch(self):
        import json
        for label in ('PRIVATE.center[0]', 'center', 'comps'):
            a={label:[{'tid':1,'n-success':1}]};b={label:[{'tid':1,'n-success':2}]}
            col,ds=rows('repness',a,b)
            plain=g12.Collector();g12._walk_keyed('repness',a,b,'repness',plain)
            self.assertEqual(g12.summarize(col),g12.summarize(plain))
            self.assertNotIn('PRIVATE',json.dumps(ds))
            self.assertTrue(all(d['detail'] in diag.DETAILS for d in ds))
            strict=StepComparer(diagnostics=True).compare_step({'repness':a},{'repness':b},0)
            self.assertEqual({d['detail'] for d in strict['diagnostics']},{'representatives-counts'})

    def test_missing_root_details_and_record_inventory(self):
        for key,detail in [('repness','representatives'),('consensus','consensus'),
                           ('group-aware-consensus','group-consensus'),('pca','other')]:
            strict=StepComparer(diagnostics=True).compare_step({key:None},{},0)
            self.assertEqual({d['detail'] for d in strict['diagnostics']},{detail})
        self.both('repness',{'1':[]},{'2':[]},'representatives-member-set')

    def test_tuple_order_all_details_and_injection(self):
        all_rows=[dict(checkpoint=0,family=diag.DETAIL_FAMILIES.get(d,'meta'),detail=d,
                       kind='shape',magnitude='not-applicable') for d in diag.DETAILS]
        admitted=diag.ordered(all_rows+all_rows)
        self.assertEqual(len(admitted),len(diag.DETAILS))
        self.assertEqual(diag.ordered(admitted[::-1]),admitted)
        for detail in ('PRIVATE',None,[],True):
            with self.assertRaises(ValueError):diag.ordered([dict(all_rows[0],detail=detail)])

    def test_detail_source_invalidates_strict_verdict_cache(self):
        from unittest.mock import patch
        cert=gate.certify
        comparer=cert._acceptance_projecting_comparer()
        before=cert._comparer_cfg_hash(comparer)
        original=Path.read_bytes
        target=Path(diag.__file__)
        def changed(path):
            raw=original(path)
            return raw+b'\n# changed reporting context\n' if path==target else raw
        with patch.object(Path,'read_bytes',changed):
            self.assertNotEqual(before,cert._comparer_cfg_hash(comparer))
        self.assertEqual(before,cert._comparer_cfg_hash(comparer))

    def test_checkpoint_one_small_numeric_projection_failure_is_localized(self):
        col=g12.Collector(diagnostics=True);col.checkpoint=1
        g12._walk_keyed('pca',{'center':[1.,1.]},{'center':[1.00015,1.00015]},'pca',col)
        ds=diag.ordered(dict(zip(diag.ROW_KEYS,r)) for r in col.diagnostics)
        self.assertEqual(ds,[dict(checkpoint=1,family='projection',detail='centering',
            kind='numeric-tolerance',magnitude='over1-to2')])
        self.assertEqual(g12.summarize(col)['rollup']['g12_outliers'],2)
