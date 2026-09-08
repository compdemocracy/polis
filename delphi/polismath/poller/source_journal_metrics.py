"""P-042 slice 0 — mandatory source-journal gauges (emit only, nothing consumes).

Design: ``cost-reduction/04-plans/P-042-commit-ordered-cursor.md`` — the net-new
``Polis/MathSource`` gauges are activation gates. P-031 does not yet publish these
series; wiring a CloudWatch collector, narrowing stats privileges and the alarm
notification remain release work.

SLICE 0 SCOPE. This module only *collects and emits* the gauge values. It is not
wired into any running loop and nothing consumes what it emits. The default sink
is the module logger, which makes the values observable in tests and dev without
any cloud dependency. Alarms, thresholds and drills are the operator's release
work; no thresholds are chosen here (the design invents none).

Two honest slice-0 limitations, documented rather than faked:

* ``ConsumerNoProgressSeconds`` in the design is "age since completed-prefix
  progress while unresolved demand exists". The slice-0 schema persists no
  last-C-advance timestamp, so this collector emits it as the age of the oldest
  *due* unresolved demand per consumer (0 when there is no due demand). The exact
  completed-prefix-progress timestamp is a slice-1 addition.
* All per-consumer gauges emit nothing in slice 0 because slice 0 registers no
  consumer. The cluster gauges (transaction / backend_xmin / prepared age, xid
  distance, journal rows/bytes) — which are what detect the horizon stall the
  design is most sensitive to — are fully computable now.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Dict, List

import sqlalchemy as sa
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger(__name__)

METRIC_NAMESPACE = "Polis/MathSource"

# --------------------------------------------------------------------------- #
# Cluster-scoped SQL (no consumer dimension)
# --------------------------------------------------------------------------- #
_OLDEST_TRANSACTION_AGE_SECONDS = sa.text(
    "SELECT COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - xact_start)), 0) "
    "FROM pg_stat_activity WHERE xact_start IS NOT NULL"
)
_OLDEST_BACKEND_XMIN_AGE_SECONDS = sa.text(
    "SELECT COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - xact_start)), 0) "
    "FROM pg_stat_activity WHERE backend_xmin IS NOT NULL"
)
_OLDEST_PREPARED_AGE_SECONDS = sa.text(
    "SELECT COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - prepared)), 0) "
    "FROM pg_prepared_xacts"
)
# Xid age is allocation distance, not seconds — labelled separately per the design.
_OLDEST_BACKEND_XMIN_XID_DISTANCE = sa.text(
    "SELECT COALESCE(max(age(backend_xmin)), 0) "
    "FROM pg_stat_activity WHERE backend_xmin IS NOT NULL"
)
_JOURNAL_ROWS = sa.text("SELECT count(*) FROM public.math_source_changes")
_JOURNAL_BYTES = sa.text(
    "SELECT pg_total_relation_size('public.math_source_changes')"
)

# --------------------------------------------------------------------------- #
# Per-consumer SQL
# --------------------------------------------------------------------------- #
_CONSUMERS = sa.text(
    "SELECT consumer_id, engine, math_env FROM public.math_source_consumers"
)
_CONSUMER_PENDING_AGES = sa.text(
    "SELECT "
    "  COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - first_dirty_at)), 0) "
    "    AS oldest_pending, "
    "  COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - first_dirty_at) "
    "    FILTER (WHERE zid IS NULL)), 0) AS sweep_pass, "
    "  COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - first_dirty_at) "
    "    FILTER (WHERE next_attempt_at <= clock_timestamp())), 0) AS no_progress "
    "FROM public.math_source_pending WHERE consumer_id=:consumer_id"
)


@dataclass(frozen=True)
class MetricSample:
    """One emitted gauge sample."""

    name: str
    value: float
    unit: str
    dimensions: Dict[str, str] = field(default_factory=dict)


def collect_samples(conn: Connection) -> List[MetricSample]:
    """Collect every mandatory slice-0 gauge from one connection.

    ``ObserverHealthy`` is emitted as 1 because collection ran to completion; a
    missing producer must never be defaulted to healthy by the consumer of these
    series (the alarm treats absent/0 for two periods as unhealthy).
    """
    samples: List[MetricSample] = [
        MetricSample("ObserverHealthy", 1.0, "None"),
        MetricSample(
            "OldestTransactionAgeSeconds",
            float(conn.execute(_OLDEST_TRANSACTION_AGE_SECONDS).scalar_one()),
            "Seconds",
        ),
        MetricSample(
            "OldestBackendXminAgeSeconds",
            float(conn.execute(_OLDEST_BACKEND_XMIN_AGE_SECONDS).scalar_one()),
            "Seconds",
        ),
        MetricSample(
            "OldestPreparedAgeSeconds",
            float(conn.execute(_OLDEST_PREPARED_AGE_SECONDS).scalar_one()),
            "Seconds",
        ),
        MetricSample(
            "XidDistance",
            float(conn.execute(_OLDEST_BACKEND_XMIN_XID_DISTANCE).scalar_one()),
            "Count",
        ),
        MetricSample(
            "JournalRows",
            float(conn.execute(_JOURNAL_ROWS).scalar_one()),
            "Count",
        ),
        MetricSample(
            "JournalBytes",
            float(conn.execute(_JOURNAL_BYTES).scalar_one()),
            "Bytes",
        ),
    ]

    for consumer in conn.execute(_CONSUMERS).mappings().all():
        dims = {
            "ConsumerId": consumer["consumer_id"],
            "Engine": consumer["engine"],
            "MathEnv": consumer["math_env"],
        }
        ages = conn.execute(
            _CONSUMER_PENDING_AGES, {"consumer_id": consumer["consumer_id"]}
        ).mappings().one()
        samples.append(MetricSample(
            "ConsumerNoProgressSeconds", float(ages["no_progress"]), "Seconds", dims))
        samples.append(MetricSample(
            "OldestPendingAgeSeconds", float(ages["oldest_pending"]), "Seconds", dims))
        samples.append(MetricSample(
            "SweepPassAgeSeconds", float(ages["sweep_pass"]), "Seconds", dims))

    return samples


def _log_sink(samples: List[MetricSample]) -> None:
    for s in samples:
        logger.info(
            "metric namespace=%s name=%s value=%s unit=%s dims=%s",
            METRIC_NAMESPACE, s.name, s.value, s.unit, s.dimensions,
        )


def emit_source_journal_metrics(
    engine: Engine,
    sink: Callable[[List[MetricSample]], None] = _log_sink,
) -> List[MetricSample]:
    """Collect and emit the gauges through ``sink`` (default: the module logger).

    Returns the samples so tests and a future collector can assert on them.
    Slice 0 does not schedule this; nothing consumes the emitted series yet.
    """
    with engine.connect() as conn:
        samples = collect_samples(conn)
    sink(samples)
    return samples
