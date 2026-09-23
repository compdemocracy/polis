"""Receipt /4 detail vocabulary and historical decoding are independent."""
import copy
from pathlib import Path
import runpy
import unittest
from receipt import canonical, decode_receipt, DIAGNOSTIC_DETAILS, DIAGNOSTIC_DETAIL_FAMILIES
from test_boundaries import job, receipt, sampled_receipt
from test_receipt3 import v3


def v4(fail=True,detail='other'):
    r=v3(fail);r['schema']='polis-probe-receipt/4'
    if fail:r['entries'][0]['diagnostics'][0].update(
        detail=detail,family=DIAGNOSTIC_DETAIL_FAMILIES.get(detail,'meta'))
    return r


class Receipt4Tests(unittest.TestCase):
    def test_detail_vocabulary_matches_producer_without_engine_dependencies(self):
        # Load the stdlib-only vocabulary directly; no engine or YAML imports.
        source = Path(__file__).resolve().parents[2] / 'delphi/polismath/replay/diagnostics.py'
        vocabulary = runpy.run_path(str(source))
        self.assertEqual(vocabulary['DETAILS'], DIAGNOSTIC_DETAILS)
        self.assertEqual(vocabulary['DETAIL_FAMILIES'], DIAGNOSTIC_DETAIL_FAMILIES)

    def test_all_tokens_roundtrip(self):
        for detail in DIAGNOSTIC_DETAILS:
            with self.subTest(detail=detail):
                r=v4(detail=detail);self.assertEqual(decode_receipt(canonical(r),job()),r)
        r=v4(False);self.assertEqual(decode_receipt(canonical(r),job()),r)

    def test_historical_versions_preserve_exact_bytes(self):
        for r in (receipt(),sampled_receipt(),v3(),v3(True)):
            raw=canonical(r);self.assertEqual(canonical(decode_receipt(raw,job())),raw)

    def test_schema_field_is_mandatory_only_for_v4(self):
        r=v4();del r['entries'][0]['diagnostics'][0]['detail']
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        r=v4();r['schema']='polis-probe-receipt/3'
        with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_injection_and_family_mismatch_refuse(self):
        for detail in ('PRIVATE.path[123]',None,0,True,[],{},''):
            r=v4();r['entries'][0]['diagnostics'][0]['detail']=detail
            with self.subTest(detail=detail),self.assertRaises(ValueError) as exc:decode_receipt(canonical(r),job())
            self.assertNotIn('PRIVATE',str(exc.exception))
        for detail in DIAGNOSTIC_DETAILS[1:]:
            r=v4(detail=detail);r['entries'][0]['diagnostics'][0]['family']='meta'
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_order_dedup_and_entry_cap_include_detail(self):
        r=v4();row=r['entries'][0];d=row['diagnostics'][0]
        admitted=[dict(d,family='repness',detail=t) for t in DIAGNOSTIC_DETAILS[1:9]]
        row['diagnostics']=admitted
        decode_receipt(canonical(r),job())
        for bad in (admitted[::-1],admitted+[admitted[0]],admitted[:1]*2):
            row['diagnostics']=bad
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_global_limit_truncation_and_wire_limit(self):
        r=v4();r['entries']=[copy.deepcopy(r['entries'][0]) for _ in range(256)]
        for e in r['entries']:e['diagnostics_truncated']=True
        decode_receipt(canonical(r),job())
        r['entries'][0]['diagnostics'].append(dict(r['entries'][0]['diagnostics'][0],checkpoint=1))
        with self.assertRaisesRegex(ValueError,'LIMIT'):decode_receipt(canonical(r),job())
        r=v4();r['entries'][0]['diagnostics_truncated']=True
        with self.assertRaisesRegex(ValueError,'TRUNCATION'):decode_receipt(canonical(r),job())
        with self.assertRaises(ValueError):decode_receipt(canonical(v4())+b' '*(256*1024),job())

    def test_worker_operator_share_v4_decoder(self):
        import worker,run
        r=v4(detail='components');r['entries'][0]['diagnostics'][0].update(kind='numeric-tolerance',magnitude='over1-to2')
        raw=canonical(r)
        self.assertEqual(worker.decode_receipt(raw,job()),r)
        self.assertEqual(run.decode_receipt(raw,job()),r)
