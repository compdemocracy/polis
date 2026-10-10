#!/usr/bin/env python3
"""Regression controls for fresh-image release evolution and corrupt receipts."""
import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "image_proof", pathlib.Path(__file__).with_name("image-proof.py"))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ImageProofTests(unittest.TestCase):
    def setUp(self):
        self.expected = proof.expected_receipts(proof.MIGRATIONS)
        self.rows = [{"name": name, **receipt} for name, receipt in self.expected.items()]

    def test_current_release_includes_adoption(self):
        proof.assert_receipts(self.rows, self.expected)
        self.assertEqual({row["name"][:6] for row in self.rows if row["status"] == "ADOPTED"},
                         proof.RETIRED)
        self.assertTrue(any(row["status"] == "APPLIED" for row in self.rows))

    def test_same_count_wrong_status_refuses(self):
        next(row for row in self.rows if row["status"] == "ADOPTED")["status"] = "APPLIED"
        with self.assertRaises(AssertionError):
            proof.assert_receipts(self.rows, self.expected)

    def test_same_count_wrong_name_refuses(self):
        self.rows[0]["name"] = "999999_unselected.sql"
        with self.assertRaises(AssertionError):
            proof.assert_receipts(self.rows, self.expected)

    def test_same_count_wrong_checksum_refuses(self):
        self.rows[0]["checksum"] = "0" * 64
        with self.assertRaises(AssertionError):
            proof.assert_receipts(self.rows, self.expected)

    def test_missing_receipt_refuses(self):
        with self.assertRaises(AssertionError):
            proof.assert_receipts(self.rows[1:], self.expected)

    def test_extra_receipt_refuses(self):
        with self.assertRaises(AssertionError):
            proof.assert_receipts(self.rows + [{**self.rows[0], "name": "999999_extra.sql"}],
                                  self.expected)

    def test_duplicate_receipt_refuses(self):
        with self.assertRaises(AssertionError):
            proof.assert_receipts(self.rows + [self.rows[0]], self.expected)

    def test_release_grows_and_shrinks_without_count_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            names = ["000000_initial.sql", "000004_drop_waitinglist_table.sql",
                     "000030_future.sql"]
            for name in names:
                (directory / name).write_text("-- synthetic SQL source\n")
            for selected in (names[:2], names, names[:1]):
                with self.subTest(selected=selected):
                    (directory / "release.txt").write_text(
                        "# synthetic release selection\n\n" + "\n".join(selected) + "\n")
                    expected = proof.expected_receipts(directory)
                    self.assertEqual(set(expected), set(selected))
                    self.assertEqual(len(expected), len(selected))
                    proof.assert_receipts([{"name": name, **receipt}
                                           for name, receipt in expected.items()], expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
