"""Codec boundary tests; no database mocks stand in for the separate SQL proof."""
import json
import unittest
from decimal import Decimal

from polismath.delphi_storage.codec import CodecError, decode_family
from polismath.delphi_storage.postgres import family_files, decode_rows


class PostgresResultCodecTest(unittest.TestCase):
    def test_exact_numeric_binary_and_set_roundtrip(self):
        family = "Delphi_CommentEmbeddings"
        rows = [{"conversation_id": "1", "comment_id": Decimal("7"),
                 "embedding": [Decimal("0.1234567890123456789012345678")],
                 "binary": b"\x00\xff", "labels": {"tree", "water"},
                 "document": '{"preserved":"as string"}'}]
        wire = family_files({family: rows})[family]
        self.assertEqual(decode_rows(family, [json.loads(x) for x in wire.splitlines()[1:]]), rows)
        self.assertEqual(decode_family(wire.encode())[0], family)

    def test_empty_family_is_explicit(self):
        family = "Delphi_CommentEmbeddings"
        self.assertEqual(decode_family(family_files({family: []})[family].encode())[1], [])
        self.assertEqual(decode_rows(family, []), [])

    def test_queue_tables_are_not_results(self):
        for family in ["Delphi_JobQueue", "Delphi_JobActiveGuard", "unknown"]:
            with self.subTest(family=family), self.assertRaises(CodecError):
                family_files({family: []})

    def test_duplicate_key_refused(self):
        row = {"conversation_id": "1", "comment_id": 1}
        with self.assertRaises(CodecError):
            family_files({"Delphi_CommentEmbeddings": [row, row]})

    def test_float_refused_instead_of_losing_precision(self):
        with self.assertRaises(CodecError):
            family_files({"Delphi_CommentEmbeddings": [{"conversation_id": "1", "comment_id": 1, "value": 0.25}]})

    def test_read_invalid_tag_refused(self):
        with self.assertRaises(CodecError):
            decode_rows("Delphi_CommentEmbeddings", [{"conversation_id": {"S": "1"}, "comment_id": {"N": "01"}}])


if __name__ == "__main__":
    unittest.main()
