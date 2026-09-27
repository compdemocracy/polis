"""Light-shadow triage selection mode of the paired battery: job/1 contract,
selection context and the receipt/5 selection binding. Dependency-free."""
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'private_cert/images'))
from contracts import BoundaryError, validate_job
from receipt import canonical, decode_receipt, sha
import light_shadow as ls
from test_boundaries import job as battery_job
from test_receipt5 import v5

DIGEST = 'e' * 64


def spec(**changes):
    return ls.validate_triage_spec(dict({
        'schema': ls.TRIAGE_SPEC_SCHEMA, 'source_run_id': 'c' * 32, 'source_job_sha256': 'd' * 64,
        'source_receipt_sha256': 'f' * 64, 'triage_sha256': DIGEST, 'conversations': 3,
        'window': {'start_ms': 1_900_000_000_000 - 86_400_000, 'end_ms': 1_900_000_000_000},
        'shadow_env': 'python', 'certification_policy': ls.CERTIFICATION_POLICY}, **changes))


def triage_job(**extra):
    base = battery_job()
    value = dict(base, reader={'image': 'localhost/producer@sha256:' + '1' * 64, 'args': ['extract']},
                 triage_selection=spec(), **extra)
    return validate_job(value)


def size(p=2, c=2, u=3, v=4):
    return dict(P=p, V=v, C=c, U=u, matrix_area=p * c, registered_participants=p, all_comments=c)


def report(**changes):
    r = {'schema': ls.TRIAGE_REPORT_SCHEMA, 'source_triage_sha256': DIGEST, 'battery_triage_sha256': DIGEST,
         'match': 'MATCH', 'compare_count': 3, 'battery_count': 3, 'flagged': 4, 'selected': 4,
         'truncated': 0, 'cap': 20, 'chosen_entry_sizes': [size()] * 4}
    r.update(changes)
    return r


class Contract(unittest.TestCase):
    def test_battery_job_accepts_a_triage_selection(self):
        j = triage_job()
        self.assertEqual(j['triage_selection'], spec())
        self.assertEqual(validate_job(j), j)

    def test_triage_is_exclusive_and_needs_the_reader(self):
        j = triage_job()
        with self.assertRaisesRegex(BoundaryError, 'SELECTION_CONFIG'):
            validate_job(dict(j, representative_selection={'seed_source': 'config', 'seed': '1' * 64}))
        with self.assertRaisesRegex(BoundaryError, 'SELECTION_CONFIG'):
            validate_job({k: v for k, v in j.items() if k != 'reader'})
        for bad in (dict(spec(), shadow_env='prod'), dict(spec(), zids=[1]), dict(spec(), conversations=0),
                    dict(spec(), certification_policy='0' * 64), 'text'):
            with self.subTest(bad=bad), self.assertRaisesRegex(BoundaryError, 'SELECTION_CONFIG'):
                validate_job(dict(j, triage_selection=bad))

    def test_compare_handoff_carries_the_label(self):
        self.assertEqual(spec()['shadow_env'], 'python')
        with self.assertRaises(ValueError):
            ls.validate_triage_spec({k: v for k, v in spec().items() if k != 'shadow_env'})

    def test_worker_passes_the_triage_selection_to_the_reader(self):
        text = (HERE / 'worker.py').read_text()
        self.assertIn("('run_id', 'representative_selection', 'triage_selection', 'run_spec')", text)


