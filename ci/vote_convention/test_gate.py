"""Unit checks of the two-convention gate's pure parts (standard library only).

    python3 -m unittest ci/vote_convention/test_gate.py
"""
import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
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
            # The audit's flips the first version missed (d07 run.py:133, startup.py:89,
            # prove_event_ingress.py:32, replay.clj:291 and :353).
            ("rows=[(p, t, -int(r['vote']), c) for r in raw]", "negated-subscript"),
            ("x = -v['vote']", "negated-subscript"),
            ("dict(created=t, pid=p, tid=c, vote=-v, weight_x_32767=None)", "assigned-negation"),
            ("{:pid pid :vote (when (some? sign) (- (long sign)))}", "clojure-negation"),
            ("SELECT count(*) FILTER (WHERE vote = 1) FROM votes", "sql-equals-sign"),
            ("UPDATE votes SET vote=-1 WHERE zid=1", "sql-equals-sign"),
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
        self.assertFalse(sign_lint.in_scope("ci/vote_convention/provision.py"))
        self.assertTrue(sign_lint.in_scope("server/src/report.ts"))
        # Only the loader is exempt in the gate's own directory.
        self.assertTrue(sign_lint.in_scope("ci/vote_convention/compare.py"))
        self.assertTrue(sign_lint.in_scope("ci/vote_convention/engine_leg.py"))


class SignLintOnATree(unittest.TestCase):
    """The lint end to end on a temporary git tree holding a copy of real files."""

    COPIED = ("server/src/report.ts", "ci/vote_convention/compare.py")

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sign-lint-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        for rel in self.COPIED:
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(sign_lint.ROOT / rel, self.root / rel)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        self.git_add()

    def git_add(self):
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)

    def lint(self) -> int:
        with contextlib.redirect_stdout(io.StringIO()):
            return sign_lint.main([], root=self.root)

    def append(self, rel, text):
        with open(self.root / rel, "a") as fh:
            fh.write(text)
        self.git_add()

    def test_todays_copy_passes(self):
        self.assertEqual(self.lint(), 0)

    def test_a_new_literal_next_to_vote_fails(self):
        self.append("server/src/report.ts", "\nexport const isAgree = (row) => row.vote === -1;\n")
        self.assertEqual(self.lint(), 1)

    def test_a_new_literal_in_the_gate_directory_fails(self):
        self.append("ci/vote_convention/compare.py", "\nAGREE = [r for r in rows if r['vote'] == -1]\n")
        self.assertEqual(self.lint(), 1)

    def test_one_more_copy_of_an_allowlisted_line_fails(self):
        allowed = [e for e in json.loads(sign_lint.ALLOWLIST.read_text())["entries"]
                   if e["path"] == "server/src/report.ts" and "vote" in e["text"]]
        self.assertTrue(allowed)
        self.append("server/src/report.ts", "\n" + allowed[0]["text"] + "\n")
        self.assertEqual(self.lint(), 1)

    def test_a_literal_far_from_vote_passes(self):
        self.append("server/src/report.ts", "\n" * 8 + "export const last = (xs) => xs.at(-1);\n")
        self.assertEqual(self.lint(), 0)


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


    def test_a_sign_blind_export_that_changes_is_an_unexpected_red(self):
        import compare

        out = Path(tempfile.mkdtemp(prefix="gate-"))
        self.addCleanup(shutil.rmtree, out, ignore_errors=True)
        for leg, summary, votes in (("v0", "voters,3", "1"), ("v1", "voters,4", "-1")):
            (out / leg / "export").mkdir(parents=True)
            (out / leg / "export" / "00001.summary.csv").write_text(summary)
            (out / leg / "export" / "00001.votes.csv").write_text(votes)
        verdict = compare.compare_v1(out)
        self.assertIn("export/summary.csv", verdict["unexpected"])
        self.assertNotIn("export/votes.csv", verdict["unexpected"])  # expected red
        (out / "v1" / "export" / "00001.summary.csv").write_text("voters,3")
        self.assertNotIn("export/summary.csv", compare.compare_v1(out)["unexpected"])


if __name__ == "__main__":
    unittest.main()
