"""Delphi queue demand observer (P-003 slice S1) — observe only.

Reads the ``Delphi_JobQueue`` DynamoDB base table with a projected, fully
paginated scan, classifies every row against the P-003 wake table, and
publishes the resulting gauges to the CloudWatch namespace
``Polis/DelphiQueue``.

This function performs **no scaling action**. It holds no Auto Scaling
permission and contains no capacity-mutation code path, not even a disabled
one; capacity reconciliation is slice S7 of the plan and a unit test asserts
that this module never grows an Auto Scaling client.

Design notes that matter for review:

* The **base table** is scanned rather than the three status GSI partitions.
  A ``Query`` against ``StatusCreatedIndex`` cannot see a row that has no
  ``status`` attribute, and the measured table has exactly such rows. The
  scan is a strict superset of the GSI partitions at this scale.
* ``ProjectionExpression`` is a *privacy* control, not a cost control:
  DynamoDB bills a Scan on the pre-projection item size. Growth is therefore
  bounded by **pre-projection bytes**, derived from the billed read units that
  ``ReturnConsumedCapacity=TOTAL`` reports, not by row count or by the size of
  the returned JSON. One eventually-consistent read unit covers 4 KB at 0.5
  units, i.e. 8 KB of billed table data per unit.
* ``job_id`` is read only so that rows can be de-duplicated across pages. It
  is never logged and never becomes a metric dimension.
* A failed or incomplete observation publishes ``ObserverHealthy=0`` and **no**
  demand samples. It must never look like an empty queue.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

try:  # pragma: no cover - boto3 is always present in the Lambda runtime
    import boto3
except ImportError:  # keeps the pure classification importable for unit tests
    boto3 = None

logger = logging.getLogger()
logger.setLevel(logging.INFO)

METRIC_NAMESPACE = "Polis/DelphiQueue"

# DynamoDB bills an eventually-consistent read at 0.5 units per 4 KB of
# pre-projection item data, so one reported capacity unit == 8 KB of table
# bytes actually read. This is the conversion the byte budget uses.
# https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html#Scan.CapacityUnits
BYTES_PER_EVENTUAL_READ_UNIT = 8192

# Statuses the Delphi poller and batch checker actually write.
#   delphi/scripts/job_poller.py:461-470, 503-520, 578-583, 640
#   delphi/umap_narrative/803_check_batch_status.py:235-258
STATUS_PENDING = "PENDING"
STATUS_AWAITING_RECHECK = "AWAITING_RECHECK"
STATUS_PROCESSING = "PROCESSING"
STATUS_LOCKED_FOR_CHECKING = "LOCKED_FOR_CHECKING"
STATUS_COMPLETED = "COMPLETED"
STATUS_FAILED = "FAILED"

# P-003 "Queue observation and wake reconciliation" wake table.
DEMAND_STATUSES = frozenset(
    {STATUS_PENDING, STATUS_AWAITING_RECHECK, STATUS_PROCESSING}
)
# Rows whose age feeds OldestPendingAgeSeconds (oldest actionable age).
ACTIONABLE_STATUSES = frozenset({STATUS_PENDING, STATUS_AWAITING_RECHECK})
TERMINAL_STATUSES = frozenset({STATUS_COMPLETED, STATUS_FAILED})
KNOWN_STATUSES = (
    DEMAND_STATUSES | TERMINAL_STATUSES | frozenset({STATUS_LOCKED_FOR_CHECKING})
)

# Anomaly kinds. Any row carrying at least one of these counts once towards
# AnomalyRows and inhibits retirement in the later slices.
ANOMALY_MISSING_STATUS = "missing_status"
ANOMALY_UNKNOWN_STATUS = "unknown_status"
ANOMALY_MISSING_CREATED_AT = "missing_created_at"
ANOMALY_MALFORMED_TIMESTAMP = "malformed_timestamp"
ANOMALY_STALE_LOCKED = "stale_locked"
ANOMALY_MALFORMED_OWNERSHIP = "malformed_ownership"

ANOMALY_KINDS = (
    ANOMALY_MISSING_STATUS,
    ANOMALY_UNKNOWN_STATUS,
    ANOMALY_MISSING_CREATED_AT,
    ANOMALY_MALFORMED_TIMESTAMP,
    ANOMALY_STALE_LOCKED,
    ANOMALY_MALFORMED_OWNERSHIP,
)

# Only scheduling, ownership and lineage metadata. No text, no conversation or
# report identifiers. "status" and "version" are DynamoDB reserved words.
PROJECTION_ATTRIBUTES = (
    "job_id",
    "status",
    "job_type",
    "created_at",
    "updated_at",
    "started_at",
    "completed_at",
    "lock_expires_at",
    "last_checked",
    "worker_id",
    "version",
)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("Ignoring non-integer %s; using default %s", name, default)
        return default


def _aws(service: str):
    """Build a boto3 client. Only ever called with 'dynamodb' or 'cloudwatch'."""
    if boto3 is None:  # pragma: no cover - unreachable in the Lambda runtime
        raise RuntimeError("boto3 is unavailable; pass an explicit client")
    return boto3.client(service)


class ObservationIncomplete(Exception):
    """The scan could not be completed within its configured budget."""


# --------------------------------------------------------------------------
# Pure classification / aggregation. Unit tested without any AWS calls.
# --------------------------------------------------------------------------


def parse_timestamp(value: Any) -> Optional[datetime]:
    """Parse an ISO-8601 queue timestamp. Returns None if unparseable."""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _age_seconds(when: Optional[datetime], now: datetime) -> Optional[float]:
    if when is None:
        return None
    return max(0.0, (now - when).total_seconds())


def classify_row(row: Mapping[str, Any], now: datetime) -> Dict[str, Any]:
    """Classify one queue row against the P-003 wake table.

    Returns a dict with:
      ``demand``          -- counts towards WakeDemand
      ``locked``          -- LOCKED_FOR_CHECKING (non-demand by itself)
      ``anomalies``       -- list of anomaly kinds (may be empty)
      ``actionable_age``  -- seconds, for PENDING / AWAITING_RECHECK rows
      ``heartbeat_age``   -- seconds since last observed worker progress, for
                             PROCESSING rows (G3 of the round-2 review)
      ``locked_age``      -- seconds since the lock was last refreshed
    """
    anomalies: List[str] = []

    has_status = "status" in row
    status = row.get("status")
    if not has_status or status is None or status == "":
        anomalies.append(ANOMALY_MISSING_STATUS)
        status = None
    elif status not in KNOWN_STATUSES:
        anomalies.append(ANOMALY_UNKNOWN_STATUS)

    created_at_raw = row.get("created_at")
    if created_at_raw is None or created_at_raw == "":
        anomalies.append(ANOMALY_MISSING_CREATED_AT)
        created_at = None
    else:
        created_at = parse_timestamp(created_at_raw)
        if created_at is None:
            anomalies.append(ANOMALY_MALFORMED_TIMESTAMP)

    # Any other timestamp we rely on must parse if it is present at all.
    for field in ("updated_at", "started_at", "lock_expires_at", "last_checked"):
        raw = row.get(field)
        if raw not in (None, "") and parse_timestamp(raw) is None:
            if ANOMALY_MALFORMED_TIMESTAMP not in anomalies:
                anomalies.append(ANOMALY_MALFORMED_TIMESTAMP)

    demand = status in DEMAND_STATUSES
    locked = status == STATUS_LOCKED_FOR_CHECKING

    actionable_age = None
    if status in ACTIONABLE_STATUSES:
        actionable_age = _age_seconds(created_at, now)

    heartbeat_age = None
    if status == STATUS_PROCESSING:
        # The poller has no dedicated heartbeat attribute. It refreshes
        # updated_at on every log flush (job_poller.py:626) and writes
        # started_at when it claims (job_poller.py:508), so the newest of
        # those is the best available evidence of a live owner.
        # created_at is deliberately NOT a progress mark: it says when the job
        # was enqueued, not that anything is still alive. It is used only as a
        # last resort for a row that was never properly claimed, which the
        # ownership check below flags anyway.
        marks = [
            parse_timestamp(row.get("updated_at")),
            parse_timestamp(row.get("started_at")),
        ]
        newest = max((m for m in marks if m is not None), default=None)
        heartbeat_age = _age_seconds(newest if newest is not None else created_at, now)
        # A PROCESSING row with no owner or no lease is malformed ownership:
        # nothing can prove whether the work is live.
        if not row.get("worker_id") or not row.get("lock_expires_at"):
            anomalies.append(ANOMALY_MALFORMED_OWNERSHIP)

    locked_age = None
    if locked:
        lock_expires_at = parse_timestamp(row.get("lock_expires_at"))
        last_checked = parse_timestamp(row.get("last_checked"))
        # Age since the checker last touched the row. created_at is only the
        # fallback for a locked row that was never checked at all.
        locked_age = _age_seconds(
            last_checked if last_checked is not None else created_at, now
        )
        # The checker refreshes lock_expires_at on every pass
        # (803_check_batch_status.py:242). An absent or expired lease means no
        # checker is paired with this row; it is an anomaly to reconcile, never
        # a row to silently treat as completed.
        if lock_expires_at is None or lock_expires_at <= now:
            anomalies.append(ANOMALY_STALE_LOCKED)

    return {
        "demand": demand,
        "locked": locked,
        "anomalies": anomalies,
        "actionable_age": actionable_age,
        "heartbeat_age": heartbeat_age,
        "locked_age": locked_age,
    }


def compute_demand(
    rows: Iterable[Mapping[str, Any]], now: Optional[datetime] = None
) -> Dict[str, Any]:
    """Aggregate classified rows into the observation the adapter returns.

    ``WakeDemand`` is the count of nonterminal work that needs a worker now or
    will need one: PENDING, AWAITING_RECHECK, and PROCESSING at any lease age.
    ``SecondsToNextEligible`` is 0 while there is demand and ``None`` when
    there is none — the null case is exported by omitting the sample, never by
    manufacturing a negative or zero delay.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    seen_job_ids = set()
    wake_demand = 0
    locked_rows = 0
    anomaly_rows = 0
    rows_scanned = 0
    anomaly_counts = {kind: 0 for kind in ANOMALY_KINDS}
    oldest_actionable: Optional[float] = None
    oldest_heartbeat: Optional[float] = None
    oldest_locked: Optional[float] = None

    for row in rows:
        # Count by full job_id so a row appearing on two pages, or moving
        # state mid-scan, cannot be counted twice.
        job_id = row.get("job_id")
        if job_id is not None:
            if job_id in seen_job_ids:
                continue
            seen_job_ids.add(job_id)
        rows_scanned += 1

        result = classify_row(row, now)

        if result["demand"]:
            wake_demand += 1
        if result["locked"]:
            locked_rows += 1
        if result["anomalies"]:
            anomaly_rows += 1
            for kind in result["anomalies"]:
                anomaly_counts[kind] += 1

        for key, current in (
            ("actionable_age", oldest_actionable),
            ("heartbeat_age", oldest_heartbeat),
            ("locked_age", oldest_locked),
        ):
            value = result[key]
            if value is None:
                continue
            if current is None or value > current:
                if key == "actionable_age":
                    oldest_actionable = value
                elif key == "heartbeat_age":
                    oldest_heartbeat = value
                else:
                    oldest_locked = value

    return {
        "complete": True,
        "observedAt": now.isoformat(),
        "WakeDemand": wake_demand,
        "SecondsToNextEligible": 0.0 if wake_demand > 0 else None,
        "OldestPendingAgeSeconds": oldest_actionable,
        "OldestProcessingHeartbeatAgeSeconds": oldest_heartbeat,
        "OldestLockedAgeSeconds": oldest_locked,
        "AnomalyRows": anomaly_rows,
        "LockedForCheckingRows": locked_rows,
        "RowsScanned": rows_scanned,
        "AnomalyCounts": anomaly_counts,
    }


