"""No network, credentials, database or cloud calls."""
import copy
import json
import unittest

from contracts import BoundaryError, audit_public_output, decode_job, public_result


def job() -> dict:
    return {"schema": "polis-probe-job/1", "run_id": "a" * 32,
            "producer": {"image": "localhost/polis-producer@sha256:" + "1" * 64,
                         "args": ["produce"]},
            "verifier": {"image": "localhost/polis-verifier@sha256:" + "2" * 64,
                         "args": ["verify"]}, "max_seconds": 18000}


class ContractTests(unittest.TestCase):
    def test_roundtrip(self) -> None:
        value = job()
        self.assertEqual(decode_job(json.dumps(value).encode()), value)

    def test_new_probe_is_an_image_and_arguments(self) -> None:
        value = job()
        value["producer"]["image"] = "registry.invalid/size-probe@sha256:" + "3" * 64
        value["producer"]["args"] = ["measure", "--seed", "42", "$(literal-argument)"]
        self.assertEqual(decode_job(json.dumps(value).encode()), value)

    def test_rejects_mutable_or_unbounded_commands(self) -> None:
        variants = []
        for field, value in (("image", "image:latest"), ("image", "image@sha256:123"),
                             ("args", []), ("args", "produce"), ("args", ["x\nFAIL"]),
                             ("args", ["x"] * 33), ("args", [True])):
            item = job()
            item["producer"][field] = value
            variants.append(item)
        for ceiling in (0, 18001, True, "10"):
            item = job()
            item["max_seconds"] = ceiling
            variants.append(item)
        for item in variants:
            with self.subTest(item=item), self.assertRaises(BoundaryError):
                decode_job(json.dumps(item).encode())

    def test_unknown_fields_and_same_verifier_refused(self) -> None:
        value = job()
        value["secret"] = "never-echo-this"
        with self.assertRaisesRegex(BoundaryError, "^JOB_SCHEMA$"):
            decode_job(json.dumps(value).encode())
        value = job()
        value["verifier"] = copy.deepcopy(value["producer"])
        with self.assertRaisesRegex(BoundaryError, "^SEPARATE_VERIFIER$"):
            decode_job(json.dumps(value).encode())

    def test_duplicate_keys_and_invalid_json_refused(self) -> None:
        for raw in (b'{"run_id":1,"run_id":2}', b'\xff', b'{', b' ' * 20001):
            with self.subTest(raw=raw[:20]), self.assertRaises(BoundaryError):
                decode_job(raw)

    def test_two_exact_public_outcomes(self) -> None:
        for passed in (True, False):
            self.assertIs(audit_public_output(public_result("a" * 32, passed), "a" * 32, []), passed)

    def test_stray_prints_commands_and_details_refused(self) -> None:
        good = public_result("a" * 32, True)
        for raw in (good + b"debug\n", b"secret\n" + good, good + b"\n",
                    good.replace(b"PASS", b"PASS path=/private/result"),
                    good + b"::notice::detail\n", good.replace(b"\n", b"\r\n"),
                    public_result("b" * 32, True), b"PASS\n"):
            with self.subTest(raw=raw), self.assertRaisesRegex(BoundaryError, "^PUBLIC_OUTPUT$"):
                audit_public_output(raw, "a" * 32, [])

    def test_even_empty_named_artifact_refused(self) -> None:
        with self.assertRaisesRegex(BoundaryError, "^PUBLIC_ARTIFACT$"):
            audit_public_output(public_result("a" * 32, True), "a" * 32, ["empty.zip"])


if __name__ == "__main__":
    unittest.main()
