# P-026 Rust coordinator experiment

Experimental crate on a branch; not a deployment or merge proposal. No math
algorithms are changed. `polis-engine/1` is implemented as a **candidate-profile**, not a claim of
full contract certification. See the P-026 report for executed coverage and gaps.

## Layout

- `src/store.rs`: `ResultsStore` trait and PostgreSQL v0, coherent joined reads,
  expected-tick conflicts, lease fencing, JSONB integrity digests, atomic publication.
- `src/lease.rs`: the three distinguishable ownership outcomes and the
  conditional heartbeat renewal that keeps a long compute inside its lease.
- `src/ordering.rs`: the declared `polis-order/1` source normalization and its
  `equal_time_census`; the coordinator's ORDER BY is built from it.
- `src/cache.rs`: bounded warm bundle cache with the LRU eviction stage.
- `src/coordinator.rs`: complete source snapshot reconciliation, durable keyset
  cursor, bounded failure backoff, one active conversation and worker process.
- `src/probe.rs`: the cheap per-conversation change probe, the durable per-zid
  reconciliation cursor that bounds how long it may be trusted, and the CO01/CO06
  backlog and scan-age aggregates.
- `src/metrics.rs`: the declared metric catalog, the pluggable sink and the
  CloudWatch Embedded Metric Format records in namespace `Polis/Math`.
- `src/engine.rs`, `src/wire.rs`: bounded JSONL subprocess client, strict parsing,
  immutable file descriptors, identity/checkpoint validation, rebuild-prefix lifecycle.
- `src/reader.rs`: metadata-first keyset sweep plus paginated trailing window.
- `tools/node_reader.cjs`: the D4 harness that loads the **real** server modules
  `server/src/utils/pca.ts` and `server/src/utils/participants.ts` in one Node
  process and reports the bytes they serve for each namespace.
- `src/fault.rs`: external arm/ack/release file barriers, debug feature only.
- `migration.sql`: additive prototype metadata/leases/sequence; explicit command.
- `../delphi/polismath/engine_adapter.py`: Conversation lifecycle and existing row
  derivation, with explicit empty serialization and snapshot un-moderation handling.
- `../delphi/tests/coordinator/`: process-neutral recovery/equivalence tests using
  migrated PostgreSQL, pinned independent fold and R09 mapping assertions.

The coordinator rebuilds from persisted warm fields and the entire authoritative
prefix for every changed source snapshot. This resets the smoother as the reference
poller does on restart. There is still no warm *worker* (Conversation) cache, so
this is not uninterrupted-warm equivalence and the live comparator uses exactly
this restart schedule. There is a bounded warm **bundle** cache
(`P026_CACHE_CAP`, default 16, 0 disables): the last coherent published bundle of
an unchanged conversation, so a quiet pass does not re-read the three results
tables. Lookup and LRU touch are one operation, so an eviction can never
interleave between them. A resident entry is **never** treated as evidence about
the durable store: every hit re-verifies companion presence, every companion's
generation and the committed checkpoint identity against the database
(`resident_is_intact`, metadata and `input_checkpoint` only, no payload column),
and any disagreement evicts the entry and repairs through the ordinary rebuild
path. Without that, a deleted companion stayed missing across passes because the
source fingerprint kept agreeing. Eviction is the CO07
`cache_eviction_contends_with_same_zid_update` stage; that stage is the bounded
Bundle-cache profile only, not a warm-worker, four-worker or Node cache profile.

## Incremental discovery, and why it is only a filter

Every pass still visits every admitted conversation independently of timestamps.
What changed is what a visit costs. Before reading the full vote/comment/
participant history, the coordinator takes a cheap single-statement aggregate
probe (`src/probe.rs`) and compares it with the probe recorded, in
`coordinator_reconciliation`, immediately **before** the authoritative snapshot
that certified the published generation. A row committing between the probe and
the snapshot therefore changes the *next* probe; it cannot be swallowed.

The probe can only skip a read. It never authorises a rebuild, and it is trusted
only while that conversation's last authoritative reconciliation is younger than
`P026_RECONCILE_SECONDS` (default 3600). Count and max are hints: a change that
leaves every aggregate identical really is invisible to them, and
`test_the_aggregate_probe_is_weak_but_the_reconciliation_ceiling_repairs_it`
stages exactly such a change to prove both halves. `P026_INCREMENTAL=0` disables
the fast path entirely and restores the unconditional full sweep. The probe also
carries `ordering::algorithm_digest`, so changing the declared normalization or
the storage agree-convention constant invalidates every conversation even though
no source row moved.

`OldestReconciliationAgeSeconds` is what makes this auditable: the fast path is
sound only while that age stays bounded, so the metric is part of the mechanism
rather than decoration.

## Metrics

