"""Fixtures declare their vote sign; fixture writers go through one helper (P-078 PR-G).

    PYTHONPATH=delphi python -m unittest ci/vote_convention/test_fixtures_declared.py

Covers the Python fixture vote writer (delphi/tests/vote_fixtures.py), its
JavaScript twin (server/characterization/seed-vote.cjs), every ``*.sign.json``
companion, the declared pca2 draw, the frozen fold oracle's declared-sign
adapter (coordinator-rs/ci/fold_declared.py) and the agree = +1 replay pin set
(coordinator-rs/ci/replay_pins_convention.py). The comparator normalization of
the characterization baseline is tested by
server/characterization/stored-votes.test.cjs.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "delphi", ROOT / "delphi/tests", ROOT / "coordinator-rs/ci", ROOT / "server/characterization"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import vote_fixtures as vf  # noqa: E402

#: Every file that writes vote rows into a database, or hands stored rows to the
#: fold oracle, and the helper it must take the stored number from (PR-G).
WRITERS = {
    # Python tests and tools: delphi/tests/vote_fixtures.py
    "delphi/tests/coordinator/conftest.py": "vote_fixtures",
    "delphi/tests/coordinator/reference_child.py": "vote_fixtures",
    "delphi/tests/coordinator/test_bridge.py": "vote_fixtures",
    "delphi/tests/coordinator/test_bundle_reader.py": "vote_fixtures",
    "delphi/tests/coordinator/test_equivalence.py": "vote_fixtures",
    "delphi/tests/coordinator/test_incremental.py": "vote_fixtures",
    "delphi/tests/coordinator/test_node_reader.py": "vote_fixtures",
    "delphi/tests/coordinator/test_recovery.py": "vote_fixtures",
    "delphi/tests/coordinator/test_rev4_admission.py": "vote_fixtures",
    "delphi/tests/coordinator/test_step1_review_controls.py": "vote_fixtures",
    "delphi/tests/coordinator/test_writer_authority.py": "vote_fixtures",
    "delphi/tests/poller/recovery/conftest.py": "vote_fixtures",
    "delphi/tests/poller/recovery/test_empty_publication.py": "vote_fixtures",
    "delphi/tests/poller/recovery/test_r01_stage_failures.py": "vote_fixtures",
    "delphi/tests/poller/test_backfill_postgres.py": "vote_fixtures",
    "delphi/tests/poller/test_integration_postgres.py": "vote_fixtures",
    "delphi/tests/poller/test_postgres_client_pid_types.py": "vote_fixtures",
    "delphi/tests/poller/test_promotion_postgres.py": "vote_fixtures",
    "delphi/tests/projgate/projection_gate_test.py": "vote_fixtures",
    "delphi/tests/replay_harness/test_poller_equiv_seed.py": "vote_fixtures",
    "delphi/tests/test_certify_bundle_integration.py": "vote_fixtures",
    "delphi/tests/test_generator_vote_copy.py": "vote_fixtures",
    "delphi/tests/test_prodclone_extract.py": "vote_fixtures",
    "delphi/tests/test_pca_column_order.py": "vote_fixtures",
    "ci/probe_box/local/pipeline_seed.py": "vote_fixtures",
    "ci/private_cert/public_revote_columns.py": "vote_fixtures",
    "coordinator-rs/tools/d05/run.py": "vote_fixtures",
    "coordinator-rs/tools/d05/cases.py": "vote_fixtures",
    "coordinator-rs/tools/d07/run.py": "vote_fixtures",
    "coordinator-rs/tools/d07/startup.py": "vote_fixtures",
    "server/characterization/seed-pca2.py": "vote_fixtures",
    "server/postgres/migrations/down/test_000022.sh": "vote_fixtures",
    "ci/vote_convention/fixtures.py": "vote_fixtures",
    # Server seeds and tests: server/characterization/seed-vote.cjs
    "server/characterization/seed-comments.cjs": "seed-vote.cjs",
    "server/__tests__/unit/importProcessorBoundaries.test.ts": "seed-vote.cjs",
}

#: Raw fixtures the plan names (§1d) and the companion that declares each.
COMPANIONS = {
    "delphi/tests/replay_harness/fixtures/near_tie_votes.json": "delphi/tests/replay_harness/fixtures/near_tie_votes.sign.json",
    "delphi/tests/replay_harness/fixtures/revote_column_order.json": "delphi/tests/replay_harness/fixtures/revote_column_order.sign.json",
    "server/characterization/pca2-fixtures.json": "server/characterization/pca2-fixtures.sign.json",
    "server/characterization/artifacts/baseline.json.gz": "server/characterization/artifacts/baseline.sign.json",
    "coordinator-rs/ci/replay-pins.json": "coordinator-rs/ci/replay-pins.sign.json",
    "coordinator-rs/evidence/polarity-public-fixture.json": "coordinator-rs/ci/polarity-public-fixture.sign.json",
}


class FixtureVoteWriter(unittest.TestCase):
    def test_named_votes_store_at_either_convention(self):
        for agree in (-1, 1):
            self.assertEqual(vf.seed_vote("agree", agree), agree)
            self.assertEqual(vf.seed_vote("disagree", agree), -agree)
            self.assertEqual(vf.seed_vote("pass", agree), 0)
            self.assertEqual(vf.seed_vote(vf.AGREE, agree), agree)
            for name in vf.NAMES:
                self.assertEqual(vf.read_vote(vf.seed_vote(name, agree), agree), vf.NAMES[name])

    def test_default_is_the_declared_storage_convention(self):
        from polismath.utils.vote_convention import STORAGE_AGREE_VALUE
        self.assertEqual(vf.convention(), STORAGE_AGREE_VALUE)
        self.assertEqual(vf.seed_vote("agree"), STORAGE_AGREE_VALUE)

    def test_export_cells_are_read_at_the_export_sign(self):
        for agree in (-1, 1):
            self.assertEqual(vf.seed_vote_from_export("1", agree), vf.seed_vote("agree", agree))
            self.assertEqual(vf.seed_vote_from_export(-1, agree), vf.seed_vote("disagree", agree))
            self.assertEqual(vf.seed_vote_from_export(0, agree), 0)

    def test_refusals(self):
        for bad in (True, 2, 1.0, None, "yes"):
            with self.assertRaises(vf.VoteConventionError):
                vf.seed_vote(bad)
        for bad in (0, True, 2, -1.0, "-1"):
            with self.assertRaises(vf.VoteConventionError):
                vf.seed_vote("agree", bad)
        self.assertIsNone(vf.read_vote(None))

    def test_seed_rows_replaces_only_the_vote_column(self):
        self.assertEqual(vf.seed_rows([(3, 4, "agree", 9)], 1), [(3, 4, 1, 9)])

    def test_database_convention_reads_the_row_when_present(self):
        class Cursor:
            def __init__(self, rows):
                self.rows, self.queries = list(rows), []

            def execute(self, sql, *args):
                self.queries.append(sql)

            def fetchone(self):
                return self.rows.pop(0)

        self.assertEqual(vf.database_convention(Cursor([(False,)])), vf.STORAGE_AGREE_VALUE)
        self.assertEqual(vf.database_convention(Cursor([(True,), (1,)])), 1)
        self.assertEqual(vf.database_convention(Cursor([{"present": True}, {"agree_value": -1}])), -1)
        with self.assertRaises(vf.VoteConventionError):
            vf.database_convention(Cursor([(True,), (0,)]))

    def test_shell_form(self):
        out = subprocess.run([sys.executable, str(ROOT / "delphi/tests/vote_fixtures.py"), "agree", "pass", "disagree"],
                             check=True, capture_output=True, text=True).stdout.split()
        self.assertEqual(out, [str(vf.seed_vote(n)) for n in ("agree", "pass", "disagree")])

    def test_javascript_twin_agrees(self):
        script = ("const s=require(process.argv[1]);process.stdout.write(JSON.stringify("
                  "[s.declaredStorageAgreeValue(),...['agree','disagree','pass'].flatMap(v=>[-1,1].map(a=>s.seedVote(v,a)))]))")
        out = json.loads(subprocess.run(["node", "-e", script, str(ROOT / "server/characterization/seed-vote.cjs")],
                                        check=True, capture_output=True, text=True).stdout)
        expected = [vf.convention()] + [vf.seed_vote(v, a) for v in ("agree", "disagree", "pass") for a in (-1, 1)]
        self.assertEqual(out, expected)


class Declarations(unittest.TestCase):
    def test_every_named_raw_fixture_has_a_valid_companion(self):
        for fixture, companion in COMPANIONS.items():
            meta = vf.declaration(ROOT / companion)
            self.assertEqual(Path(meta["fixture_path"]), (ROOT / fixture).resolve(), companion)
            self.assertEqual(meta["storage_agree_value"], -1, companion)

    def test_every_companion_in_the_tree_validates(self):
        listed = subprocess.run(["git", "ls-files", "*.sign.json"], cwd=ROOT, check=True,
                                capture_output=True, text=True).stdout.split()
        self.assertEqual(sorted(listed), sorted(COMPANIONS.values()))
        for companion in listed:
            vf.declaration(ROOT / companion)

    def test_a_changed_fixture_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = ROOT / COMPANIONS["delphi/tests/replay_harness/fixtures/near_tie_votes.json"]
            shutil.copy(src, tmp)
            shutil.copy(src.with_name("near_tie_votes.json"), tmp)
            (Path(tmp) / "near_tie_votes.json").write_text((Path(tmp) / "near_tie_votes.json").read_text() + " ")
            with self.assertRaisesRegex(vf.VoteConventionError, "changed after its sign was declared"):
                vf.load_declared(Path(tmp) / src.name)

    def test_every_writer_goes_through_its_helper(self):
        for path, helper in WRITERS.items():
            self.assertIn(helper, (ROOT / path).read_text(), path)


class Pca2Draw(unittest.TestCase):
    def test_the_shared_draw_is_the_recorded_one(self):
        import numpy as np

        import pca2_votes

        for f in pca2_votes.fixtures()[:12]:
            rng = np.random.RandomState(f["seed"])
            historical = [int(rng.choice([-1, 0, 1], p=[.45, .1, .45]))  # the draw as first recorded
                          for _ in range(f["participants"] * f["comments"])]
            stored = [vf.seed_vote(v, -1) for _, _, v in pca2_votes.semantic_votes(f)]
            self.assertEqual(stored, historical, f["zid"])


class FoldAdapter(unittest.TestCase):
    ROWS = [dict(pid=0, tid=0, vote=-1, created=1), dict(pid=0, tid=1, vote=1, created=2),
            dict(pid=1, tid=0, vote=0, created=3), dict(pid=1, tid=0, vote=1, created=4),
            dict(pid=2, tid=1, vote=-1, created=5), dict(pid=2, tid=1, vote=1, created=5)]

    def setUp(self):
        import fold_declared

        self.fd = fold_declared
        self.oracle = fold_declared.oracle()

    def summary(self, fold):
        return self.fd.fold_summary(fold)

    def test_the_oracle_is_the_pinned_bytes_and_keeps_its_literal(self):
        self.assertEqual(self.oracle.RAW_AGREE, -1)

    def test_identity_at_the_oracles_own_sign(self):
        self.assertEqual(self.summary(self.fd.fold_votes_declared(self.ROWS, storage_agree_value=-1)),
                         self.summary(self.oracle.fold_votes(self.ROWS)))

    def test_rows_stored_at_plus_one_fold_to_the_same_meaning(self):
        mirrored = [{**r, "vote": vf.seed_vote(vf.read_vote(r["vote"], -1), 1)} for r in self.ROWS]
        self.assertNotEqual(mirrored, self.ROWS)
        self.assertEqual(self.summary(self.fd.fold_votes_declared(mirrored, storage_agree_value=1)),
                         self.summary(self.oracle.fold_votes(self.ROWS)))
        # Fed to the oracle directly, the same rows invert: the reason for the adapter.
        self.assertNotEqual(self.summary(self.oracle.fold_votes(mirrored)),
                            self.summary(self.oracle.fold_votes(self.ROWS)))

    def test_semantic_rows_are_rows_declared_at_plus_one(self):
        semantic = [{**r, "vote": vf.read_vote(r["vote"], -1)} for r in self.ROWS]
        self.assertEqual(self.summary(self.fd.fold_votes_declared(semantic, storage_agree_value=vf.AGREE)),
                         self.summary(self.oracle.fold_votes(self.ROWS)))

    def test_refusals(self):
        for bad in (None, 2, True):
            with self.assertRaises(ValueError):
                self.fd.fold_votes_declared([dict(pid=0, tid=0, vote=bad, created=1)], storage_agree_value=-1)
        for bad in (0, True, "1", None):
            with self.assertRaises(ValueError):
                self.fd.fold_votes_declared(self.ROWS, storage_agree_value=bad)

    def test_a_callers_own_oracle_copy_is_used(self):
        calls = []

        class Spy:
            RAW_AGREE = self.oracle.RAW_AGREE

            @staticmethod
            def fold_votes(rows):
                calls.append(rows)
                return "folded"

        self.assertEqual(self.fd.fold_votes_declared(self.ROWS, storage_agree_value=1, fold=Spy), "folded")
        self.assertEqual([r["vote"] for r in calls[0]], [-r["vote"] for r in self.ROWS])


class CoordinatorCoherenceFold(unittest.TestCase):
    """``assert_coherent``'s fold uses the convention the FIXTURE wrote, and
    requires the generation's own declaration to match it (review F2)."""

    def setUp(self):
        import importlib
        from unittest.mock import patch

        import fold_declared

        cf = importlib.import_module("coordinator.conftest")
        self.oracle = fold_declared.oracle()
        for name, value in (("FOLD", self.oracle), ("FOLD_DECLARED", fold_declared)):
            patcher = patch.object(cf, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.cf = cf
        self.rows = [dict(pid=p, tid=t, vote=vf.seed_vote(v), created=10 * p + t)
                     for p, t, v in ((0, 0, "agree"), (0, 1, "disagree"), (1, 0, "pass"), (1, 1, "agree"))]

    def summary(self, fold):
        return {"totals": sorted(fold.per_comment_totals().items()), "events": fold.event_count}

    def test_folds_at_the_written_convention(self):
        written = {"ordering": {"storage_agree_value": vf.convention()}}
        expected = self.summary(self.oracle.fold_votes(
            [{**r, "vote": vf.seed_vote(vf.read_vote(r["vote"]), self.oracle.RAW_AGREE)} for r in self.rows]))
        self.assertEqual(self.summary(self.cf.fold_stored(self.rows, written)), expected)
        self.assertEqual(self.summary(self.cf.fold_stored(self.rows)), expected)

    def test_a_generation_that_misreads_the_sign_fails(self):
        for checkpoint in ({"ordering": {"storage_agree_value": -vf.convention()}}, {"ordering": {}}, {}):
            with self.assertRaises(AssertionError):
                self.cf.fold_stored(self.rows, checkpoint)


class PlusOnePins(unittest.TestCase):
    def setUp(self):
        import replay_pins_convention as rpc

        self.rpc = rpc

    def test_committed_plus_one_set_is_the_generated_one(self):
        self.assertEqual(self.rpc.main(["--check"]), 0)

    def test_both_sets_select_on_every_admitted_platform(self):
        from replay_pins import select_pin

        for key in (("Darwin", "arm64", "not-forced"), ("Linux", "x86_64", "Haswell")):
            runtime = dict(system=key[0], machine=key[1], forced_kernel=key[2], blas=[
                dict(prefix=p, internal_api="openblas", architecture="Haswell", num_threads=1)
                for p in ("libopenblas", "libscipy_openblas")])
            minus, plus = (select_pin(runtime, self.rpc.pins_path(s))["pin"] for s in (-1, 1))
            self.assertEqual(minus["id"], plus["id"])
            self.assertEqual(minus["checkpoints"], plus["checkpoints"])  # convention-invariant, carried
            mw, pw = minus["witnesses"], plus["witnesses"]
            for name in self.rpc.POLARITY:
                self.assertEqual((pw[name]["a"], pw[name]["b"], pw[name]["negative"]),
                                 (mw[name]["b"], mw[name]["a"], mw[name]["negative"]))
            for m, p in zip(mw[self.rpc.SCHEDULE], pw[self.rpc.SCHEDULE]):
                self.assertEqual((p["positive"], p["paired"]), (m["paired"], m["positive"]))
            tie_m, tie_p = mw[self.rpc.TIE_KEY], pw[self.rpc.TIE_KEY]
            self.assertEqual(tie_p["declared"]["storage_agree_value"], 1)
            self.assertEqual(tie_p["declared"]["algorithm_digest"], tie_m["mirrored_digest"])
            self.assertEqual(tie_p["mirrored_digest"], tie_m["declared"]["algorithm_digest"])
            for name, witness in pw.items():
                self.assertEqual(plus["witness_sha256"][name], self.rpc.witness_sha256(witness))

    def test_pins_path_refuses_a_non_convention(self):
        for bad in (0, True, "1"):
            with self.assertRaises(ValueError):
                self.rpc.pins_path(bad)


if __name__ == "__main__":
    unittest.main()
