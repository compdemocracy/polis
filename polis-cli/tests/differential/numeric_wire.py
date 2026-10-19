"""Compare numeric JSON paths directly from wire/printed bytes, without floats."""
import base64
from decimal import Decimal
import hashlib
import json
import zlib

MAX_BODY = 8 * 1024 * 1024


def numeric_fields(raw):
    def reject_constant(_):
        raise ValueError('non-JSON number')

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON field')
            result[key] = value
        return result

    value = json.loads(raw, parse_int=Decimal, parse_float=Decimal,
                       parse_constant=reject_constant, object_pairs_hook=object_pairs)
    fields = {}

    def visit(node, path):
        if isinstance(node, Decimal):
            fields[path] = node
        elif isinstance(node, dict):
            for key, child in node.items():
                visit(child, path + '/' + key.replace('~', '~0').replace('/', '~1'))
        elif isinstance(node, list):
            for index, child in enumerate(node):
                visit(child, path + '/' + str(index))

    visit(value, '')
    return fields


def compare_numeric_bytes(wire, printed):
    """CLI envelopes put the unmodified API/math payload under data.

    Decimal parses the original number tokens exactly. Equivalent exponent or
    trailing-zero formatting is fine; a one-bit numeric change is not. Numeric
    fields added, removed, moved, or changed into a string/bool also fail.
    """
    expected = numeric_fields(wire)
    actual = {key.removeprefix('/data'): value
              for key, value in numeric_fields(printed).items()
              if key == '/data' or key.startswith('/data/')}
    paths = sorted(key for key in expected.keys() | actual.keys()
                   if key not in expected or key not in actual or expected[key] != actual[key])
    return {'numeric_fields': len(expected), 'different_paths': paths,
            'wire_sha256': hashlib.sha256(wire).hexdigest(), 'passed': not paths}


def compare_recording(records, printed):
    if len(records) != 1:
        raise RuntimeError('numeric wire check needs exactly one response')
    record = records[0]
    if not record['complete'] or record['overflow'] or record['status'] != 200:
        raise RuntimeError('numeric wire response is incomplete or unsuccessful')
    wire = base64.b64decode(record['body'], validate=True)
    if len(wire) > MAX_BODY:
        raise RuntimeError('numeric wire response exceeds limit')
    encoding = record['encoding'].lower()
    if encoding == 'gzip':
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        wire = decoder.decompress(wire, MAX_BODY + 1)
        if len(wire) > MAX_BODY or not decoder.eof or decoder.unused_data:
            raise RuntimeError('numeric wire gzip is incomplete or exceeds limit')
    elif encoding not in ('', 'identity'):
        raise RuntimeError('numeric wire response uses an unsupported encoding')
    return compare_numeric_bytes(wire, printed)
