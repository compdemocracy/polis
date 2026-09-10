# coordinator-rs (`polis-coordinator`)

An experimental crate, not a merge or deployment decision. It runs on branch
`experiment/rust-coordinator` (draft PR #2727) and does not change any math
algorithm and does not touch production traffic.

Polis computes each conversation's clustering (PCA + k-means) in a background
"math" pipeline that polls the database for new votes and comments, runs the
math, and writes the result back for the API to serve. Today that pipeline
is Python/Clojure. This crate is a from-scratch Rust rewrite of the
coordination layer around it — deciding *which* conversation needs
recomputing, *who* may compute it right now, and how the result is written
durably — while the math itself stays untouched.

## What this crate owns

- **Deciding what changed** — a background sweep visits every conversation
  and cheaply checks whether its votes/comments/moderation changed since the
  last computed result (`src/probe.rs`, `src/reader.rs`).
- **Deciding who is allowed to compute it** — a *lease* (a time-boxed,
  database-backed "I have this" claim) stops two workers from computing the
  same conversation at once; an *epoch* (a counter bumped on every ownership
  change) lets a takeover be detected after the fact, called *fencing*
  (`src/lease.rs`).
- **Running the actual math worker as a subprocess**, speaking a strict,
  versioned line-protocol to it (`src/engine.rs`, `src/wire.rs`, plus the
  Python-side adapter `../delphi/polismath/engine_adapter.py`, which is part
  of this experiment though it lives outside `coordinator-rs/`).
- **Writing the result durably and atomically** to the same three Postgres
  results tables Node already reads (`src/store.rs`), with exact-byte custody
  of what the worker produced, plus a bounded in-memory cache of each
  conversation's last known-good result (`src/cache.rs`).
- **Reporting numeric health signals** (how far behind the oldest
  conversation is, how many are stuck) in a fixed, checked-in catalog
  (`src/metrics.rs`), plus a test-only fault-injection harness for pausing
  the process at named points (crash-testing lease loss, mid-publish kills),
  behind a Cargo feature refused in release builds (`src/fault.rs`, `build.rs`).
- **Proving its results survive a coherent reader** — the step-4 S2 slice adds
  a candidate `loadBundle` (`tools/bundle_reader.cjs`) that reads all three
  results tables plus the checkpoint in one database snapshot in the real Node
  runtime, and a witness that this closes the "old main, new mapping" torn read
  the current separate-read reader allows, with missing/mismatched-companion
  admission and math_env scoping. This is a verification witness against a real
  reader, **not** the production read path (that rewrite still belongs to
  `server-rs/` and the Node server).

## What this crate explicitly does not own

- **The math itself** — PCA, clustering, repness — unchanged, still in
  Python/Clojure. This crate decides when to ask the worker to compute and
  what to do with the answer; it never computes a result itself.
- **The Node server's read path** — the `/api/v3/math/pca2` route and its
  own cache belong to `server-rs/` and the existing Node server (see that
  crate's README). This crate is verified *against* what that route serves
  today (see "How it is judged") but does not change it.
- **Production cutover** — nothing here replaces the Python poller or wires a
  queue into the real deployment; "will own the Postgres queue substrate" is
  a future goal this crate steps toward, not something it already does.
- **A finished security story** — no TLS here either (same open item as
  `server-rs/`); this only ever talks to a local, trusted Postgres.

## What it promises

The contract this crate is scored against is a set of internal design notes,
not shipped in this branch (see "Where the evidence lives"). The short
version:

- **Exactly one worker computes a given conversation at a time.** A worker
  that no longer holds the current epoch is *fenced*: it must stop, never
  publish, and not be retried by that process. Four named outcomes, each
  with its own log word and process exit code, are checked by `src/lease.rs`
  and enforced again under a database row lock the instant before commit:

  | Outcome | Exit | Meaning |
  |---|---|---|
  | Fenced | 3 | someone else now owns this; give up entirely |
  | Lease unavailable | 4 | someone else holds it; try again later |
  | Lease expired | 5 | our own claim timed out; re-claim and recompute |
  | any other failure | 1 | not an ownership problem; back off and retry |

  A worker still computing as its lease nears expiry renews it (a
  "heartbeat") instead of being killed mid-computation, but renewal can
  never resurrect a lease that has already moved to someone else.

- **A published result is exactly what the worker produced, byte for byte.**
  The original bytes are stored alongside the parsed/decoded form, with
  digests (short fingerprints) checked on every read-back. This catches an
  *accidentally* corrupted or partially-deleted result. It is explicitly
  **not** tamper-evidence: anyone with write access to the database tables
  could rewrite the bytes, digests, and parsed form together undetected —
  stated plainly rather than implied.

- **Conversation generation zero is a real, meaningful first result**, not a
  sentinel for "nothing yet" — matching the existing Python/Clojure writer.

- **A declared, versioned ordering rule** (`polis-order/1`, in
  `src/ordering.rs`) fixes exactly how votes are sorted before being fed to
  the math, so re-running a conversation twice gives the same answer — a
  deliberate, checked-in choice, not "whatever order the database returns."

- **A local-only "candidate" input format** (`polis-candidate-input/1`)
  stands in for a not-yet-finalized general worker-input contract
  (`polis-input/1`). It is explicitly a placeholder, not a certified format.

## How it is judged

There are three layers of check, and none of them alone is "done":

1. **Rust checks** — `cargo test`, `cargo clippy -D warnings`, and a release
   build, run twice: default feature set and the test-only `fault-injection`
   feature. 31 Rust tests pass in each (verified locally, see below).
   `unwrap()`/`expect()` are banned crate-wide (`Cargo.toml`'s
   `[lints.clippy]`), so a real error can never silently become a panic.
2. **Python integration tests against a real, disposable Postgres** — 151
   tests in `delphi/tests/coordinator/` covering lease loss/recovery,
   crash-and-restart, duplicate/overlapping work, byte-for-byte comparison
   against the existing Python worker's output, and negative controls
   (deliberately broken input that must be refused).
3. **A named stage checklist** (`delphi/tests/coordinator/audit_stages.py`)
   requiring every one of 25 required scenarios ("stages") to be actually
   reached in a real run, not merely have a test with that name. This is the
   *gate*: `stage_inventory_gate: PASS` once all 25 are reached, but
   `full_contract_gate: FAIL` while any open item below remains, exiting
   non-zero in that case. **A green run of this crate's own tests is not the
   same as a passing full-contract gate.**

On top of that, a separate check (`tools/node_reader.cjs`,
`tools/node_route_probe.cjs`) loads the *actual*, unmodified Node server
modules that serve `/api/v3/math/pca2` today and compares what they serve
for a result this crate published against the existing writer's result —
zero byte differences currently (see evidence). This exercises today's real
reader, not a rewritten one. The step-4 S2 slice adds a candidate coherent-read
`loadBundle` witness (`tools/bundle_reader.cjs`) and makes the Node job
unconditional (a missing `server/node_modules` now fails rather than skips),
but the production Node-side Bundle rewrite this project eventually wants still
does not exist and is not shipped here.

## Publication outcome telemetry (S3 slice)

The intended transfer fences Clojure out in favour of the certified Python
poller. This slice changes no writer routing, lease policy or deployment.

A lost COMMIT response emits `PublishUncertain=1` before readback. Readback
then emits exactly one of `PublishResolvedOwn=1` or `PublishUnresolvedLost=1`.
Only this operation's coherent checkpoint, epoch and tick establish ownership.
An overwritten receipt, missing/inconsistent rows, or a reconnect/read failure
is unresolved; it does not prove that the transaction rolled back. Signals are
emitted at the operation boundary, including failed one-shot commands, and are
not emitted again with the source-pass totals. Operation identity is log context,
never a metric dimension. `PublishCommitted` retains its source-pass meaning.

The catalog declares a local alarm rule: `PublishUnresolvedLost` Sum >= 1 in
one 60-second period, with the existing Environment/MathEnv dimensions. Missing
sparse events do not breach that event alarm, but do not prove health or
resolution either. A later resolved operation never cancels an unresolved one.
Real PostgreSQL tests sever the actual COMMIT response and exercise both
classifications plus failed readback; the local observer applies this rule.
No alarm is deployed here. Bounded nonblocking transport, independent producer
and sink observation, delivery verification and the transfer rehearsal remain
open. O7 stays OPEN; this is not completion of the broader S3 slice.

## What is still open

The stage checklist names these explicitly (`evidence/test-summary.json`,
`open_conditions`); none is hidden or waived:

- **O8 — candidate profile only.** The local input format
  (`polis-candidate-input/1`) is not the finished, contract-owner-certified
  general format (`polis-input/1`). Exact-byte custody and identity checks
  are in place; the full required test-case set, an immutable input
  manifest, and telling apart "rebuilt," "resumed," and "warm incremental"
  output are not. (The design notes record this as PARTIAL, not OPEN; treat
  a fresh `audit_stages.py` run as the live source of truth — see "How to run.")
- **S2's reader is only partly delivered (O1, PARTIAL) — S2 is not complete.**
  This delivers the *candidate-reader portion*: a coherent-read `loadBundle`
  that serves one snapshot generation's exact mapping (closing the torn read) in
  the D4 harness, plus a local Node-reader failure guard. The **open S2
  remainder**, dispatched separately (its code may live in `server-rs`/the Node
  server, but the acceptance obligation is still S2, not S5): the production
  `loadBundle` threaded through getPidsForGid/doFamousQuery/report.ts, a bounded
  whole-Bundle cache with the 3s TTL preserved, and the comment-owned empty
  presentation. Only the combined full-app / private ~2,884-case campaigns are
  S5. There is also no required CI job here (the failure guard is local only).
- **A real server-side quirk, fixed upstream not here:** Node's `getPca(zid,
  undefined)` once missed a freshly-committed generation zero on a cold cache
  while the HTTP route served it correctly. #2732 (merged to edge, in this
  rebased tree) fixes the cold miss; the review-control test is updated to that
  behaviour. The eventual `getPca` refactor still belongs to whoever owns that
  server code.
- **The staleness check is a time-boxed hint, not a proof**, and there is no
  multi-worker or cross-conversation concurrency campaign — today's tests
  exercise one worker process reconciling conversations one at a time.
- **No production alerting hookup** — implements none of the three alerts a
  separate, accepted design (P-031) calls for, and has no deployed publisher.

## How to run the checks locally

Run every command from inside `coordinator-rs/` unless noted. All re-run and
confirmed working for this README.

```sh
export CARGO_HOME=/private/tmp/p026-toolchain/cargo
export RUSTUP_HOME=/private/tmp/p026-toolchain/rustup
export PATH="$CARGO_HOME/bin:$PATH"

cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --features fault-injection -- -D warnings
cargo test --locked
cargo build --locked --release
cargo build --locked --features fault-injection --target-dir target/fault
```

`rust-toolchain.toml` pins the exact compiler (`1.98.1`), picked up
automatically by running `cargo` inside this directory. With no system Rust,
install one first (e.g. `rustup-init` with a scratch `CARGO_HOME`/
`RUSTUP_HOME` as above, not your real `~/.cargo`).

A release build with `fault-injection` on must fail (`build.rs`'s point):
`cargo build --locked --release --features fault-injection --target-dir target/fault-release`
should print `fault-injection is forbidden in release builds` and exit
non-zero — confirmed.

The Python integration suite needs a disposable, local-only Postgres. Use a
compose project name and port that are yours alone so two runs never collide
— the numbers below match `compose.yml`'s defaults; pick your own if running
alongside someone else's:

```sh
COMPOSE_PROJECT_NAME=p026 POLIS_RECOVERY_PG_PORT=55458 RECOVERY_PG_PORT=55458 \
  docker compose -f coordinator-rs/compose.yml up -d --wait

POLIS_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:55458/p026 \
  PYTHONPATH=delphi PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  python -m pytest -o addopts='' --confcutdir=delphi/tests/coordinator delphi/tests/coordinator -q

COMPOSE_PROJECT_NAME=p026 POLIS_RECOVERY_PG_PORT=55458 RECOVERY_PG_PORT=55458 \
  docker compose -f coordinator-rs/compose.yml down -v
```

Re-run from a clean checkout: `cargo test --locked` 31/31; both `cargo
clippy` invocations clean; release and fault-injection builds succeed and
release+fault-injection correctly refuses to build; `docker compose up`
starts a healthy Postgres in seconds; Python suite **151/151, 0 skipped**
with `server/node_modules` linked read-only into this checkout so the Node
reader tests run. As of step-4 S2 that Node reader job is unconditional: a
missing `server/node_modules` makes the D4/route tests **fail**, not skip
(`require_node` in `_node_gate.py`), so a quick run without them must set
`P026_NODE_READER_OPTIONAL=1` to skip them on purpose. `python -m pytest` assumes Python 3.12
with this project's `delphi` dependencies (`evidence/python-requirements.txt`)
and `PYTHONPATH=delphi` pointing at this checkout's `delphi/` directory.

To see the full stage-by-stage gate result:

```sh
python delphi/tests/coordinator/audit_stages.py
```

Confirmed: exits 1 on purpose (`full_contract_gate: FAIL`, 25/25 stages
reached) as long as any item in "What is still open" remains open — that is
not a bug in the checker.

## Where the evidence lives

- `coordinator-rs/evidence/*.json` — checked-in, sanitized summaries: test
  counts, stage reachability, byte-hash comparisons against the existing
  writer and the real Node reader, and the metric catalog. No production
  data or credentials are in these files.
- `cost-reduction/04-plans/P-026-rust-coordinator-report.md` and
  `P-022-G-coordinator-contract.md` — the accepted design notes this README
  summarizes; they live outside this branch and are the authoritative
  record of why each decision was made and who signed off.
- Raw logs and per-run artifacts go to a git-ignored `artifacts/` directory,
  not checked in; only the sanitized `evidence/` summaries are.

## Glossary

- **Lease** — a time-boxed database row meaning "I own this conversation's
  computation right now, until this timestamp." Stops two workers from
  computing the same thing at once.
- **Fence / fenced / epoch** — once a lease moves to a new owner (a new
  *epoch*, a counter bumped on every ownership change), the old owner is
  fenced: its writes are refused even if it doesn't know yet.
- **Tick / generation** — the version number of a computed result. Tick 0 is
  a real, valid first result, not "nothing yet."
- **`math_env`** — a namespace label (`python`, `rustproto`) keeping results
  from different engines/experiments from colliding in one database.
- **Checkpoint** — the durable record of exactly what inputs and worker
  version produced a given tick.
- **Replay / oracle** — re-running recorded input through a worker (or two)
  and comparing outputs; the *oracle* decides pass/fail from that comparison.
- **Census** — an exhaustive count-and-classify pass over real data, checking
  every shape a decoder might see is accounted for (see `server-rs/README.md`).
- **Contract** — a written, versioned description of what a component
  promises to produce or accept, independent of implementation.
