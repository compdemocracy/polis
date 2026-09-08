"""Unit tests for the Delphi demand observer's classification (P-003 S1).

Pure functions only: no AWS calls, no boto3 session, no network.

Run from the `cdk` directory with either:
    python3 -m unittest discover -s test/python -v
    python3 -m pytest test/python -v
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "lambda", "delphi-demand-observer"),
)

import index  # noqa: E402


NOW = datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc)


def iso(minutes_ago):
    return (NOW - timedelta(minutes=minutes_ago)).isoformat()


def iso_ahead(minutes):
    return (NOW + timedelta(minutes=minutes)).isoformat()


def row(job_id, status=index.STATUS_PENDING, **overrides):
    """A well-formed row of the given status, before overrides."""
    item = {"job_id": job_id, "status": status, "created_at": iso(30), "version": 1}
    if status == index.STATUS_PROCESSING:
        item.update(
            {
                "worker_id": "worker-a",
                "started_at": iso(5),
                "updated_at": iso(1),
                "lock_expires_at": iso_ahead(10),
            }
        )
    if status == index.STATUS_LOCKED_FOR_CHECKING:
        item.update({"last_checked": iso(1), "lock_expires_at": iso_ahead(10)})
    if status in (index.STATUS_COMPLETED, index.STATUS_FAILED):
        item.update({"started_at": iso(20), "completed_at": iso(10)})
    item.update(overrides)
    return item


class TestStatusCoverage(unittest.TestCase):
    """Every status the poller and batch checker write, one fixture each."""

    def test_known_statuses_match_the_poller(self):
        # job_poller.py:461-470, 503-520, 578-583, 640 and
        # 803_check_batch_status.py:235-258.
        self.assertEqual(
            index.KNOWN_STATUSES,
            frozenset(
                {
                    "PENDING",
                    "AWAITING_RECHECK",
                    "PROCESSING",
                    "LOCKED_FOR_CHECKING",
                    "COMPLETED",
                    "FAILED",
                }
            ),
        )

    def test_pending_is_demand(self):
        result = index.classify_row(row("j1", index.STATUS_PENDING), NOW)
        self.assertTrue(result["demand"])
        self.assertEqual(result["anomalies"], [])
        self.assertAlmostEqual(result["actionable_age"], 1800.0)

    def test_awaiting_recheck_is_demand(self):
        # The finder has no due-time scheduling, so a recheck row needs a
        # worker now, not at some future eligibility.
        result = index.classify_row(row("j2", index.STATUS_AWAITING_RECHECK), NOW)
        self.assertTrue(result["demand"])
        self.assertEqual(result["anomalies"], [])
        self.assertAlmostEqual(result["actionable_age"], 1800.0)

    def test_processing_is_demand_at_any_lease_age(self):
        fresh = index.classify_row(row("j3", index.STATUS_PROCESSING), NOW)
        expired = index.classify_row(
            row("j4", index.STATUS_PROCESSING, lock_expires_at=iso(60)), NOW
        )
        self.assertTrue(fresh["demand"])
        self.assertTrue(expired["demand"])
        # Neither is an anomaly: an expired lease is ordinary zombie recovery,
        # and recovery is exactly what needs a worker.
        self.assertEqual(expired["anomalies"], [])

    def test_locked_for_checking_is_not_demand_by_itself(self):
        result = index.classify_row(row("j5", index.STATUS_LOCKED_FOR_CHECKING), NOW)
        self.assertFalse(result["demand"])
        self.assertTrue(result["locked"])
        self.assertEqual(result["anomalies"], [])

    def test_completed_and_failed_are_not_demand(self):
        for status in (index.STATUS_COMPLETED, index.STATUS_FAILED):
            with self.subTest(status=status):
                result = index.classify_row(row("j6", status), NOW)
                self.assertFalse(result["demand"])
                self.assertEqual(result["anomalies"], [])

    def test_processing_rows_do_not_contribute_actionable_age(self):
        # OldestPendingAgeSeconds is the oldest *actionable* age; a claimed row
        # is tracked by its heartbeat instead.
        result = index.classify_row(row("j7", index.STATUS_PROCESSING), NOW)
        self.assertIsNone(result["actionable_age"])


class TestAnomalies(unittest.TestCase):
    def test_attribute_less_row(self):
        # The measured table holds rows with no status/created_at/job_type at
        # all. No GSI query can see them; only a base-table scan can.
        result = index.classify_row({"job_id": "j8"}, NOW)
        self.assertFalse(result["demand"])
        self.assertIn(index.ANOMALY_MISSING_STATUS, result["anomalies"])
        self.assertIn(index.ANOMALY_MISSING_CREATED_AT, result["anomalies"])

    def test_unknown_status(self):
        result = index.classify_row(row("j9", "SOMETHING_ELSE"), NOW)
        self.assertFalse(result["demand"])
        self.assertEqual(result["anomalies"], [index.ANOMALY_UNKNOWN_STATUS])

    def test_empty_status_string_counts_as_missing(self):
        result = index.classify_row(row("j10", ""), NOW)
        self.assertIn(index.ANOMALY_MISSING_STATUS, result["anomalies"])

    def test_stale_locked_for_checking_expired_lease(self):
        result = index.classify_row(
            row(
                "j11",
                index.STATUS_LOCKED_FOR_CHECKING,
                lock_expires_at=iso(90),
                last_checked=iso(120),
            ),
            NOW,
        )
        self.assertFalse(result["demand"])
        self.assertTrue(result["locked"])
        self.assertEqual(result["anomalies"], [index.ANOMALY_STALE_LOCKED])
        self.assertAlmostEqual(result["locked_age"], 7200.0)

    def test_locked_for_checking_with_no_lease_is_unpaired(self):
        item = row("j12", index.STATUS_LOCKED_FOR_CHECKING)
        del item["lock_expires_at"]
        result = index.classify_row(item, NOW)
        self.assertEqual(result["anomalies"], [index.ANOMALY_STALE_LOCKED])

    def test_processing_without_owner_is_malformed_ownership(self):
        item = row("j13", index.STATUS_PROCESSING)
        del item["worker_id"]
        result = index.classify_row(item, NOW)
        # Still demand — an unownable claimed row is exactly the recovery case.
        self.assertTrue(result["demand"])
        self.assertEqual(result["anomalies"], [index.ANOMALY_MALFORMED_OWNERSHIP])

    def test_malformed_timestamp(self):
        result = index.classify_row(row("j14", created_at="not-a-date"), NOW)
        self.assertIn(index.ANOMALY_MALFORMED_TIMESTAMP, result["anomalies"])
        self.assertIsNone(result["actionable_age"])

    def test_malformed_timestamp_on_a_secondary_field(self):
        result = index.classify_row(row("j15", updated_at="not-a-timestamp"), NOW)
        self.assertIn(index.ANOMALY_MALFORMED_TIMESTAMP, result["anomalies"])


class TestHeartbeatAge(unittest.TestCase):
    """G3: a worker dying while holding PROCESSING keeps demand >= 1 forever.

    WakeDemand can therefore never fall to 0 and the protected-idle ceiling can
    never trip. The heartbeat age is the metric that actually detects it.
    """

    def test_uses_the_newest_progress_mark(self):
        result = index.classify_row(
            row(
                "j16",
                index.STATUS_PROCESSING,
                created_at=iso(600),
                started_at=iso(300),
                updated_at=iso(7),
            ),
            NOW,
        )
        self.assertAlmostEqual(result["heartbeat_age"], 420.0)

    def test_dead_worker_holding_processing_shows_a_growing_age(self):
        item = row(
            "j17",
            index.STATUS_PROCESSING,
            started_at=iso(240),
            updated_at=iso(240),
            lock_expires_at=iso(225),
        )
        observation = index.compute_demand([item], now=NOW)
        # Demand stays at 1 indefinitely — that is the trap G3 describes.
        self.assertEqual(observation["WakeDemand"], 1)
        self.assertAlmostEqual(
            observation["OldestProcessingHeartbeatAgeSeconds"], 14400.0
        )

    def test_falls_back_to_started_at_when_no_log_flush_happened(self):
        item = row("j18", index.STATUS_PROCESSING, started_at=iso(45))
        del item["updated_at"]
        result = index.classify_row(item, NOW)
        self.assertAlmostEqual(result["heartbeat_age"], 2700.0)

    def test_no_processing_rows_means_no_heartbeat_sample(self):
        observation = index.compute_demand([row("j19", index.STATUS_PENDING)], now=NOW)
        self.assertIsNone(observation["OldestProcessingHeartbeatAgeSeconds"])


class TestComputeDemand(unittest.TestCase):
    def test_mixed_queue(self):
        rows = [
            row("a", index.STATUS_PENDING, created_at=iso(90)),
            row("b", index.STATUS_PENDING, created_at=iso(10)),
            row("c", index.STATUS_AWAITING_RECHECK, created_at=iso(45)),
            row("d", index.STATUS_PROCESSING),
            row("e", index.STATUS_LOCKED_FOR_CHECKING),
            row("f", index.STATUS_COMPLETED),
            row("g", index.STATUS_FAILED),
        ]
        observation = index.compute_demand(rows, now=NOW)
        self.assertTrue(observation["complete"])
        self.assertEqual(observation["WakeDemand"], 4)
        self.assertEqual(observation["LockedForCheckingRows"], 1)
        self.assertEqual(observation["AnomalyRows"], 0)
        self.assertEqual(observation["RowsScanned"], 7)
        self.assertEqual(observation["SecondsToNextEligible"], 0.0)
        self.assertAlmostEqual(observation["OldestPendingAgeSeconds"], 5400.0)

    def test_empty_queue_publishes_zero_demand_and_no_delay(self):
        observation = index.compute_demand([], now=NOW)
        self.assertEqual(observation["WakeDemand"], 0)
        # Null is exported by omitting the sample, never as a negative or a
        # manufactured zero delay.
        self.assertIsNone(observation["SecondsToNextEligible"])
        self.assertIsNone(observation["OldestPendingAgeSeconds"])

    def test_terminal_only_queue_is_zero_demand(self):
        rows = [row("a", index.STATUS_COMPLETED), row("b", index.STATUS_FAILED)]
        observation = index.compute_demand(rows, now=NOW)
        self.assertEqual(observation["WakeDemand"], 0)
        self.assertIsNone(observation["SecondsToNextEligible"])

    def test_duplicate_job_ids_across_pages_are_counted_once(self):
        rows = [row("dup", index.STATUS_PENDING), row("dup", index.STATUS_PROCESSING)]
        observation = index.compute_demand(rows, now=NOW)
        self.assertEqual(observation["RowsScanned"], 1)
        self.assertEqual(observation["WakeDemand"], 1)

    def test_measured_five_row_anomaly_shape(self):
        """Reproduces the shape the reviewer measured on the live table.

        227 COMPLETED, 23 FAILED, 3 stale LOCKED_FOR_CHECKING and 2 rows with
        no status attribute -> AnomalyRows == 5, WakeDemand == 0.
        """
        rows = [row(f"c{i}", index.STATUS_COMPLETED) for i in range(227)]
        rows += [row(f"f{i}", index.STATUS_FAILED) for i in range(23)]
        rows += [
            row(
                f"l{i}",
                index.STATUS_LOCKED_FOR_CHECKING,
                lock_expires_at=iso(50000),
                last_checked=iso(50000),
            )
            for i in range(3)
        ]
        rows += [{"job_id": "x0"}, {"job_id": "x1"}]

        observation = index.compute_demand(rows, now=NOW)
        self.assertEqual(observation["RowsScanned"], 255)
        self.assertEqual(observation["WakeDemand"], 0)
        self.assertEqual(observation["AnomalyRows"], 5)
        self.assertEqual(observation["LockedForCheckingRows"], 3)
        self.assertEqual(observation["AnomalyCounts"][index.ANOMALY_STALE_LOCKED], 3)
        self.assertEqual(observation["AnomalyCounts"][index.ANOMALY_MISSING_STATUS], 2)

    def test_a_row_with_several_anomalies_counts_once(self):
        rows = [{"job_id": "z", "status": "WAT"}]
        observation = index.compute_demand(rows, now=NOW)
        self.assertEqual(observation["AnomalyRows"], 1)
        self.assertEqual(observation["AnomalyCounts"][index.ANOMALY_UNKNOWN_STATUS], 1)
        self.assertEqual(
            observation["AnomalyCounts"][index.ANOMALY_MISSING_CREATED_AT], 1
        )


class TestMetricRendering(unittest.TestCase):
    DIMS = [{"Name": "Environment", "Value": "prod"}]

    def _by_name(self, data):
        return {d["MetricName"]: d["Value"] for d in data}

    def test_complete_observation_publishes_the_expected_metric_set(self):
        observation = index.compute_demand(
            [row("a", index.STATUS_PENDING), row("b", index.STATUS_PROCESSING)],
            now=NOW,
        )
        observation["consumedCapacityUnits"] = 139.0
        data = index.build_metric_data(observation, self.DIMS)
        names = self._by_name(data)
        self.assertEqual(
            set(names),
            {
                "ObserverHealthy",
                "WakeDemand",
                "AnomalyRows",
                "LockedForCheckingRows",
                "RowsScanned",
                "SecondsToNextEligible",
                "OldestPendingAgeSeconds",
                "OldestProcessingHeartbeatAgeSeconds",
                "ScanConsumedCapacityUnits",
            },
        )
        self.assertEqual(names["ObserverHealthy"], 1.0)
        self.assertEqual(names["WakeDemand"], 2.0)
        self.assertEqual(names["ScanConsumedCapacityUnits"], 139.0)

    def test_empty_queue_omits_the_age_samples_but_states_zero_demand(self):
        data = index.build_metric_data(index.compute_demand([], now=NOW), self.DIMS)
        names = self._by_name(data)
        self.assertEqual(names["WakeDemand"], 0.0)
        self.assertNotIn("SecondsToNextEligible", names)
        self.assertNotIn("OldestPendingAgeSeconds", names)
        self.assertNotIn("OldestProcessingHeartbeatAgeSeconds", names)

    def test_incomplete_observation_publishes_health_only(self):
        # A failed or truncated read must never look like an empty queue.
        data = index.build_metric_data(
            {"complete": False, "observedAt": NOW.isoformat()}, self.DIMS
        )
        names = self._by_name(data)
        self.assertEqual(names, {"ObserverHealthy": 0.0})

    def test_dimensions_carry_no_identifiers(self):
        observation = index.compute_demand([row("secret-job-id")], now=NOW)
        data = index.build_metric_data(observation, self.DIMS)
        self.assertTrue(all(d["Dimensions"] == self.DIMS for d in data))


class TestScanBudget(unittest.TestCase):
    class FakeDdb:
        """Returns `pages` pages, each reporting `units_per_page` capacity."""

        def __init__(self, pages, units_per_page=139.0, items_per_page=1):
            self.pages = pages
            self.units_per_page = units_per_page
            self.items_per_page = items_per_page
            self.calls = 0

        def scan(self, **kwargs):
            self.calls += 1
            last = self.calls >= self.pages
            response = {
                "Items": [
                    {"job_id": {"S": f"p{self.calls}-{i}"}, "status": {"S": "PENDING"}}
                    for i in range(self.items_per_page)
                ],
                "ConsumedCapacity": {"CapacityUnits": self.units_per_page},
            }
            if not last:
                response["LastEvaluatedKey"] = {"job_id": {"S": f"p{self.calls}"}}
            return response

    def test_single_page_scan_is_complete(self):
        fake = self.FakeDdb(pages=1, units_per_page=139.0, items_per_page=3)
        result = index.scan_queue("Delphi_JobQueue", client=fake)
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(result["pages"], 1)
        self.assertAlmostEqual(result["consumedCapacityUnits"], 139.0)
        self.assertAlmostEqual(
            result["scannedBytes"], 139.0 * index.BYTES_PER_EVENTUAL_READ_UNIT
        )

    def test_projection_excludes_payload_attributes(self):
        fake = self.FakeDdb(pages=1)
        index.scan_queue("Delphi_JobQueue", client=fake)
        self.assertNotIn("logs", index.PROJECTION_ATTRIBUTES)
        self.assertNotIn("conversation_id", index.PROJECTION_ATTRIBUTES)
        self.assertNotIn("result", index.PROJECTION_ATTRIBUTES)

    def test_byte_budget_failure_is_incomplete_not_truncated(self):
        os.environ["MAX_SCAN_BYTES"] = str(16 * 1024)  # 2 read units
        try:
            fake = self.FakeDdb(pages=5, units_per_page=139.0)
            with self.assertRaises(index.ObservationIncomplete):
                index.scan_queue("Delphi_JobQueue", client=fake)
        finally:
            del os.environ["MAX_SCAN_BYTES"]

    def test_page_budget_failure(self):
        os.environ["MAX_SCAN_PAGES"] = "2"
        try:
            fake = self.FakeDdb(pages=10, units_per_page=0.5)
            with self.assertRaises(index.ObservationIncomplete):
                index.scan_queue("Delphi_JobQueue", client=fake)
        finally:
            del os.environ["MAX_SCAN_PAGES"]

    def test_a_large_but_single_page_scan_is_not_failed(self):
        # Budgets are only enforced while pages remain.
        os.environ["MAX_SCAN_BYTES"] = "1"
        try:
            fake = self.FakeDdb(pages=1, units_per_page=9999.0)
            result = index.scan_queue("Delphi_JobQueue", client=fake)
            self.assertEqual(result["pages"], 1)
        finally:
            del os.environ["MAX_SCAN_BYTES"]


class TestItemFlattening(unittest.TestCase):
    def test_flattens_dynamodb_typed_values(self):
        flat = index._plain(
            {
                "job_id": {"S": "j"},
                "status": {"S": "PENDING"},
                "version": {"N": "3"},
                "worker_id": {"NULL": True},
            }
        )
        self.assertEqual(flat["status"], "PENDING")
        self.assertEqual(flat["version"], 3)
        self.assertIsNone(flat["worker_id"])

    def test_flattened_attribute_less_row_still_classifies(self):
        flat = index._plain({"job_id": {"S": "j"}})
        result = index.classify_row(flat, NOW)
        self.assertIn(index.ANOMALY_MISSING_STATUS, result["anomalies"])


class TestNoScalingCode(unittest.TestCase):
    """S1 is observe-only: the scaling path must not exist, not even disabled."""

    def test_module_has_no_autoscaling_surface(self):
        source_path = os.path.join(
            os.path.dirname(index.__file__), os.path.basename(index.__file__)
        )
        with open(source_path, encoding="utf-8") as handle:
            source = handle.read()
        for forbidden in (
            "SetDesiredCapacity",
            "set_desired_capacity",
            "update_auto_scaling_group",
            "boto3.client(\"autoscaling\")",
            "boto3.client('autoscaling')",
        ):
            self.assertNotIn(forbidden, source, f"S1 must not reference {forbidden}")


class TestTimestampParsing(unittest.TestCase):
    def test_accepts_z_suffix_and_naive_values(self):
        self.assertEqual(
            index.parse_timestamp("2026-09-08T12:00:00Z"),
            datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            index.parse_timestamp("2026-09-08T12:00:00"),
            datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc),
        )

    def test_rejects_junk_without_raising(self):
        for value in ("", None, "yesterday", 17, {"S": "x"}):
            self.assertIsNone(index.parse_timestamp(value))

    def test_clock_skew_does_not_produce_a_negative_age(self):
        result = index.classify_row(row("future", created_at=iso(-15)), NOW)
        self.assertEqual(result["actionable_age"], 0.0)


if __name__ == "__main__":
    unittest.main()
