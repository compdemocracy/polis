# Coordinator → Python poller bridge

The Rust coordinator selects a repeatable-read source snapshot, acquires and
renews its `(math_env,zid)` lease, and dispatches one Python process. Python runs
`MathPollerService._run_engine` with the actual poller writer. Rust never receives
fresh computed payloads for publication and has no math-write or publication-RPC
privilege. It verifies the durable operation receipt after the child acknowledges.

This is an implementation for local certification. It activates no deployment,
changes no existing math-table columns, and revokes no legacy writer credentials.
The operator must isolate the serving namespace and remove other write authority
before any transfer. The control connection still uses Rust's `NoTls`; this is
not an admitted remote deployment or a full-contract certificate.

## Schema and effective authority

Reviewed migration `000021_create_polis_coordinator.sql` installs new coordinator
state, receipt and provenance tables. Both bridge adapters pin its exact bytes.
The runtime check of the install record is a compatibility check, not an
independent live-catalog attestation. Apply/replay/down and catalog preflight
belong to the separate reviewed schema workflow. The CLI `migrate` refuses.
The old `coordinator-rs/migration.sql` is historical and is never applied by the
bridge or its integration fixture.

Provision two distinct LOGIN roles outside the migration:

- The control login inherits `polis_coordinator_control`, reads conversations,
  votes, comments, participants and the four math tables, and needs
  `UPDATE(topic)` on conversations for the parent key-share lock.
- The publisher login inherits `polis_coordinator_publisher` and needs public
  schema usage. It can read the lease/install/receipt metadata and execute
  `pc_publish`. It cannot write math, leases, receipts or the caching sequence
  directly, or assume the control or either owner role.

Both adapters check effective role reachability and table/column grants, including
non-inherited roles the login could reach through SET ROLE. They
refuse superuser, role/database creation, replication, bypass-RLS and direct math
DML authority. The control login cannot execute the publication RPC. The new
NOLOGIN function owner owns that narrowly defined authority; its exact existing
math-table grants and reversal are documented by migration 000021.

Set `DATABASE_URL` for control and `COORDINATOR_PUBLISHER_DATABASE_URL` for Python.
The local parent must launch the child with its publisher credential, so this is
a database authorization boundary, not isolation from a compromised parent OS
process. The child receives an explicit environment and never the control URL,
legacy PG environment or cloud credentials. Production credential delivery,
namespace isolation and image admission remain separate operator work.

## Dispatch and publication

`polis-poller-bridge/1` sends one bounded UTF-8 JSON line through stdin. It binds
namespace, zid, owner, epoch, expected tick, operation ID, schema pin, the source
and prior-state byte digest, ordering, event count, schedule digest and engine
source-manifest digest. The child verifies the pinned manifest against all 66
Python package source files it covers. This detects source drift; it is not
attestation against a compromised runtime or OS.
Two independent random UUIDs provide a 32-byte capability with 244 random bits.
Only its hash is stored in the lease/receipt; the raw value travels through stdin
and bound database parameters, never command arguments or diagnostic context.
The child checks dispatch identity before computing. The SQL function checks it
again under the lease lock, alongside expected-generation and final DB-time
margin checks. Input snapshots contain at most one million rows per source
relation and the dispatch frame is capped at 256 MiB; these bounds are not a
measured production memory or capacity admission.

The child starts no independent polling or reconciliation threads. `FrozenSource`
implements the real poller's full-history interfaces over the selected snapshot,
so a late vote cannot silently change an in-flight operation's input. Every
changed source rebuilds from all history, restoring the prior coherent main
payload where available. This is `poller-rebuild-prefix/1`, with seed 42 and PCA
`powerit`; it is not exact-resume or warm incremental certification. Moderation
sets are replaced on rebuild to carry un-moderation. The serialization-only empty
contract is shared with the retained engine-adapter comparison fixture. Non-null
vote weights remain part of ordering/input identity and are ignored by science,
matching both existing Python paths; null or unsupported votes are refused.

The real writer derives and serializes all three payloads before opening the
publication transaction. Python calls `pc_publish`, which locks parent → lease →
tick and writes tick → bidtopid → ptptstats → main plus the generation and three
original-byte receipts atomically. Original bytes and canonical storage digests
are retained in the new tables. The function requires a positive remaining lease
margin. SQL serialization failures and deadlocks retry the whole transaction at most twice,
with the same operation/capability/output bytes. Python repeats the DB-time/owner/epoch check immediately before COMMIT
while still holding that lock. Neither check proves that the COMMIT round trip
finishes before expiry. No child acknowledgement is sent before COMMIT.

The expected tick includes retained receipt history as well as the current tick
pointer. Repair after deletion or regression of current math rows therefore
advances the generation instead of reusing an immutable receipt key.

A successful reply and an ambiguous child/COMMIT exit are verified against the
operation receipt, including owner/epoch, capability, checkpoint, raw bytes and
storage digests. A newer generation cannot erase that proof. Missing or corrupt
receipt material and failed reconnect/readback remain unresolved; no queue job
is finalized by this bridge. Receipt retention/GC and a real queue adapter are
not implemented. Source polling remains authoritative outside the queue.

`ComputeSeconds` covers child startup through its publication phase message;
`PublishSeconds` covers that phase through process completion. This separates
actual intervals without labeling combined compute/publication time as SQL time.
Ambiguity metrics are emitted only after a publication phase was entered.

## Fault and regression evidence

The release build refuses fault control and fixture publication. The fault build
can request a named pause only in a marked public-fixture database and a non-serving
namespace. Python verifies the marker before enabling its latches or fixture
input. `publish-fixture` uses Python and the same restricted RPC; it is never an
alternate Rust publisher.

`delphi/tests/coordinator/bridge_faults.sql` installs disposable test triggers;
production 000021 installs none on the math tables. For SQL write stages, the
harness observes the real publication backend waiting on an advisory lock inside
its INSERT/UPDATE. Python and Rust then report the named stage with that backend
PID. COMMIT and compute/restore seams pause in the actual Python path. Existing
whole-component SIGKILL cases kill the process group; separate bridge cases stop
a Python child, kill only its parent, allow real lease expiry and takeover, then
resume the stale child.

The original 151 test identities remain in the regression inventory. Their SQL
metadata mutations now target new tables. The row helper explicitly projects new
metadata beside old math rows solely for compatibility with those assertions.
Original-byte corruption witnesses first verify the new database hash constraint,
then remove that one guard in their disposable database to exercise the independent
reader. Lost-ack cases inspect the durable receipt rather than only current math.
A newer generation resolves the original operation; missing/corrupt receipts
still trigger the unchanged unresolved/alarm oracle. These are schema-dependent
oracle changes and require review; historical receipts are not relabeled.

Bridge-specific tests add 20 executions of each stale-child and final-margin
schedule, broad/second-publisher refusal, schema/engine pins, capability tampering and real SQL retry failures.
A scratch copy with the final Python check removed must violate the same
zero-published-rows oracle. Local success does not close the standing full-contract,
private-data, row-order, capacity, delivery or activation obligations.
