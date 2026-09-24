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
        producer = "localhost/polis-probe-producer@sha256:8cde9e9d249d526d34ce00452b8654efa373d961d9ccc5a2a86efdbca97f97b2"
        verifier = "localhost/polis-probe-verifier@sha256:e56b2289f0c0209023e1f0d695ca6dec9a6f1c8e3481f75d7132d75c969199fa"
        self.assertEqual(self.job["reader"], {"image": producer, "args": ["extract"]})
        self.assertEqual(self.job["producer"], {"image": producer, "args": ["produce"]})
        self.assertEqual(self.job["verifier"], {"image": verifier, "args": ["verify"]})
        self.assertNotEqual(producer.split("@", 1)[1], verifier.split("@", 1)[1])
        self.assertEqual(self.job["max_seconds"], 43200)

    def test_fresh_run_changes_only_identity_and_preserves_registry(self):
        original = copy.deepcopy(self.job)
        self.assertEqual(original["run_id"], "0" * 32)
        for run_id in ("1" * 32, "2" * 32):
            job = dict(self.job, run_id=run_id)
            self.assertEqual(decode_job(json.dumps(job).encode()), job)
            self.assertEqual({**job, "run_id": original["run_id"]}, original)
        self.assertEqual(self.job, original)

    def test_roles_census_has_three_admitted_images_and_closed_actions(self):
        job = self.registry["jobs"]["roles-census-v1"]
        self.assertEqual(validate_job(job), job)
        self.assertEqual((job["schema"], job["kind"], job["max_seconds"]),
                         ("polis-probe-job/2", "roles-census", 900))
        # Actual OCI manifests exported from reviewed source 9a0c124d9.
        digests = {
            "reader": "d345ec92b0839fa54a8c6b5906e7072513411022e6ff6bb99768a78bd9d7e201",
            "producer": "4961595bf001151fe80517e5cd1989beb1e2e470e403b89ad355be026c4656f1",
            "verifier": "8478ba5cb98603c027743ab65a116c481f6590a2a0d417815b0da79d919c3ae2",
        }
        for role, action in (("reader", "read"), ("producer", "produce"), ("verifier", "verify")):
            self.assertEqual(job[role], {
                "image": f"localhost/polis-roles-{role}@sha256:{digests[role]}",
                "args": [action],
            })
        self.assertEqual(len(set(digests.values())), 3)

    def test_roles_census_fresh_identity_preserves_image_bindings(self):
        original = copy.deepcopy(self.registry["jobs"]["roles-census-v1"])
        self.assertEqual(original["run_id"], "0" * 32)
        job = dict(original, run_id="3" * 32)
        self.assertEqual(decode_job(json.dumps(job).encode()), job)
        self.assertEqual({**job, "run_id": original["run_id"]}, original)
        self.assertEqual(self.registry["jobs"]["roles-census-v1"], original)


if __name__ == "__main__":
    unittest.main()
