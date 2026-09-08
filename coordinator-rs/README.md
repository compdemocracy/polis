# P-026 Rust coordinator experiment

Uncommitted prototype, not a deployment or merge proposal. No math algorithms are
changed. `polis-engine/1` is implemented as a **candidate-profile**, not a claim of
full contract certification. See the P-026 report for executed coverage and gaps.

## Layout

- `src/store.rs`: `ResultsStore` trait and PostgreSQL v0, coherent joined reads,
  expected-tick conflicts, lease fencing, JSONB integrity digests, atomic publication.
- `src/coordinator.rs`: complete source snapshot reconciliation, durable keyset
  cursor, bounded failure backoff, one active conversation and worker process.
- `src/engine.rs`, `src/wire.rs`: bounded JSONL subprocess client, strict parsing,
  immutable file descriptors, identity/checkpoint validation, rebuild-prefix lifecycle.
- `src/reader.rs`: metadata-first keyset sweep plus paginated trailing window.
- `src/fault.rs`: external arm/ack/release file barriers, debug feature only.
- `migration.sql`: additive prototype metadata/leases/sequence; explicit command.
- `../delphi/polismath/engine_adapter.py`: Conversation lifecycle and existing row
  derivation, with explicit empty serialization and snapshot un-moderation handling.
- `../delphi/tests/coordinator/`: process-neutral recovery/equivalence tests using
  migrated PostgreSQL, pinned independent fold and R09 mapping assertions.

The coordinator rebuilds from persisted warm fields and the entire authoritative
prefix for every changed source snapshot. This resets the smoother as the reference
poller does on restart. It does not implement a persistent warm worker cache, so
cache eviction/update contention is absent from this profile. The live comparator
uses exactly this restart schedule. This is not uninterrupted-warm equivalence.

Source order is `tid,pid,created,semantic_vote,weight NULLS FIRST`, matching the
live poller's encounter order; the final keys explicitly resolve otherwise
ambiguous ties. Exact duplicate multiplicity survives. The source fingerprint
covers all vote rows, current comment metadata and participant moderation. One
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
ptptstats, main. Ownership is checked under the lease lock and expiry is checked
again immediately before commit. Reclaims increment the epoch; rows are expired,
never deleted/recreated. Default lease duration is 120 seconds. Long computations
that outlive it are fenced; renewal during computation is not implemented.
Per-conversation error attempts are durable and capped at 30 for backoff. SQLSTATE
40001/40P01 gets at most three whole-transaction attempts. Uncertain COMMIT checks
coherent persisted checkpoint identity before reporting success or failure.

Integrity digests are separate from harness semantic hashes. JSONB normalizes
numeric spellings (`-0.0` and exponent notation). `storage_digest` expands decimal
number tokens and removes insignificant zeroes, preserving JSON types and all
payload fields. Hashing/encoding occurs before any publication lock. The original
worker file bytes have SHA256 descriptors; PostgreSQL JSONB does not preserve those
lexical bytes. The row-shape golden compares `data::text` from both writers.

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
`poll <high-water>`, `reader <consumer-id>`, `stages`. `once` completes one full
pass; `run` bounds each cycle by `P026_PAGE_SIZE` (default 16, range 1–1000).
`MATH_ENV` defaults to `rustproto`. `DATABASE_URL`, `P026_PYTHON`,
`STORAGE_AGREE_VALUE` (-1 or +1), `POLL_SHARD_INDEX`, `POLL_SHARD_COUNT`,
`POLL_ALLOWLIST`, `P026_WINDOW` (default 64, positive), `P026_LEASE_SECONDS`, `P026_POLL_MS` are configuration inputs.
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
`storage_agree_value`, `ordering`, `votes`, `moderation`, `parent`.
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

`evidence/` contains sanitized final summaries, fixture digests and the explicit
coverage inventory. Runtime logs and detailed per-test artifacts are retained in
ignored `artifacts/`. A registry with no missing implemented markers does not
claim the absent cache/Node profile stage is covered.
