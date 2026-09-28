"""Public adapter admission controls, not substitute engine/publication success."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import bridge_adapter as b
import daily


def request():
    raw = b.encode(dict(votes=[], comments=[], participants=[], ordering={})).decode()
    return dict(schema="polis-shadow-replay-input/1", host="public-host", legacy_namespace="legacy",
                namespace="shadow-test", zid=1, cut_bytes=raw, cut_sha256=b.digest(raw.encode()),
                history_sha256="2"*64, expected_tick=None, prior_bundle_sha256=None,
                storage_agree_value=-1, reference="public-window-1")


def expected(value):
    return {key: value[key] for key in b.FIELDS - {"schema", "cut_bytes"}}


def result_fixture(value):
    """Parser-only fixture: never executed as an engine or published to a database."""
    main = daily._empty.apply_empty_contract({"public": "main"})
    originals = {key: list(b.encode(main if key == "main" else {"public": key}))
                 for key in ("main", "bidtopid", "ptptstats")}
    checkpoint = dict(input_sha256="3"*64, source_fingerprint=value["cut_sha256"],
                      lifecycle="poller-rebuild-prefix/1", operation_id="public-operation",
                      publisher_epoch=1, original_digests={key: b.digest(bytes(raw)) for key, raw in originals.items()})
    bundle = dict(payloads=dict(originals=originals, **{key: b.strict(bytes(raw)) for key, raw in originals.items()}),
                  math_tick=0, caching_tick=1, checkpoint=checkpoint, publisher_epoch=1, operation_id="public-operation")
    raw = b.encode(bundle).decode()
    result = dict(schema="polis-shadow-replay-result/1", **{k: value[k] for k in
                  ("host", "namespace", "zid", "cut_sha256", "history_sha256", "reference")},
                  lifecycle="poller-rebuild-prefix/1", input_sha256="3"*64,
                  bundle_sha256=b.digest(raw.encode()), bundle_bytes=raw, retained=True, parent_pid=101)
    profile = dict(forced_kernel="not-forced", system="public-system", machine="public-machine",
                   blas=[dict(num_threads=1, architecture="public-kernel")], blas_observed=True)
    event = dict(fields=dict(message="python_worker_runtime", operation_id="public-operation",
                            worker_pid=102, numerical_runtime=b.encode(dict(profile, worker_pid=102)).decode()))
    return result, event, profile


class Admission(unittest.TestCase):
    def test_exact_cut_serialization_is_forwarded(self):
        r = request()
        self.assertEqual(b.strict(b.admit_request(r, expected(r))), r)

    def test_unknown_request_field_refused(self):
        r = request()
        with self.assertRaisesRegex(ValueError, "SCHEMA"):
            b.admit_request(dict(r, fault={}), expected(r))

    def test_cut_mutation_refused(self):
        r = request(); r["cut_bytes"] += " "
        with self.assertRaisesRegex(ValueError, "CUT"):
            b.admit_request(r, expected(r))

    def test_history_namespace_host_substitution_refused(self):
        r = request()
        for key in ("history_sha256", "namespace", "host"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "BINDING"):
                b.admit_request(dict(r, **{key: "changed"}), expected(r))

    def test_serving_namespaces_refused(self):
        for namespace in ("legacy", "prod", "preprod", "dev"):
            r = request(); r["namespace"] = namespace
            with self.subTest(namespace=namespace), self.assertRaisesRegex(ValueError, "NAMESPACE"):
                b.admit_request(r, expected(r))

    def test_duplicate_and_nonfinite_json_refused(self):
        for raw in ('{"zid":1,"zid":2}', '{"vote":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                b.strict(raw)

    def test_boolean_identity_and_polarity_refused(self):
        for key in ("zid", "storage_agree_value", "expected_tick"):
            r = request(); r[key] = True
            with self.subTest(key=key), self.assertRaises(ValueError):
                b.admit_request(r, expected(r))

    def test_prior_generation_requires_bundle_hash(self):
        r = request(); r["expected_tick"] = 0
        with self.assertRaisesRegex(ValueError, "PRIOR"):
            b.admit_request(r, expected(r))
        r["prior_bundle_sha256"] = "4"*64
        b.admit_request(r, expected(r))

    def test_changed_binary_refused_before_process(self):
        r = request()
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory)/"public-binary"; executable.write_bytes(b"public bytes")
            with patch.object(b.subprocess, "Popen") as launch, self.assertRaisesRegex(ValueError, "BINARY"):
                b.run_replay(r, expected(r), result_fixture(r)[2], binary=executable, binary_sha256="0"*64,
                             environment={}, private_directory=Path(directory)/"result")
            launch.assert_not_called()

    def test_cloud_environment_never_forwarded(self):
        r = request()
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory)/"public-binary"; executable.write_bytes(b"public bytes")
            with patch.object(b.subprocess, "Popen") as launch, self.assertRaisesRegex(ValueError, "ENVIRONMENT"):
                b.run_replay(r, expected(r), result_fixture(r)[2], binary=executable, binary_sha256=b.digest(executable.read_bytes()),
                             environment={"AWS_PROFILE": "unwanted"}, private_directory=Path(directory)/"result")
            launch.assert_not_called()


class RetainedResult(unittest.TestCase):
    def setUp(self):
        self.request = request()
        self.result, self.event, self.profile = result_fixture(self.request)

    def admit(self):
        return b.admit_result(b.encode(self.result), b.encode(self.event)+b"\n", self.request, self.profile)

    def test_parser_binds_retained_generation_and_actual_child_shape(self):
        result = self.admit()
        self.assertEqual(result["computing_pid"], 102)
        self.assertEqual(result["runtime"]["threads"], 1)
        self.assertNotIn("verdict", result)

    def test_missing_child_observation_refused(self):
        with self.assertRaisesRegex(ValueError, "RUNTIME_MISSING"):
            b.admit_result(b.encode(self.result), b"", self.request, self.profile)

    def test_duplicate_child_observation_refused(self):
        log = (b.encode(self.event)+b"\n")*2
        with self.assertRaisesRegex(ValueError, "RUNTIME_MISSING"):
            b.admit_result(b.encode(self.result), log, self.request, self.profile)

    def test_parent_pid_cannot_claim_to_compute(self):
        self.event["fields"]["worker_pid"] = 101
        runtime = b.strict(self.event["fields"]["numerical_runtime"]); runtime["worker_pid"] = 101
        self.event["fields"]["numerical_runtime"] = b.encode(runtime).decode()
        with self.assertRaisesRegex(ValueError, "RUNTIME"):
            self.admit()

    def test_kernel_or_thread_mismatch_refused(self):
        for change in (dict(forced_kernel="other"), dict(blas=[dict(num_threads=2)])):
            event = copy.deepcopy(self.event)
            runtime = b.strict(event["fields"]["numerical_runtime"]); runtime.update(change)
            event["fields"]["numerical_runtime"] = b.encode(runtime).decode()
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "RUNTIME"):
                b.admit_result(b.encode(self.result), b.encode(event), self.request, self.profile)

    def test_wrong_operation_runtime_refused(self):
        self.event["fields"]["operation_id"] = "other-operation"
        with self.assertRaisesRegex(ValueError, "RUNTIME_MISSING"):
            self.admit()

    def test_missing_retention_is_not_success(self):
        self.result["retained"] = False
        with self.assertRaisesRegex(ValueError, "RETENTION"):
            self.admit()

    def test_bundle_one_byte_change_refused(self):
        self.result["bundle_bytes"] += " "
        with self.assertRaisesRegex(ValueError, "BUNDLE"):
            self.admit()

    def test_newer_generation_cannot_replace_selected_one(self):
        bundle = b.strict(self.result["bundle_bytes"]); bundle["math_tick"] = 1
        self.result["bundle_bytes"] = b.encode(bundle).decode()
        self.result["bundle_sha256"] = b.digest(self.result["bundle_bytes"].encode())
        with self.assertRaisesRegex(ValueError, "GENERATION"):
            self.admit()

    def test_original_bytes_are_independently_checked(self):
        bundle = b.strict(self.result["bundle_bytes"]); bundle["payloads"]["originals"]["main"][0] = 32
        self.result["bundle_bytes"] = b.encode(bundle).decode()
        self.result["bundle_sha256"] = b.digest(self.result["bundle_bytes"].encode())
        with self.assertRaisesRegex(ValueError, "ORIGINALS"):
            self.admit()

    def test_warm_lifecycle_label_refused(self):
        self.result["lifecycle"] = "warm-continuation/1"
        with self.assertRaisesRegex(ValueError, "RESULT"):
            self.admit()
