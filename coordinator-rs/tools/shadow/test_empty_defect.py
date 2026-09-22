"""Bound empty legacy omissions are visible findings, never byte equality."""
import copy
import json
import unittest

import daily as d
from test_daily import response, receipt


def bodies():
    main = d._empty.apply_empty_contract({"zid": 1, "pca": {"comps": [[], []]}})
    legacy = copy.deepcopy(main)
    for path in d._empty.legacy_absent_keys():
        parent = legacy
        keys = path.split('.')
        for key in keys[:-1]: parent = parent[key]
        del parent[keys[-1]]
    return legacy, main


class EmptyDefect(unittest.TestCase):
    route = {'class': 'PCA2_FULL', 'unordered': False}

    def pair(self, left=None, right=None):
        a, b = bodies()
        return response(d.canonical(a if left is None else left)), response(d.canonical(b if right is None else right))

    def compare(self, left=None, right=None, **kwargs):
        return d.compare(*self.pair(left,right), self.route,
                         empty_contract_sha256=d._empty.contract_sha256(), **kwargs)

    def test_named_bound_omissions(self):
        self.assertEqual(self.compare(), 'LEGACY_EMPTY_DEFECT')
        self.assertEqual(d.compare(*self.pair(), self.route), 'ENGINE_DIFFERENCE')
        self.assertEqual(d.compare(*self.pair(), self.route, empty_contract_sha256='0'*64), 'INCOMPLETE')

    def test_binding_uses_full_python_contract_and_actual_vote_rows(self):
        _, main = bodies()
        cut = {'votes': []}
        bundle = {'payloads': {'main': main}}
        self.assertEqual(d.empty_binding(d.canonical(cut), d.canonical(bundle)), d._empty.contract_sha256())
        cut['votes'] = [{'pid':1,'tid':1,'vote':0}]
        self.assertIsNone(d.empty_binding(d.canonical(cut),d.canonical(bundle)))
        for path in d._empty.empty_contract():
            broken=copy.deepcopy(main); parent=broken
            keys=path.split('.')
            for key in keys[:-1]: parent=parent[key]
            del parent[keys[-1]]
            with self.subTest(path=path), self.assertRaises(ValueError):
                d.empty_binding(b'{"votes":[]}', d.canonical({'payloads':{'main':broken}}))

    def test_all_wrong_present_values_refused(self):
        a,b=bodies()
        for path in d._empty.empty_contract():
            for side in ('legacy','python'):
                left,right=copy.deepcopy(a),copy.deepcopy(b)
                target=left if side=='legacy' else right
                keys=path.split('.')
                for key in keys[:-1]:target=target[key]
                target[keys[-1]]='wrong'
                with self.subTest(path=path,side=side):
                    self.assertEqual(self.compare(left,right),'ENGINE_DIFFERENCE')

    def test_undeclared_missing_field_and_pca_parent_refused(self):
        a,b=bodies()
        del a['zid']
        self.assertEqual(self.compare(a,b),'ENGINE_DIFFERENCE')
        a,b=bodies();del a['pca']
        self.assertEqual(self.compare(a,b),'ENGINE_DIFFERENCE')
        a,b=bodies();a['pca']['comps']=[[1],[1]]
        self.assertEqual(self.compare(a,b),'ENGINE_DIFFERENCE')

    def test_reversed_engines_non_pca_and_no_missing_key_not_exempt(self):
        a,b=bodies()
        self.assertEqual(self.compare(b,a),'ENGINE_DIFFERENCE')
        for route in ('COMMENT_MATH','REPORT_READ','PARTICIPANT_MAPPING'):
            self.assertEqual(d.compare(*self.pair(),{'class':route},empty_contract_sha256=d._empty.contract_sha256()),'ENGINE_DIFFERENCE')
        self.assertEqual(self.compare(b,b),'EXACT')
        self.assertEqual(d.compare(response(d.canonical(b)),response(json.dumps(b).encode()),self.route,
                                  empty_contract_sha256=d._empty.contract_sha256()),'ENGINE_DIFFERENCE')

    def test_subset_is_bound_to_full_row_but_checks_only_exposed_fields(self):
        self.assertEqual(d.compare(response(b'{"lastVoteTimestamp":0}'),response(b'{"lastVoteTimestamp":0,"n":0}'),
            {'class':'PCA2_SUBSET'},empty_contract_sha256=d._empty.contract_sha256()),'LEGACY_EMPTY_DEFECT')

    def test_gzip_headers_and_conditional_reference(self):
        import gzip
        a,b=self.pair();a['body']=gzip.compress(a['body']);a['encoding']='gzip'
        self.assertEqual(d.compare(a,b,self.route,empty_contract_sha256=d._empty.contract_sha256()),'LEGACY_EMPTY_DEFECT')
        a,b=self.pair();conditional=[]
        for original in (a,b):
            row=response(b'');row.update(status=304,full_body=d.hashlib.sha256(original['body']).hexdigest());conditional.append(row)
        self.assertEqual(d.compare(*conditional,self.route,(a,b),empty_contract_sha256=d._empty.contract_sha256()),'LEGACY_EMPTY_DEFECT')
        b['etag']='different'
        self.assertEqual(d.compare(a,b,self.route,empty_contract_sha256=d._empty.contract_sha256()),'ENGINE_DIFFERENCE')
        conditional[1]['full_body']='0'*64
        self.assertEqual(d.compare(*conditional,self.route,(a,b),empty_contract_sha256=d._empty.contract_sha256()),'INCOMPLETE')

    def test_duplicate_boolean_and_nonfinite_do_not_gain_exemption(self):
        for raw in (b'{"n":0,"n":1}',b'{"n":NaN}'):
            self.assertEqual(d.compare(response(raw),self.pair()[1],self.route,
                            empty_contract_sha256=d._empty.contract_sha256()),'ENGINE_DIFFERENCE')
        a,b=bodies();b['n']=False
        self.assertEqual(self.compare(a,b),'ENGINE_DIFFERENCE')

    def test_named_accounting_requires_schedule_digest(self):
        v=receipt();v['routes']['PCA2_FULL'].update(EXACT=0,LEGACY_EMPTY_DEFECT=1)
        with self.assertRaisesRegex(ValueError,'EMPTY_CONTRACT'):d.validate_receipt(v)
        v['empty_contract']=d._empty.contract_sha256()
        d.validate_receipt(v)
        counts=d.summarize_windows([v])
        self.assertEqual(counts['PASS'],1)
        self.assertEqual(counts['LEGACY_EMPTY_DEFECT'],1)
        self.assertEqual(counts['ENGINE_DIFFERENCE'],0)
        v['empty_contract']='0'*64
        with self.assertRaisesRegex(ValueError,'EMPTY_CONTRACT'):d.validate_receipt(v)

    def test_unbound_inputs_and_other_failures_still_dominate(self):
        v=receipt();v['routes']['PCA2_FULL'].update(EXACT=0,LEGACY_EMPTY_DEFECT=1)
        v['empty_contract']=d._empty.contract_sha256()
        v['admission']['input']=False;v['verdict']='INCOMPLETE'
        d.validate_receipt(v)
        v['admission']['input']=True
        v['routes']['REPORT_READ'].update(EXACT=0,ENGINE_DIFFERENCE=1)
        v['verdict']='ENGINE_DIFFERENCE';d.validate_receipt(v)

    def test_old_receipt_stays_accepted_new_vocabulary_stays_closed(self):
        d.validate_receipt(receipt())
        v=receipt();v['routes']['PCA2_FULL']['some_other_defect']=0
        with self.assertRaises(ValueError):d.validate_receipt(v)
