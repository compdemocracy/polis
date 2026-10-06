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
            # Positive comparisons through a subscript or a wrapped read (second review R3).
            ("agree = row['vote'] == 1", "equals-one"),
            ('const testAgree = row["vote"] === 1;', "equals-one"),
            ("if int(r['vote']) == 1:", "equals-one"),
            ('if (1 === row["vote"]) {', "equals-one"),
            ("const agree = row.vote === 1;", "equals-one"),
            ("agree = r['vote'] == -1", "equals-minus-one"),
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
            'assert census["null_votes"] == 1',
            "if (x.votes.length === 1) {",
            "assert len(r['votes']) == 1",
            "ok = row['vote'] == 10",
        ]:
            with self.subTest(line=line):
                self.assertIsNone(sign_lint.classify(line))

    def test_allowlist_entries_carry_an_audit_reference(self):
        data = json.loads(sign_lint.ALLOWLIST.read_text())
        self.assertEqual(data["sites"], sum(e["count"] for e in data["entries"]))
        for e in data["entries"]:
            self.assertTrue(e["audit"].startswith(("audit 2026-10-03", "not in the audit", "not in the 2026-10-03 audit")), e)
            self.assertGreater(e["count"], 0)

    def test_chokepoints_are_exempt(self):
        self.assertFalse(sign_lint.in_scope("delphi/polismath/utils/vote_convention.py"))
        self.assertFalse(sign_lint.in_scope("server/src/votes/convention.ts"))
        self.assertFalse(sign_lint.in_scope("ci/vote_convention/provision.py"))
        # The database's own declaration and the test that pins it (PR-A).
        self.assertFalse(sign_lint.in_scope("server/postgres/migrations/000025_vote_convention.sql"))
        self.assertFalse(sign_lint.in_scope("server/postgres/migrations/down/000025_drop_vote_convention.sql"))
        self.assertFalse(sign_lint.in_scope("server/postgres/operations/vote_convention_declare.sql"))
        self.assertFalse(sign_lint.in_scope("server/bin/vote-convention-declare.sh"))
        self.assertFalse(sign_lint.in_scope("server/postgres/migrations/down/test_000025_down.py"))
        # Every other migration, and the startup checks that read the row, stay in scope.
        self.assertTrue(sign_lint.in_scope("server/postgres/migrations/000006_update_votes_rule.sql"))
        self.assertTrue(sign_lint.in_scope("server/src/votes/dbConvention.ts"))
        self.assertTrue(sign_lint.in_scope("delphi/polismath/utils/vote_convention_boot.py"))
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

    def test_a_positive_subscript_comparison_fails_in_python(self):
        self.append("ci/vote_convention/compare.py", "\nagree = row['vote'] == 1\n")
        self.assertEqual(self.lint(), 1)

    def test_a_positive_subscript_comparison_fails_in_ts(self):
        self.append("server/src/report.ts", '\nconst testAgree = (row) => row["vote"] === 1;\n')
        self.assertEqual(self.lint(), 1)

    def test_one_more_copy_of_an_allowlisted_line_fails(self):
        allowed = [e for e in json.loads(sign_lint.ALLOWLIST.read_text())["entries"]
                   if e["path"] == "ci/vote_convention/compare.py" and "vote" in e["text"]]
        self.assertTrue(allowed)
        self.append("ci/vote_convention/compare.py", "\n" + allowed[0]["text"] + "\n")
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


