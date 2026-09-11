# coordinator-rs (`polis-coordinator`)

A Rust coordination layer around the existing Python math poller. It changes no
math algorithm. The coordinator has no production startup wiring; deploying the
server does activate the coherent math reader described below. Production writer
transfer remains subject to separate operational and certification gates.

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
- **Dispatching the actual Python poller** through `src/bridge.rs` and
  `delphi/polismath/poller/coordinator_bridge.py`. A bound source snapshot goes
  through the poller's rebuild, compute, serialization and write-before-cache
  path. The older `engine.rs` adapter remains a comparison/contract fixture.
- **Verifying publication receipts and coherent reads** (`src/store.rs`).
  Python alone invokes the restricted `pc_publish` function. Rust receives a
  receipt, reads the new coordinator metadata tables, and keeps a bounded
  cache of the last coherent generation. See [the bridge contract](bridge.md).
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
  reader. The production Node reader now also lives in this tree; its scoped
  local proof is recorded separately in `evidence/s2-production-reader.json`.

## What this crate explicitly does not own

- **The math itself** — PCA, clustering, repness — unchanged, still in
  Python/Clojure. This crate decides when to ask the worker to compute and
  what to do with the answer; it never computes a result itself.
- **The Node server's read path** — the `/api/v3/math/pca2` route and its
  own cache execute in the existing Node server. This branch changes its mapping
  and report helpers to use coherent Bundles. The Rust coordinator does not
  replace the HTTP server; its checks exercise the actual Node implementation.
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
   feature. The current required inventory contains 34 Rust tests in each profile.
   `unwrap()`/`expect()` are banned crate-wide (`Cargo.toml`'s
   `[lints.clippy]`), so a real error can never silently become a panic.
2. **Python integration tests against a real, disposable Postgres** — 291
   required test identities (the original 151 plus additive bridge/observer controls) in `delphi/tests/coordinator/` covering lease loss/recovery,
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
zero differences in the populated cross-writer witness (see evidence). This
exercises the actual Node modules, including this branch's reader changes. The step-4 S2 slice adds a candidate coherent-read
`loadBundle` witness (`tools/bundle_reader.cjs`) and makes the Node job
unconditional (a missing `server/node_modules` now fails rather than skips),
and the production Node reader is now implemented in this tree. BOARD[633]
accepts its local1265/0/2 public replay proof. The two r19/r20 row-order
residuals remain reported. Exact-inventory required CI now exists; combined
full-app/private certification remains open.

## Publication outcome telemetry (S3 slice)

The intended transfer fences Clojure out in favour of the certified Python
poller. This slice changes no writer routing, lease policy or deployment.

A lost COMMIT response emits `PublishUncertain=1` before readback. Readback
then emits exactly one of `PublishResolvedOwn=1` or `PublishUnresolvedLost=1`.
Only this operation's coherent checkpoint, epoch, capability and tick establish
ownership. Newer math can overwrite the current four math rows without erasing
that operation's receipt in the new coordinator tables.
A missing/corrupt operation receipt or a reconnect/read failure
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
No alarm is deployed here. Bounded nonblocking transport and independent
producer/current-table observation are implemented, with public transfer and
rollback rehearsals under `tools/d05` and `tools/d07`. Operator notification
delivery remains unproved. O7 stays OPEN; local observations are not deployed
coverage.

## Rev7 operation admission

The bridge consumes the amended migration 000021 rev7, including observer
math-table access and per-conversation revocable writer authority. Before starting Python it commits a
control-only `pc_admit` reservation bound to the lease epoch, operation,
capability, checkpoint, source digest and expected generation. A lost admission
COMMIT reply stops dispatch; it never authorizes a worker launch.

Dispatch requires an explicitly configured `P026_RESERVATION_BYTES` (1 MiB to
1 TiB) and an independently provisioned namespace budget. The default is zero,
which disables dispatch. Runtime never inserts or enlarges budget profiles.
Tests alone install public-fixture profiles and request 64 MiB per operation. The
reservation must cover the three original payloads, receipt checkpoint and the
schema's 1 MiB accounting overhead. Both namespace operation count and logical
bytes remain charged for pending, unresolved and resolved operations.

Each completed dispatch reconciles its exact operation over a fresh control
connection. Each one-shot/daemon pass also visits at most `P026_PAGE_SIZE`
nonterminal operations, oldest reconciliation first, avoiding live workers
unless a receipt already exists. The fixed reconciliation RPC acquires its
locks; Rust independently checks all three original payloads and digests before
committing that state transition. Absent receipts stay unresolved and charged.
Corrupt receipts retain their prior state and capacity; repair is required and
repeated corruption can occupy the bounded reconciliation page.

