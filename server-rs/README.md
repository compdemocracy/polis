# Polis API: PCA2 implementation candidate

`polis-api` implements `GET /api/v3/math/pca2` with Axum, Tokio and
`tokio-postgres`. This is the first P-032 route candidate against commit
`c9685319980cd048d3c7bfa98e75b0c302083a6a` and the 869-case archive SHA-256
`f448cbbb5d754b3e152ffef67578c41f0fdff4b583f6cf7eb7b6bc2090aa6eef`.
The judgement selects exactly its 336 `/pca2/` cases, preserving recording order.
Results are in `evidence/results.json`; committed-zero HTTP checks are separately
reported in `evidence/tick-zero.json`. Nothing changes traffic routing.

## Route behavior and types

The reference registration in `server/app.ts:336–352` is `moveToBody`,
`redirectIfHasZidButNoConversationId`, required capability-to-zid resolution,
optional integer `math_tick`, optional string-array `keys`, optional length-limited
`If-None-Match`, then `handle_GET_math_pca2`. There is **no authentication,
participant binding, ownership or moderator check** in this chain or the handler
in `server/src/routes/math.ts`. Anonymous and cross-owner 200s in the recording
corroborate that. Generated participant tokens are verified by the replay adapter
before all four recorded actors' actual credentials are sent to Rust.

SQL lookup and the LRU key both include `(MATH_ENV, zid)`. The generation column
wins over the engine-local blob tick, including at zero. Omitted tick means -1;
equal/newer ticks produce 304. Both branches of Node's `finishWith304or404` are
304. A missing row in the selected environment synthesizes the ordered empty
structure with approved tids; rows under a different environment do not count.
The characterization feature injects the same fixed clock as the recorder;
ordinary builds use wall time. The three-second cache uses a 300-entry LRU when
`CACHE_MATH_RESULTS` is unset/blank/`true`, otherwise one entry.

`src/model.rs` contains 24 generated structs/enums, explicit serde field order,
typed numeric maps and a typed subset serializer. Optional fields reject explicit
null; the observed null timestamp is a distinct unit/null type. There is no
`serde_json::Value`, flattened arbitrary-success map, or raw-JSON success escape.
`contract/empty.schema.json` is the supplied empty contract.
`contract/populated.schema.json` is an **implementation candidate**, derived from
all 96 full response recordings, with closed objects and explicit empty-only
collection resolutions. Independent populated-schema review and client admission
remain open. `tools/generate-contract.py` preserves observed order constraints and
fails on conflicting orders or unresolved empty element types.

Full mode sends the cached gzip buffer without reserialization or recompression.
The reference Postgres column is JSONB, not a gzip column: as in Node's
`updatePcaCache`, the buffer is created once when an entry is loaded. Rust reads
the stored JSONB, removes the same internal/subgroup properties in SQL, applies
the group-vote id normalization and typed merge defaults, and stores both the
typed object and its compressed bytes. `keys=""` selects `{}`, while `keys: []`
selects full mode. Subset serialization follows requested key order, deduplicates
keys, and omits unknown/prototype properties. Integers in numeric maps enumerate
numerically; finite floats use `ryu-js` for JSON.stringify spelling, including
negative zero and exponent boundaries.

## Wire compatibility

The comparator preserves header casing/order and gzip bytes. `src/transport.rs`
uses Axum routing behind a small HTTP/1 writer to preserve the observed headers;
it handles one request per connection. The recorded policy explicitly excludes
Connection/Keep-Alive/Date. The writer bounds request size and rejects ambiguous
Content-Length/Transfer-Encoding framing. HTTP/2, streaming request bodies and
production transport hardening are outside this candidate.

Ordinary 304s retain Content-Type and Vary and have no ETag. Express's wildcard
freshness 304 removes Content-Type/Vary but keeps the explicit gzip coding and
ETag. Full 200s use `application/json`; subset/error JSON adds `charset=utf-8`.
Negotiated large subsets use gzip and chunked transfer; short subsets retain
Content-Length. The recorded conflict error uses Express 3's MD5 weak automatic
ETag, including the source's `If-Not-Match` typo.