class Ratchet(unittest.TestCase):
    """compare.py v1 --ratchet on a small two-leg tree. The witnesses of the
    second review: each must fail the ratchet, and the base tree must pass."""

    CASE = "pca2/r5_moderator_pca2_f401_populated"
    INVENTORY = {
        "db/00001.votes.json", "export/00001.votes.csv", "export/00001.summary.csv",
        CASE + ".head.json", CASE + ".body",
        "pca2/r5_moderator_pca2_f400_zero-approved.head.json", "pca2/r5_moderator_pca2_f400_zero-approved.body",
    }
    PINNED = {"export/00001.votes.csv", CASE + ".head.json", CASE + ".body"}

    def setUp(self):
        import compare

        self.compare = compare
        self.out = Path(tempfile.mkdtemp(prefix="gate-"))
        self.addCleanup(shutil.rmtree, self.out, ignore_errors=True)
        for leg, sign in (("v0", -1), ("v1", 1)):
            base = self.out / leg
            self.put(leg, "_meta/server-leg.json", json.dumps({"pca2Cases": 2, "exports": 2, "exportFailures": 0}))
            self.put(leg, "engine-leg.json", json.dumps({"replay": {}}))
            self.put(leg, "db/00001.votes.json", json.dumps([{"pid": 0, "tid": 0, "vote": sign, "created": 1},
                                                            {"pid": 1, "tid": 0, "vote": 0, "created": 2}]))
            self.put(leg, "export/00001.votes.csv",
                     f"status 200\ntimestamp,datetime,comment-id,voter-id,vote\n1,d,0,0,{'1' if leg == 'v0' else '-1'}\n2,d,0,1,0")
            self.put(leg, "export/00001.summary.csv", "status 200\ntopic,t\nvoters,2")
            body = json.dumps({"tids": [0, 1, 2, 3, 4, 5], "n": 2,
                               "pca": {"center": [sign * 0.5, 0.25], "comps": [[sign * 0.1, 0.2], [0.3, sign * 0.4]]},
                               "consensus": {"agree": [0, 1] if leg == "v0" else [2], "disagree": []}})
            self.put(leg, self.CASE + ".head.json", json.dumps(
                {"caseId": "c", "status": 200, "headers": {"content-type": "application/json",
                                                         "etag": f"W/{leg}", "content-length": str(len(body))}}))
            self.put(leg, self.CASE + ".body", body)
            self.put(leg, "pca2/r5_moderator_pca2_f400_zero-approved.head.json",
                     json.dumps({"caseId": "z", "status": 200, "headers": {"etag": "W/z"}}))
            self.put(leg, "pca2/r5_moderator_pca2_f400_zero-approved.body", json.dumps({"tids": []}))
            assert base.exists()

    def put(self, leg, rel, text):
        path = self.out / leg / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def verdict(self):
        return self.compare.compare_v1(self.out, inventory=set(self.INVENTORY), pinned=set(self.PINNED))

    def assertFails(self, needle):
        v = self.verdict()
        self.assertFalse(v["ratchet_ok"], v)
        self.assertTrue(any(needle in f for f in v["failures"]), v["failures"])

    def test_the_base_tree_is_expected_red_and_passes(self):
        v = self.verdict()
        self.assertTrue(v["ratchet_ok"], v["failures"])
        self.assertFalse(v["green"])  # the pinned files do differ

    def test_witness_pca2_http_500(self):
        self.put("v1", "pca2/r5_moderator_pca2_f400_zero-approved.head.json",
                 json.dumps({"caseId": "z", "status": 500, "headers": {"etag": "W/z"}}))
        self.assertFails("HTTP 500")

    def test_witness_pca2_500_inside_a_pinned_case(self):
        head = json.loads((self.out / "v1" / (self.CASE + ".head.json")).read_text())
        self.put("v1", self.CASE + ".head.json", json.dumps({**head, "status": 500}))
        self.assertFails("HTTP 500")

    def test_witness_v1_export_exception(self):
        self.put("v1", "export/00001.votes.csv", "status error\nboom")
        self.put("v1", "_meta/server-leg.json", json.dumps({"pca2Cases": 2, "exports": 2, "exportFailures": 1}))
        self.assertFails("export failure")
        self.assertFails("failed (status error)")

    def test_witness_same_output_deleted_from_both_legs(self):
        for leg in ("v0", "v1"):
            (self.out / leg / "db/00001.votes.json").unlink()
        self.assertFails("missing output db/00001.votes.json")

    def test_witness_one_sided_deletion(self):
        (self.out / "v1" / "export/00001.summary.csv").unlink()
        self.assertFails("v1: missing output export/00001.summary.csv")

    def test_witness_must_hold_summary_changes(self):
        self.put("v1", "export/00001.summary.csv", "status 200\ntopic,t\nvoters,3")
        self.assertFails("must-hold")

    def test_an_unpinned_difference_fails(self):
        self.put("v1", "pca2/r5_moderator_pca2_f400_zero-approved.body", json.dumps({"tids": [1]}))
        self.assertFails("not a pinned expected-red case")

    def test_a_pinned_difference_that_is_not_sign_shaped_fails(self):
        self.put("v1", "export/00001.votes.csv",
                 "status 200\ntimestamp,datetime,comment-id,voter-id,vote\n1,d,0,9,-1\n2,d,0,1,0")
        self.assertFails("not a sign-shaped difference")

    def body(self, leg):
        return json.loads((self.out / leg / (self.CASE + ".body")).read_text())

    def put_body(self, leg, obj):
        self.put(leg, self.CASE + ".body", json.dumps(obj))

    def test_witness_pinned_pca_replaced_by_null(self):
        self.put_body("v1", {**self.body("v1"), "pca": None})
        self.assertFails("type dict -> NoneType")

    def test_witness_pinned_tids_emptied(self):
        self.put_body("v1", {**self.body("v1"), "tids": []})
        self.assertFails("tids: identity field changed")

    def test_a_pinned_nested_list_that_changes_length_fails(self):
        b = self.body("v1")
        b["pca"]["comps"][0] = [0.1]
        self.put_body("v1", b)
        self.assertFails("length 2 -> 1")

    def test_a_pinned_nested_key_that_disappears_fails(self):
        b = self.body("v1")
        del b["pca"]["comps"]
        self.put_body("v1", b)
        self.assertFails("keys changed")

    def test_selection_lists_may_change_with_the_sign(self):
        # consensus.agree differs in length in the base tree; that alone passes.
        self.assertTrue(self.verdict()["ratchet_ok"])

    def test_witness_pinned_csv_loses_a_row(self):
        self.put("v1", "export/00001.votes.csv", "status 200\ntimestamp,datetime,comment-id,voter-id,vote\n1,d,0,0,-1")
        self.assertFails("row count 2 -> 1")

    def test_stored_rows_must_differ_by_sign_only(self):
        self.put("v1", "db/00001.votes.json", json.dumps([{"pid": 0, "tid": 0, "vote": -1, "created": 1},
                                                          {"pid": 1, "tid": 0, "vote": 0, "created": 2}]))
        self.assertFails("not a sign change")


