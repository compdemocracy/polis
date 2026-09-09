# server-rs (`polis-api`)

An experimental crate, not a merge or deployment decision. It runs on branch
`experiment/rust-pca2-route` (draft PR #2741) and changes nothing about how
production traffic is routed today.

Polis's API serves a `GET /api/v3/math/pca2` route: given a conversation, it
returns the latest computed clustering result (or a "nothing new" 304). Today
that route is Node/Express. This crate is a from-scratch Rust reimplementation
of that one route, built and judged by trying to match the existing Node
route's output byte for byte, header for header, on a large set of recorded
real requests — not by re-deriving the behavior from a written spec.

## What this crate owns

- **The one route** `GET /api/v3/math/pca2` — request parsing, the SQL lookup,
  an in-process cache, tick/`If-None-Match` handling, and building the
  response (`src/main.rs`, `src/model.rs`, `src/db.rs`).
- **Matching Node's exact wire behavior for that route**, including quirks
  that look like bugs: which HTTP headers appear, in what order and casing,
  which content-negotiation edge cases select which compression, and
  byte-identical gzip output — not just "the same JSON" (`src/transport.rs`,
  `src/negotiate.rs`, `src/gzip.c`, `vendor/node-zlib/`).
- **A typed, closed description of every response shape actually observed**
  in the recorded traffic (`src/model.rs`, `contract/*.schema.json`) — an
  unrecognized shape is refused loudly (HTTP 502) rather than guessed at —
  plus a connection pool to Postgres with a basic health check at `/health`
  (`src/db.rs`).

## What this crate explicitly does not own

- **Every other API route** — one route out of the whole API surface;
  nothing else in the Node server is touched or replaced.
- **Authentication, in general** — this route itself has none in Node either
  (see "What it promises"), a property of the route being ported, not
  something this crate adds or removes.
- **The math coordination layer** — deciding when to recompute a
  conversation, leases, and durable publication belong to `coordinator-rs/`
  (see that crate's README); this crate only reads what has already been
  published.
- **Encrypted database connections (TLS).** The pool connects with `NoTls`.
  This is a known, named blocker — see "What is still open" — not an
  oversight to be inferred.
- **Production traffic routing.** Nothing here is wired into `nginx-proxy` or
  the real deployment. Passing this crate's checks is a precondition for a
  future routing decision, not the decision itself.

## What it promises

The contract is a set of internal design notes (`cost-reduction/04-plans/
P-032-slice1-pca2.md` and `P-032-slice1-rust-implementation-notes.md`, not
shipped in this branch — see "Where the evidence lives"). In plain terms:

- **Byte-for-byte equality with the real Node route, on every recorded case.**
  Not "produces equivalent JSON" — the literal bytes on the wire, including
  gzip-compressed bytes, header order and casing, and quirky legacy behavior
  (e.g. a comment-count field that is `null` today is typed as "a number or
  null," matching Node's declared type, not just what the recordings happen
  to contain).
- **No authentication.** The real Node route chain has no participant,
  ownership, or moderator check before it serves math data — verified against
  the recording, not assumed. This crate reproduces that as-is; it is not
  this crate's place to silently add a check the reference doesn't have.
- **Two data shapes: "empty" (a certified contract) and "populated" (an
  implementation candidate).** The "empty" response shape (what gets served
  when there's nothing to show yet) is a reviewed, certified contract. The
  "populated" shape (an actual computed result) is generated from the 96
  full response bodies actually observed in the recordings — a strong
  starting point, but explicitly **not** independently reviewed or certified
  the way the empty shape is.
- **An honest refusal beats a guess.** A response shape this crate's decoder
  doesn't recognize is answered `502 polis_err_pca2_contract_violation`
  (logged, counted on `/health`) instead of a best-effort 500 or a silently
  wrong 200.
- **A named, narrow set of allowed compression outcomes** — `gzip` or
  `identity` — matching exactly what the real (old) compression middleware in
  front of Node can ever select; anything else Node's negotiator could
  theoretically pick (like `deflate`) is refused with a named 502, not guessed.

## How it is judged

The gate is a byte-exact replay against real recorded traffic, not "the tests
I wrote pass":

1. **The 336-case replay.** A fixed, recorded set of 336 real HTTP
   request/response pairs against this route (drawn from a larger 869-case
   archive, pinned by content hash) is replayed against this crate's own
   HTTP server. Every request must produce the *exact* same bytes — status,
   headers, and body — as what was recorded from the real Node route,
   checked by an existing, unmodified comparator tool: **336/336 match, 0
   oracle failures**, per the crate's checked-in evidence (`evidence/
   results.json`) — see "How to run" for what re-running this today actually
   showed. A **key-reorder control** (asking for the same fields in a
   different order) is expected to still pass schema validation but *fail*
   the exact-replay check, itself a check that the comparator isn't
   accidentally too lenient.
2. **Header parity, measured live.** A separate check
   (`tools/negotiation-parity.cjs`) drives real `Accept-Encoding` headers —
   49 of them, including deliberately odd ones — through a live copy of the
   real, exact compression middleware Node uses, and compares its choice
   against this crate's: **49/49 match** (re-verified locally, see below).
3. **Rust-side checks** — `cargo fmt --check`, `cargo test` (default and the
   `characterization` feature), `cargo clippy -D warnings`, and a release
   build.
4. **Everything above running against a live, disposable six-service stack**
   (the same containers used elsewhere in this repo — Postgres, DynamoDB, the
   Node app, etc.) rather than mocks, torn down after.

A green run of this crate's own unit tests is not the finish line — the
336-case replay against the real recordings is.

## What is still open

None of these is hidden or waived; they are named blockers, not nice-to-haves:

- **B1 — the populated-shape census is not run against a full/production
  corpus here.** The typed model was built from 96 recorded bodies plus two
  small real samples read once, read-only, and not committed. Before this
  model is trusted broadly, it needs to be run against a much larger real
  corpus: `P032_CENSUS_DIR=<dir> cargo test --locked -- --ignored census`
  decodes every blob in a directory you supply and reports any shape it
  cannot describe. No production data of any kind is committed to this repo.
- **TLS is not implemented.** The database connection is unencrypted
  (`NoTls`), which is fine against a local disposable Postgres and not fine
  against anything resembling production. This blocks any real deployment
  consideration on its own.
- **m6 — the vendored compressor's equivalence to the production Node
  image's own compressor is a separate, not-yet-done verification.** The
  vendored `node-zlib` sources are pinned to a specific Node release; nobody
  has confirmed the real deployed image compresses identically, only that
  this pin does.
- **Wider traffic admission is not certified** — general Express
  query-parameter coercion quirks, richer content negotiation than the 49
  measured headers, dynamic CORS, HTTP/2, streaming request bodies, and any
  runtime failure response outside the recorded 200/304/400 cells are
  outside what these 336 cases exercise. This is a byte-exact port of one
  route's *recorded* behavior, not a general Express-compatibility certificate.
- **The legacy "empty body" clock is nondeterministic** outside a fixed test
  clock — a field in the synthesized empty response stamps the current time,
  so two servers answering the same request outside the recording's injected
  fixed clock produce different bytes and their `ETag` cannot mean what an
  ETag normally means. Inherited from Node, not introduced here.

## How to run the checks locally

Run every command from inside `server-rs/` unless noted; `rust-toolchain.toml`
pins the exact compiler (`1.98.1`) and is picked up automatically there.

```sh
export CARGO_HOME=/private/tmp/p026-toolchain/cargo
export RUSTUP_HOME=/private/tmp/p026-toolchain/rustup
export PATH="$CARGO_HOME/bin:$PATH"

cargo fmt --check
cargo test --locked
cargo test --locked --features characterization
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo build --locked --release
```

Re-run from a clean checkout of this branch and confirmed: `cargo fmt --check`
clean; `cargo test --locked` and `--features characterization` both **50
passed, 0 failed, 1 ignored** (the ignored one is the B1 census gate, which
needs a corpus you supply — see "What is still open"); clippy clean across
all targets/features; release build succeeds.

The full 336-case replay against a live six-container stack needs Docker.
Run it from the repository root:

```sh
NODE_PATH=/Users/colinmegill/polis/server/node_modules \
  server-rs/tools/replay-pca2.sh
```

**Isolation rule:** this script (and any manual run) must use a compose
project name and a port range that belong to nobody else, so concurrent runs
never collide. The script's own defaults (project prefix `rpca2x`, ports
`55720`–`55739`) **did not pass this repo's isolation guard when tried against
this exact commit**: `server/characterization/isolation.py` — a shared file,
not owned by this crate — requires the compose project name to start with
`p027` and the three forwarded ports to sit inside `$P027_PORT_MIN..MAX`
(default `55930..55939`). Overriding `P032_PROJECT_PREFIX=p027x`,
`P032_PORT_MIN=55930`, `P032_PORT_MAX=55939`, `P027_PORT_MIN=55930`,
`P027_PORT_MAX=55939` got past that guard. The script always tears down its
own project on exit or failure (confirmed: no leftover containers, networks,
or volumes after either a passing or a failing run) and never pulls images.

With that override, the stack came up, seeded, and the header-parity check
(criterion 2 above) passed — **49/49**, matching what's recorded. The 336-case
byte comparison (`tools/replay.cjs`) then **failed on this exact checkout**,
not on a difference in this crate: it hard-codes an expectation of exactly
869 total recorded cases before selecting its 336, and the shared
`server/characterization/artifacts/baseline.json.gz` archive here holds
1,265 — a later, unrelated recording round (commit `867d83f76`, a different
slice's comments recordings) appended to that same shared archive after this
crate's evidence was pinned to the 869-case one. This is a stale pin in
shared harness code, not a byte mismatch in the route, and it means the
336-case replay is **not currently runnable end-to-end** without first
reconciling that pin — reported here rather than worked around.

Regenerate the typed model from the pinned recorded wire, then format:
`python3 server-rs/tools/generate-contract.py && (cd server-rs && cargo fmt)`.

## Where the evidence lives

- `server-rs/evidence/*.json` — checked-in, sanitized summaries: the 336-case
  replay result, header-parity counts, source-file pins, and a diagnostic
  record of the stock-vs-vendored zlib difference that motivated vendoring
  Node's own compressor. No production data or credentials are in these
  files. `evidence/checks.json` keeps a labelled provenance record from the
  first submitted round alongside the current tree's counts, so the two are
  never confused.
- `cost-reduction/04-plans/P-032-slice1-pca2.md` and
  `P-032-slice1-rust-implementation-notes.md` — the accepted design notes and
  review history this README summarizes; they live outside this branch and
  are the authoritative record of why each decision was made and who signed
  off.
- `server-rs/contract/*.schema.json` and `*.json` — the empty-response
  contract, the populated-response candidate schema, and pinned sample
  bodies used to generate `src/model.rs`.
- Detailed per-run wire comparisons are kept locally in a git-ignored
  `evidence/actual.jsonl`, regenerated by the replay script rather than
  committed.

## Glossary

- **Byte-for-byte / wire-exact** — matching not just "the same data" but the
  literal bytes sent over the network: header spelling, order, casing,
  compressed bytes, everything.
- **Replay / oracle** — resending a previously recorded real request and
  comparing the new response against what was recorded then; the *oracle*
  decides pass/fail from that comparison ("0 oracle failures" means every
  comparison it made agreed).
- **Census** — an exhaustive count-and-classify pass over a corpus of real
  data, checking every shape a decoder might see is actually accounted for,
  not just the shapes a small sample happened to contain.
- **Contract** — a written, versioned description of what a component
  promises to produce or accept, independent of implementation. Here, an
  "empty" contract (certified) and a "populated" contract (a candidate).
- **`math_env`** — a namespace label (`python`, `rustproto`) keeping results
  from different engines/experiments from colliding in one database (see
  `coordinator-rs/README.md`).
- **Negotiation** — how a server and client agree on a response format
  (here, which compression, if any) from the client's `Accept-Encoding`.
- **ETag / conditional request** — a short tag for "this exact version of
  the response"; a client can ask "still this version?" via `If-None-Match`
  and get a cheap 304 instead of the full body.