class Report(unittest.TestCase):
    def test_counts_only_report(self):
        self.assertEqual(ls.validate_triage_report(report(), spec()), report())
        changed = report(battery_triage_sha256='a' * 64, match='CHANGED', battery_count=2)
        ls.validate_triage_report(changed, spec())
        none = report(battery_triage_sha256=None, match='CHANGED', battery_count=0, flagged=1, selected=1,
                      chosen_entry_sizes=[size()])
        ls.validate_triage_report(none, spec())
        capped = report(flagged=25, selected=20, truncated=5, chosen_entry_sizes=[size()] * 20)
        ls.validate_triage_report(capped, spec())

    def test_refusals(self):
        for bad in (report(match='CHANGED'), report(battery_triage_sha256='a' * 64),
                    report(source_triage_sha256='a' * 64), report(compare_count=2), report(cap=30),
                    report(selected=3, chosen_entry_sizes=[size()] * 3), report(truncated=1),
                    report(flagged=25, selected=25, chosen_entry_sizes=[size()] * 25),
                    report(flagged=0, selected=0, battery_count=0, battery_triage_sha256=None, match='CHANGED',
                           chosen_entry_sizes=[]),
                    report(battery_count=0), report(zids=[1]),
                    report(chosen_entry_sizes=[dict(size(), zid=1)] * 4),
                    report(chosen_entry_sizes=[dict(size(), matrix_area=5)] * 4),
                    report(chosen_entry_sizes=[size(v=9), size(), size(), size()])):
            with self.subTest(bad=bad), self.assertRaises((ValueError, KeyError, TypeError)):
                ls.validate_triage_report(bad, spec())

    def test_order_is_fail_first_then_largest_deltas(self):
        rows = [dict(zid=1, outcome='NEAR-TIE-CANDIDATE', worst_rel=0.1, worst_abs=0.1),
                dict(zid=2, outcome='FAIL', worst_rel=None, worst_abs=None),
                dict(zid=3, outcome='HISTORY-DIVERGENCE', worst_rel=0.5, worst_abs=0.01),
                dict(zid=4, outcome='NEAR-TIE-CANDIDATE', worst_rel=0.5, worst_abs=0.2)]
        self.assertEqual([r['zid'] for r in sorted(rows, key=ls.triage_order)], [2, 4, 3, 1])


class ReceiptSelection(unittest.TestCase):
    def receipt(self, j, selection):
        r = v5()
        r.update(run_id=j['run_id'], job_sha256=sha(j), selection=selection)
        return r

    def test_triage_receipt_binds_its_report_to_the_job(self):
        j = triage_job()
        r = self.receipt(j, report())
        self.assertEqual(decode_receipt(canonical(r), j), r)
        for bad in (None, report(source_triage_sha256='a' * 64), dict(report(), seed_source='config')):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                decode_receipt(canonical(self.receipt(j, bad)), j)
        old = self.receipt(j, report())
        old['schema'] = 'polis-probe-receipt/4'
        for e in old['entries']:
            e.pop('attribution'), e.pop('attribution_truncated')
        with self.assertRaises(ValueError):
            decode_receipt(canonical(old), j)

    def test_a_triage_report_cannot_ride_on_an_ordinary_battery_job(self):
        j = battery_job()
        with self.assertRaises(ValueError):
            decode_receipt(canonical(self.receipt(j, report())), j)


class Context(unittest.TestCase):
    def test_triage_context_drops_the_representative_sample(self):
        try:
            import selection_context
        except ImportError:
            self.skipTest('delphi dependencies not on the path')
        import json
        config = json.loads(selection_context.PROBE_CONFIG_PATH.read_bytes())
        self.assertIn('representative_selection', config)
        resolved, source = selection_context.resolve(config, {'run_id': 'a' * 32, 'triage_selection': spec()})
        self.assertEqual(source, selection_context.TRIAGE)
        self.assertNotIn('representative_selection', resolved)
        self.assertEqual({k: v for k, v in config.items() if k != 'representative_selection'}, resolved)
        with self.assertRaises(ValueError):
            selection_context.resolve(config, {'run_id': 'a' * 32, 'triage_selection': spec(),
                                               'representative_selection': {'seed_source': 'config',
                                                                            'seed': '1' * 64}})
        self.assertEqual(selection_context.from_job(triage_job())['triage_selection'], spec())


if __name__ == '__main__':
    unittest.main()
