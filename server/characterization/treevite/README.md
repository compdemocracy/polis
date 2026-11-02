# Treevite recordings

This Node-only profile observes all nine registered Treevite routes on the
sealed characterization stack. No product code, migrations, or shared recorder
rules change. The participant endpoint is `myInvites` (camel case), and both
`invites/csv` and `myInvites/csv` are included. This directory is independent of
the identity and post-comments fixtures.

`cases.cjs` is the ordered scenario matrix. It covers root and child wave
creation, explicit and default parents, immediate and lazy child issuance,
wave/invite reads and pagination, empty and populated participant reads, both
CSV exports, GET/HEAD, fresh acceptance, accept → login → me, trimming, used,
unknown, wrong-conversation, revoked and expired-status invites, invalid and
revoked login codes, ignored login expiry, inconsistent bcrypt storage, owner
refusals, parameter refusals and malformed/missing Bearers. Every route has a
success, authentication refusal and missing-conversation case.

Two requested refusal scenarios are actually successful in today's Node:
Treevite disabled does not disable these handlers, and an allow-listed XID
presenting an invite is not rejected. The matrix records both the bare-XID
fresh anonymous path and the verified existing-XID conversion path. It then
removes the XID from the allow-list: the original XID is refused, while the
converted login and anonymous identity continue to work.

`deltas.json` separates the immutable Node baseline from deliberate corrections.
TQ1 refuses XID/account conversion; F2 atomic admission must remove the race
loser's partial membership. PID-zero and cross-conversation anonymous behavior
are also marked. TQ2 says surge is never throttled: this functional corpus
adds no limits and makes no throughput or capacity claim.

## Evidence and comparison

`recordings.json` contains each normalized request, ordered response headers,
base64 response bytes, verified JWT claims/header, before/after rows, database
effects, route hits and explicit assertions. The profile uses the identity
harness's real HTTP transport, generated fixture data and clock, PostgreSQL and
DynamoDB snapshots, work-drain barrier, ephemeral signing keys, JWT verifier,
typed capability normalizer and lexical JSON string substitution. It has its
own `treevite-recordings/1` projection because two responses share one race
snapshot; it is not a P-025 transport record.

No raw login code or bearer token is persisted. Codes live only in driver
memory. Before substitution the runner verifies bcrypt cost 10 and the full
bcrypt comparison, SHA-256 lookup, HMAC fingerprint, `fp_kid`, RS256 signature,
issuer/audience, lifetime and committed UID/PID/conversation binding. The
explicit inconsistent-storage case is separately seeded. SQL timestamps become
typed presence symbols; NULL stays NULL. Generated IDs are deterministic from
the fresh seed and compared exactly, including numeric versus bigint-string
representation. Generated site IDs and invite codes are encounter-bound typed
symbols. JSON string values alone are substituted; field order, delimiters,
whitespace, numbers and all other bytes remain exact. CSV code/date cells are
substituted against observed rows; row order, labels and newline bytes remain.
Original Content-Length and ETag are checked before deriving their normalized
values. HEAD headers are checked against an adjacent real GET's entity headers.
Clock/connection headers, chunk boundaries and elapsed timing are excluded.
The first owner request may fetch the local simulator JWKS. Its key is verified
against the owner token before symbol substitution; any other outbound attempt
fails the profile. No provider network outside the sealed stack is used.

The race control is loaded only by `treevite/entry.cjs`. It runs two real unused
invite SELECTs and parks their results. It releases the first until its consume
UPDATE is reached (membership has committed), then the second until its UPDATE
is reached. Both real compare-and-set statements then run, first followed by
second. No SQL result or error is mocked. Exactly one response is 201; the loser
is 400 `polis_err_treevite_invite_race_condition`. Assertions pin two committed
users/participants, one consumed invite and one login row, and identify the
loser's member row without a credential. This is a controlled real PostgreSQL
interleaving, not a probabilistic stress test or a mixed Node/Rust test.

## Record and replay

Prepare the same images used by the identity workflow (server dependencies,
current Postgres migrations/runner, file server, OIDC simulator, DynamoDB).
The CI workflow builds these before starting the internal network. Local runs
use available images without pulling. Choose a unique project and three unused
loopback ports:

```sh
export COMPOSE_PROJECT_NAME=p027treevite-$(openssl rand -hex 4)
export P027_PORT_MIN=56585 P027_PORT_MAX=56587
export POLIS_RECOVERY_PG_PORT=56585 P027_HTTP_PORT=56586 P027_CONTROL_PORT=56587
export P027_POSTGRES_IMAGE=treevite-postgres:local
bash server/characterization/treevite/run.sh
```

A source archive must also set `P027_SOURCE_COMMIT` to its full base commit.
Optional `P027_SERVER_IMAGE`, `P027_FILE_SERVER_IMAGE` and `P027_OIDC_IMAGE`
select prepared images. `provenance.py` records image IDs and source hashes,
checks the internal network and read-only source mounts; the driver requires
the transaction-scoped participant allocator. Nothing contacts production.

Ordinary verification records once and replays twice, each with a fresh SQL
seed and restarted Node/DynamoDB. All three runs compare every case against the
checked-in fixture; fresh output never becomes its own expectation. Outputs
are under `server/characterization/artifacts/treevite-*`. Only the owned Compose
project and volumes are removed on success or failure.

To deliberately re-record, run the same command with `--update`. It validates
the entire matrix before copying the completed fixture into this directory.
Review the fixture and delta ledger, then run without arguments to perform the
record and both replays against that expectation. Keep recording changes
separate from serving changes, as required by `ci/post_comments_golden_guard.sh`.
Future Rust consumers must implement the named security deltas explicitly;
these vulnerable Node results are evidence, not a requirement to reproduce them.

## Opt-in Rust credential replay

`queue-rs/polis-api/conformance/treevite-write-run.sh` wraps this same record and
two-replay profile. Set its unique Rust port and an address reachable from the
sealed driver. The original Node corpus remains the expectation. Each accept
or login also restores its raw before-state and sequence positions into the
separate disposable `p027_rust` database and calls the Rust handler. It verifies
credential derivations, signatures, identity binding, expiry and response bytes.
The delta ledger names the intended differences. Ordinary profile runs do not
load or start Rust.

The differential profile alone temporarily shares its generated signing key
with Rust in mode-0600 artifact files. Cleanup removes those files and stops the
owned Rust process. No private key or generated credential belongs in a retained
recording or a test result. Do not point the replay database URL at another
name: restoration truncates its generated fixture tables.

On a Docker VM host, set `P027_TREEVITE_HOST_BRIDGE=1`, choose another unused
loopback port as `P027_TREEVITE_HOST_PG_PORT`, and use
`P027_TREEVITE_RUST_URL=http://treevite-rust-bridge:<Rust port>`. The optional
adapter forwards two fixed TCP destinations: the disposable PostgreSQL and
`host.lima.internal:<Rust port>`. It publishes only the database adapter on
loopback. Node and the recorder remain on their original internal network;
the adapter does not interpret HTTP or SQL. Cleanup removes it as well.
