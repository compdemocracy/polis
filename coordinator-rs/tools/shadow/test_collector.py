"""Public accounting and failure controls; clock tests do not claim live days."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

import collector as c
import capture
import daily
import views
import bridge_adapter as bridge
from test_bridge_adapter import request as bridge_request, result_fixture
from test_daily import response


def request():
    return dict(run="1"*32, window=0, start=1000, end=87400, build="2"*64, policy="3"*64)


def profile():
    headers = {"accept": "application/json"}
    requests = [dict(route=dict(method="GET", path="/api/v3/public/"+route,
        request_sha256=capture.request_digest("/api/v3/public/"+route, headers),
        query_sha256="4"*64, unordered=False, **{"class": route}), headers=headers, full_request=None)
        for route in daily.ROUTES]
    return dict(schema="polis-shadow-collector/1", expected_cuts=1,
        expected_routes=dict.fromkeys(daily.ROUTES, 1), observer_expected=1440,
        cuts=[dict(offset=0, custody_file=None, zid=1, requests=requests)], readers={"common": {}}, database={},
        private_directory="/private/public-fixture", observer_file="/private/public-observer",
        environment="public")


class Clock:
    def __init__(self): self.now = 1000
    def wall(self): return self.now
    def monotonic(self): return self.now - 1000
    def sleep(self, duration): self.now += duration


class Collector(unittest.TestCase):
    def test_unknown_legacy_history_never_reads_or_replays(self):
        clock, collect = Clock(), Mock()
        value = c.run_window(request(), profile(), wall=clock.wall,
            monotonic=clock.monotonic, sleep=clock.sleep, collect=collect)
        self.assertEqual(value["verdict"], "INCOMPLETE")
        self.assertEqual(value["residuals"]["cut-unbound-late-row"], 1)
        self.assertEqual(value["windows"], dict(expected=1, bound=0, incomplete=1))
        collect.assert_not_called()

    def test_late_start_has_no_duration_or_observation_credit(self):
        clock = Clock(); clock.now += 0.5
        collect = Mock()
        value = c.run_window(request(), profile(), wall=clock.wall,
            monotonic=clock.monotonic, sleep=clock.sleep, collect=collect)
        self.assertEqual(value["seconds"], 0)
        self.assertEqual(value["residuals"]["cut-unbound-late-row"], 0)
        collect.assert_not_called()

    def test_later_window_refuses_without_matching_confirmed_previous_pass(self):
        for prior in (None, c.pending(request(), profile())):
            clock, collect = Clock(), Mock()
            with patch.object(c, "load", return_value=prior):
                value = c.run_window(request() | {"window": 1}, profile(), wall=clock.wall,
                    monotonic=clock.monotonic, sleep=clock.sleep, collect=collect,
                    previous_receipt="/private/prior" if prior else None)
            self.assertEqual(value["verdict"], "INCOMPLETE")
            self.assertEqual(value["residuals"]["cut-unbound-late-row"], 0)
            collect.assert_not_called()

    def test_prior_confirmed_pass_gate_is_bound_to_run_window_build_policy(self):
        from test_scheduler import profile as schedule_profile, complete
        prior = complete(schedule_profile(), request())
        prior.update(run=request()["run"], window=0, build=request()["build"], policy=request()["policy"], delivery="CONFIRMED")
        prior["verdict"] = daily.receipt_verdict(prior)
        daily.validate_receipt(prior)
        for field in (None, "run", "window", "build", "policy"):
            row = copy.deepcopy(prior)
            if field is not None: row[field] = 9 if field == "window" else "9" * len(row[field])
            clock = Clock()
            with patch.object(c, "load", return_value=row):
                value = c.run_window(request() | {"window": 1}, profile(), wall=clock.wall,
                    monotonic=clock.monotonic, sleep=clock.sleep, previous_receipt="/private/prior")
            self.assertEqual(value["residuals"]["cut-unbound-late-row"], int(field is None))
            self.assertEqual(value["verdict"], "INCOMPLETE")

    def test_short_or_extra_window_refused(self):
        for row in (request() | {"end": 1100}, request() | {"private": "never export"}):
            with self.assertRaises(ValueError): c.pending(row, profile())

    def test_dead_custodian_stays_incomplete(self):
        clock = Clock(); p = profile(); p["cuts"][0]["custody_file"] = "/missing"
        with patch.object(c, "load", side_effect=OSError):
            value = c.run_window(request(), p, wall=clock.wall,
                monotonic=clock.monotonic, sleep=clock.sleep)
        self.assertEqual(value["verdict"], "INCOMPLETE")
        self.assertFalse(value["admission"]["collector"])

    def test_stop_on_byte_difference_without_second_cut(self):
        clock = Clock(); p = profile(); p["cuts"][0]["custody_file"] = "/public"
        collect = Mock(return_value=[("PCA2_FULL", "ENGINE_DIFFERENCE")])
        with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}):
            value = c.run_window(request(), p, wall=clock.wall,
                monotonic=clock.monotonic, sleep=clock.sleep, collect=collect)
        self.assertEqual(value["verdict"], "ENGINE_DIFFERENCE")
        self.assertEqual(value["seconds"], 0)
        self.assertEqual(collect.call_count, 1)

    def test_full_clock_window_needs_separate_delivery_confirmation(self):
        clock = Clock(); p = profile(); p["cuts"][0]["custody_file"] = "/public"
        p["readers"] = dict(python_namespace="public-shadow", common={})
        collect = Mock(return_value=[(route, "EXACT") for route in daily.ROUTES])
        def observer(*args):
            return dict(expected=1440, observed=min(1440, int((clock.now-1000)/60)), alarms=0, unresolved=0)
        with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}), patch.object(c, "observer_counts", side_effect=observer):
            value = c.run_window(request(), p, wall=clock.wall,
                monotonic=clock.monotonic, sleep=clock.sleep, collect=collect)
        self.assertEqual(value["seconds"], 86400)
        self.assertEqual(value["verdict"], "INCOMPLETE")
        local = copy.deepcopy(value); local["delivery"] = "CONFIRMED"
        local["verdict"] = daily.receipt_verdict(local)
        self.assertEqual(daily.validate_receipt(local)["verdict"], "PASS")

    def test_empty_findings_are_counted_and_contract_bound_in_daily_receipt(self):
        clock = Clock(); p = profile(); p["cuts"][0]["custody_file"] = "/public"
        p["readers"] = dict(python_namespace="public-shadow", common={})
        collect = Mock(return_value=[(route, "LEGACY_EMPTY_DEFECT" if route.startswith("PCA2") else "EXACT")
                                     for route in daily.ROUTES])
        def observer(*args):
            return dict(expected=1440, observed=min(1440, int((clock.now-1000)/60)), alarms=0, unresolved=0)
        with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}), patch.object(c, "observer_counts", side_effect=observer):
            value = c.run_window(request(), p, wall=clock.wall,
                monotonic=clock.monotonic, sleep=clock.sleep, collect=collect)
        self.assertEqual(value["empty_contract"], daily._empty.contract_sha256())
        self.assertEqual(value["routes"]["PCA2_FULL"]["LEGACY_EMPTY_DEFECT"], 1)
        value["delivery"] = "CONFIRMED"
        value["verdict"] = daily.receipt_verdict(value)
        self.assertEqual(daily.validate_receipt(value)["verdict"], "PASS")

    def test_prestarted_collector_counts_only_scheduled_window_despite_wakeup_jitter(self):
        clock = Clock(); clock.now = 999.5
        p = profile(); p["cuts"][0]["custody_file"] = "/public"
        p["readers"] = dict(python_namespace="public-shadow", common={})
        def sleep(seconds):
            clock.now += seconds + (0.1 if clock.now < 1000 else 0)
        def observer(*args):
            return dict(expected=1440, observed=min(1440, int((clock.now-1000)/60)), alarms=0, unresolved=0)
        with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}), patch.object(c, "observer_counts", side_effect=observer):
            value = c.run_window(request(), p, wall=clock.wall, monotonic=clock.monotonic,
                sleep=sleep, collect=lambda *_: [(route, "EXACT") for route in daily.ROUTES])
        self.assertEqual(value["seconds"], 86400)
        self.assertTrue(all(value["admission"].values()))
        self.assertEqual(value["observer"]["observed"], 1440)

    def test_clock_change_while_waiting_cannot_earn_credit(self):
        clock = Clock(); clock.now = 999.5
        value = c.run_window(request(), profile(), wall=clock.wall,
            monotonic=lambda: 0, sleep=lambda _: setattr(clock, "now", clock.now-3))
        self.assertEqual(value["seconds"], 0)
        self.assertFalse(any(value["admission"].values()))

    def test_capture_crossing_minute_boundary_uses_current_observer_deadline(self):
        clock = Clock(); p = profile(); p["cuts"][0].update(custody_file="/public", offset=60)
        p["readers"] = dict(python_namespace="public-shadow", common={})
        def collect(*_):
            clock.now += 61
            return [(route, "EXACT") for route in daily.ROUTES]
        def observer(*args):
            return dict(expected=1440, observed=min(1440, int((args[-1]-1000)/60)), alarms=0, unresolved=0)
        with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}), patch.object(c, "observer_counts", side_effect=observer):
            value = c.run_window(request(), p, wall=clock.wall, monotonic=clock.monotonic,
                sleep=clock.sleep, collect=collect)
        self.assertEqual(value["seconds"], 86400)
        self.assertTrue(all(value["admission"].values()))
        self.assertEqual(value["observer"], dict(expected=1440, observed=1440, alarms=0, unresolved=0))

    def test_observer_alarm_stops_before_whole_window(self):
        clock = Clock(); p = profile(); p["cuts"][0]["custody_file"] = "/public"
        p["readers"] = dict(python_namespace="public-shadow", common={})
        with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}), patch.object(c, "observer_counts",
                return_value=dict(expected=1440, observed=1, alarms=1, unresolved=0)):
            value = c.run_window(request(), p, wall=clock.wall,
                monotonic=clock.monotonic, sleep=clock.sleep,
                collect=lambda *_: [(route, "EXACT") for route in daily.ROUTES])
        self.assertEqual(value["seconds"], 60)
        self.assertEqual(value["verdict"], "INCOMPLETE")

    def test_late_capture_and_clock_jump_cannot_earn_window_credit(self):
        for advance in (86401, 86500):
            clock = Clock(); p = profile(); p["cuts"][0]["custody_file"] = "/public"
            def collect(*_):
                clock.now += advance
                return [(route, "EXACT") for route in daily.ROUTES]
            with patch.object(c, "load", return_value={"expected": {"cut": "4"*64, "history": "5"*64}}):
                value = c.run_window(request(), p, wall=clock.wall,
                    monotonic=clock.monotonic, sleep=clock.sleep, collect=collect)
            self.assertEqual(value["verdict"], "INCOMPLETE")
            self.assertEqual(value["windows"]["bound"], 0)
            self.assertEqual(value["routes"]["PCA2_FULL"]["observed"], 0)

    def test_actual_emf_sample_accounting_and_missing_alarm(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/"observer.jsonl"
            rows = [dict(schema="polis-observer/1", Environment="public", MathEnv="shadow",
                         ObserverHealthy=1, PollHealthy=1, PublishLagSeconds=0,
                         UnresolvedOperations=0, MetricsDropped=0, CurrentPointerHealthy=1, code="OK",
                         _aws=dict(Timestamp=(1000+n*60)*1000)) for n in range(-4, 5)]
            path.write_text("\n".join(json.dumps(row) for row in rows)); path.chmod(0o600)
            value = c.observer_counts(str(path), request(), 1440, "public", "shadow", 1300)
            self.assertEqual(value, dict(expected=1440, observed=5, alarms=0, unresolved=0))
            path.write_text("\n".join(json.dumps(row) for row in rows[:4]))
            value = c.observer_counts(str(path), request(), 1440, "public", "shadow", 1300)
            self.assertGreater(value["alarms"], 0)
            self.assertEqual(value["observed"], 0)

    def test_one_failed_observer_sample_has_no_complete_observation_credit(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/"observer.jsonl"
            rows = [dict(schema="polis-observer/1", Environment="public", MathEnv="shadow",
                ObserverHealthy=1, PollHealthy=1, CurrentPointerHealthy=1, code="OK",
                PublishLagSeconds=0, UnresolvedOperations=0, MetricsDropped=0,
                _aws=dict(Timestamp=(1000+n*60)*1000)) for n in range(-4, 5)]
            rows[5].update(ObserverHealthy=0, code="OBSERVER_QUERY")
            path.write_text("\n".join(json.dumps(row) for row in rows)); path.chmod(0o600)
            value = c.observer_counts(str(path), request(), 1440, "public", "shadow", 1300)
            self.assertEqual(value["observed"], 4)
            self.assertEqual(value["alarms"], 0)

    def test_duplicate_wrong_scope_and_future_observer_refuse(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/"observer.jsonl"; path.touch(mode=0o600)
            row = dict(schema="polis-observer/1", Environment="public", MathEnv="shadow",
                       ObserverHealthy=1, PollHealthy=1, PublishLagSeconds=0,
                       UnresolvedOperations=0, MetricsDropped=0, _aws=dict(Timestamp=1000000))
            for rows in ([row, row], [row | {"Environment": "other"}],
                         [row | {"_aws": dict(Timestamp=2000000)}], [row | {"MetricsDropped": 1}]):
                path.write_text("\n".join(json.dumps(item) for item in rows))
                with self.assertRaises(ValueError):
                    c.observer_counts(str(path), request(), 1440, "public", "shadow", 1060)

    def test_keeper_loss_and_error_always_close_connection(self):
        connection = MagicMock(); connection.closed = False
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.side_effect = [(True, False), (0,), (0,), ("00001-00002-1",), (False,)]
        with self.assertRaisesRegex(ValueError, "LOST"):
            with views.Keeper(connection) as keeper: keeper.alive()
        connection.rollback.assert_called_once(); connection.close.assert_called_once()

    def test_elevated_keeper_refuses_before_export(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (True, True)
        with self.assertRaisesRegex(ValueError, "ROLE"):
            with views.Keeper(connection): pass
        self.assertFalse(any("pg_export_snapshot" in str(call) for call in cursor.execute.call_args_list))
        connection.close.assert_called_once()


class BoundWiring(unittest.TestCase):
    """Exercise custody-to-reader wiring with labeled parser-only bridge data."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        req = bridge_request()
        result, event, runtime = result_fixture(req)
        def save(name, raw):
            path = self.root/name; path.write_bytes(raw); path.chmod(0o600)
            return str(path)
        expected = dict(host="public-host", cut=req["cut_sha256"], history=req["history_sha256"],
            node_build="3"*64, node_dependencies="4"*64, node_settings="5"*64,
            clojure_namespace="legacy", python_namespace="shadow-test",
            clojure_runtime=dict(observed=True, threads=1, kernel="legacy-public", libraries=["public"]),
            python_runtime=dict(observed=True, threads=1, kernel=runtime["forced_kernel"], libraries=runtime["blas"]))
        view = dict.fromkeys(views.TABLES, "6"*64)
        legacy = {k: expected[k] for k in ("host", "cut", "history", "node_build", "node_dependencies", "node_settings")}
        legacy.update(lifecycle="warm-continuation/1", namespace="legacy", engine="clojure",
            computing_pid=201, parent_pid=200, runtime=expected["clojure_runtime"],
            bundle=bridge.digest(daily.canonical(view)), read_only=True)
        self.custody = dict(schema="polis-shadow-custody/1", expected=expected, legacy=legacy,
            legacy_view=view, cut_file=save("cut", req["cut_bytes"].encode()),
            replay_request=save("request", bridge.encode(req)), replay_result=save("result", bridge.encode(result)),
            replay_log=save("runtime", bridge.encode(event)+b"\n"), runtime_profile=runtime)
        self.profile = profile()
        self.profile.update(zid=1, requests=self.profile["cuts"][0]["requests"])
        self.profile["readers"] = dict(clojure_namespace="legacy", python_namespace="shadow-test",
            common={k: expected[k] for k in ("node_build", "node_dependencies", "node_settings")})
        self.profile["readers"]["common"]["requests"] = [entry["route"]["request_sha256"] for entry in self.profile["requests"]]
        self.connect = Mock()
        self.keeper = MagicMock(); self.keeper.snapshot = "0001-0002-1"
        self.keeper.__enter__.return_value = self.keeper
        self.launch = MagicMock()
        self.launch.return_value.__enter__.return_value = ({"clojure": {}, "python": {}}, {})

    def tearDown(self): self.temp.cleanup()

    def execute(self, bodies=None):
        with patch.object(c, "host_identity", return_value="public-host"), \
             patch.object(views, "Keeper", return_value=self.keeper), \
             patch.object(c.capture, "pair", return_value=bodies or (response(), response())):
            return c.collect_bound(self.custody, self.profile, str(self.root/"readers"),
                                   connect=self.connect, launch=self.launch)

    def test_empty_classification_reaches_bound_collector(self):
        from test_empty_defect import bodies
        a, b = bodies()
        result = self.execute((response(daily.canonical(a)), response(daily.canonical(b))))
        self.assertEqual(result[:2], [("PCA2_FULL", "LEGACY_EMPTY_DEFECT"),
                                     ("PCA2_SUBSET", "LEGACY_EMPTY_DEFECT")])
        self.assertEqual(result[2], ("PARTICIPANT_MAPPING", "ENGINE_DIFFERENCE"))
        self.keeper.admit_python.assert_called_once()

    def test_actual_adapter_output_is_checked_before_common_view_and_http(self):
        self.assertEqual(self.execute(), [(route, "EXACT") for route in daily.ROUTES])
        self.keeper.admit.assert_called_once_with("legacy", 1, self.custody["legacy_view"])
        self.keeper.admit_python.assert_called_once()
        self.assertEqual(self.launch.call_args.args[1], "0001-0002-1")

    def test_different_host_never_connects(self):
        self.custody["expected"]["host"] = "other"
        with self.assertRaisesRegex(ValueError, "HOST"): self.execute()
        self.connect.assert_not_called()

    def test_cut_mutation_never_connects(self):
        Path(self.custody["cut_file"]).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "CHANGED"): self.execute()
        self.connect.assert_not_called()

    def test_legacy_view_cannot_be_substituted(self):
        self.custody["legacy_view"]["math_main"] = "7"*64
        with self.assertRaisesRegex(ValueError, "VIEW_BINDING"): self.execute()
        self.connect.assert_not_called()

    def test_newer_database_generation_never_launches_readers(self):
        self.keeper.admit_python.side_effect = ValueError("SHADOW_VIEW_CHANGED")
        with self.assertRaisesRegex(ValueError, "VIEW_CHANGED"): self.execute()
        self.launch.assert_not_called()

    def test_one_byte_stops_other_routes(self):
        self.assertEqual(self.execute((response(), response(b"changed"))),
                         [("PCA2_FULL", "ENGINE_DIFFERENCE")])

    def test_identical_auth_denial_and_server_error_are_not_math_coverage(self):
        for status in (401, 403, 404, 500):
            a = response(); a["status"] = status
            with self.subTest(status=status):
                self.assertEqual(self.execute((a, copy.deepcopy(a))), [("PCA2_FULL", "INCOMPLETE")])

    def test_different_error_bodies_are_incomplete_not_engine_evidence(self):
        a, b = response(b'{"error":"left"}'), response(b'{"error":"right"}')
        a["status"] = b["status"] = 500
        self.assertEqual(self.execute((a, b)), [("PCA2_FULL", "INCOMPLETE")])

    def test_unordered_error_rows_cannot_earn_math_credit(self):
        self.profile["requests"] = [self.profile["requests"][-1]]
        entry = self.profile["requests"][0]
        entry["route"]["class"] = "COMMENT_MATH"
        entry["route"]["unordered"] = True
        self.profile["readers"]["common"]["requests"] = [entry["route"]["request_sha256"]]
        for status in (403, 500):
            a, b = response(b'[{"id":1},{"id":2}]'), response(b'[{"id":2},{"id":1}]')
            a["status"] = b["status"] = status
            self.assertEqual(daily.compare(a, b, entry["route"]), "UNORDERED_QUERY_RESIDUAL")
            self.assertEqual(self.execute((a, b)), [("COMMENT_MATH", "INCOMPLETE")])

    def test_equal_html_fallback_or_invalid_json_cannot_fill_a_json_route(self):
        for raw, content_type in ((b"<html>fallback</html>", "text/html"),
                                  (b"not-json", "application/json")):
            a = response(raw); a["content_type"] = content_type
            self.assertEqual(self.execute((a, copy.deepcopy(a))), [("PCA2_FULL", "INCOMPLETE")])


if __name__ == "__main__": unittest.main()
