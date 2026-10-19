# CLI differential loop

Run the real CLI against one generated database with Node routing, reset the
fixture and local credential/files state, then run it again with every inventoried
staged Rust route enabled. This is independent of the byte replays: it neither starts
those runners nor reads a recording archive. Byte replays remain the wire gate.

Build the CLI and four local images from the source being tested:

```sh
(cd polis-cli && cargo build --locked -p polis --features fixture-ids)
docker build --target prod --build-arg NODE_ENV=production -t cli-diff-node -f server/Dockerfile server
docker build --build-context queue-rs=queue-rs -t cli-diff-postgres -f server/Dockerfile-db server
docker build -t cli-diff-oidc oidc-simulator
docker build --build-arg FEATURES=fixture-clock -t cli-diff-rust -f queue-rs/polis-api/Dockerfile queue-rs
```

Choose an unused project and three unused ports. The images are explicit and
`up --pull never` prevents a test from silently changing them. The nginx image
is the same pinned tag used by the existing routing tests.

```sh
export COMPOSE_PROJECT_NAME=p027cli-diff-local
export P027_PORT_MIN=56201 P027_PORT_MAX=56203
export POLIS_RECOVERY_PG_PORT=56201 RECOVERY_PG_PORT=56201
export P027_HTTP_PORT=56202 P027_CONTROL_PORT=56203
export CLI_DIFF_NODE_IMAGE=cli-diff-node CLI_DIFF_POSTGRES_IMAGE=cli-diff-postgres
export CLI_DIFF_OIDC_IMAGE=cli-diff-oidc CLI_DIFF_RUST_IMAGE=cli-diff-rust
bash scripts/test-polis-cli-differential.sh \
  --binary polis-cli/target/debug/polis --output /tmp/cli-differential.json
```

The runner refuses an existing project and removes only its own containers and
volumes in `finally`, even on an assertion failure. No application services can
reach external providers: Node, Rust, Postgres, DynamoDB and the OIDC simulator
are on an internal network. A small gateway exposes loopback ports and forwards
only to the sealed proxy/control service. No real credentials or data are used.

`cases.py` explicitly names every implemented command. The running binary's
`schema` supplies the independent census. A new implemented command without a
scenario fails the run; planned leaf commands must still return exit 8 in both
modes. Parent commands that also perform an operation (such as `vote`) are
included. Local discovery, authentication, file operations and mounted-router
commands are included even when absent from a server registration inventory.
This is one scenario per command, not exhaustive option/identity coverage.

The comparator ignores JSON object key order only. It retains all data/error
fields, types, arrays, IDs, timestamps, status/exit codes and downloaded file
hashes. It never drops fields, replaces IDs, sorts arrays, retries writes or
accepts a mismatch. The output lists differing JSON paths without secret values
or submitted text. `auth token` is compared privately in memory, never logged.

The gateway also records the actual response body bytes for successful `math
view` (whole and subset) and `api` scenarios, whose payloads are printed directly
under `data`. A separate numeric check parses the original wire and CLI stdout
number tokens as exact decimals, not binary floats. It catches parse/print drift
even when the same CLI binary makes the identical mistake in both phases.
Equivalent exponent/trailing-zero spellings are accepted; changed, missing,
additional or nonnumeric replacement fields fail. The generated PCA center
includes a value that exposed a one-bit parser drift without `float_roundtrip`.

Capture is bounded to 8 MiB per body and two responses, stays in memory, and
never rewrites the bytes forwarded to the CLI. Gzip is decoded with a bounded
output size. Missing, duplicated, truncated or oversized recordings fail the
check. Only numeric field counts, differing paths and body hashes enter the
`node_numeric_wire` / `rust_numeric_wire` reports. Other commands reshape their
payloads and retain the existing semantic comparison; they do not claim this
additional numeric wire coverage. The separate byte-replay corpus is untouched.

Generated test clocks, SQL timestamp defaults and server-generated identity
entropy are fixed *before* execution, not erased from results. They live only
in the test entry point and disposable database; the real handlers, access
checks and credential signing run unchanged. The explicit CLI `fixture-ids` feature similarly accepts a generated statement
UUID from `POLIS_CLI_FIXTURE_UUID` before a seed write. Default production builds
have no such override. This does not change OAuth randomness, authentication,
receipts, or the comparison. Using a normal binary deliberately fails the seed
receipt comparison; build the documented test variant.

