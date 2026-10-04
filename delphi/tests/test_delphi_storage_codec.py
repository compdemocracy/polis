"""Golden and round-trip tests for the frozen Delphi storage codec (P-077 P2-0).

Python writes -> TypeScript reads is checked by the server's Node test on the
same golden files; this module checks that Python regenerates them byte for
byte, reads its own output back, and reads the file the Node test writes
(golden/cross/written-by-node.jsonl). Stdlib-only, no services.
"""

import hashlib
import unittest
from decimal import Decimal

from polismath.delphi_storage import codec
from polismath.delphi_storage.golden_corpus import GOLDEN, corpus, cross_items


class GoldenCorpus(unittest.TestCase):
    def test_version_and_families(self):
        self.assertEqual(codec.CODEC_VERSION, "delphi-storage-codec/1")
        self.assertEqual(len(codec.FAMILIES), 20)
        self.assertEqual(sorted(f["id"] for f in codec.FAMILIES.values()), [f"T{n:02d}" for n in range(1, 21)])

    def test_regenerates_committed_bytes(self):
        sums = []
        for family, items in sorted(corpus().items()):
            data = codec.encode_family(family, items)
            self.assertEqual(data, (GOLDEN / f"{family}.jsonl").read_bytes(), family)
            sums.append(f"{hashlib.sha256(data).hexdigest()}  {family}.jsonl\n")
        self.assertEqual("".join(sums), (GOLDEN / "SHA256SUMS").read_text())

    def test_every_family_round_trips_byte_exact(self):
        for family in codec.FAMILIES:
            data = (GOLDEN / f"{family}.jsonl").read_bytes()
            name, items = codec.decode_family(data)
            self.assertEqual(name, family)
            self.assertEqual(codec.encode_family(name, items), data)
            # through the boto3-resource value form and back
            again = [codec.item_from_python({k: codec.to_python(v) for k, v in it.items()}) for it in items]
            self.assertEqual(codec.encode_family(name, again), data, family)

    def test_reads_the_file_node_wrote(self):
        data = (GOLDEN / "cross" / "written-by-node.jsonl").read_bytes()
        name, items = codec.decode_family(data)
        self.assertEqual(name, "Delphi_JobQueue")
        self.assertEqual(codec.encode_family(name, cross_items()), data)
        one = {i["job_id"]["S"]: i for i in items}["cross-1"]
        self.assertEqual(one["s"]["S"], "caf\u00e9\u0000\U0001f600")
        self.assertEqual(one["b"]["B"], b"\x00\xff")
        self.assertEqual(one["ns"]["NS"], ["10", "2"])
        self.assertEqual(one["m"]["M"]["k1"], {"S": '{"json":true}'})


class Rules(unittest.TestCase):
    def test_numbers(self):
        for given, want in [("1.50", "1.5"), ("1E+2", "100"), ("-0", "0"), ("0.0", "0"), ("1e-10", "0.0000000001"),
                            ("00012", "12"), (".5", "0.5"), ("5.", "5"), ("-1.2300e5", "-123000")]:
            self.assertEqual(codec.canonical_number(given), want)
        for bad in ["", "1e", "NaN", "Infinity", "0x10", "1E+126", "1E-131", "1" * 39,
                    "\u0663", "1\u0663", "\uff11", "1e\u0663"]:
            with self.assertRaises(codec.CodecError):
                codec.canonical_number(bad)

    def test_python_values(self):
        self.assertEqual(codec.from_python(Decimal("1.50")), {"N": "1.5"})
        self.assertEqual(codec.from_python(3), {"N": "3"})
        with self.assertRaises(codec.CodecError):
            codec.from_python(0.5)
        with self.assertRaises(codec.CodecError):
            codec.from_python(Decimal("NaN"))
        self.assertEqual(codec.to_python({"NS": ["1", "2"]}), {Decimal(1), Decimal(2)})

    def test_refuses_malformed_attribute_values(self):
        bad = [{"SS": "ab"}, {"NS": "12"}, {"BS": b"ab"}, {"B": 3}, {"B": "AQ=="}, {"BS": ["AQ=="]},
               {"BS": [3]}, {"SS": [1]}, {"L": "x"}, {"M": []}, {"BOOL": 1}, {"NULL": False}, {"S": 1},
               {"N": 1}, {"X": "1"}, {"S": "a", "N": "1"}]
        for av in bad:
            with self.assertRaises(codec.CodecError, msg=repr(av)):
                codec.encode_item("Delphi_JobQueue", {"job_id": {"S": "a"}, "x": av})

    def test_refuses_non_canonical(self):
        head = '{"codec":"delphi-storage-codec/1","family":"Delphi_JobQueue","key":["job_id"]}'
        bad = [
            head + '\n{"job_id":{"S":"a"},"n":{"N":"1.50"}}\n',
            head + '\n{"n":{"N":"1"}, "job_id":{"S":"a"}}\n',
            head + '\n{"job_id":{"S":"a"},"ss":{"SS":["b","a"]}}\n',
            head + '\n{"job_id":{"S":"a"},"ss":{"SS":["a","a"]}}\n',
            head + '\n{"job_id":{"S":"a"},"ss":{"SS":[]}}\n',
            head + '\n{"job_id":{"S":"b"}}\n{"job_id":{"S":"a"}}\n',
            head + '\n{"job_id":{"S":"a"}}\n{"job_id":{"S":"a"}}\n',
            head + '\n{"job_id":{"S":"a"},"b":{"B":"AQ"}}\n',
            head + '\n{"job_id":{"N":"1"}}\n',
            head + '\n{"job_id":{"S":"a"},"x":{"S":"\\u00e9"}}\n',
            head + '\n{"job_id":{"S":"a"},"x":{"S":"\\ud800"}}\n',
            head + '\n{"job_id":{"S":"a"}}',
            head + '\n{"job_id":{"S":"a"},"x":{"Q":"1"}}\n',
            '{"codec":"delphi-storage-codec/2","family":"Delphi_JobQueue","key":["job_id"]}\n',
        ]
        for text in bad:
            with self.assertRaises((codec.CodecError, ValueError), msg=text):
                codec.decode_family(text.encode("utf-8"))
        with self.assertRaises(codec.CodecError):
            codec.encode_family("Delphi_JobQueue", [{"job_id": {"S": "a"}}, {"job_id": {"S": "a"}}])
        with self.assertRaises(codec.CodecError):
            codec.encode_family("Not_A_Table", [{"k": {"S": "a"}}])


if __name__ == "__main__":
    unittest.main()