def build_metric_data(
    observation: Mapping[str, Any], dimensions: Sequence[Mapping[str, str]]
) -> List[Dict[str, Any]]:
    """Render an observation as CloudWatch MetricDatum entries.

    Gauges that have no meaningful sample (the age metrics when their set is
    empty, ``SecondsToNextEligible`` when there is no demand) are **omitted**
    rather than published as 0. Alarms on those must use
    ``treatMissingData: notBreaching``.
    """
    dims = list(dimensions)
    timestamp = parse_timestamp(observation.get("observedAt")) or datetime.now(
        timezone.utc
    )

    def datum(name: str, value: float, unit: str) -> Dict[str, Any]:
        return {
            "MetricName": name,
            "Dimensions": dims,
            "Timestamp": timestamp,
            "Value": float(value),
            "Unit": unit,
        }

    if not observation.get("complete"):
        # An incomplete observation publishes health only. Never a zero depth.
        return [datum("ObserverHealthy", 0, "None")]

    data = [
        datum("ObserverHealthy", 1, "None"),
        datum("WakeDemand", observation["WakeDemand"], "Count"),
        datum("AnomalyRows", observation["AnomalyRows"], "Count"),
        datum("LockedForCheckingRows", observation["LockedForCheckingRows"], "Count"),
        datum("RowsScanned", observation["RowsScanned"], "Count"),
    ]
    for name in (
        "SecondsToNextEligible",
        "OldestPendingAgeSeconds",
        "OldestProcessingHeartbeatAgeSeconds",
        "OldestLockedAgeSeconds",
    ):
        value = observation.get(name)
        if value is not None:
            data.append(datum(name, value, "Seconds"))

    # rev3: "validate with actual ConsumedCapacity during S1". Published so the
    # ~139 units/scan estimate and the byte budget can be checked against
    # reality rather than re-derived from the table size.
    consumed = observation.get("consumedCapacityUnits")
    if consumed is not None:
        data.append(datum("ScanConsumedCapacityUnits", consumed, "Count"))
    return data