Stock zlib produces different DEFLATE bytes despite identical decoded JSON.
`vendor/node-zlib` contains only the needed, unmodified compressor files from
[Node v22.23.2](https://github.com/nodejs/node/tree/v22.23.2/deps/zlib), with source
hashes and both upstream licenses. Node's
[insert-string implementation](https://github.com/nodejs/node/blob/v22.23.2/deps/zlib/contrib/optimizations/insert_string.h)
uses a different dictionary hash from canonical zlib. `build.rs` compiles that
compressor without SIMD; `src/gzip.c` sets Node's level/window/memory/strategy and
Unix gzip OS byte. Golden tests cover empty, populated and large-subset gzip.
No Node subprocess runs inside the service.

## Build and verification

Run Cargo inside this directory so `rust-toolchain.toml` applies. It pins 1.98.1
with rustfmt/clippy, matching the coordinator checkout. The requested
`experiment/rust-coordinator` ref was absent here; the same pinned toolchain and
instructions were read from the existing coordinator checkout instead.

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

The ordinary service needs `DATABASE_URL` and `MATH_ENV`; `MATH_ENV` has no
default and the process refuses to start without it, because `Config.mathEnv`
has none either and an unset variable would silently serve another namespace's
math. `LISTEN_ADDR` defaults to `127.0.0.1:5000`.

CORS is not configured here: `src/cors.rs` reads the same variables
`addCorsHeader` reads — `DOMAIN_OVERRIDE`, `DEV_MODE`, `NODE_ENV`, `TESTING`,
`API_DEV_HOSTNAME`, `API_PROD_HOSTNAME` and `DOMAIN_WHITELIST_ITEM_01..08` — and
reflects the request `Origin` (or `Referer`) rather than emitting a static one.
The recording ran with `DOMAIN_OVERRIDE=localhost`, so every recorded response
carries `https://localhost`; that is one point on the curve, not the rule.

No credential values are provided or stored here. For this candidate use the
generated local stack.

From the repository root:

```sh
NODE_PATH=/Users/colinmegill/polis/server/node_modules \
  server-rs/tools/replay-pca2.sh
```

The script builds the characterization binary, chooses a fresh random
`rpca2x-*` project and five free ports within 55720–55739, starts the six existing
local images without pulling, seeds the exact SQL fixture and real Python math
writer, installs the Dynamo page fixtures, runs schema/replay/control and six
additional HTTP checks, then tears down only that project. Docker's sealed
internal network suppresses published ports on this host; the owned driver's
stdio bridge exposes only Postgres, the Node fixture authority and DynamoDB to
loopback without changing the network's internal property. Rust handles all 336
route requests directly at its base URL. The Node server supplies generated
tokens only; it never serializes or proxies a Rust response.

The adapter reuses `cli.cjs`'s actual request sender and state snapshot plus the
unchanged wire comparator/normalizer/oracle. It snapshots every SQL table and
Dynamo table before/after each request, checks whole-run state equality, observes
the Rust child lifecycle/stderr and its working directory, and performs the
key-reorder control on an actual Rust subset response. Node-only dispatch
markers use the comparator's existing `P027_MARKERS=0` exclusion. External/file
absence is supported by the binary's lack of those IO paths, child observation
and directory/state checks; it is **not syscall-level interception** and does
not close the broader P-025 process/effect admission program.

Regenerate the candidate schemas/types from the pinned wire, then format:

```sh
python3 server-rs/tools/generate-contract.py
(cd server-rs && cargo fmt)
```

## Scope still requiring admission

The 336 recorded cells and extra committed-zero witness are the conformance
claim. The supplied contract explicitly left populated/client/numeric-boundary
review open. Non-null `lastModTimestamp`, new populated fields, different
publication shapes and numeric map keys outside the implemented u32 domain
require additional typed evidence; the decoder fails closed. General Express
query-object/coercion variants, richer content negotiation, dynamic CORS and
transport behavior outside these recordings are not certified by this run.
Runtime failure responses outside the recorded 200/304/400 cells are also not
certified. The legacy wall-clock empty-body behavior remains nondeterministic
outside the injected recording clock, as documented in P-040.