`src/metrics.rs` emits CloudWatch Embedded Metric Format records in namespace
`Polis/Math` with P-031's two fixed dimensions `Environment` and `MathEnv`, and
no per-conversation, per-run or per-instance dimension. There is **no AWS client
and no AWS dependency**: a `Sink` receives finished records, and the prototype
ships a JSON-lines sink (`P026_METRICS` = `off` (default), `stderr`, `stdout`, or
a path) plus a null sink. The default is `off` deliberately: a long-running `run`
whose stderr is an undrained pipe blocks once the pipe buffer fills, and per-pass
records fill it far faster than the log lines do, so a deployment picks its sink
explicitly rather than having the coordinator stall on its own telemetry. `polis-coordinator metrics` prints the declared
catalog, which is generated from the emitting code and checked into
`evidence/metrics-catalog.json`.

Per pass: `PollHealthy` (P-031 A01), `SourcePassSeconds`,
`SourcePass{Conversations,Probed,Skipped,Reconciled,Published,Deferred}`. Gauges,
at most once per `P026_GAUGE_SECONDS` and computed by one bounded aggregate that
reads no payload column: `OldestReconciliationAgeSeconds` (CO01 scan age),
`ReconciliationBacklogConversations` (CO01 backlog),
`FailureBacklogConversations`, `OldestUnrepairedAgeSeconds` (CO06). Per zid:
`ConversationLatencySeconds`, `SourceReadSeconds`, `ComputeSeconds`,
`PublishSeconds`. Lease outcomes: `LeaseAcquired`, `LeaseUnavailable`,
`LeaseExpired`, `LeaseFenced`. Publication outcomes: `PublishCommitted`,
`PublishConflict`, `PublishRefused`, `PublishRetried`, `PublishUncertain`. Plus
`MetricsDropped`, because a lost record must be visible rather than silent.

`PollHealthy` says the pass completed, and nothing more. A pass in which every
conversation failed is still a completed pass; stuck work is the failure backlog
and unrepaired age, exactly as P-031 splits A01 from the lag signals.