Publication locks its own conversation and reservation, while admission holds
the namespace budget lock only for its short accounting transaction. Independent
conversations may finish out of caching sequence order; the original R12 overlap
and metadata-sweep controls remain required.

Runtime performs no automatic cleanup. Reviewed control callers may use
`pc_protect`, `pc_reference` and `pc_cleanup`; the substrate refuses deletion of active,
current, maximum, unresolved or referenced operations. Retained floors prevent
generation/caching cursor reuse after cleanup. Rust rejects current bundles
below the retained generation floor even when all four pointers agree.
Terminal release of absent operations, physical disk/WAL/MVCC limits and
production activation remain separate work.

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
- **S2 production-reader slice complete; overall O1 PARTIAL.** The joined
  production loadBundle, bounded whole-Bundle cache, caller propagation,
  owned featured-author response, source-deadline TTL and C7 presentation
  are implemented. The accepted local public replay completed1265 cases,
  zero oracle failures and two standing r19/r20 row-order differences;
  24 direct audit checks passed and all302 route fingerprints matched.
  `evidence/s2-production-reader.json` records that scoped proof. Required
  pinned-module CI with exact case-set/zero-skip enforcement is implemented.
  Combined immutable-build/full-app/private certification remains open. This is no full-contract certificate.
- **S1/S2 revalidated after the response-boundary harness repair.** On
  `97a6cca5a` plus the recorded harness/metadata edits, the same151 cases pass
  with zero failures/skips; both Rust profiles pass31 tests and all25 fault
  stages have fresh witnesses. `getPca` remains raw; `presentPca` supplies the
  served comment defaults. Both bypassing presentation and mutating the raw row
  are rejected by the repaired test. Three replay checkpoints and all polarity
  controls reproduce; the populated D4 compared bytes remain unchanged.
  `evidence/s1s2-repin.json` attributes all32 moved Delphi sources to merged PRs,
  inventories9 additional Python files, and identifies the local harness repairs.
  The two S2 test pins are reconciled separately with37 passing tests; the
  historical public replay is preserved, not rerun. Current accounting is8 open,
  0 closed,2 partial (O1/O8); the full gate still fails. The earlier150/1 run
  remains in `evidence/s1-revalidation.json` as historical evidence.
- **A real server-side quirk, fixed upstream not here:** Node's `getPca(zid,
  undefined)` once missed a freshly-committed generation zero on a cold cache
  while the HTTP route served it correctly. #2732 (merged to edge, in this
  rebased tree) fixes the cold miss; the review-control test is updated to that
  behaviour. The eventual `getPca` refactor still belongs to whoever owns that
  server code.
- **The staleness check is a time-boxed hint, not a proof**, and measured production service
  budgets remain unadmitted. Tests cover competing owners and unrelated
  publications, but do not certify a new multi-worker or warm-science profile.
- **No production alerting hookup** — the independent observer supplies
  PollHealthy, PublishLagSeconds and ObserverHealthy with local alarm checks.
  Transport, deployed dimensions, missing-data handling and notification
  arrival at an operator destination still require operational evidence.

## Bridge schema and credentials

Apply reviewed migration `000021_create_polis_coordinator.sql` separately in an
authorized environment. The CLI `migrate` path refuses automatic application;
`migration.sql` is retained only as historical prototype input. Set `DATABASE_URL`
to the restricted control login and `COORDINATOR_PUBLISHER_DATABASE_URL` to the
restricted publisher login. Neither may use legacy direct math-write credentials.
This implementation does not activate a deployment or revoke existing writers.

## Deployment boundary and build identity

An ordinary edge deployment activates the Node Bundle reader in the existing
server, using that server's configured `MATH_ENV`; it does not build or launch a
coordinator service. Coordinator source is present, and a separately built binary
runs only when an operator explicitly launches `polis-coordinator once` or `run`.
Migrations 000019/000021 are present in the repository; applying them requires the
separate reviewed migration procedure and go, and is not authorized by this merge.
The ordinary poller remains on its existing writer until launched through the
lease bridge: that requires restricted `DATABASE_URL` and
`COORDINATOR_PUBLISHER_DATABASE_URL` logins, mapped namespace authority, an
installed namespace budget, a positive `P026_RESERVATION_BYTES`, a pinned Python
runtime and the explicit coordinator launch. Serving that namespace additionally
requires replacing every serving replica with the destination `MATH_ENV` after
writer exclusion, drain and a recorded transition. The observer is separately
launched with `tools/d06/observer.py --profile ... --output ...` and its restricted
`COORDINATOR_OBSERVER_DATABASE_URL`; it does not configure notification delivery.

The checked-in engine manifest and bridge constants must bind the ordinary source
checkout. Campaigns still isolate their execution in a source snapshot, but a
current checkout requires zero metadata transformations. The retained mechanical
reconciliation helper reports any future source drift; such a transformed run
must not be represented as validation of an unchanged deployment build. Freeze
and review the manifest and actual executable/runtime before activation. These
source identity checks do not close full-contract, notification or capacity gates.

## How to run the checks locally

Run Rust commands from `coordinator-rs/`; run Python and Compose commands from
the repository root. Test results below distinguish historical runs from the
current required inventory.

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

When running from a copied test tree, set `POLIS_COORDINATOR_CHECKOUT_DIR` to
its full source checkout. A bad explicit coordinator override fails the run.
`POLIS_CHECKOUT_DIR` belongs to the projection/recordings test inputs and may
point to the partial `/app/projgate` tree in Delphi CI; it does not select the
coordinator checkout. Automatic ancestor discovery still works in a full checkout.

Historical S3 campaign before the rebase: `cargo test --locked` 31/31; both `cargo
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