Some commands need stored analysis artifacts absent from this small fixture.
Their rows are marked `missing-store`, the collective-statement exports among them;
the narrative export, whose routes this server version does not serve, is marked
`unserved`; malformed external-result imports
are marked `invalid-input`. Those rows verify empty/availability/refusal behavior only; they are
not successful export/import, provider, analysis or backend coverage. Planned
commands and local commands are likewise reported separately. Never turn a
connectivity/parser/authentication failure into a successful live scenario.

The real nginx renderer receives `RUST_API_ROUTES` empty and then every
switch in `routes.json`. The route-template census rejects missing entries.
Each entry requires an exact request count, a minimum number of sole Rust
HTTP200 responses, and an exact count of scoped Node handoffs with a reason.
These counts cover this generated fixture only. Unexercised routes explicitly
claim no CLI coverage. Named-location and retry chains are always handoffs,
never Rust successes. Added handoffs or lost positive coverage fail the run.
The raw byte replays remain the per-route behavioral oracle.

Cursor-based owner listing is a new contract without a Node counterpart. Its two
scenarios are reported separately in `rust_only`, never counted as byte or JSON
equality. With switches off they must return exit 8, `capability_unavailable`,
and the exact documented message; with switches on they must succeed and leave
the same downloaded artifacts. The owner CLI and PostgreSQL contract tests check
response shape, filtering, authorization and cursors. Authentication and other
server failures remain distinct. All existing Node-vs-Rust equality comparisons
and durable participation/administration assertions are retained.

The participation path stays unchanged. The fixture runs one bounded live CLI
request/flow at a time (unimplemented local commands run concurrently and must
make no HTTP requests), uses only the existing Node write routes, and adds no
production schema, pool, lock, queue, provider or Rust write. No load/isolation
performance claim follows from this functional test.

Dedicated administration cases are in `admin_cases.py`. After the existing
missing-store cases, `admin-seed.cjs` creates empty local analysis tables and one
generated completed-job record. The simulator's real admin claim and generated
local developer user exercise operator reads and queue admission. No worker is
started. Empty feeds, blocked mail, disabled operator endpoints, missing legacy
tables and permission refusals have separate scenario labels; none claims a
provider computation or delivery.

`admin-verify.cjs` independently checks durable database effects, including
participant attribution, subscriptions, agenda saves/removal, reports, allowlists,
account changes and job admission. It also verifies the existing star handler's
persisted row despite its error response. Output contains check names only.
Run native CI before the live loop: native tests rebuild the default binary;
rebuild `--features fixture-ids` afterwards, and keep that binary unchanged
through both phases.

The stack lifecycle, the per-actor CLI invocation, the comparator, the routing
counts and the phase loop live in `harness.py`. `run.py` holds the fixed
scenarios; `polis-cli/tests/fuzz/run.py` runs seeded generated sequences on the
same stack in three phases (Node, switches on, Node again as the A/A control)
through `scripts/test-polis-cli-fuzz.sh`.

### Generated sequence clocks

The fuzz entry point advances the fixture clock before each step using
`1700000010000 + (run_seed mod 86400000) + index * 10000` milliseconds.
All three phases use the same sequence. The base follows the generated fixture
rows; the stride exceeds the Node and Rust math caches' 3000 ms TTL.
The step barrier drains request effects before the next clock change.
Node's `/begin?clock=...` sets `Date`; the sealed gateway supplies
`X-Polis-Fixture-Clock` to fixture-enabled Rust requests. Rust scopes it to the
request future. Production Rust builds ignore this header; real timers and
request deadlines stay unchanged. Calls without a clock retain the historical
frozen replay clock. No committed recording is refreshed by this change.

`test-polis-cli-fuzz.sh --clock-mode within-window` deliberately keeps one
seed-derived instant throughout each phase. It reports the existing shared
math-cache difference through the known-differences registry, with the same
zero bound; this mode is a diagnostic, not an equivalence pass.
