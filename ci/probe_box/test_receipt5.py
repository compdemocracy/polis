"""Receipt /5 closed categories and coupled worker/operator decoding."""
import copy
import unittest
from receipt import canonical, decode_receipt, ATTRIBUTION_STARTS, ATTRIBUTION_TOKENS
from test_boundaries import job, receipt, sampled_receipt
from test_receipt3 import v3
from test_receipt4 import v4


def row():
    return dict(checkpoint=0,folded_matrix='equal',moderated_matrix='equal',
                legacy_starts=['nonzero-warm']*2,python_starts=['zero-fallback','padded-warm'],
                person_projection='pass',base_partition='same-ids',
                comment_center_swap='not-applicable',comment_components_swap='not-applicable',comment_joint_swap='not-applicable')


def v5():
    r=v4();r['schema']='polis-probe-receipt/5'
    for e in r['entries']:
        e['attribution']=[dict(row(),checkpoint=i) for i in range(e['checks'])]
        e['attribution_truncated']=False
    return r


class Receipt5Tests(unittest.TestCase):
    def test_historical_and_current_byte_roundtrips(self):
        for r in [receipt(),sampled_receipt(),v3(),v4(),v5()]:
            with self.subTest(schema=r['schema']):
                self.assertEqual(canonical(decode_receipt(canonical(r),job())),canonical(r))

    def test_worker_and_operator_use_same_boundary(self):
        import worker, run
        r=v5()
        self.assertEqual(worker.decode_receipt(canonical(r),job()),r)
        self.assertEqual(run.decode_receipt(canonical(r),job()),r)

    def test_fully_unavailable_rows_decode_in_both_consumers(self):
        import worker, run
        r=v5()
        for entry in r['entries']:
            for observation in entry['attribution']:
                for key in ATTRIBUTION_TOKENS: observation[key]='unavailable'
                for key in ('legacy_starts','python_starts'): observation[key]=['unavailable']*2
        self.assertEqual(worker.decode_receipt(canonical(r),job()),r)
        self.assertEqual(run.decode_receipt(canonical(r),job()),r)

    def test_all_start_categories_are_closed(self):
        for value in ATTRIBUTION_STARTS:
            r=v5();r['entries'][0]['attribution'][0]['legacy_starts']=[value]*2
            decode_receipt(canonical(r),job())
        for value in ('PRIVATE/path',True,1,None,[],{}):
            r=v5();r['entries'][0]['attribution'][0]['legacy_starts']=[value]*2
            with self.assertRaises(ValueError) as caught:decode_receipt(canonical(r),job())
            self.assertNotIn('PRIVATE',str(caught.exception))

    def test_every_field_rejects_labels_scores_paths_and_extra_keys(self):
        for field in ATTRIBUTION_TOKENS:
            for value in ('PRIVATE/path',1,False,None,[],{}):
                r=v5();r['entries'][0]['attribution'][0][field]=value
                with self.subTest(field=field,value=value),self.assertRaises(ValueError):
                    decode_receipt(canonical(r),job())
        for field in ('matrix','scores','labels','eigenvalues','path'):
            r=v5();r['entries'][0]['attribution'][0][field]='PRIVATE'
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_version_and_checkpoint_contracts(self):
        r=v5();r['schema']='polis-probe-receipt/4'
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        r=v5();del r['entries'][0]['attribution']
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        for value in (True,-1,999):
            r=v5();r['entries'][0]['attribution'][0]['checkpoint']=value
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        r=v5();r['entries'][0]['attribution']=r['entries'][0]['attribution'][::-1]
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_truncation_and_global_budget(self):
        r=v5();r['entries'][0]['attribution']=[]
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        r['entries'][0]['attribution_truncated']=True
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        r=v5();r['entries']=[copy.deepcopy(r['entries'][0]) for _ in range(64)]
        with self.assertRaisesRegex(ValueError,'LIMIT'):decode_receipt(canonical(r),job())


if __name__=='__main__':unittest.main()
