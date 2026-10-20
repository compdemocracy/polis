import csv
import importlib.util
import os
import stat
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("join_example", Path(__file__).resolve().parents[2] / "examples/join-member-votes.py")
JOIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JOIN)


class JoinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.write("members", ["xid", "member_label"], [["001", "North, 雪"], ["unused", "No votes"]])
        self.write("xids", ["pid", "xid", "vote_count"], [["0", "001", "2"], ["7", "not-a-member", "1"], ["8", "", "1"]])
        self.write("votes", ["voter-id", "vote", "comment-id"], [["0", "original-export-value", "3"], ["0", "other-export-value", "3"], ["7", "unchanged", "3"], ["8", "unchanged", "3"], ["9", "unchanged", "3"]])

    def write(self, name, headers, rows):
        with (self.root / name).open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(headers)
            writer.writerows(rows)

    def run_join(self):
        JOIN.join(*(self.root / p for p in ["members", "xids", "votes", "output"]))

    def test_left_join_preserves_votes_duplicates_order_and_string_ids(self):
        self.run_join()
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE((self.root / "output").stat().st_mode), 0o600)
        with (self.root / "output").open(encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 5)
        self.assertEqual([r["member_match"] for r in rows], ["matched", "matched", "no_member", "no_xid", "no_xid"])
        self.assertEqual(rows[0]["xid"], "001")
        self.assertEqual(rows[0]["member_label"], "North, 雪")
        _, original = JOIN.read(self.root / "votes", {"vote"})
        self.assertEqual([{k: row[k] for k in original[0]} for row in rows], original)

    def test_duplicate_member_key_refused_without_output(self):
        self.write("members", ["xid", "member_label"], [["001", "a"], ["001", "b"]])
        with self.assertRaises(ValueError): self.run_join()
        self.assertFalse((self.root / "output").exists())

    def test_duplicate_pid_refused_without_output(self):
        self.write("xids", ["pid", "xid"], [["0", "001"], ["0", "002"]])
        with self.assertRaises(ValueError): self.run_join()
        self.assertFalse((self.root / "output").exists())

    def test_no_overwrite(self):
        (self.root / "output").write_text("keep")
        with self.assertRaises(FileExistsError): self.run_join()
        self.assertEqual((self.root / "output").read_text(), "keep")

    def test_missing_duplicate_headers_and_short_rows_refused(self):
        for content in ["pid\n0\n", "pid,xid,xid\n0,a,b\n", "pid,xid\n0\n"]:
            (self.root / "xids").write_text(content)
            with self.assertRaises(ValueError): self.run_join()
            self.assertFalse((self.root / "output").exists())

    def test_output_column_collision_refused(self):
        self.write("votes", ["voter-id", "vote", "xid"], [["0", "unchanged", "existing"]])
        with self.assertRaises(ValueError): self.run_join()
        self.assertFalse((self.root / "output").exists())
