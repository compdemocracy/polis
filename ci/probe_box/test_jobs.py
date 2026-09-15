"""Reviewed release bindings and the operator's fresh-run constructor.

The zero run ID is a template; the operator replaces it before launch. The
first private sizing run uses the allowed campaign ceiling, not a predicted
duration or a claim that the private sample fits the public canary's resources.
"""
import copy
import json
from pathlib import Path
import unittest

from contracts import decode_job, validate_job


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.registry = json.loads(Path(__file__).with_name("jobs.json").read_bytes())
        self.job = self.registry["jobs"]["sampled-paired-battery-v1"]

    def test_sampled_battery_has_reviewed_manifest_digests_and_closed_commands(self):
        self.assertEqual(set(self.registry), {"schema", "jobs"})
        self.assertEqual(self.registry["schema"], "polis-probe-registry/1")
        self.assertEqual(validate_job(self.job), self.job)
        producer = "localhost/polis-probe-producer@sha256:00dbf26aaa933cde422b9f80390fa1154e929968bf5994d92479489146fc4c99"
        verifier = "localhost/polis-probe-verifier@sha256:b6520b3aadafa74c0fcc546cddef99a20e7469ef033b3a85f4fbcac50a24763b"
        self.assertEqual(self.job["reader"], {"image": producer, "args": ["extract"]})
        self.assertEqual(self.job["producer"], {"image": producer, "args": ["produce"]})
        self.assertEqual(self.job["verifier"], {"image": verifier, "args": ["verify"]})
        self.assertNotEqual(producer.split("@", 1)[1], verifier.split("@", 1)[1])
        self.assertEqual(self.job["max_seconds"], 18000)

    def test_fresh_run_changes_only_identity_and_preserves_registry(self):
        original = copy.deepcopy(self.job)
        self.assertEqual(original["run_id"], "0" * 32)
        for run_id in ("1" * 32, "2" * 32):
            job = dict(self.job, run_id=run_id)
            self.assertEqual(decode_job(json.dumps(job).encode()), job)
            self.assertEqual({**job, "run_id": original["run_id"]}, original)
        self.assertEqual(self.job, original)


if __name__ == "__main__":
    unittest.main()
