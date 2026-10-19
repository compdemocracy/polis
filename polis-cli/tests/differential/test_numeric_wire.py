import base64
import gzip
import unittest
from numeric_wire import compare_numeric_bytes, compare_recording, numeric_fields, MAX_BODY


class NumericWireTests(unittest.TestCase):
    def compare(self, raw, printed):
        return compare_numeric_bytes(raw.encode(), ('{"data":' + printed + '}').encode())

    def test_known_one_bit_cli_parse_drift_is_rejected(self):
        check = self.compare('{"center":[0.9856906946328695]}',
                             '{"center":[0.9856906946328696]}')
        self.assertFalse(check['passed'])
        self.assertEqual(check['different_paths'], ['/center/0'])
        self.assertNotIn('0.985690', str(check))

    def test_exact_numbers_nested_in_arrays_pass(self):
        body = '{"pca":{"center":[0.9856906946328695,0.1]},"tick":1700000000000}'
        self.assertTrue(self.compare(body, body)['passed'])
        self.assertEqual(self.compare(body, body)['numeric_fields'], 3)

    def test_comparison_does_not_round_through_binary_float(self):
        self.assertFalse(self.compare('1.0000000000000001', '1')['passed'])
        self.assertFalse(self.compare('9007199254740993', '9007199254740992')['passed'])

    def test_equivalent_exponents_and_object_order_are_accepted(self):
        self.assertTrue(self.compare('{"a":1e-7,"b":1.0}', '{"b":1,"a":0.0000001}')['passed'])

    def test_missing_extra_and_nonnumeric_replacements_fail(self):
        for changed in ['{}', '{"n":"1"}', '{"n":true}', '{"n":null}', '{"n":1,"extra":2}']:
            with self.subTest(changed=changed):
                self.assertFalse(self.compare('{"n":1}', changed)['passed'])

    def test_array_order_and_escaped_paths(self):
        self.assertEqual(self.compare('{"a/b~":[1,2]}', '{"a/b~":[2,1]}')['different_paths'],
                         ['/a~1b~0/0', '/a~1b~0/1'])

    def test_envelope_numbers_are_not_compared_as_payload(self):
        self.assertTrue(compare_numeric_bytes(b'{"n":1}', b'{"data":{"n":1},"version":2}')['passed'])

    def test_duplicate_keys_and_non_json_numbers_are_refused(self):
        for raw in ['{"n":1,"n":2}', 'NaN', 'Infinity', '-Infinity']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                numeric_fields(raw)

    def record(self, body=b'{"n":0.9856906946328695}', **kwargs):
        return dict(status=200, complete=True, overflow=False, encoding='',
                    body=base64.b64encode(body).decode()) | kwargs

    def test_exact_gzip_response_bytes_are_decoded_before_comparison(self):
        raw = b'{"n":0.9856906946328695}'
        record = self.record(gzip.compress(raw), encoding='gzip')
        self.assertTrue(compare_recording([record], b'{"data":'+raw+b'}')['passed'])

    def test_missing_duplicate_incomplete_or_oversize_recordings_fail(self):
        for records in [[], [self.record(), self.record()],
                        [self.record(complete=False)], [self.record(overflow=True)],
                        [self.record(status=502)], [self.record(encoding='br')]]:
            with self.subTest(records=len(records)), self.assertRaises(RuntimeError):
                compare_recording(records, b'{}')

    def test_truncated_and_expanding_gzip_are_refused(self):
        for body in [gzip.compress(b'{}')[:-2], gzip.compress(b' ' * (MAX_BODY + 1))]:
            with self.assertRaises(RuntimeError):
                compare_recording([self.record(body, encoding='gzip')], b'{}')


if __name__ == '__main__':
    unittest.main()
