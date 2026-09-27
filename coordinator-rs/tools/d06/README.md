# Delivery and independent observation

The coordinator uses a bounded JSON-lines transport: at most 128 records of
16 KiB, one independent I/O thread, nonblocking enqueue and a 100 ms shutdown
drain limit. Device failures and queue drops are counted without logging device
errors or payloads. A blocked writer thread is detached at process exit. Daemon reconnect re-admits
the database connection while retaining the same transport and loss counters;
it cannot create a new blocked output worker on each reconnect. This
is best-effort telemetry, not a durable event journal. Missing telemetry cannot
prove a successful publication or a resolved uncertain operation.

The standalone observer uses a separate LOGIN with **only**
`polis_coordinator_observer` membership. It refuses elevated attributes,
extra memberships, any `pc_*` execution and table/column writes. It requires
SELECT on all four math tables from the amended rev7 observer grant. The test template provisions `p027_observer`; deployment credential
provisioning is operator-owned. No migration or existing-table grant is added.

Configure a reviewed JSON profile with these exact keys (public example):

```json
{"environment":"public-fixture","math_env":"rustproto","shards":1,"allowlist":[]}
```

The allowlist is sorted, unique positive integers; empty means the full namespace.
Its digest and the shard count must match the coordinator. Every expected shard
must have a matching completion row, and extra/stale shard configurations refuse
polling health. Run using a credential supplied through the environment:

```sh
python coordinator-rs/tools/d06/observer.py \
  --profile "$OBSERVER_PROFILE" --output "$OBSERVER_LOG"
```

`COORDINATOR_OBSERVER_DATABASE_URL` is required and must use the dedicated LOGIN.
It is never printed. `--once` samples once for local diagnostics. Output is closed
JSON/EMF with fixed Environment/MathEnv dimensions, codes and numeric values;
no conversation IDs, operation IDs, paths, fixture text or payload bytes. No cloud
client or notification send is part of this program.

The observer uses a repeatable-read, read-only transaction, statement timeout
5 seconds and lock timeout 500 ms. Each sample opens a connection with a bounded
connection timeout. The output queue has the same 128-record/16-KiB/100-ms limits.
It never waits for sink I/O. A dead observer or blocked output produces missing
health at the destination. A failed/incomplete query emits ObserverHealthy=0
and **omits** lag; successful complete emptiness is the only source of lag zero.
Database footprint/EXPLAIN on the selected deployment remains an operator gate.

## Meaning of the signals

- `PollHealthy`: all configured shards completed their actual complete source
  sweep successfully, beginning within the last 120 seconds. The coordinator
  records this only after real source processing; the cheap probe reads votes,
  comments and participant moderation together. Full source reads also include
  all three. Deferral, backoff and computation failures conservatively fail the
  sweep. Partial pages cannot refresh health, and restart in mid-sweep cannot
  manufacture a new complete-sweep mark. Empty complete sweeps are healthy.
  Large valid sweeps that exceed this bound require capacity/profile review;
  this flag never grants restart or publication authority.
- `PublishLagSeconds`: oldest admitted operation with **no matching generation
  receipt**, combined with the oldest pending current-table generation described
  below. `AdmittedLagSeconds` and `CurrentLagSeconds` retain each component;
  `PublishLagSeconds` is their maximum. An operation can remain pending after publication, so state alone
  is insufficient. Negative/future/nonfinite times and inconsistent identity
  produce unhealthy observation. Unresolved work is not erased by transitions.
- `ObserverHealthy`: credential, scope, metadata and all queries completed, with no invalid
  current-table pointer or timestamp. Main-ahead, missing ticks, missing or
  mismatched companion pointers emit zero health and omit lag. Poll
  missing/stale is a successfully observed unhealthy producer, not a failed DB
  observation. This is not proof of downstream log delivery.
- `UnresolvedOperations`: still-unresolved operations without a receipt. A later
  resolved operation does not subtract this count. Original outcome telemetry
  `PublishUnresolvedLost` remains a separate monotonic event counter; a later
  `PublishResolvedOwn` cannot cancel it.
- `WithdrawnPendingOperations` and `Transitions`: namespace-bound metadata from
  rev7's writer authority and transition records, without executing predicates.

The P-031 query runs on every sample through the same observer LOGIN and in
its same read-only snapshot. It binds the namespace on every table and applies
the allowlist. A tick with missing main or a higher generation than main is
pending; age comes from `math_ticks.modified` in epoch milliseconds. Null, zero
or future pending timestamps fail observation. The query never reads
`math_ticks.caching_tick` (known schema drift) or any payload. Main ahead of tick,
main without tick, orphan companion rows, and companion generations different
from main fail observation. `CurrentBehind`, `CurrentAhead`,
`CurrentMissingTicks`, `CurrentBundleMismatch` and `CurrentPointerHealthy`
expose only aggregate pointer state. Tick-only lag is a valid observed pending
state; main-ahead is an invalid state. Repair clears the current-table signal.

An admission before first publication is visible in coordinator metadata, while
direct current-table changes can be visible only in the current-table query.
Neither assertion replaces the other. Tests retain both through the actual
observer login, including committed-but-unreconciled operations that have no
publication lag. No signal claims missed-input detection, payload correctness,
scientific parity or downstream notification delivery. Repeated tick increments
can reset the current lag timestamp; metadata does not prove all source events
were ingested. These remain correctness/capacity gates outside D06.

A01/A03 use Minimum <1, 3/5 one-minute periods, missing=breaching. A02 uses
Maximum >600 seconds, 3/5, missing=notBreaching and must be paired with A03.
The local arithmetic helper checks those policies; it does not reproduce every
CloudWatch late-data evaluation behavior. Queue/device failures cannot emit a
trustworthy success through the failed delivery path; missing-data alarms and
operator delivery drills remain necessary. Direct producer outcome loss can
only be recovered from durable operation state, not inferred from later events.

The required campaign retains the D06 tests and `d06-observer.json` receipt.
Actual alarm-to-destination ALARM/OK delivery remains `OPERATOR_NOT_EVALUATED`.
There is no deployed-alarm, private-battery or full-contract acceptance claim.
