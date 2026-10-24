# Vote reads

Nothing is served by default. The `votesRead` nginx selector includes only
bodyless GET/HEAD on `/api/v3/votes` and `/api/v3/votes/me`. POST, OPTIONS and
requests with bodies stay on Node. The existing reload command and generation
persistence apply to this selector without changes.

The Rust process additionally requires `POLIS_API_VOTES_READS=1` and
`POLIS_API_VOTES_READ_DATABASE_URL`. Its auth lookups use that primary DSN;
`READ_ONLY_DATABASE_URL`, when set, supplies the data pool. Participant public
verification keys and the existing read OIDC JWKS configuration are needed to
admit those identities. There is no token minting, user creation or write.

Each pool owns one connection and its own semaphore/acquisition queue. Acquisition
expires after 15 ms, statements after 50 ms, connections after 300 s. A 75 ms
request deadline sheds read work to Node. Cancelling the waiter does not release
a slot while its blocking query still runs. Neither pool borrows participation
writer slots, connections or acquisition queues. The executor, process and
underlying database CPU/I/O remain shared; this is not a resource-isolation claim
for an overloaded database. Queries materialize at most two candidate rows.

## Node compatibility

The contract is `polis-contracts/src/votes_read.rs`. Node registration is
`server/app.ts:868-892`; handlers are `server/src/routes/votes.ts:132-211` at
`4f50b6f28f30160a9d8a0ca3f3024ef3c03b6ec2`.

| Branch | Node response | Rust admission |
| --- | --- | --- |
| Latest, no resolved PID | 200 `[]` | Yes |
| Latest, selected PID and optional `tid` | 200 latest rows | Zero or one row |
| History, missing member | 500 `polis_err_getting_pid` | Node |
| History, member and participant JWT PID | 200 history rows, including `weight:null` | Zero or one row |
| History, OIDC member without auth PID | 200 `[]` | Yes; preserve the auth-PID lookup mismatch |
| Closed conversation | Same read behavior | Same rules as an open conversation |
| Invalid/missing conversation or malformed `tid` | 400 parameter finalhandler HTML | Node |
| Missing required auth or invalid JWT | 401 auth JSON | Node |
| OIDC mapping failure | 400/429/500 user-error JSON | Node |
| Query/enrichment failure | 500 failJson | Node |
| Conditional freshness / HEAD | 304 / status with no body | Common HTTP renderer |
| Listener parser / HTTPS policy | 400/413/415/500 HTML; HTTPS GET 302, HEAD 400 | Listener or common HTTP policy |

Both readers call Node's `storageRowToWire`; the wire is agree `-1`, disagree
`+1`, pass `0`. CSV exports use a different convention. Rust uses the shared
`votes::StorageConvention` boundary, including Node's preserved-invalid policy.
Null stays null. No CLI or reader performs sign arithmetic.

`/votes` preserves a nonzero JWT PID over a query PID. JWT PID zero can be
overridden; the self-lookup sentinel asks for the authenticated UID's membership.
`/me` checks `getPid(uid)` but selects using the PID already assigned by auth.
OIDC has no such PID. `weight` is null because Node divides an absent field,
while `weight_x_32767` remains unchanged. BIGINT times are decimal strings.
Neither route paginates or orders its rows. The latest query reads the latest
table; history can include multiple votes for one statement.

## Hand-back boundary

Rust returns the existing pre-response 502 hand-back for:

- A disabled lane, missing pool, unsupported method, body/framing, or cookie.
- Missing, duplicate, unknown or noncanonical query parameters; noncanonical
  integer spelling; extra filters/pagination; invalid conversation IDs.
- Missing required auth; unsupported or invalid JWTs, XID, mixed claim shapes,
  foreign conversation scope, missing membership, treevite-gated membership,
  missing verifier keys, or an OIDC identity requiring account creation.
- Unknown conversation, ambiguous membership, negative resolved member PID,
  or `/me` membership lookup failure.
- More than one selected row (Node supplies no stable ordering), multiple or
  noncanonical capability aliases for a populated response, or a changed table
  column layout. Empty results require no capability enrichment.
- Connection/acquisition/statement/request deadline, database error or decoding
  failure. Node owns its error body and caches.

The nginx fallback covers failure before response headers; it cannot recover a
truncated response after headers. Requests are reads, so hand-back never replays
a participation write.

`polis vote list` already resolves the participant when needed, passes `pid`,
and labels the data with the wire convention. `polis vote mine` already calls
`/api/v3/votes/me`. Neither needs a change when these routes are selected. The
existing `/me` OIDC behavior and lack of pagination remain visible to the CLI.

## Checks

`conformance/votes-read-run.sh` uses the existing sealed characterization stack,
the unchanged Node listener and direct complete HTTP byte comparison. It saves
both responses and accounts for every served request and hand-back. A Date-only
clock-boundary difference retries the entire exchange; no header/body is removed
from an accepted comparison. The checked-in contract fixture contains decoded
Node response bodies from that run, not hand-written expected successes.

Set unique `COMPOSE_PROJECT_NAME`, `POLIS_RECOVERY_PG_PORT`, `P027_HTTP_PORT` and
`P027_CONTROL_PORT`, and supply the characterization images as for other read
routes. `X54_POLIS_API_IMAGE` must be built with `FEATURES=fixture-clock`. The
runner tears down only its own project. The normal API db-tests check locked-read
shedding, separate pool availability and write refusal. `nginx-routing.sh` checks
both path selections, deduplication, method/body routing and fallback.
