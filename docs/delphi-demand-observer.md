# Delphi demand observer

A scheduled Lambda that watches the Delphi job queue and publishes what it sees
to CloudWatch. It is **observe-only**: it holds no Auto Scaling permission, it
contains no capacity-mutation code, and it changes nothing about how the Delphi
workers run today.

It exists because CPU utilisation is not evidence that a worker can be
terminated. Before the small Delphi pool can be allowed to scale to zero, we
need a durable, measured answer to "is there outstanding work?" that survives a
worker dying, a job being enqueued by another job rather than by an HTTP
request, and rows that no status index can see. This Lambda produces that
answer and nothing else.

It is off by default. See [Enabling it](#enabling-it).

## What it measures

Every 60 seconds it runs one projected, fully paginated `Scan` of the
`Delphi_JobQueue` DynamoDB table, classifies each row, and publishes gauges to
the CloudWatch namespace **`Polis/DelphiQueue`**.

The base table is scanned rather than the status GSI partitions on purpose. A
`Query` against `StatusCreatedIndex` cannot return a row that has no `status`
attribute, and the table currently holds exactly such rows. A scan sees them.

### Row classification

| Row state | Counts as demand? | Notes |
|---|---|---|
| `PENDING` | Yes | Waiting for a claim. |
| `AWAITING_RECHECK` | Yes | The poller has no due-time scheduling, so a recheck row needs a worker now. |
| `PROCESSING`, any lease age | Yes | Recovering a vanished owner needs a worker even before the 15-minute lease expires. |
| `LOCKED_FOR_CHECKING` | No, by itself | A parent/checker coordination state, not a ready unit of compute. Counted and aged separately, and paired against its checker (below). |
| `COMPLETED` / `FAILED` | No | Terminal. |
| Missing or unknown `status`, malformed scheduling/ownership fields | No | Counted as an anomaly. Unknown work must inhibit retirement, never be inferred as absent. |

Anomaly kinds, all of which contribute to `AnomalyRows`:

- `missing_status` — no `status` attribute, or an empty one
- `unknown_status` — a status the poller does not write
- `missing_created_at` — nothing to age the row by
- `malformed_timestamp` — a timestamp field that will not parse
- `stale_locked` — `LOCKED_FOR_CHECKING` whose lease is absent or expired
- `unpaired_locked` — `LOCKED_FOR_CHECKING` with no live checker descendant, whatever its lease says
- `malformed_ownership` — `PROCESSING` with no `worker_id` or no lease

A row with several anomalies counts once towards `AnomalyRows`; the per-kind
breakdown goes to the log line.

### Parent/checker pairing

A `LOCKED_FOR_CHECKING` row is a parent waiting on a provider batch. Its checker
is a *separate row* that points back at it: `801_narrative_report_batch.py`
writes a row with `job_type=AWAITING_NARRATIVE_BATCH` and
`batch_job_id=<parent job_id>`, and the poller runs that row against the parent.

So a locked parent is classified by looking for a live descendant, not by its
lease. If no non-terminal row references it, it is `unpaired_locked` — nothing
is going to advance it. An unexpired lease is not evidence to the contrary,
because nothing renews the lease once the checker is gone; that is why the
stale-lease rule alone could not see this case.

A descendant with an unknown or missing status counts as live, deliberately:
assuming unclassifiable work has finished is the one error that loses jobs. It
raises its own anomaly regardless.

Pairing needs one extra projected attribute, `batch_job_id`, which costs
nothing — see [Cost](#cost). The provider's own batch identifier is not
projected; the in-table edge is all the pairing needs.

### Duplicate observations

A `Scan` has no snapshot isolation, so the same `job_id` can be returned more
than once and in more than one state. Repeat observations of one job are merged
conservatively — demand and anomalies OR together, ages take the maximum —
rather than resolved by arrival order. Arrival order is not a state authority:
a terminal row read before a pending row for the same job must not erase that
job's demand. The result of an observation does not depend on the order rows
came back in.

No single scan, however complete, certifies that retirement is safe.

### Metrics

Namespace `Polis/DelphiQueue`. Fixed dimensions on every datum:
`Environment`, `Queue`, `WorkerClass`. No job, conversation or report
identifier is ever a dimension, a log field, or a metric.

| Metric | Unit | Meaning |
|---|---|---|
| `ObserverHealthy` | None | 1 for a complete observation, 0 for a failed or budget-truncated one. |
| `WakeDemand` | Count | Rows needing a worker now or on recovery. The number the wake decision will eventually read. |
| `SecondsToNextEligible` | Seconds | 0 while there is demand. **Omitted** when there is none. |
| `OldestPendingAgeSeconds` | Seconds | Age of the oldest actionable (`PENDING` / `AWAITING_RECHECK`) row. Omitted when there are none. |
| `OldestProcessingHeartbeatAgeSeconds` | Seconds | Time since the newest progress mark (`updated_at`, else `started_at`) on any `PROCESSING` row. Omitted when there are none. |
| `AnomalyRows` | Count | Rows failing at least one triage rule. |
| `LockedForCheckingRows` | Count | `LOCKED_FOR_CHECKING` rows, valid ones included. |
| `OldestLockedAgeSeconds` | Seconds | Age of the least recently checked locked row. Omitted when there are none. |
| `RowsScanned` | Count | Distinct `job_id`s seen this pass. |
| `ScanConsumedCapacityUnits` | Count | Billed read units the scan actually cost, for validating the cost model and the growth guard. |

Two rules about absent samples:

- **A failed observation publishes `ObserverHealthy=0` and nothing else.** It
  never publishes `WakeDemand=0`. A scan error must not be readable as an empty
  queue.
- **Age gauges are omitted, not zeroed, when their set is empty.** Alarms built
  on them must use `treatMissingData: notBreaching` — and note that this alone
  does not immediately clear an alarm, since CloudWatch may still evaluate
  older actual datapoints in the window. No automated action should key on an
  omitted age alone; pair it with an explicit no-demand condition and with
  fresh `ObserverHealthy` / `Errors` / missing-sample alarms.

### Which alarm detects a dead worker

`OldestProcessingHeartbeatAgeSeconds` is the **primary** crash detector, and it
is the reason the metric exists.

A worker that dies while holding a claimed row leaves that row in `PROCESSING`
forever. `PROCESSING` counts as demand at any lease age, so `WakeDemand` stays
at 1 permanently — which means the planned "instance is InService, protected,
and `WakeDemand=0` for 20 minutes" alarm can *never* fire for precisely the
crash it was written to catch. That ceiling is **secondary** coverage, useful
only for a crash while idle. Watch the heartbeat age.

Lambda `Throttles` are informational, not an error condition: with reserved
concurrency 1, a duplicate scheduled delivery throttles by design and the next
invocation simply reads current state. Alarm on `Errors` and on missing
`ObserverHealthy` samples instead.

No alarms are created by this change. The metrics come first so that thresholds
can be set from observed behaviour rather than guessed.

## Enabling it

Everything is behind a CDK context flag that defaults to **false**. Absent, or
anything other than the literal string `true`, means off.

```bash
cd cdk

# Off (default): the synthesized template is byte-identical to one without
# this feature at all.
npx cdk synth

# On: adds a Lambda, its log group, a dedicated role and policy, an
# EventBridge rule and the rule's invoke permission. Nothing else changes.
npx cdk synth -c enableDelphiDemandObserver=true

# Always confirm the ASG is untouched before deploying.
npx cdk diff -c enableDelphiDemandObserver=true
```

Configuration is by Lambda environment variable, all with working defaults:

| Variable | Default | Purpose |
|---|---|---|
| `DELPHI_QUEUE_TABLE` | `Delphi_JobQueue` | Table to scan. |
| `POLIS_ENVIRONMENT` | `prod` | `Environment` metric dimension. |
| `DELPHI_WORKER_CLASS` | `delphi-small` | `WorkerClass` metric dimension. |
| `MAX_SCAN_BYTES` | 16 MiB | Pre-projection byte budget per invocation. |
| `MAX_SCAN_PAGES` | 100 | Page budget per invocation. |
| `SCAN_DEADLINE_SECONDS` | 30 | Wall-clock budget per invocation. |

Exceeding any budget while pages remain fails the observation rather than
truncating it: `ObserverHealthy=0`, no demand sample. If that starts happening,
the table has outgrown a per-invocation full scan and needs a reviewed
audit/cursor design — not a bigger budget.

### Permissions

The observer gets its own role. It is deliberately *not* the shared
`instanceRole`, and it holds exactly three statements:

```json
{"Effect": "Allow", "Action": "dynamodb:Scan",
 "Resource": "arn:aws:dynamodb:us-east-1:<account>:table/Delphi_JobQueue"}

{"Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
 "Condition": {"StringEquals": {"cloudwatch:namespace": "Polis/DelphiQueue"}}}

{"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
 "Resource": "<its own log group>"}
```

`cloudwatch:PutMetricData` supports no resource-level permissions at all. The
`Resource: "*"` is unavoidable and the `cloudwatch:namespace` condition key is
the only thing that constrains it — written as a resource ARN the policy would
simply never match, and written as a bare `*` it would grant the entire
account's metric namespace.

There is **no** `dynamodb:Query`, no write of any kind, no secrets access, no
`autoscaling:*` and no attached AWS managed policy.

## Cost

At the measured table size (255 items, 1,134,230 bytes, PAY_PER_REQUEST) and a
60-second schedule — 43,200 invocations per month:

| Component | Basis | $/month |
|---|---|---|
| DynamoDB scans | 1.11 MB ÷ 8 KB ≈ **139 eventually-consistent read units** per scan × 43,200 = 6.0M RRU at $0.125/M | **0.75** |
| CloudWatch custom metrics | 6 on a fully quiet queue (7 on today's table, which has locked rows), up to 10 when every age gauge has samples, at $0.30 each. Budget the full 10: a series published once can persist for the month. | **1.80 – 3.00** |
| `PutMetricData` requests | 43,200 at $0.01 per 1,000 | **0.43** |
| Lambda | 43,200 × 256 MB × ~1 s ≈ 10,800 GB-s (free tier usually absorbs this) | **0.00 – 0.19** |
| CloudWatch Logs | ~13 MB ingest | **0.01** |
| **Total** | | **≈ $3.00 – 4.40** |

Two things worth knowing about that DynamoDB line:

- **The projection is a privacy control, not a cost control.** DynamoDB bills a
  `Scan` on the *pre-projection* item size, so restricting the returned
  attributes limits what the observer can see but not what it pays. The
  projection is there because the observer has no business reading job payloads
  or `logs` blobs. Growth is bounded in bytes, from the reported consumed
  capacity, for the same reason — and adding an attribute to the projection,
  as the parent/checker pairing does, costs nothing.
- **Queue reads go down overall, not up.** Each running worker's poller today
  runs three fully paginated GSI queries *every 2 seconds*. One scan per minute
  is a small fraction of that.

## Source

- Handler: `cdk/lambda/delphi-demand-observer/index.py`
- Infrastructure: `cdk/delphiDemandObserver.ts`, role in `cdk/iamRoles.ts`
- Tests: `cdk/test/python/test_delphi_demand_observer.py` (classification),
  `cdk/test/delphi-demand-observer.test.ts` (template and IAM shape)

Run them with:

```bash
cd cdk
python3 -m unittest discover -s test/python   # no boto3 or AWS required
npx jest
```