# --------------------------------------------------------------------------
# AWS plumbing
# --------------------------------------------------------------------------


def _projection() -> Dict[str, Any]:
    names = {f"#a{i}": attr for i, attr in enumerate(PROJECTION_ATTRIBUTES)}
    return {
        "ProjectionExpression": ", ".join(names.keys()),
        "ExpressionAttributeNames": names,
    }


def scan_queue(table_name: str, client=None) -> Dict[str, Any]:
    """Fully paginate a projected scan of the queue base table.

    Bounded by **pre-projection bytes scanned** (converted from the billed read
    units DynamoDB reports, which is what it actually charges), by page count,
    and by a wall-clock deadline. Hitting a budget with pages remaining raises
    ``ObservationIncomplete``: an incomplete read is a failed observation,
    never a truncated one.

    The measured table is ~1.11 MB / ~139 eventual read units per scan, so the
    16 MiB default leaves roughly 15x headroom before the guard fires.
    """
    ddb = client if client is not None else _aws("dynamodb")
    max_bytes = _env_int("MAX_SCAN_BYTES", 16 * 1024 * 1024)
    max_pages = _env_int("MAX_SCAN_PAGES", 100)
    deadline_seconds = _env_int("SCAN_DEADLINE_SECONDS", 30)

    started = time.monotonic()
    kwargs: Dict[str, Any] = {
        "TableName": table_name,
        "ConsistentRead": False,
        "ReturnConsumedCapacity": "TOTAL",
        **_projection(),
    }

    items: List[Dict[str, Any]] = []
    consumed = 0.0
    pages = 0
    last_key = None

    while True:
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        response = ddb.scan(**kwargs)
        pages += 1
        items.extend(response.get("Items", []))
        consumed += float(
            (response.get("ConsumedCapacity") or {}).get("CapacityUnits", 0.0)
        )
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        # Budgets are only checked when pages remain: a scan that finished
        # inside its final page is complete regardless of how large it was.
        scanned_bytes = consumed * BYTES_PER_EVENTUAL_READ_UNIT
        if scanned_bytes > max_bytes:
            raise ObservationIncomplete(
                f"byte budget exceeded: {scanned_bytes:.0f} > {max_bytes} "
                f"pre-projection bytes after {pages} page(s)"
            )
        if pages >= max_pages:
            raise ObservationIncomplete(f"page budget exceeded: {pages} >= {max_pages}")
        if time.monotonic() - started > deadline_seconds:
            raise ObservationIncomplete(
                f"scan deadline exceeded after {pages} page(s)"
            )

    return {
        "items": items,
        "consumedCapacityUnits": consumed,
        "scannedBytes": consumed * BYTES_PER_EVENTUAL_READ_UNIT,
        "pages": pages,
    }


