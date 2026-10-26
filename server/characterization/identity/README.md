# Identity recordings

Observable serving changes: none. This profile records the current Node
middleware and routes on the existing sealed characterization stack. It adds
no identity implementation, handler edit, schema migration, or production data.
`queue-rs/polis-api/conformance/identity-run.sh` is a separate Node-only
recording workflow for first-contact writes and refusal responses. It does not
extend `participant-run.sh` or start the Rust API. Rust consumes the returned
tokens through the `polis-auth` integration test.

The generated matrix in `cases.cjs` includes anonymous first vote and repeat,
anonymous cross-conversation use; bare XID on participationInit, votes and
comments with the allow-list off/on and XID required; XID tokens in their own
conversation, another conversation under the same owner, another owner's
conversation, and request-XID precedence; standard-user first join and repeat;
OIDC first use/repeat; both anonymous and XID `pc` cookie migration; Treevite
accept/login/refusals; and the classifier and OIDC provisioning refusal bodies, including wrong audience
and issuer for all three participant token kinds.

Each case uses the existing `runCase` transport, database snapshots, effect
drain, P-025 record validation and exact comparator. SQL failures are explicit,
controlled faults in `entry.cjs`, loaded only by this profile. They exercise the
real query caller and middleware error handling. The outer OIDC
`authentication_error` catch requires a one-shot request-property failure:
ordinary JSON claims cannot naturally throw while reading `jwtPayload`. This
control is distinguished from SQL failures in the case inventory and evidence.
For `oidc-load`, the driver rejects four mapping INSERTs with SQLSTATE 23505
and constraint `oidc_user_mappings_pkey`. Node rolls back each transaction,
performs its three real delayed retries, then reads the missing mapping and
emits 429. The evidence asserts four faults; the final lookup is not mocked.
No recorded failure is represented as a naturally occurring provider failure.

The checked-in fixture contains raw response body bytes as base64, response
headers, generated request JWTs and public verification keys, normalized wire/effect records,
and raw before/after identity rows. Keys capable of signing are never written.
All tokens and login codes belong only to generated disposable identities.
The recorder checks original Content-Length and ETag before JWT substitution;
Jest re-verifies every returned JWT, its committed participant binding, and
exact surrounding response bytes. The Rust identity integration test verifies all 20 returned tokens (5 anonymous,
14 XID, 1 standard-user) against their committed participants, and refuses all
14 expired, signature, issuer and audience request tokens. The standard-user
input is harness-minted: Node re-scopes it on joining another conversation;
OIDC first use does not issue that initial participant token.

The fixture declares `{version: 3, profile: "identity", symbolFields: ["site_ids"]}`.
Consumers validate and load this profile before comparing. Replay uses normalization policy 3: verified JWT values and typed capabilities
are symbols, while JSON field order, other body bytes and ordered headers
remain exact. Dates, connection headers, chunk boundaries and timing are
excluded by the shared comparator. This profile also treats `user.site_ids` entries as typed site identifiers,
verified against the committed user row before substitution. It substitutes only
the Treevite login row's bcrypt hash, fingerprint and lookup after verifying
all three against the returned login code. Treevite SQL timestamp values are
compared as typed timestamp presence; raw timestamps remain in the evidence.
The login request uses that run's returned code; its normalized request uses a
credential symbol. Neither crypto entropy nor production clocks are changed.
The shared recorder freezes its own server/SQL fixture clock as usual.

The identity Compose override sets `DEV_MODE=false` for Node and the driver.
Thus OIDC 500 bodies omit the development-only `details` field. This also enables
JWKS rate limiting, production URL selection (with the local domain override),
and production pool sizes; the sealed network and disposable database remain
in force. Raw capture is cleared before every request.

The XID cookie request uses an XID absent from `xids` before and after the
request, and asserts uid 3 with zero new identity rows. It depends on the
legacy-cookie branch, not the XID table lookup.

Every request asserts the exact number of new users, participants, XID bindings
and OIDC mappings. The Treevite refusal asserts a user without a participant.
The injected XID upsert failure asserts a committed participant without an XID;
retry asserts a different user and participant while the first remains unbound.
OIDC repeat asserts the same mapping and user values. Successful Treevite login
proves the issued code authenticates and updates last_used_at.

Current behavior includes a 200 participationInit response without admission
when no XID is supplied under either XID policy; votes/comments refuse the
corresponding request. The XID upsert failure returns plain `Internal Server Error\n`
with HTTP 500 under production serialization, while its user and participant
remain committed. OIDC first use provisions the account and participant
without returning a participant JWT when its OIDC Authorization header is
present. The recordings preserve these distinctions.

## Running

Build a disposable Postgres image from the current migrations first:

```sh
docker build --build-context queue-rs=queue-rs -t identity-postgres:local -f server/Dockerfile-db server
```

With the characterization server, file-server, OIDC and DynamoDB images ready,
choose three unused ports and a unique project:

```sh
COMPOSE_PROJECT_NAME=p027identity-$(openssl rand -hex 4) \
P027_PORT_MIN=56280 P027_PORT_MAX=56282 \
POLIS_RECOVERY_PG_PORT=56280 P027_HTTP_PORT=56281 P027_CONTROL_PORT=56282 \
P027_POSTGRES_IMAGE=identity-postgres:local \
queue-rs/polis-api/conformance/identity-run.sh
```

The script checks isolation and read-only source mounts, records image/source
hashes, requires the transaction-scoped participant allocator, seeds generated
data, records once and replays twice from fresh database seeds/server caches.
It runs the fixture, participant interop, and live Jest files under the default
configuration with an explicit test-match override for the live file, then removes
only its own Compose project, volumes, and saved simulator tokens, including on failure. All outputs live under
`server/characterization/artifacts/identity-*`. A source archive must set
`P027_SOURCE_COMMIT` to its full base commit.

Every ordinary recorder invocation, both replays, and the live Jest test compare
with `server/__tests__/fixtures/identity/recordings.json`. Any difference fails;
fresh output never becomes its own expectation. The Jest test starts its own
real Node process in the driver container, seeds SQL, installs simulator tokens,
runs the full matrix, and terminates that process. The runner stops the earlier
Node service and restarts DynamoDB before Jest. The test requires this stack;
it does not skip or fall back to checking fixture consistency when unavailable.
The live test lives at `characterization/identity/live.test.ts`, outside the
default `__tests__` collection. Hosted server Jest runs the stack-free checks;
`.github/workflows/identity-recordings.yml` builds the images and calls this same
`identity-run.sh` entry point for live coverage. The other Jest cases check the committed fixture's internal consistency and
exercise deliberate status, body-order, database-row and header differences.

To intentionally replace the fixture after changing the matrix, use the same
environment and run `identity-run.sh --update`. This separate operation records
once, validates every case, and copies only a completed recording into the
fixture. Review that diff, then run `identity-run.sh` without arguments to verify
the committed expectation with a fresh recording, two replays and all three Jest
files under the default configuration with the explicit live-file match. No environment override can redirect
Jest to a newly recorded fixture.
