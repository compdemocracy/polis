# Local Rust queue adapter and shared acceptance cases

This independent crate exercises `polis-queue/1` without changing the coordinator
or Python science package. It is a local, opt-in transport for the twelve public
queue RPCs on migration 000019. It runs no daemon, follows no artifact URI and
executes no science or provider request. The actual math bridge still polls
outside the queue. No stage, descriptor policy, schema, grant or deployment is
changed by this crate.

Every call validates its name, argument count and types before connecting, then
uses a fresh READ COMMITTED transaction under the restricted queue executor
login. UUIDs bind as UUIDs, priority as i16, counts as i32 and epochs as i64.
Replies retain decimal-string counters and the closed wire field sets. Direct
table/column grants or membership permitting entry to the owner role refuse the
connection. `NoTls` is restricted to literal loopback IPs. The same dev/test
namespace rule as the Python executor and an explicit flag exclude production.
The SQL hash is a repository compatibility pin, not live-catalog attestation.

`Completion::Unknown` carries a provisional reply when COMMIT does not report
success. There is no automatic retry, including no reissue of an uncertain claim.
Renew the exact claim token on a fresh connection, or retain it as unresolved.
An exact finalize token/digest can reconcile to `already_succeeded`. Another
attempt's success is not borrowed. The JSONL executable returns either `reply`,
`uncertain`, or a fixed `error` with optional SQLSTATE; it suppresses database
diagnostics and connection strings. Input lines are limited to 64 KiB. The DSN
and queue environment come from `QUEUE_DATABASE_URL` and `QUEUE_ENV`.

## Local campaign

Use a dedicated project and unused local port, and a Python environment with the
Delphi test dependencies. Keep the evidence directory fresh and outside the repo:

```sh
COMPOSE_PROJECT_NAME=p027-queue-example \
POLIS_RECOVERY_PG_PORT=56160 RECOVERY_PG_PORT=56160 \
QUEUE_PYTHON=/path/to/venv/bin/python \
QUEUE_EVIDENCE_DIR=/private/tmp/queue-example \
bash queue-rs/run-acceptance.sh
```

The script builds/tests/lints Rust, starts the isolated PostgreSQL 17 fixture,
runs the exact case inventory, rejects failures/errors/skips/omissions/duplicates,
and removes only its own Compose project, including volumes. Normal Delphi CI
does not collect this directory without `QUEUE_ACCEPTANCE_URL`; an explicit
campaign with missing prerequisites fails. The runner does not mutate the existing
coordinator CI's historical inventory or evidence. It is not wired to hosted CI.

The shared Python tests drive the unchanged psycopg consumer and this Rust
transport against the same installed SQL and fixture recipe. Python enqueue is
a test-only producer calling the same fixed SQL and grant boundary; enqueue is
not added to the Python consumer. Both adapters use real PostgreSQL transactions.

| Contract seam | Local witnesses and negative controls |
|---|---|
| A1 | Four claimers, three lanes, 24 distinct live tokens; progress past a locked first row. Removing SKIP LOCKED blocks; barrier-controlled read/unconditional-update returns duplicate ownership. The weighted caller schedule is explicit in the test. |
| A2 | Actual nested PL/pgSQL claim plan via auto_explain, 10,000 terminal + 10,000 ready rows across lanes, no forced planner settings. Empty-lane equality-prefix probe; removing priority causes 10,000 unrelated rows to be examined. |
| A3 | Actual DB-time lease expiry, reap/reclaim, every stale heartbeat/release/fail/park/finalize seam, new owner succeeds. Removing ownership checks permits stale renewal. |
| A4 | Wire-level disconnect before and after actual claim/finalize COMMIT; independent durable-state observation; exact-token reconciliation. Real SIGKILL after finalize COMMIT and restart, wrong identity/digest denied. Reclaiming with a fresh attempt strands ownership; unconditional fencing loses exact-success recovery. |
| A5 | Enqueue COMMIT disconnects leave four complete records or none; key replay/conflict. A shared deliberately split producer algorithm leaves a durable partial run. |
| A6 | Older completion after newer, desired-run failure, exact repeat; prior pointer retained. Removing desired-generation policy incorrectly publishes a suppressed run. |
| A7 | Each language/profile performs 10,000 real heartbeat RPC transactions. Local profile: PG17, fillfactor80, one owner, autovacuum disabled, HOT ratio >=0.90 and <=100 dead tuples after observed explicit vacuum. Adding an expiry index produces zero HOT updates. These are local profile bounds, not production admission. |
| A8 | Exhausted budgets, 105-row parked cursor pass with a busy low ID and held heads, separate committed reaps, FK lookup plans over 10,000 retained runs/heads and referenced/unreferenced DELETE checks. Budget/index/reaper/per-job-commit controls expose their respective broken invariants. |

Faults alter only individual disposable databases. They never alter a migration
file or its recorded fingerprint. Bulk history fixture rows are generated locally;
they are not conversation data. The original descriptors are imported from the
existing frozen Python contract, including its compatibility spellings.

These transport/SQL cases do not certify an operational Rust scheduler, daemon
restart journal, measured production capacity or full A1–A8 admission. Native
weighted scheduling/reaper lifecycle remains a caller obligation; the existing
Python executor is unchanged. The D04 durable pending-operation catalog,
count/byte admission, protected-reference retention/cleanup and eventual real
math-stage admission require their separately reviewed schema/authority work.
No queue finalize occurs in the math bridge, so a restart between math COMMIT
and queue finalize cannot yet be a live queue integration witness.