def _plain(item: Mapping[str, Any]) -> Dict[str, Any]:
    """Flatten a low-level DynamoDB item to plain Python values.

    Only S / N / BOOL / NULL appear in the projected attributes; anything else
    is passed through as-is and will simply fail the classifier's type checks,
    which is the conservative outcome.
    """
    out: Dict[str, Any] = {}
    for key, value in item.items():
        if not isinstance(value, Mapping) or len(value) != 1:
            out[key] = value
            continue
        (kind, raw), = value.items()
        if kind == "S":
            out[key] = raw
        elif kind == "N":
            out[key] = float(raw) if "." in str(raw) else int(raw)
        elif kind == "BOOL":
            out[key] = bool(raw)
        elif kind == "NULL":
            out[key] = None
        else:
            out[key] = raw
    return out


def _dimensions() -> List[Dict[str, str]]:
    # Fixed environment / queue / worker-class dimensions only. No job,
    # conversation or report identifiers ever become a dimension.
    return [
        {"Name": "Environment", "Value": os.environ.get("POLIS_ENVIRONMENT", "prod")},
        {
            "Name": "Queue",
            "Value": os.environ.get("DELPHI_QUEUE_TABLE", "Delphi_JobQueue"),
        },
        {
            "Name": "WorkerClass",
            "Value": os.environ.get("DELPHI_WORKER_CLASS", "delphi-small"),
        },
    ]


