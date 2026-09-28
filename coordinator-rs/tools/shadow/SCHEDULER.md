# Daily receipt scheduler

`scheduler.py` is a dormant executable around the adjacent `collector.py` and
`daily.py` receipt contract. It schedules fixed 86,400-second windows, invokes
the real collector, and publishes only a closed receipt. Neither the scheduler
nor elapsed time creates bound input history or successful reader evidence.
An absent legacy custody binding closes the collector immediately with
`cut-unbound-late-row` and `INCOMPLETE`; the scheduler publishes that result and
stops scheduling. Database writes and bridge replay belong to a separately
authorized process; the collector receives read-only database credentials.

## Private profiles and requests

The scheduler profile has exactly these fields. Values below demonstrate the
shape only; hashes must identify the reviewed build and policy, and the bucket
and key must be the admitted private evidence destination.

```json
{
  "schema": "polis-shadow-schedule/1",
  "run": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "build": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policy": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "start_epoch": 2000000000,
  "days": 7,
  "bucket": "private-evidence",
  "prefix": "shadow",
  "kms_key": "reviewed-key",
  "collector_profile": "/run/shadow/collector.json",
  "expected_cuts": 1,
  "expected_routes": {
    "PCA2_FULL": 1,
    "PCA2_SUBSET": 1,
    "PARTICIPANT_MAPPING": 1,
    "COMMENT_MATH": 1,
    "REPORT_READ": 1
  },
  "observer_expected": 1440
}
```

Every route class and cut count must be positive. The current collector requires
1,440 independently observed minute samples per day. Each collector cut supplies
its own `offset`, `custody_file`, `zid`, and `requests`; aggregate expected route
counts must equal the scheduler profile. No default custody file exists.
Observer, request, body, authentication, database and custody files remain
private. A null custody entry is the explicit incomplete configuration.

The scheduler creates a private immutable request with exactly
`run, window, start, end, build, policy`; window ordinals begin at zero and
`start = start_epoch + window * 86400`. The production command is fixed:

```text
python3 -B collector.py --profile FROZEN_PROFILE --request REQUEST --output OUTPUT
```

For every window after zero the command also includes
`--previous-receipt STATE/window-NNNNN/confirmed-receipt.json`, naming the
immediately preceding window. That file is created only after the scheduler
derives and validates a confirmed local PASS. Before its first scheduled cut,
the next collector validates that receipt's exact run/build/policy and previous
window identity. Missing, incomplete, uncertain or foreign evidence refuses
capture; a pending remote receipt cannot unlock the gate.

The collector profile's exact bytes are frozen as `collector-profile.json` in
the state directory before the first invocation. Their SHA-256 binding remains
local. Changes during the run refuse a subsequent collection. The scheduler
passes only `PATH`, locale/timezone settings, `PYTHONDONTWRITEBYTECODE=1`, and
`SHADOW_COLLECTOR_ENABLE=1`. Publisher credential environment variables, shell
commands, `NODE_OPTIONS`, and `PYTHONPATH` are not inherited. This environment
filter is not a separate IAM boundary: same-task metadata credentials still
require an appropriately restricted task role.

Only validated PENDING receipts with the exact run/window/build/policy and
expected cut/route/observer counts are admitted. Reported seconds cannot exceed
elapsed time or a day. Missing, dead, invalid, underscoped, or interrupted
collection yields a receipt with zero observations and all admissions false.
An interrupted request is never silently collected again across the gap.

## Immutable publication and reconciliation

The private state directory must belong to the executing user and have mode
0700. Run and per-window bindings are create-only mode-0400 files, installed
atomically and fsynced. An exclusive local lock covers the whole scheduled run.
Use a durable local filesystem that supports hard links, directory fsync and
`flock`; do not share one run across hosts. These protections detect accidental
rebinding and record-chain corruption, not a privileged actor rewriting state.

The object key is `PREFIX/RUN/window-00000.json`. Before PUT, the scheduler
durably records the receipt SHA and destination binding. `daily.publish` sends
canonical bytes with `IfNoneMatch: *` and the explicit KMS key. There is at most
one application PUT attempt per window. SDK retries are disabled. A lost ACK is
reconciled by exact byte equality with GET. On restart, an existing publication
intent always permits GET only, including when the process died before PUT.
No replacement key or automatic retry can hide uncertainty.

Each outcome appends a new immutable `delivery-NNNN.json` containing exactly
`schema, run, window, sequence, action, outcome, receipt_sha256,
previous_sha256`. Outcomes are `CONFIRMED`, `FAILED`, or `UNCERTAIN`; sequence
numbers and predecessor SHA values form a locally checked chain. CONFIRMED and
FAILED are terminal. At most 1,024 records are allowed. Missing/unreadable
remote bytes remain UNCERTAIN; different bytes are FAILED.

The remote receipt remains PENDING and therefore INCOMPLETE: delivery cannot be
asserted inside the bytes being delivered. The separate local delivery record
derives a confirmed view using `daily.receipt_verdict`. Only that validated
view can let the schedule advance to the next day. Confirmation never upgrades
missing custody, missing observations, short duration, or an engine difference.
The durable records plus remote bytes are the audit evidence; stdout only emits
closed run/window/verdict/delivery summaries and never private diagnostics.

