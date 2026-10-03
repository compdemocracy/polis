"""Unit checks of the two-convention gate's pure parts (standard library only).

    python3 -m unittest ci/vote_convention/test_gate.py
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sign_lint  # noqa: E402


class SignLintPatterns(unittest.TestCase):
    def test_sign_literals_are_found(self):
        for line, kind in [
            ("const agrees = rows.filter((r) => r.vote === -1);", "equals-minus-one"),
            ("if (vote == 1) { disagree += 1; }", "equals-one"),
            ("return pg_vote * -1", "times-minus-one"),
            ("res.push(String(-row.vote));", "negated-vote"),
            ("if vote < 0:", "sign-test"),
            ("votes.append((pid, tid, -1, created))", "minus-one"),
            ("(filter #(= -1 (:vote %)) votes)", "minus-one"),
        ]:
            with self.subTest(line=line):
                self.assertEqual(sign_lint.classify(line), kind)

    def test_index_and_count_idioms_are_not_signs(self):
        for line in [
            "last = votes[-1]",
            "tail = votes[:-1]",
            "rev = mat[:, ::-1]",
            "x = arr.reshape(-1, 1)",
            "if (votes.indexOf(tid) === -1) {",
            "assert len(votes) == 1",
            "since = t - 1",
            "- Vote data, one row per vote",
            "user-vote-counts",
        ]:
            with self.subTest(line=line):
                self.assertIsNone(sign_lint.classify(line))

    def test_allowlist_entries_carry_an_audit_reference(self):
        data = json.loads(sign_lint.ALLOWLIST.read_text())
        self.assertEqual(data["sites"], sum(e["count"] for e in data["entries"]))
        for e in data["entries"]:
            self.assertTrue(e["audit"].startswith(("audit 2026-10-03", "not in the audit")), e)
            self.assertGreater(e["count"], 0)

    def test_chokepoints_are_exempt(self):
        self.assertFalse(sign_lint.in_scope("delphi/polismath/utils/vote_convention.py"))
        self.assertFalse(sign_lint.in_scope("server/src/votes/convention.ts"))
        self.assertTrue(sign_lint.in_scope("server/src/report.ts"))


class SameButSign(unittest.TestCase):
    def test_rows_must_differ_by_sign_only(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "delphi"))
        try:
            import compare
        except ImportError as exc:  # compare imports the fixture module only lazily
            self.skipTest(str(exc))
        v0 = json.dumps([{"pid": 0, "tid": 1, "vote": -1}, {"pid": 1, "tid": 1, "vote": 0},
                         {"pid": 2, "tid": 1, "vote": None}]).encode()
        good = json.dumps([{"pid": 0, "tid": 1, "vote": 1}, {"pid": 1, "tid": 1, "vote": 0},
                           {"pid": 2, "tid": 1, "vote": None}]).encode()
        bad = json.dumps([{"pid": 0, "tid": 1, "vote": -1}, {"pid": 1, "tid": 1, "vote": 0},
                          {"pid": 2, "tid": 1, "vote": None}]).encode()
        self.assertTrue(compare.same_but_sign(v0, good)[0])
        self.assertFalse(compare.same_but_sign(v0, bad)[0])


if __name__ == "__main__":
    unittest.main()