Source order is the **declared** `polis-order/1` normalization
`(tid,pid,created_ms,semantic_vote,weight_x_32767 NULLS FIRST)`, where
`semantic_vote = raw_vote * storage_agree_value`. It is a contract term, not a
literal in one query: `src/ordering.rs` owns the terms, the coordinator builds
its ORDER BY from them, the same declaration (with its `algorithm_digest` and
this conversation's `equal_time_census`) is the worker manifest's `ordering`
value and is recorded in the published checkpoint, and the worker rejects a
manifest whose declaration does not match its `storage_agree_value`. Ordering on
the raw sign instead would break the polarity property. This is a declared
content normalization, not historical encounter order. Exact duplicate
multiplicity survives. The source fingerprint covers all vote rows, current
comment metadata, participant moderation and that declaration. One
REPEATABLE READ snapshot covers all three source queries. Every conversation is
visited independently of event timestamps; a late commit behind a completed page
is found on the next pass. Source rows are limited to 1,000,000 per table per
conversation; exceeding that limit fails visibly, without acknowledging a prefix.

`caching_tick` comes from a sequence. It is not commit ordered. The reader always
reserves a metadata sweep page as the unconditional backstop. Its CLI has no
payload cache; selected metadata are cache misses and load full coherent bundles.
Positions survive process restart in `coordinator_cursors`, but remain delivery
hints. Sweep replay recovers a lost consumer response. This does not wire Node's
existing caches to this reader.

Publication order: parent `conversations FOR KEY SHARE`, lease, ticks, bidtopid,
ptptstats, main. Ownership is checked under the lease lock, and the final
authorization immediately before COMMIT re-reads owner, epoch and the
**remaining** lease under that same row lock, refusing when less than
`P026_COMMIT_MARGIN_SECONDS` is left rather than gambling that the COMMIT round
trip beats the clock. That check does not prove the round trip finishes in time
— nothing in-transaction can — so an uncertain COMMIT is still resolved by
checkpoint identity, never by a wall-clock deadline. Reclaims increment the epoch; rows are expired,
never deleted/recreated. Default lease duration is 120 seconds.

## Ownership outcomes

Refusal is not one state. Each outcome has its own log token and process exit
code, and only one of them is terminal:

| Outcome | Token | Exit | Meaning | Response |
| --- | --- | --- | --- | --- |
| `LeaseState::Fenced` | `FENCED` | 3 | owner or epoch superseded | publication authority is gone; the daemon exits and this zid is not retried by this owner |
| `LeaseState::Unavailable` | `LEASE-UNAVAILABLE` | 4 | another owner holds an unexpired lease | defer this zid with bounded backoff and keep sweeping the rest |
| `LeaseState::Expired` | `LEASE-EXPIRED` | 5 | our own lease elapsed in DB time | do not publish; reacquire and recompute on a later pass |
| any other failure | — | 1 | not an ownership question | durable backoff, cursor retained |

Exit codes 4 and 5 are reachable only from `once` and `publish-fixture`, which
are strict one-shot commands: a lease refusal ends that pass with its typed
code. The `run` daemon exits only on `FENCED`.

A compute that outlasts the lease renews instead of fencing itself. A heartbeat
on its own connection extends `expires_at` every `lease/3`, conditional on
`(owner_id, owner_epoch)` and on the lease still being unexpired in database
time, so it can never resurrect an expired or transferred epoch. A renewal that
fails definitively aborts the operation the worker is running and no publication
follows; an uncertain renewal is not treated as ownership, and after one full
lease without a confirmed renewal the work stops. Ownership is then classified
once more against the lease row before anything is published, so a heartbeat the
database contradicts does not invent a loss, and publication independently
re-checks owner, epoch and expiry inside its own transaction. The heartbeat
cannot renew while the publication transaction holds the lease row `FOR UPDATE`,
so a publication must fit inside one lease window; the pre-commit expiry check is
what enforces that, and it fails closed.

An unclean death leaves the lease live until it genuinely expires. A restarted
process defers that conversation and keeps working; it never crash-loops, and it
repairs without anyone expiring the dead owner's row by hand. A process that
fails cleanly releases its own epoch immediately (the release is conditional on
`(owner_id, owner_epoch)`, so a transferred row is untouched). That release is
best effort: a failure to reconnect, or a failure before the heartbeat is
started, leaves the lease to expire on its own, so genuine DB-time expiry — not
the release — is what the invariant rests on.

Per-conversation error attempts are durable and capped at 30 for backoff. SQLSTATE
40001/40P01 gets at most three whole-transaction attempts. Uncertain COMMIT checks
coherent persisted checkpoint identity before reporting success or failure.

Integrity digests are separate from harness semantic hashes. JSONB normalizes
numeric spellings (`-0.0` and exponent notation). `storage_digest` expands decimal
number tokens and removes insignificant zeroes, preserving JSON types and all
payload fields. Hashing/encoding occurs before any publication lock. The original
worker file bytes have SHA256 descriptors; PostgreSQL JSONB does not preserve those
lexical bytes. The row-shape golden compares `data::text` from both writers.

## Toolchain

`rust-toolchain.toml` pins the crate to stable `1.98.1` with `clippy` and
`rustfmt`, so every build here uses one known compiler. Run cargo from inside
`coordinator-rs/` for the pin to apply; `--manifest-path` from the repository
root bypasses it.

`Cargo.toml` declares `rust-version = "1.88"` as the minimum supported Rust
version. Edition 2024 alone needs 1.85, and the highest MSRV among the locked
dependencies is also 1.85; 1.88 is required because `src/main.rs` uses a
let-chain, stabilized in 1.88 for edition 2024. The MSRV is derived from the
edition, that feature and the lockfile — it has not been exercised by building
on a 1.88 toolchain. Raise it deliberately if newer language features land here.

## Local build and test

The sandbox refused writes to `$HOME/.cargo` and `.git/FETCH_HEAD`. Stable rustup
was installed under `/private/tmp/p026-toolchain` with no profile changes. The
Python environment is `/private/tmp/p026-venv`. Dependencies are recorded in
`evidence/python-requirements.txt`; Rust dependencies are in `Cargo.lock`.

```sh
export CARGO_HOME=/private/tmp/p026-toolchain/cargo
export RUSTUP_HOME=/private/tmp/p026-toolchain/rustup
export PATH="$CARGO_HOME/bin:$PATH"
cargo clippy --manifest-path coordinator-rs/Cargo.toml -- -D warnings
cargo test --manifest-path coordinator-rs/Cargo.toml
cargo build --manifest-path coordinator-rs/Cargo.toml --release
cargo build --manifest-path coordinator-rs/Cargo.toml --features fault-injection --target-dir coordinator-rs/target/fault
COMPOSE_PROJECT_NAME=p026 POLIS_RECOVERY_PG_PORT=55458 RECOVERY_PG_PORT=55458 docker compose -f coordinator-rs/compose.yml up -d --wait
POLIS_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:55458/p026 PYTHONPATH=delphi PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 /private/tmp/p026-venv/bin/python -m pytest -o addopts='' --confcutdir=delphi/tests/coordinator delphi/tests/coordinator -q
COMPOSE_PROJECT_NAME=p026 POLIS_RECOVERY_PG_PORT=55458 RECOVERY_PG_PORT=55458 docker compose -f coordinator-rs/compose.yml down -v
```

This test-only Compose service binds loopback and uses trust authentication without
credentials. Each test creates a fresh database from a template built by applying
**all repository SQL migrations**. The template removes `math_ticks.caching_tick`
to exercise documented production drift, then applies the prototype migration.
Do not point migration/test commands at an existing service database.

Commands: `migrate`, `once`, `run`, `read <zid>`, `scan <after-zid>`,
`poll <high-water>`, `reader <consumer-id>`, `stages`, `metrics`. `once` completes one full
pass; `run` bounds each cycle by `P026_PAGE_SIZE` (default 16, range 1–1000).
`MATH_ENV` defaults to `rustproto`. `DATABASE_URL`, `P026_PYTHON`,
`STORAGE_AGREE_VALUE` (-1 or +1), `POLL_SHARD_INDEX`, `POLL_SHARD_COUNT`,
`POLL_ALLOWLIST`, `P026_WINDOW` (default 64, positive), `P026_LEASE_SECONDS`,
`P026_POLL_MS`, `P026_CACHE_CAP` (default 16, 0-1024, 0 disables),
`P026_INCREMENTAL` (default 1, 0 disables the probe fast path),
`P026_RECONCILE_SECONDS` (default 3600, positive), `P026_COMMIT_MARGIN_SECONDS`
(default 0.5, less than the lease), `P026_METRICS`, `P026_ENVIRONMENT` (default
`synthetic`) and `P026_GAUGE_SECONDS` are configuration inputs.
`PYTHONPATH` must include this checkout's `delphi` directory. No credentials are
stored in the crate or report.

## Candidate wire profile

Initialization requires descriptors `{path,bytes,sha256}` for an input manifest
and resolved schedule, a `config`, and `required_capabilities`. Dedicated input
and output roots are process arguments. Symlinks/traversal, duplicate keys, invalid
votes (including NULL), foreign identities and checksum errors fail closed.
The control line limit is 64 KiB; each admitted bulk file is bounded at 256 MiB.
The client operation timeout is 120 seconds and failure kills/discards the worker.

Local manifest keys: `schema:"polis-input/1"`, `fixture_id`,
`storage_agree_value`, `ordering`, `votes`, `moderation`, `parent`. `ordering` is
either the `polis-order/1` declaration above (live profile) or the pinned name of
a frozen replay order; a live declaration must agree with `storage_agree_value`
and must declare the semantic tie term, or initialization fails.
Vote lines use the contract's eight-field normalized example. Moderation lines
are `{slot,state}`, where state is the existing poller snapshot with four
moderation sets and `lastModTimestamp`. Current poller snapshot semantics leave
the latter null. This profile records real comment `modified` values in source
fingerprints; it does not fabricate historical moderation events.
Schedule: `{schema:"polis-schedule/1",operations:[{op,payload},...]}`. Every
post-initialize operation must match the admitted list exactly. Config keys:
`profile:"candidate-profile"`, `seed:42`, `pca_mode:"powerit"`,
`empty_contract:true`, `init_vector:"engine-default"` (also supports `ones`).
`apply_votes` and `apply_moderation` consume contiguous ranges without compute;
`compute`, `snapshot`, `restore`, `close` are separate operations. Snapshot emits
a manifest last, referring to main, bidtopid, ptptstats and full restore payloads.
The exhaustive B-owned raw schema, source/transform/units manifest, certified
worker provenance and a persisted operation-history restore attestation remain
contract-admission gaps. The local schema must not be advertised as a completed
G01–G16 certificate.

## Fault seam and evidence

Build with `fault-injection` into a separate target directory so default builds
cannot replace the running test binary. An attempted release+feature build fails
in `build.rs`. Release binaries reject `P026_FAULT_DIR` before connecting to DB.
The test-enabled binary additionally requires a row for the namespace in
`p026_test_marker` in the target synthetic DB and rejects prod/preprod/dev.

Write `arm.json` to `P026_FAULT_DIR` with protocol `polis-fault-control/1`,
`run_id`, `operation_id`, `stage`. At the real stage the process atomically writes
`ack.json` carrying PID, context, and `state:"reached-and-blocked"`; it waits for
`release` or an external SIGKILL. Publication contexts contain the actual PG
backend PID. The barrier has a bounded deadline. A log alone is never an ack.

`audit_stages.py` reports two separate verdicts: `stage_inventory_gate` over the
25 contract-required fault stages, and `full_contract_gate`, which is still
**FAIL**. It names its open conditions explicitly — CO04's `loadBundle`/Bundle
cache-unit rewrite does not exist in the server, HTTP routes and the private
served corpus are not executed, a committed generation of 0 is not served by the
real reader at all, C7's published-versus-synthesized empty listing needs a
ruling, the incremental probe is a bounded hint, and the resident-cache
reconciliation is single-threaded — and it exits non-zero while any remain.

`evidence/` contains sanitized final summaries, fixture digests and the explicit
coverage inventory. Runtime logs and detailed per-test artifacts are retained in
ignored `artifacts/`. A registry with no missing implemented markers does not
claim the absent cache/Node profile stage is covered.