def publish(metric_data: Sequence[Dict[str, Any]], client=None) -> None:
    cw = client if client is not None else _aws("cloudwatch")
    data = list(metric_data)
    for start in range(0, len(data), 20):
        cw.put_metric_data(
            Namespace=METRIC_NAMESPACE, MetricData=data[start : start + 20]
        )


def lambda_handler(event, context):  # noqa: ARG001 - AWS entry point
    """Observe the queue and publish. Never scales anything."""
    table_name = os.environ.get("DELPHI_QUEUE_TABLE", "Delphi_JobQueue")
    dimensions = _dimensions()

    try:
        scan = scan_queue(table_name)
        rows = [_plain(item) for item in scan["items"]]
        observation = compute_demand(rows)
        observation["consumedCapacityUnits"] = scan["consumedCapacityUnits"]
        observation["scannedBytes"] = scan["scannedBytes"]
        observation["pages"] = scan["pages"]
    except Exception as exc:  # noqa: BLE001 - any failure is an unhealthy read
        logger.error("Observation failed: %s", exc, exc_info=True)
        observation = {"complete": False, "observedAt": datetime.now(timezone.utc).isoformat()}
        try:
            publish(build_metric_data(observation, dimensions))
        except Exception:  # noqa: BLE001
            # Inability to publish is itself alarm-worthy; surface it as a
            # Lambda error so both signals exist.
            logger.error("Failed to publish ObserverHealthy=0", exc_info=True)
            raise
        return observation

    publish(build_metric_data(observation, dimensions))

    # Aggregates only. No job identifiers are ever logged.
    logger.info(
        "observation complete rows=%s wake_demand=%s anomalies=%s locked=%s "
        "read_units=%.1f scanned_bytes=%.0f pages=%s anomaly_counts=%s",
        observation["RowsScanned"],
        observation["WakeDemand"],
        observation["AnomalyRows"],
        observation["LockedForCheckingRows"],
        observation["consumedCapacityUnits"],
        observation["scannedBytes"],
        observation["pages"],
        observation["AnomalyCounts"],
    )
    return observation
