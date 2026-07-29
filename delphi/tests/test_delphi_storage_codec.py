"""Unit tests for delphi_storage.codec — canonical JSON, packed floats, zstd, envelopes.

Pure unit level: no backend, no services. The cross-language wire format these
pin down is shared with server/src/storage/delphi/codec.ts via the conformance
fixtures in delphi_storage/conformance/cases/.
"""

import hashlib
import math
from decimal import Decimal

import pytest

from delphi_storage.codec import (
    F64,
    INLINE_LIMIT,
    canonical_json_dumps,
    compress,
    decode_payload,
    decompress,
    encode_payload,
    from_dynamo,
    pack_f64,
    to_dynamo,
    unpack_f64,
)


class TestCanonicalJson:
    def test_sorted_keys_compact(self):
        assert canonical_json_dumps({"b": 1, "a": [1.5, "x"]}) == '{"a":[1.5,"x"],"b":1}'

    def test_unicode_not_escaped(self):
        assert canonical_json_dumps({"k": "café 😀"}) == '{"k":"café 😀"}'

    def test_deterministic(self):
        obj = {"z": {"y": [3, 2, 1]}, "a": None, "m": True}
        assert canonical_json_dumps(obj) == canonical_json_dumps(obj)

    def test_nested_keys_sorted(self):
        assert canonical_json_dumps({"o": {"b": 1, "a": 2}}) == '{"o":{"a":2,"b":1}}'

    def test_rejects_nan(self):
        with pytest.raises(ValueError):
            canonical_json_dumps({"x": float("nan")})

    def test_rejects_inf(self):
        with pytest.raises(ValueError):
            canonical_json_dumps({"x": float("inf")})


class TestPackF64:
    def test_roundtrip(self):
        values = [0.0, 0.5, -1.25, 1e300, 5e-324, math.pi]
        assert unpack_f64(pack_f64(values)) == values

    def test_little_endian_ieee754(self):
        # 0.5 in little-endian IEEE-754 float64
        assert pack_f64([0.5]) == bytes.fromhex("000000000000e03f")

    def test_length(self):
        assert len(pack_f64([0.0] * 7)) == 56

    def test_nan_bits_survive(self):
        [out] = unpack_f64(pack_f64([float("nan")]))
        assert math.isnan(out)

    def test_empty(self):
        assert pack_f64([]) == b""
        assert unpack_f64(b"") == []


class TestZstd:
    def test_roundtrip(self):
        raw = b"delphi storage v2" * 1000
        comp = compress(raw)
        assert len(comp) < len(raw)
        assert decompress(comp) == raw

    def test_binary_safe(self):
        raw = bytes(range(256)) * 10
        assert decompress(compress(raw)) == raw


class TestEnvelope:
    def test_small_json_inline(self):
        value = {"pca": [0.1, 0.2], "n": 3}
        enc = encode_payload(value)
        assert enc.meta["enc"] == "json"
        assert enc.blob is None
        assert decode_payload(enc.meta, enc.blob) == value

    def test_large_json_compressed(self):
        value = {"rows": [{"i": i, "v": i * 0.5} for i in range(20000)]}
        assert len(canonical_json_dumps(value)) > INLINE_LIMIT
        enc = encode_payload(value)
        assert enc.meta["enc"] == "json+zstd"
        assert enc.blob is not None
        raw = canonical_json_dumps(value).encode("utf-8")
        assert enc.meta["bytes"] == len(raw)
        assert enc.meta["sha256"] == hashlib.sha256(raw).hexdigest()
        assert decode_payload(enc.meta, enc.blob) == value

    def test_f64_payload(self):
        values = [i * 0.25 for i in range(1000)]
        enc = encode_payload(F64(values))
        assert enc.meta["enc"] == "f64+zstd"
        assert enc.meta["count"] == 1000
        packed = pack_f64(values)
        assert enc.meta["bytes"] == len(packed)
        assert enc.meta["sha256"] == hashlib.sha256(packed).hexdigest()
        assert decode_payload(enc.meta, enc.blob) == values

    def test_f64_bit_exact(self):
        values = [0.1, 1e-9, 1e300, -0.0, 5e-324]
        enc = encode_payload(F64(values))
        out = decode_payload(enc.meta, enc.blob)
        assert [v.hex() for v in out] == [v.hex() for v in values]

    def test_unknown_enc_rejected(self):
        with pytest.raises(ValueError):
            decode_payload({"enc": "protobuf"}, b"")


class TestDynamoNumbers:
    def test_floats_become_decimal(self):
        out = to_dynamo({"a": 0.1, "b": [1.5, {"c": 2.25}], "n": 3})
        assert out["a"] == Decimal("0.1")
        assert out["b"][0] == Decimal("1.5")
        assert out["b"][1]["c"] == Decimal("2.25")
        assert out["n"] == 3 and isinstance(out["n"], int)

    def test_from_dynamo_restores_numbers(self):
        back = from_dynamo({"a": Decimal("0.1"), "n": Decimal("3"), "l": [Decimal("2.5")]})
        assert back["a"] == 0.1 and isinstance(back["a"], float)
        assert back["n"] == 3 and isinstance(back["n"], int)
        assert back["l"] == [2.5]

    def test_roundtrip_by_value(self):
        obj = {"x": 0.1, "y": 42, "z": [1e-9, 2.0]}
        back = from_dynamo(to_dynamo(obj))
        assert back["x"] == obj["x"]
        assert back["y"] == obj["y"]
        assert back["z"][0] == obj["z"][0]
        assert back["z"][1] == 2.0

    def test_bools_untouched(self):
        out = to_dynamo({"t": True, "f": False})
        assert out["t"] is True and out["f"] is False
        back = from_dynamo(out)
        assert back["t"] is True and back["f"] is False

    def test_rejects_nan(self):
        with pytest.raises(ValueError):
            to_dynamo({"x": float("nan")})