The fresh revalidation audit exits1 (`full_contract_gate: FAIL`,25/25 stages
reached). S1/S2 source pins now verify after the complete successful campaign;
O8 and O1 are PARTIAL, with their remaining obligations explicit. Stage
reachability alone does not close any condition.

## Where the evidence lives

### Dedicated candidate CI (D02)

`.github/workflows/coordinator-ci.yml` adds the stable check
`Coordinator S1/S2 required` on every PR, edge/stable push, merge group and manual
run. It provisions a full history checkout, Python dependencies from the retained
exact requirements, Node 24 modules with `npm ci`, and the crate's pinned Rust
toolchain. It needs no credentials or private fixtures. Repository branch rules
must require this check separately; adding a workflow does not configure those
rules. A hosted run of this new job must pass before its required-CI obligation
can be accepted. Existing stack lint, server, Delphi and full-app jobs remain
separate required evidence on the same proposed build.

The runner executes both locked Rust test/clippy profiles, release and fault
builds, all 291 Python cases (including the original 151), 164 campaign controls,
all 25 stage witnesses, and the 37-case, three-suite production Bundle selection.
`ci/inventory-v2.json` fixes exact identities and preserves the historical v1
inventory. A pytest collection hook refuses a subset before
execution; JUnit, Cargo and Jest admission also rejects skips, duplicates,
substitutions and missing outcomes. The separate control suite has its own exact
inventory. New bridge cases need an explicitly reviewed inventory revision that
preserves the historical case set; they cannot replace old cases silently.

From a fully provisioned checkout, run this local-only command with an unused
project, port and output directory (the output must be outside the checkout):

```sh
COMPOSE_PROJECT_NAME=coordinator-local-unique \
POLIS_RECOVERY_PG_PORT=55492 RECOVERY_PG_PORT=55492 \
python coordinator-rs/ci/run.py --output /tmp/coordinator-campaign-unique
```

The runner owns its disposable PostgreSQL project and applies the unchanged
repository migration chain to a fresh public-fixture Bundle database. The
Python fixtures also use the reviewed coordinator substrate in their disposable
databases. The retained prototype SQL is not applied by the runtime. This adds
no production schema application.
The receipt records exact commands, actual runtime/image identities, source and
artifact hashes, counts, failure controls and cleanup. There is no private run,
deployment, activation or transfer in this job.

Old artifacts are parked before execution and restored afterward. Four D4
summaries are removed before the tests, requiring fresh witnesses. Fresh replay
and polarity results are compared to the reviewed baseline; existing source pins
are verified without calling either closure recorder. All historical evidence is
restored byte for byte, and the fresh receipt is retained separately. The
published-empty bytes and stable D4 fields must reproduce. Synthesized-empty
request-clock and associated JSON/gzip observations retain their existing
non-certifying scope: nine precisely named values are retained in the receipt,
with no synthesized-empty byte-equality or clock-only-causation claim. Changes
to stable fields, published bytes or inconsistent observations fail admission.
The
candidate gate may PASS while the full-contract gate remains FAIL with O1/O8
PARTIAL. The earlier closure records describe their historical slice; this new
plumbing does not silently rewrite or close those obligations.

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