class StandInConventionTable:
    """A cursor over a stand-in for PR-A's public.vote_convention: the singleton
    row and its monotonic guard (version + 1, sign changes), or no table at all."""

    def __init__(self, exists=True, row=(0, -1)):
        self.exists, self.row, self.statements, self._result = exists, row, [], None

    def execute(self, sql, params=None):
        self.statements.append(" ".join(sql.split()))
        if "to_regclass('public.vote_convention')" in sql:
            self._result = (self.exists,)
        elif sql.lstrip().startswith("SELECT version, agree_value"):
            assert self.exists
            self._result = self.row
        elif sql.lstrip().startswith("UPDATE public.vote_convention"):
            assert self.exists and "WHERE singleton" in sql
            new = (1, 1)
            if new[0] != self.row[0] + 1 or new[1] == self.row[1]:
                raise RuntimeError("P0782 monotonic guard")
            self.row = new
            self._result = None
        else:
            raise AssertionError(f"unexpected statement: {sql}")

    def fetchone(self):
        return self._result


class ProvisionConventionRow(unittest.TestCase):
    def setUp(self):
        import provision

        self.provision = provision

    def test_v0_leaves_the_seed(self):
        cur = StandInConventionTable()
        self.assertEqual(self.provision.declare_convention(cur, -1), (0, -1))
        self.assertFalse(any(s.startswith("UPDATE") for s in cur.statements))

    def test_v1_applies_the_plans_version_bump(self):
        cur = StandInConventionTable()
        self.assertEqual(self.provision.declare_convention(cur, 1), (1, 1))
        updates = [s for s in cur.statements if s.startswith("UPDATE")]
        self.assertEqual(len(updates), 1)
        for part in ("SET version = 1, agree_value = 1", "changed_at = clock_timestamp()",
                     "changed_by = session_user", "WHERE singleton"):
            self.assertIn(part, updates[0])

    def test_without_the_table_nothing_happens(self):
        for agree in (-1, 1):
            cur = StandInConventionTable(exists=False)
            self.assertIsNone(self.provision.declare_convention(cur, agree))
            self.assertEqual(len(cur.statements), 1)

    def test_a_database_not_at_the_seed_is_refused(self):
        with self.assertRaises(SystemExit):
            self.provision.declare_convention(StandInConventionTable(row=(1, 1)), 1)
        with self.assertRaises(SystemExit):
            self.provision.declare_convention(StandInConventionTable(row=(1, 1)), -1)


if __name__ == "__main__":
    unittest.main()