## Activation and stop behavior

These are operator commands for an already admitted runtime. This change does
not build or admit an image, create infrastructure, or start an observation.
The runtime needs Python, its existing boto3 dependency, the collector modules,
and the exact original Node build/dependencies needed by the reader profile.

```sh
python3 -B coordinator-rs/tools/shadow/scheduler.py run --enable \
  --profile /run/shadow/schedule.json --state /var/lib/polis-shadow

python3 -B coordinator-rs/tools/shadow/scheduler.py reconcile --enable \
  --profile /run/shadow/schedule.json --state /var/lib/polis-shadow --window 0
```

Without `--enable`, the CLI exits before importing the publisher SDK or reading
profiles. Reconcile refuses a window with no publication intent and never
starts collection. Run sleeps to each fixed start, resumes already confirmed
windows without collection or PUT, and stops at the first non-PASS local view.
The scheduler launches the first collector 60 seconds before its fixed start,
then prewarms the next collector during the final 60 seconds of the current
window. At most two collector processes are owned at once. The collector must
already be alive at the boundary, prewaits with a wall/monotonic anchor, and
never rounds a late start into a complete day. The next process observes its
fixed boundary but does not capture without the previous confirmed PASS gate.
Since prior delivery occurs after the prior window ends, a next-day first cut
at offset zero will ordinarily refuse. The reviewed cut inventory must leave
an explicit positive offset for publication; even then an absent gate at that
cut is INCOMPLETE. Window boundaries and cut offsets are never shifted to hide
late delivery. A prior non-PASS or scheduler interruption stops any prewarmed
child. A persisted prewarm request after process loss is not recaptured.

The collector enforces actual start/duration/clock and current-window observer
evidence. Exit 0 means all scheduled windows passed; exit 2 means disabled or
incomplete execution. An operator interruption also stops execution.

Collector execution has a day-plus-120-second deadline, including its bounded
prestart wait. Timeout or interruption
terminates its owned process group, then kills remaining children even if the
leader has already exited. Successful collector exits receive the same remaining
group cleanup before receipt admission. Original Node children inherit that group. SIGTERM
to the enabled scheduler enters this cleanup path. Uncatchable process death
requires the container/task supervisor to stop the entire task; on restart the
persisted request closes incomplete. Preserve the state directory and private
capture evidence for the retention policy; this program does not delete them.

`../../deploy/shadow-compose.yml` is a standalone dormant Compose profile:
`shadow-daily`, zero replicas, no image pull/build, no restart, read-only root,
non-root user, dropped capabilities, private input bind and writable state bind.
A bounded 16 MiB non-executable `/tmp` tmpfs permits the Node reader's temporary
database credentials. This scratch ceiling is not production capacity admission;
exhaustion fails closed and total CPU/memory reservations remain UNADMITTED.
The image defaults to an intentionally unadmitted local name. An operator must
select the admitted digest, provision existing private paths with the executing
UID and correct permissions, and explicitly scale the named service to one.
The shape is Linux-only and uses host networking for original Node loopback
readers plus the host machine/boot identity; no reader port is published.
Host source paths should be absolute. No Compose command was executed as part
of scheduler unit validation.

## Future CDK task shape (design only)

The reviewed integration should express the following properties; no CDK stack,
schedule, task or role is created by this change:

| Property | Required value or admission |
| --- | --- |
| Service default | ECS EC2 service, `desiredCount: 0`; no autoscaling |
| Activation | Explicit enable decision plus one admitted service instance |
| Placement | Constrain the exact same EC2 host as both measured math processes; fail if unavailable |
| Network | Host loopback only for the two original Node reader processes |
| Image | Reviewed immutable digest including collector, publisher and Node dependencies |
| Entry | Scheduler `run --enable` with the two private paths above |
| Scheduling | Scheduler owns daily windows; no Lambda and no independent overlapping daily tasks |
| External schedule | Absent by default; any future start rule remains disabled pending review |
| Runtime | Non-root, read-only root, dropped capabilities, whole-task stop and child reaping |
| State | Durable host volume; one run/host, owned 0700, retained on task removal |
| Inputs | Read-only private profile/custody/CA/credential mounts; collector DB role read-only |
| Publisher role | Only designated prefix PUT/GET and designated KMS encrypt/decrypt data-key actions; no delete |
| Capacity | Measured headroom admission for collector, two readers and paired math; no guessed reservation |
| Alarm path | Independent missed-receipt/collector-heartbeat alarm and tested operator delivery |

Resource reservations, task placement, bucket conditional-write policy,
KMS/role policy, independent notification delivery, trusted legacy history and
the actual bound same-host reader run remain operator admission requirements.
Unit controls and a null-custody CLI execution are not a live shadow day or
proof of production notification delivery.

## Local validation

```sh
python3 -B -m unittest discover -s coordinator-rs/tools/shadow -p test_scheduler.py -v
```

The suite covers immutable delivery and crash reconciliation, scope refusal,
fixed schedule and stop behavior, environment filtering, profile freeze,
actual null-custody collector execution, and a real owned child process that
survives TERM after its leader exits. Publisher calls use an in-memory client;
no cloud service or bound production reader is exercised.
