# polis-api

A small Rust program that answers one API request, `GET /api/v3/math/pca2`,
the request every open conversation page makes every few seconds to fetch the
latest opinion-group map. Today the Node server answers it. This program
answers it with the same bytes, so that request can move off Node without any
client noticing.

It is the first piece of moving Node routes to Rust one at a time. Nothing
else moves.

## Is it on?

Only if you turn it on. Two switches, both off by default:

1. Start the program: set `POLIS_API_START=1` for the normal web deployment,
   or explicitly start the `polis-api` Compose service in a local stack.
2. Tell nginx to send it the route: `RUST_API_ROUTES=pca2` in the
   deployment environment. Use the drained switch helper described in
   `file-server/nginx/README.md` for a live change.

With `RUST_API_ROUTES` unset (production today), nginx's rendered config is
the same as before this change and every request goes to Node. With it set,
only GET and HEAD requests on the exact path `/api/v3/math/pca2` that carry
no body (no `Content-Length`, no `Transfer-Encoding`) go to polis-api. Every
other method on that path (OPTIONS, POST, ...) and any request with a body go
to Node before nginx reads any of it, so Node's own body parsing and non-GET
answers are unchanged. For the requests polis-api gets, Node answers instead
whenever polis-api fails **before it starts its response**:

- the polis-api container is absent, restarting or gone (nginx looks it up
  per request through Docker's DNS, so nginx itself always starts);
- polis-api does not connect within 2 seconds or answer within 5;
- polis-api answers 502, which it does whenever its database fails it (no
  connection, no free pool slot within 2 seconds, a statement over its
  3-second timeout, any query error), for any path other than the exact
  route, and for a request body it does not model (a `Content-Encoding`, a
  non-UTF-8 charset, multipart), which nginx does not send it anyway.

That fallback ends once polis-api has sent its status line and headers
(nginx does not buffer the answer). A reply cut short after that point, for
example by the process dying mid-body, reaches the client truncated (shorter
than its `Content-Length`, or chunked without its end); the client sees a
failed request, and the page's next poll a few seconds later is a new request
that falls back as above. polis-api's own 500 answers pass through, as Node's
would.

No value of these settings stops nginx: an unknown route name, an upstream
that is not `host:port`, a resolver that is not a list of addresses, or any
rendered configuration that `nginx -t` refuses is logged as an `ERROR
RUST_API_...` line and leaves every route on Node. A route named twice is
rendered once. `nginx-routing.sh` checks all of this against stub upstreams,
in CI, including the truncated-reply limit.

## Before turning it on anywhere real

- **Database transport.** Production compose defaults to verified TLS and the
  bundled RDS certificate authorities. Set `POLIS_API_DB_HOST_ALLOWLIST` to the
  exact database hostname. Missing trust or a mismatched hostname fails closed.
  Local stacks with non-TLS Postgres must explicitly select their development
  transport; the web deployment refuses that transport.
- **Which database.** Like Node's read pool, it reads `READ_ONLY_DATABASE_URL`
  when that is set and not empty, else `DATABASE_URL`
  (`POLIS_API_DATABASE_URL` overrides both).
- **Database login.** It uses the same login as Node's read pool. A dedicated
  read-only login (SELECT on `zinvites`, `math_main`, `comments` only) is a
  separate credential and grants configuration. The common pool always sets
  its sessions read-only.
- **`NODE_ENV`.** The image defaults to `production`, as the server's prod
  image does, and the shared env file overrides both alike. The error pages
  depend on it.
- **Logs.** One JSON line per request on stdout, in the shape of the server's
  `http_request` log: method, path (no query string), status, duration and
  whether the math came from the cache. With the switch on, pca2 requests
  appear here instead of in the server's log, and the server's in-memory
  `pcaGetQuery` metric stops counting them.
- **Through nginx.** The byte replay talks to Node and polis-api directly.
  An on/off replay through nginx-proxy itself has not been run yet.

## What "the same" means

Not "equivalent JSON": the same status line, the same headers in the same
order with the same capitalisation, and the same body bytes, including the
gzip-compressed bytes and how they are split into HTTP chunks. Only the
`Date` header can differ, when two answers fall in different seconds.

The proof is a replay (`conformance/run.sh`). It starts the sealed test stack
the API recordings were made with, runs Node and polis-api side by side on
the same database, sends every recorded pca2 request (344 of them, from the
pinned public-fixture archive `server/characterization/artifacts/baseline.json.gz`)
to both as identical raw bytes, and compares the two raw answers with nothing
removed or rewritten. A further set of generated requests covers what the
recordings do not: labelled entity tags, HEAD, OPTIONS, other methods,
gzip and deflate subsets, redirects, malformed parameters and bodies,
HTTP/1.0, a request with no Host header.

## How it works

The route's behaviour is spread over several layers of the Node server; this
program reproduces each one that changes the answer:

- **The middleware chain** (`route.rs`): the HTTPS redirect, body parsing,
  default headers, CORS, OPTIONS, the old `zid` redirect, parameter checks
  and their exact error pages, then the route itself: math tick or
  `If-None-Match` (the entity tag is `"<math_env>-<tick>"`), 304 answers,
  the `keys` subset, and the stored gzip body.
- **Express's own rules** (`route.rs`): how `res.send` and `res.json` set
  `Content-Type`, `Content-Length` and a weak `ETag`, when a request counts as
  "fresh" (304), and the compression middleware's choices.
- **The math read** (`pca.rs`): the same three-second caches, the same
  reshaping of the stored math (`processMathObject`,
  `ensureCompletePcaStructure`) and the same backfill of comment ids for a
  conversation without math.
- **JavaScript's details** (`js.rs`): object key order, number printing and
  string escaping, which decide the JSON bytes.
- **Node's compressor** (`compress.rs`, `vendor/node-zlib`): Node ships its
  own copy of zlib, which compresses differently from the standard one, so its
  source (pinned to Node v22.23.2) is compiled in. Why vendored: with stock
  zlib the same JSON gives different gzip bytes.
- **Node's HTTP writer** (`http.rs`): the `Date`, `Connection` and
  `Transfer-Encoding` lines Node adds. This is why the program does not use
  hyper or axum: they normalise header names, and this route sends both `Etag`
  and `ETag` spellings depending on the path.

## The database

Three read-only queries (`db.rs`), each with a typed result: conversation
code to conversation id, the `math_main` row for `(conversation, MATH_ENV)`,
and the approved comment ids. The session is set read-only, every statement
has a timeout, and connections are retired after a fixed lifetime. Connections use
this workspace's shared transport rules (`queue-rs/src/jobs/transport.rs`):
verify-full TLS to listed hosts, a Unix socket, or plain TCP to loopback.
`docker-internal` (plain TCP to named hosts) exists for the dev and test
compose stacks, whose Postgres has no TLS.

## Configuration

It reads the Node server's env file, so these match Node: `MATH_ENV`
(required; there is no default, as in Node), `READ_ONLY_DATABASE_URL` and
`DATABASE_URL`, `DD_ENV` (the log's `env`), `DEV_MODE`, `NODE_ENV`,
`DOMAIN_OVERRIDE`, `USE_NETWORK_HOST`, `TESTING`, `API_DEV_HOSTNAME`,
`API_PROD_HOSTNAME`, `DOMAIN_WHITELIST_ITEM_01..08`, `CACHE_MATH_RESULTS`.
It refuses to start if `POLIS_REACHABLE_ERROR_HANDLER` is on, because it only
implements Node's default error pages.

Its own settings: `POLIS_API_DATABASE_URL` (else `DATABASE_URL`),
`POLIS_API_DB_TRANSPORT` (`tls` default, `local`, `loopback`,
`docker-internal`), `POLIS_API_DB_CA_FILE` and `POLIS_API_DB_HOST_ALLOWLIST`
(tls), `POLIS_API_DB_PLAIN_HOSTS` (docker-internal),
`POLIS_API_DB_PASSWORD_FILE`, `POLIS_API_DB_POOL` (8),
`POLIS_API_DB_ACQUIRE_TIMEOUT_MS` (2000), `POLIS_API_DB_STATEMENT_TIMEOUT_MS`
(3000), `POLIS_API_DB_MAX_LIFETIME_MS` (300000, after which a connection is
replaced), `POLIS_API_LISTEN`
(`127.0.0.1:5100`; the image uses `0.0.0.0:5100`). `GET /health` reports
database reachability and counts; it is not routed by nginx.

A pool slot belongs to the database operation, not to the request waiting
for it: a request that is abandoned (its 30-second deadline, a dropped
connection) keeps its slot until the statement or connect has really ended,
so at most `POLIS_API_DB_POOL` operations run and at most that many idle
connections are kept.

## Known differences from Node (none reached by any recorded request)

- **The math cache is not shared.** Node's 3-second math cache is shared
  with participationInit, reports and nextComment. A report can put an empty
  presentation there that Node's pca2 then serves as a 200 for up to 3
  seconds, where polis-api, which sees only pca2 requests, answers 304. The
  difference lasts at most one cache window, and real generations carry the
  same entity tag on both sides.
- **Odd paths.** nginx matches the normalised path (`//pca2`, `%70ca2`) but
  forwards the raw one. polis-api answers 502 for anything but the exact
  path, so Node answers those requests as it always has; only a client
  talking to polis-api directly sees the 502.
- **Whitespace.** Trimming follows JavaScript's whitespace (U+FEFF counts,
  U+0085 does not), as Node's `trim()` and `parseInt` do.
- **Database failures** are 502s here, so nginx asks Node, which answers
  with whatever its own database gives it. Node prints the Postgres error's
  fields in a 500 body; polis-api never prints database error text.
- With `NODE_ENV` other than `production`, an unparseable JSON body gets
  Node's stack trace on Node and a plain message here.
- A `math_main.data` value that is not a JSON object (no writer produces one)
  is answered 500 here.
- Request bodies over 1 MB, chunked request bodies and multipart bodies are
  refused or ignored; Node accepts up to 50 MB. A body with a
  `Content-Encoding` or a non-UTF-8 charset is answered 502. nginx sends
  polis-api no request with a body, so none of these is reachable through
  it; the route reads no body field that a client sends in practice.

## Running the checks

```sh
cd queue-rs
cargo fmt -p polis-api --check
cargo clippy --locked -p polis-api --all-targets -- -D warnings
cargo test --locked -p polis-api
POLIS_API_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/scratch \
  cargo test --locked -p polis-api --features db-tests   # a throwaway Postgres
cd ..
queue-rs/polis-api/conformance/nginx-routing.sh      # needs Docker
# Byte-for-byte replay (needs Docker and the local characterization images;
# see the header of run.sh):
docker build --build-arg FEATURES=fixture-clock -t x54pca2-polis-api:conformance \
  -f queue-rs/polis-api/Dockerfile queue-rs
docker build -t x54pca2-postgres:local -f server/Dockerfile-db server
COMPOSE_PROJECT_NAME=p027x54pca2-$(openssl rand -hex 3) \
P027_PORT_MIN=55479 P027_PORT_MAX=55481 POLIS_RECOVERY_PG_PORT=55479 \
P027_HTTP_PORT=55480 P027_CONTROL_PORT=55481 \
  queue-rs/polis-api/conformance/run.sh result.json
```

The `fixture-clock` feature exists only for the replay: the test stack
freezes Node's clock, and a build with this feature can freeze its own the
same way (`POLIS_API_FIXTURE_CLOCK`). The default build cannot.
A fixture-clock build also honours a per-request `X-Polis-Fixture-Clock` header
(milliseconds), token checks included, so the differential harness can advance
the clock one step at a time; the default build ignores the header.

## Credits

The HTTP compatibility work started in draft PR #2741 (`server-rs`): the
compression negotiation (`negotiate.rs`), the CORS rules (`cors.rs`) and the
vendored Node zlib come from there. This crate moves it into the `queue-rs`
workspace, onto the shared database transport, and up to the route's current
behaviour on `edge` (labelled entity tags, the comment backfill, the reshaping
guards).

## Client-data proof for route changes

Every route change also runs the independent CLI differential workflow. It
executes the real command census on identical generated inputs with the Rust
switches off and on, compares complete JSON data and exits, and requires
positive serving evidence rather than counting Node fallback as Rust coverage.
Add each new switch and its CLI scenarios to
`polis-cli/tests/differential/routes.json`; the route-template and command
censuses refuse omissions. Run `scripts/test-polis-cli-differential.sh` after
iteration; build instructions and scope are in
`polis-cli/tests/differential/README.md`. This does not replace the byte replay.


## Owner conversation list (opt-in)

`GET /api/v3/owner/conversations` is a **new contract**, separate from Node's
`/api/v3/conversations`. It lists only conversations whose exact owner is the
verified OIDC user's local UID. Site moderators and administrators receive no
ownership bypass. There is no user or participant creation, token minting,
participant-token support, or cookie authentication in this endpoint.

Both gates are off by default. Set `POLIS_API_OWNER_LIST=1` in the Rust process,
and add `owner-conversations` to nginx's `RUST_API_ROUTES` only after configuring:

- `AUTH_ISSUER` and `AUTH_AUDIENCE`, matching the OIDC access-token configuration.
- `POLIS_API_OWNER_JWKS_FILE`: a mounted, operator-reviewed public JWKS snapshot,
  at most 64 KiB and 32 keys, with unique nonempty key IDs. RS256 signatures,
  issuer, audience, required expiry, optional not-before and subject are checked.
  No URL or UID supplied in the token is trusted. Unknown keys fail closed.
  This snapshot is read once; rotate it and restart before switching issuer
  keys. The process makes no network calls to an identity provider.
- `POLIS_API_OWNER_DATABASE_URL`: an explicit read database DSN, using the same
  transport/CA/host allowlist settings as the math pool. Provision the mounted
  JWKS and DSN through a deployment-specific compose override or service config;
  the default compose file does not enable or supply them.

An existing `oidc_user_mappings` row joined to a user is required. Sign in through
Node first if the identity has not yet been mapped. Verified but unmapped users
receive 403. Invalid/missing credentials receive 401. Database failures and busy
admission receive 503 with no internal diagnostics. nginx never falls back to
Node for this new endpoint; an unavailable route cannot silently return an
older unfiltered list. Only bodyless GET/HEAD requests are routed; other methods
receive 405. HEAD has the GET headers with no wire body. Responses are JSON with
`Cache-Control: no-store` and `Vary: Authorization`.

Query parameters (duplicates and unknown parameters are errors):

| Parameter | Contract |
| --- | --- |
| `sort` | `newest` (default) or `oldest`, ordered by creation milliseconds then internal ID, both in the same direction |
| `min_participants` | Nonnegative signed 32-bit integer, default 0; filters the stored conversation counter |
| `search` | Case-insensitive literal topic substring, at most 200 Unicode characters; `%` and `_` are literal |
| `is_active`, `is_draft` | Optional exact `true` or `false` |
| `limit` | 1–500, default 100 |
| `cursor` | Opaque `next_cursor` from the prior page with the same owner and filters; page size may change |

The response has `scope: "owner"`, `sort`, `conversations`, and
`pagination: {limit, has_more, next_cursor}`. Each row contains
`conversation_id`, `topic`, `description`, `created`, `modified`,
`participant_count`, `is_active` and `is_draft`. Nullable stored values stay null,
except missing creation time and participant count become zero. Each conversation
appears once using its earliest-created public code (lexical code breaks ties);
conversations without a code are omitted. Rows omit owner identities and download keys. The cursor encodes an
owner-bound position and is not encrypted. Page selection uses a tuple cursor and fetches one extra row, without
an offset scan or full count. The cursor is an encoded position, not a signed
capability: every page independently verifies identity and applies owner filters.
Do not edit it. Pagination is not a frozen snapshot; concurrent ownership or
filter changes can change membership. Participant count is the stored counter,
not a freshly recomputed count of distinct people.

The owner list has its own two-connection read-only pool, 250 ms acquire limit,
1 s statement timeout and two admitted requests. Excess work sheds with 503;
cancellation does not release running database/signature work early. It never
borrows the participation or math pool, writes rows, or holds a connection over
an external call. This bounds the new process's work; it is not a claim that
sharing a database server or host has zero resource cost. Use a read replica
when sizing that cost. The PostgreSQL contract test parks every owner-pool slot,
proves another pool still answers, and verifies self-shedding and recovery.

The existing CI commands (`cargo test --locked -p polis-api --features db-tests`
and `conformance/nginx-routing.sh`) cover this contract, signed-token failures,
exact owner filtering, tied-time traversal, literal search, cursor binding,
read-only sessions, pool saturation, and switch off/on behavior. Node byte
recordings are not applicable to this new endpoint; existing pca2 parity remains
a separate check.


## Comment reads

`POLIS_API_COMMENT_READS=1` enables bodyless GET/HEAD `/api/v3/comments`.
It requires `POLIS_API_COMMENTS_DATABASE_URL` for conversation lookup and rows.
Pagination and moderator checks use the separate `READ_ONLY_DATABASE_URL` pool,
falling back to the comments DSN when unset. The pools have two and one connections,
a 100 ms acquisition deadline and a 1 s statement deadline; sessions are read-only.
They never borrow the vote, comment-write or next-statement pools. This bounds
waiting within this process; it does not prove shared database load isolation.

Both the process flag and nginx's `RUST_API_ROUTES=comments` remain off by default.
Plain lists retain their existing participant-token admission. Moderation lists
also admit already-mapped OIDC users through the existing static JWKS verifier
(`POLIS_API_READ_JWKS_FILE`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_NAMESPACE`).
Verified users use Node's site-moderator predicate and configured `ADMIN_UIDS`.
No identity claims from query parameters confer authority. Cookies, unsupported
credentials, absent mappings, report enrichment, provider-dependent `mod_gt`
values and failures retain the 502 handoff to Node; no user or membership is created.

For `moderation=true`, callers without moderator rights get active, unmuted,
participant-visible statements and the plain fields. Requested vote counts remain.
Moderators retain the moderation fields and whole list. Counts pass through the
shared storage convention boundary, matching the server's current constant source;
invalid and NULL values do not become passes. Any storage convention migration
must update both services together, without changing wire or export declarations.

The legacy SQL behavior is preserved: plain lists order only by created; moderation
lists have no imposed ordering, ignore tids, and paginate the vote-bucket join
before merging counts. Count and row filters retain Node's distinct modIn/mod_gt
semantics. Count, authority and row reads remain separate observations, including
replica lag; no snapshot consistency or deterministic unordered-row claim is made.

`conformance/comments-run.sh` replays all 396 archived requests against fresh Node
and Rust, then 42 additional moderation count/filter/page requests. The six actor
moderation cases must be served by Rust, including anonymous, bound participant and
foreign-owner callers. Results contain fresh Node/Rust raw response recordings for
these cases. Status, headers, field/array order and body bytes compare exactly;
only Date-only pairs may retry, with retries counted. The committed general archive
is unchanged. `conformance/nginx-routing.sh` covers off/on, method/body guards and
moderation query/credential forwarding and the 502 fallback. This is generated
fixture conformance, not production-load or activation approval.

## Anonymous next-statement reads

`POLIS_API_NEXT_COMMENT_READS=1` and nginx's `RUST_API_ROUTES=nextComment`
are separate gates, both off by default. The process requires an explicit
`POLIS_API_NEXT_COMMENT_DATABASE_URL` primary read DSN. Bodyless GET/HEAD
requests may carry only `conversation_id`, `without`, and `initial_tid`.
Authorization, cookies, language and identity parameters, unknown parameters,
other methods and request bodies stay with Node. No participant resolution,
translation, topical-storage call or write is performed by this Rust branch.

Normal weighted selection requires `TOPICAL_COMMENT_RATIO=0` in both Node and
Rust. Preserve the same value when configuring the processes. Any other Rust
value hands normal selection to Node. `initial_tid` bypasses topical selection
in Node and can be served independently of that setting. The response retains
Node's visibility rules, created-only ordering, 999-candidate cap, zero-weight
fallback, `randomN`, initial status, count semantics and empty translations.
The initial branch retains Node's negative participant sentinel in eligibility
reads; it never resolves or creates a participant. Committed math priorities
have a bounded three-second process-local cache. Independent process caches
and concurrent database publications can observe different generations; static
fixture byte proof is not a concurrent-publication equivalence claim.

This participation route has its own two-connection read-only pool, a 1 ms
acquisition budget, 50 ms statement limit and 75 ms total database-work deadline.
It does not borrow math, owner-list or comment-list slots. Cancelled callers
retain their slot until the blocking operation finishes. Unsupported requests
hand back before pool admission; errors, saturation and deadlines return 502
for nginx's Node fallback. Nginx connect/send/read timeouts are each 100 ms;
these are per-operation bounds, not one combined end-to-end timeout. Once
response headers have been sent, the general mid-response fallback limitation
still applies. `/health` exposes `nextCommentServed` and `nextCommentFallback`
separately; a fallback counts as Node work, never a Rust implementation.

The existing CI format, lint, database-test, build, image and nginx checks cover
this branch. Database tests occupy all slower-route pool slots before checking
that nextComment answers, then fill its dedicated pool and verify prompt
handoff. These checks do not establish zero shared-host or database contention.

`conformance/next-comment-run.sh` records unchanged Node and Rust raw HTTP bytes
against the existing generated SQL and real-engine fixtures. It rejects an
eligible successful request falling back, counts all boundary handoffs, and
writes both raw recordings and a result summary. A fixture-clock build accepts
`X-Polis-Fixture-Seed` to match the recorder's seeded entropy; production builds
ignore it and use the normal random generator. No response bytes are normalized;
Date-only differences trigger a counted repeat of the same pair.

The same entry point runs paired nginx-off/on latency measurements with fresh
connections, alternating order, 20 warmups and 200 measurements per boundary.
It also checks a peer that accepts but sends no headers, proving the 100 ms read
timeout hands back to Node. Set `POLIS_API_NGINX_IMAGE` to a locally built image
from `file-server/nginx.Dockerfile`; both proxies use that exact image and route
configuration. The report describes local fixture-network latency, not deployed
network latency or a live participation-load campaign.

### Existing participant reads

Comments and nextComment can serve Node-issued anonymous and standard-user
participant credentials with `POLIS_API_PARTICIPANT_READS=1`, in addition to
their existing process and nginx route switches. All remain off by default.
Configure `POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE` with Node's matching RSA public
key and `POLIS_JWT_ISSUER` / `POLIS_JWT_AUDIENCE` with Node's exact values. A key
change requires replacing the configured public-key file and restarting this
process. No private signing key belongs in polis-api.

The shared polis-auth verifier requires an exact conversation-code binding and
an existing matching `(zid, uid, pid)` membership. PID zero is supported. XID,
provider bearer tokens, cookies, identity query overrides, missing participants,
other-conversation tokens, Treevite and unsupported shapes return the counted
502 handoff to Node. An already-voted `initial_tid` also hands back to Node;
ordinary selection excludes existing votes and returns currentPid. No participant,
user, invite or token is created. Signed-in comments support the same public
projection; moderation uses the verified moderator rule described above and report views remain with Node.

Membership reads use the route's existing bounded read-only primary pool;
nextComment retains its own two slots, 1 ms admission, 50 ms statements and
75 ms total database-work deadline. Slower route pools do not supply its slots.
This does not eliminate shared-host CPU or database contention. Health reports
`participantServed` and `participantFallback` for credential-bearing requests to
these two routes, alongside the existing nextComment counters.

Generated-fixture proof: `queue-rs/polis-api/conformance/participant-run.sh`.
Its test-only control wrapper invokes Node's actual JWT issuers, exports only the
ephemeral public key, and leaves product handlers and the existing recorder
unchanged. Node responses are recorded and compared as complete HTTP bytes;
Date-only retries and Node handoffs are counted separately. Existing anonymous
conformance commands still run with participant serving disabled.

### Connection probe

`POLIS_API_CONNECTION_READS=1` and nginx `RUST_API_ROUTES=testConnection`
opt into bodyless GET/HEAD `/api/v3/testConnection`. Both switches default off.
The request/response types live in `polis-contracts::connection`, which the CLI
already consumes. The response is Node's `{"status":"ok"}` and its normal HTTP
middleware bytes, including HEAD, conditional requests and compression. Like
Node, this probe is exempt from the HTTPS redirect and proves connectivity only.
It performs no database query, provider call, participant resolution or write.
Query parameters, credentials, cookies, bodies and unsupported methods hand back
to Node and are counted separately in `connectionServed`/`connectionFallback`.
Nginx uses the same 100 ms per-phase fallback limits as nextComment. Full response
bytes are recorded by `conformance/connection-run.sh`; Date-only retries and
handoffs are reported separately. This adds no participation pool or database work.

### Crawler policy

`POLIS_API_ROBOTS_READS=1` and nginx `RUST_API_ROUTES=robots` opt into bodyless
GET/HEAD `/robots.txt`. Both default off. Types are shared with the CLI through
`polis-contracts::robots`. The body and headers match Node, including its existing
application/json content type for this text body, and no API CORS headers.
The normal HTTPS redirect still applies. Unknown queries, credentials, cookies,
bodies and unsupported methods use counted Node handoffs. Health exposes
`robotsServed` and `robotsFallback`. The handler performs no database/provider
work and adds no participation pool. `conformance/robots-run.sh` records complete
Node/Rust response pairs, separately counting Date-only retries and Node work.

### Database probe

`GET`/`HEAD /api/v3/testDatabase` is staged behind `POLIS_API_DATABASE_READS=1`
and nginx's `RUST_API_ROUTES=testDatabase`, both off by default. Set
`POLIS_API_DATABASE_PROBE_URL` to the same primary database Node probes.
The route runs Node's `select uid from users limit 1` before answering with
`polis-contracts::database::Response`. An empty users table still succeeds.
It has a separate one-connection read-only pool (15 ms acquire, 50 ms statement,
75 ms caller deadline), never the comments or next-statement pool. Cancelled
queries retain their pool slot until the blocking operation finishes.
Database errors/timeouts and unsupported credentials/cookies/query/body/method
shapes hand back to Node and increment `databaseFallback`; served responses
increment `databaseServed`. Node retains its own database-error contract.
Run `queue-rs/polis-api/conformance/database-run.sh result.json` against the
isolated fixture stack to record and compare complete Node/Rust HTTP bytes.

### Context names

`GET`/`HEAD /api/v3/contexts` is staged behind `POLIS_API_CONTEXTS_READS=1`
and nginx's `RUST_API_ROUTES=contexts`, both off by default. Shared types are
`polis-contracts::contexts::{Request, Context, Response}`; nullable names and
Postgres ordering are preserved. Only public contexts are selected.

`POLIS_API_CONTEXTS_DATABASE_URL` supplies an independent primary auth pool;
context reads use a second pool on `READ_ONLY_DATABASE_URL` when configured,
otherwise that primary. Each pool has one read-only connection, a 15 ms acquire
limit and a 50 ms statement limit; the full route has a 75 ms caller deadline.
Neither uses participation pools. All failures hand back to Node and increment
`contextsFallback`; responses increment `contextsServed`.

Requests without credentials use Node's optional-auth behavior. Signed-in reads
reuse the participant verifier and existing exact membership resolution, with
no XID/treevite/creation path. OIDC reads reuse the owner-list RS256 verifier,
configured with `POLIS_API_READ_JWKS_FILE`, `AUTH_ISSUER`, `AUTH_AUDIENCE` and
`AUTH_NAMESPACE`. Only an existing user mapping with a required email claim is
admitted; unmapped identities and unsupported credentials go to Node, which
retains its user-creation and auth-error behavior. Non-exact Bearer schemes,
cookies, query parameters, bodies and unsupported methods also go to Node.

The generated-fixture replay is
`queue-rs/polis-api/conformance/contexts-run.sh result.json`; it retains complete
Node/Rust response bytes for anonymous, participant and OIDC reads and fallback
boundaries. Authentication never downgrades an invalid supplied token to an
anonymous Rust response.

### Site domain whitelist

`GET`/`HEAD /api/v3/domainWhitelist` is staged behind
`POLIS_API_DOMAIN_WHITELIST_READS=1` and nginx route `domainWhitelist`, both off
by default. Shared types are in `polis-contracts::domain_whitelist`.
The hybrid reader now exposes the verified UID: participant claims require
exact existing membership; OIDC uses the existing mapping and ignores a token's
UID claim. This route requires a verified identity; missing credentials and
unsupported auth paths hand back to Node, never anonymous success.

`POLIS_API_DOMAIN_WHITELIST_DATABASE_URL` supplies two independent primary
read-only pools for auth and policy, each one connection (15 ms acquire, 50 ms
statement), with a 75 ms route deadline. Participation pools are not borrowed.
The query selects only the authenticated user's site. Missing/null policies
become the empty string, as in Node. Duplicate policies hand back because
Node's unordered first-row choice is not a deterministic contract.
`domainWhitelistServed` and `domainWhitelistFallback` count route outcomes.
Run `queue-rs/polis-api/conformance/domain-whitelist-run.sh result.json` for
complete HTTP byte replay with participant/OIDC and policy boundary cases.

### Empty metadata questions

`GET`/`HEAD /api/v3/metadata/questions?conversation_id=...` stages only the
empty result behind `POLIS_API_METADATA_QUESTIONS_READS=1` and nginx route
`metadataQuestions`, both off by default. Shared request/question/response types
are in `polis-contracts::metadata_questions`. Populated rows hand back to Node,
which owns their cached conversation-ID enrichment. Invite-code parameters,
unknown/duplicate parameters and unsupported auth also hand back and are counted.

The existing hybrid verifier now accepts an optional requested conversation;
participant tokens must match it exactly before resolving membership. OIDC still
requires an existing user mapping, with no creation. Anonymous reads are allowed
as Node's optional middleware permits. Missing conversations hand back.

`POLIS_API_METADATA_QUESTIONS_DATABASE_URL` supplies an independent primary auth
and ID-resolution pool. Data uses a second pool on READ_ONLY_DATABASE_URL when
configured. Each is one read-only connection, 15 ms acquire/50 ms statement,
with a 75 ms whole-route deadline; no participation pool is borrowed.
`metadataQuestionsServed`/`metadataQuestionsFallback` report outcomes.
Run `queue-rs/polis-api/conformance/metadata-questions-run.sh result.json` for
raw HTTP comparisons, including populated-row and cross-conversation handoffs.

### Empty metadata answers

`GET`/`HEAD /api/v3/metadata/answers?conversation_id=...` stages empty results
behind `POLIS_API_METADATA_ANSWERS_READS=1` and nginx route `metadataAnswers`,
both off by default. `polis-contracts::metadata_answers` shares request and
response types. A canonical integer `pmqid` filter is supported; zero retains
Node's unfiltered semantics. Duplicate/malformed/unsupported parameters hand
back. Populated responses remain Node work because of cached conversation-ID
enrichment; this is not a complete replacement of the legacy route.

The scoped hybrid verifier and existing identities are reused. Independent
primary auth/ID and replica-capable metadata pools are configured by
`POLIS_API_METADATA_ANSWERS_DATABASE_URL` and optional READ_ONLY_DATABASE_URL.
Each has one read-only connection, 15 ms acquire/50 ms statement limits; the
whole route has a 75 ms deadline. No participation pool is borrowed.
`metadataAnswersServed`/`metadataAnswersFallback` count outcomes. Replay:
`queue-rs/polis-api/conformance/metadata-answers-run.sh result.json`.

### Aggregate metadata

`GET`/`HEAD /api/v3/metadata?conversation_id=...` uses required hybrid auth,
reusing verified participant membership or existing OIDC mappings. Both
`POLIS_API_METADATA_READS=1` and nginx route `metadataRead` default off.
Request/response types live in `polis-contracts::metadata_read`.

Empty questions return `{}`. Populated results preserve numeric property order,
nullable labels, inactive rows, unselected arrays and Node's scalar participant
assignment. Duplicate choices, orphaned/malformed data, nonpositive IDs and more
than 1,000 rows in any input table hand back to Node, as do invite parameters,
unsupported auth and request shapes. No cache or user/participant creation occurs.

`POLIS_API_METADATA_DATABASE_URL` configures a separate primary auth/ID pool;
metadata uses an independent pool with optional READ_ONLY_DATABASE_URL. Both use
one read-only connection, 15 ms acquire and 50 ms statement limits, under a 75 ms
whole-route deadline. No participation pool is borrowed. Outcomes are counted by
`metadataReadServed`/`metadataReadFallback`. The isolated proof command is
`queue-rs/polis-api/conformance/metadata-read-run.sh result.json`.

### Empty metadata choices

`GET`/`HEAD /api/v3/metadata/choices?conversation_id=...` stages empty results
behind `POLIS_API_METADATA_CHOICES_READS=1` and nginx route `metadataChoices`,
both off by default. Shared types are in `polis-contracts::metadata_choices`.
Required hybrid auth reuses verified participant membership scoped to the
conversation or an existing OIDC mapping. Unsupported auth/requests hand back.
Populated rows remain Node work because of cached conversation-ID enrichment;
this is not a complete route replacement. Inactive-only choices return `[]`.

`POLIS_API_METADATA_CHOICES_DATABASE_URL` configures independent primary auth/ID
and replica-capable read pools, each with one read-only connection, 15 ms acquire
and 50 ms statement limits under a 75 ms route deadline. No participation pool is
borrowed. `metadataChoicesServed`/`metadataChoicesFallback` count outcomes.
Run `queue-rs/polis-api/conformance/metadata-choices-run.sh result.json` for the
raw HTTP proof and regressions of earlier routes.

### Recently started conversations: empty results and developer refusals

`GET`/`HEAD /api/v3/conversations/recently_started` uses required hybrid auth and
Node's numeric `ADMIN_UIDS` allowlist. A verified user outside that list receives
the same 403 JSON. String IDs in the allowlist never confer numeric authority.
Missing/empty ADMIN_UIDS means no developers. Unsupported auth stays with Node.
Both `POLIS_API_RECENT_STARTED_READS=1` and nginx `recentStarted` default off.

The shared `polis-contracts::recent_started` contract covers canonical nonnegative
integer `sinceUnixTimestamp` seconds within JavaScript's exact millisecond range,
or the default last seven days, and empty arrays. The inclusive created boundary
matches Node. Populated SELECT * rows remain Node work until their complete schema
wire representation is staged; this is not a full route replacement.

Independent primary auth and replica-capable read pools use
`POLIS_API_RECENT_STARTED_DATABASE_URL`, with optional READ_ONLY_DATABASE_URL,
one read-only connection each, 15 ms acquire/50 ms statement limits and a 75 ms
route deadline. No participation pool is borrowed. Outcomes are counted by
`recentStartedServed`/`recentStartedFallback`. Run
`queue-rs/polis-api/conformance/recent-started-run.sh result.json` for raw proof.

### Recent conversation activity: empty results and developer refusals

`GET`/`HEAD /api/v3/conversations/recent_activity` uses required hybrid auth and
Node's numeric `ADMIN_UIDS` allowlist. A verified user outside that list receives
the same 403 JSON. String IDs in the allowlist never confer numeric authority.
Missing/empty ADMIN_UIDS means no developers. Unsupported auth stays with Node.
Both `POLIS_API_RECENT_ACTIVITY_READS=1` and nginx `recentActivity` default off.

The shared `polis-contracts::recent_activity` contract covers canonical nonnegative
integer `sinceUnixTimestamp` seconds within JavaScript's exact millisecond range,
or the default last seven days, and empty arrays. The inclusive modified boundary
matches Node. Populated SELECT * rows remain Node work until their complete schema
wire representation is staged; this is not a full route replacement.

Independent primary auth and replica-capable read pools use
`POLIS_API_RECENT_ACTIVITY_DATABASE_URL`, with optional READ_ONLY_DATABASE_URL,
one read-only connection each, 15 ms acquire/50 ms statement limits and a 75 ms
route deadline. No participation pool is borrowed. Outcomes are counted by
`recentActivityServed`/`recentActivityFallback`. Run
`queue-rs/polis-api/conformance/recent-activity-run.sh result.json` for raw proof.

### Retired math poll

`GET`/`HEAD /api/v3/math/pca` returns Node's empty 304 response, including normal
middleware headers, behind `POLIS_API_LEGACY_PCA_READS=1` and nginx `legacyPca`,
both off by default. Shared HTTP request/response types are in
`polis-contracts::legacy_pca`. The retired handler ignores query parameters;
queries up to 4 KiB are accepted. Unsupported methods, bodies, credentials or
cookies hand back to Node and are counted. No database, auth provider, math
engine, pool or participation work runs on this handler.
`legacyPcaServed`/`legacyPcaFallback` count outcomes. Run
`queue-rs/polis-api/conformance/legacy-pca-run.sh result.json` for raw HTTP proof.

### Tree-invitation waves: bounded moderator reads

`POLIS_API_TREEVITE_WAVES_READS=1` stages GET/HEAD `/api/v3/treevite/waves`.
The API and nginx `RUST_API_ROUTES=treeviteWaves` switches default off.
Set `POLIS_API_TREEVITE_WAVES_DATABASE_URL` for primary identity reads; the
separate data/authority pool uses `READ_ONLY_DATABASE_URL` when configured.
Each read-only pool has one connection, 15 ms acquisition and 50 ms statement
limits; the entire route has a 75 ms deadline. Participation pools are separate.

Existing scoped participant membership or verified OIDC mappings establish the
UID; the shared authority library applies Node's site-moderator predicate and
numeric `ADMIN_UIDS` bypass. Owners with NULL site IDs are denied, as in Node.
The exact 403, populated/empty arrays, bigint strings, nullable fields and
millisecond UTC dates are supported. Canonical optional integer `wave` filters
are accepted; more than 500 rows, unusual dates, cookies, creation-dependent
authentication and unsupported requests remain counted Node work. No writes.
`treeviteWavesServed` / `treeviteWavesFallback` expose the boundary. The generated
live replay covers roles, site changes, filters, compression and HTTP caching.

### Tree-invitation listing: bounded pagination

`POLIS_API_TREEVITE_INVITES_READS=1` and nginx `RUST_API_ROUTES=treeviteInvites`
stage GET/HEAD `/api/v3/treevite/invites`; both default off. Set
`POLIS_API_TREEVITE_INVITES_DATABASE_URL` for primary identity reads. The separate
read-only data/authority pool uses `READ_ONLY_DATABASE_URL` when configured.
Each pool has one connection, 15 ms acquisition and 50 ms statements; the whole
route has a 75 ms deadline. Participation resources remain separate.

Scoped hybrid identity and the shared site-moderator rule match the waves route.
Canonical integer wave_id/status filters and limit/offset match Node's defaults,
clamping and nonpositive handling. Only owner-controlled invites are returned.
At most 1,000 matching rows are admitted; equal creation timestamps, unusual
dates, count/read disagreement and unsupported authentication hand back to Node.
Unique descending ordering, bigint strings, nullable fields and pagination
metadata are preserved. `treeviteInvitesServed` / `treeviteInvitesFallback` count
the boundary; no database writes or authentication creation paths are added.

### Tree-invitation CSV: moderator refusals only

`POLIS_API_TREEVITE_CSV_READS=1` and nginx `RUST_API_ROUTES=treeviteCsv` stage
GET/HEAD `/api/v3/treevite/invites/csv`; both default off. Set
`POLIS_API_TREEVITE_CSV_DATABASE_URL` for primary identity reads. The independent
read-only authority pool uses `READ_ONLY_DATABASE_URL` when configured. Each
pool has one connection, 15 ms acquisition and 50 ms statements, with a 75 ms
whole-route deadline; participation pools are separate.

Only verified, conversation-scoped identities denied by the shared Node
site-moderator policy receive the matching 403. All authorized CSV downloads
remain counted Node work, including empty exports: filenames use Node's cached
conversation ID and dates depend on its local timezone. No CSV result or full
route replacement is claimed. Unsupported auth/requests and database failures
also hand back; no creation path or writes. `treeviteCsvServed` and
`treeviteCsvFallback` expose this boundary.

### Conversation preload: public presentation fields

`POLIS_API_CONVERSATION_PRELOAD_READS=1` and nginx
`RUST_API_ROUTES=conversationPreload` stage GET/HEAD
`/api/v3/conversations/preload`; both default off. Set
`POLIS_API_CONVERSATION_PRELOAD_DATABASE_URL` for a dedicated primary read-only
pool,matching Node's conversation-data read. It has one connection,15 ms
acquisition/50 ms statement limits and a75 ms configured whole-route timeout.
Participation pools are separate;no writes or identity creation are performed.

A single ASCII alphanumeric conversation_id up to300 bytes is admitted. The
public projection preserves nullable text and auth flags,bigint creation time
as a string,and the two fixed false auth-needed fields. Unknown/ambiguous IDs,
cookies,Authorization headers and unsupported requests remain counted Node
work. `conversationPreloadServed` / `conversationPreloadFallback` expose the
boundary;no full middleware or arbitrary-query replacement is claimed.

### Owner participation summaries: PID counts

`POLIS_API_PARTICIPATION_READS=1` and nginx `RUST_API_ROUTES=participationRead`
stage GET/HEAD `/api/v3/participation`; both default off. Set
`POLIS_API_PARTICIPATION_DATABASE_URL` for primary identity reads; the
separate read-only authority/count pool uses `READ_ONLY_DATABASE_URL` if set.
Each pool has one connection,15 ms acquisition/50 ms statement limits and a
75 ms configured whole-route timeout. Participation pools remain separate.

Verified scoped hybrid identity and the shared strict-owner policy establish
access; site moderators and configured admins have no independent bypass.
Without XID mappings,the response contains event counts keyed by PID,or the
matching409 when strict=true. Counts do not inspect vote values. XID summaries,
more than1000 PIDs,unsupported request/auth shapes and failures hand back to
Node. Canonical strict=true/false is accepted; no product writes or vote-value
changes. `participationReadServed` / `participationReadFallback` count the staged
boundary. No complete XID/report or voting endpoint replacement is claimed.

### Global conversation listings: empty developer results

`POLIS_API_ALL_CONVERSATIONS_READS=1` and nginx `RUST_API_ROUTES=allConversations`
stage GET/HEAD `/api/v3/all_conversations`; both default off. Set
`POLIS_API_ALL_CONVERSATIONS_DATABASE_URL` for primary hybrid identity reads.
The independent data pool uses `READ_ONLY_DATABASE_URL` when configured. Both
pools are read-only, one connection each, with 15 ms acquisition and 50 ms
statement limits; the configured route timeout is 75 ms. Participation pools
remain separate.

Verified hybrid identity and numeric `ADMIN_UIDS` preserve the developer gate.
Nondevelopers receive the matching403. Developer results are served only when
no conversation matches the optional ASCII owner_email filter; populated sets,
including empty pages of nonempty sets, remain Node work. Canonical limit and
offset preserve the default50, maximum500 and zero offset pagination metadata.
Other filters, unsupported shapes and failures hand back to Node. Counters
`allConversationsServed` and `allConversationsFallback` expose this boundary.
No product writes or complete populated-list replacement is claimed.

### Report listings: empty results and moderator refusals

`POLIS_API_REPORTS_READ_READS=1` and nginx `RUST_API_ROUTES=reportsRead` stage
GET/HEAD `/api/v3/reports`; both default off. Set
`POLIS_API_REPORTS_READ_DATABASE_URL` for the primary identity/report data pool.
A separate authority pool uses `READ_ONLY_DATABASE_URL` when configured. Each
read-only pool has one connection,15 ms acquisition/50 ms statement limits;
the configured route timeout is 75 ms. Participation pools remain separate.

Optional verified hybrid identity preserves anonymous no-filter empty results.
A conversation filter requires a verified scoped identity and the shared
moderator policy; refusals match403. Empty owned-report or authorized conversation
results are served. Populated rows,report_id capabilities,combined filters and
unsupported requests stay counted Node work. Authority connections are released
before primary report reads. No report writes or full report-result replacement.
Counters are `reportsReadServed` and `reportsReadFallback`.

### Bucket-to-participant mappings

`POLIS_API_BID_TO_PID_READS=1` and nginx `RUST_API_ROUTES=bidToPid` stage GET/HEAD
`/api/v3/bidToPid`; both default off. `POLIS_API_BID_TO_PID_DATABASE_URL` supplies
primary identity/code reads; a separate map pool uses `READ_ONLY_DATABASE_URL`
when configured. Each read-only pool has one connection,15 ms acquisition and
50 ms statement limits;the configured route timeout is75 ms. Existing
participation pools remain separate.

Optional hybrid credentials are verified and participant tokens scoped to the
conversation. Missing or stale mapping rows return the existing304; freshness
uses the embedded data.math_tick,including Node's zero/latest and absent-field
behavior. Table math_tick is not substituted. Typed nested integer PID arrays
retain order,up to1000 clusters/10000 entries/1MiB blob. Unsupported shapes,
credentials,queries and failures hand back to Node. No participant or math writes.
Counters `bidToPidServed` and `bidToPidFallback` expose the staged boundary.

### Conversation statistics: moderator refusals

`POLIS_API_CONVERSATION_STATS_READS=1` and nginx
`RUST_API_ROUTES=conversationStats` stage GET/HEAD `/api/v3/conversationStats`;
both default off. Set `POLIS_API_CONVERSATION_STATS_DATABASE_URL` for primary
identity/code reads;the independent authority pool uses `READ_ONLY_DATABASE_URL`
when configured. Both read-only pools have one connection,15 ms acquisition and
50 ms statement limits;the configured route deadline is75 ms. Participation
pools remain separate,and authorized statistics stay on Node's report/export pool.

Verified scoped hybrid identity and the shared moderator policy admit only exact
403 refusals. Authorized statistics,report_id capabilities,anonymous requests
and unsupported shapes stay counted Node work. Canonical safe-integer until is
accepted without changing the permission decision. This slice reads no event or
vote values and performs no product writes. Counters are
`conversationStatsServed` and `conversationStatsFallback`.

### Topic agenda selections: empty results

`POLIS_API_TOPIC_SELECTIONS_READS=1` and nginx `RUST_API_ROUTES=topicSelections`
stage GET/HEAD `/api/v3/topicAgenda/selections`;both default off. Set
`POLIS_API_TOPIC_SELECTIONS_DATABASE_URL` to primary for code,membership and
selection reads. Its dedicated read-only pool has one connection,15 ms
acquisition/50 ms statement limits and a75 ms configured route deadline.
Participation pools remain separate.

Cookieless anonymous requests receive the matching no-selections object.
With the existing participant verifier enabled,scoped anonymous/standard
participant tokens must resolve exact existing membership before an empty
selection set is served. Populated selections,OIDC identity/PID cache lookup,
XIDs,Treevite credentials and unsupported requests remain counted Node work.
This read path never allocates participants,mints credentials or writes selections.
Counters `topicSelectionsServed` and `topicSelectionsFallback` expose its boundary.

### Participant-owned invites: empty results

`POLIS_API_TREEVITE_MY_INVITES_READS=1` and nginx `RUST_API_ROUTES=treeviteMyInvites`
stage GET/HEAD `/api/v3/treevite/myInvites`;both default off. Set
`POLIS_API_TREEVITE_MY_INVITES_DATABASE_URL` for primary code/membership reads.
The separate invite pool uses `READ_ONLY_DATABASE_URL` when configured. Both
pools are read-only,size one,15 ms acquisition/50 ms statement limits,with a
75 ms configured route deadline. Participation pools remain separate.

Existing scoped anonymous/standard participant tokens must resolve exact
existing membership. Only empty pending-invite sets are served. Populated
credentials,OIDC/PID-cache lookups,XIDs,Treevite credentials or enabled
conversations,and unsupported requests remain counted Node work. This read
never allocates participants or invitations. Counters `treeviteMyInvitesServed`
and `treeviteMyInvitesFallback` expose this boundary.

### Public topic-prioritization availability

`POLIS_API_TOPIC_PRIORITIZE_READS=1` and nginx `RUST_API_ROUTES=topicPrioritize`
stage GET/HEAD `/api/v3/participation/topicPrioritize`;both default off. Set
`POLIS_API_TOPIC_PRIORITIZE_DATABASE_URL` to primary,matching Node's report read.
Its dedicated read-only pool has one connection,15 ms acquisition/50 ms statement
limits and a75 ms configured route deadline. Participation pools remain separate.

The response preserves the input conversation code,the newest report capability
and nullable BIGINT creation string,or the exact no-report object. As in Node,
has_delphi_data is optimistic and merely follows report presence;no Delphi data
query is performed. Equal newest created values (including NULL ties),ambiguous
codes,headers/queries outside the staged subset and read failures remain counted
Node work. No report or participant writes. Counters are `topicPrioritizeServed`
and `topicPrioritizeFallback`.

### Legacy conversation lists: empty matching sets

`POLIS_API_LEGACY_CONVERSATIONS_READS=1` and nginx `RUST_API_ROUTES=legacyConversations`
stage GET/HEAD `/api/v3/conversations`;both default off. Set
`POLIS_API_LEGACY_CONVERSATIONS_DATABASE_URL` for primary hybrid identity reads.
The separate data pool uses `READ_ONLY_DATABASE_URL` when configured. Each pool
is read-only,size one,with15 ms acquisition and50 ms statement limits;the
configured route deadline is75 ms. Participation pools remain separate.

Optional verified hybrid identity preserves the anonymous403. Signed-in empty
matching sets preserve direct owner,same-site and optional participant visibility,
plus canonical limit and active/draft booleans. There is no administrator bypass.
Populated sets,context and conversation-ID queries,unsupported auth and request
shapes remain counted Node work. Counters `legacyConversationsServed` and
`legacyConversationsFallback` expose the boundary. The separate owner cursor
contract is unchanged. No writes or complete populated-list replacement.

### Participant Treevite context: no wave or invites

`POLIS_API_TREEVITE_ME_READS=1` and nginx `RUST_API_ROUTES=treeviteMe` stage
GET/HEAD `/api/v3/treevite/me`;both default off. Set
`POLIS_API_TREEVITE_ME_DATABASE_URL` for primary code/membership reads.
The independent context pool uses `READ_ONLY_DATABASE_URL` when configured.
Both pools are read-only,size one,15 ms acquisition/50 ms statement limits,
with a75 ms configured route deadline. Participation pools remain separate.

Scoped anonymous/standard participant tokens must resolve exact existing
membership. Only the no-wave/no-owned-invites context is served,preserving
participant PID/ZID and null wave. Any joined wave or owned invitation remains
Node work. OIDC/PID-cache lookup,XIDs,Treevite credentials or enabled
conversations,and unsupported requests also hand back. No participant or
invitation allocation occurs. Counters `treeviteMeServed` and
`treeviteMeFallback` expose this boundary.

### Participant XID CSV downloads

`POLIS_API_XID_REPORT_READS=1` and nginx `RUST_API_ROUTES=xidReport` stage
GET/HEAD `/api/v3/xid/<uuid>-xid.csv`; both default off. Set
`POLIS_API_XID_REPORT_DATABASE_URL` to the primary identity database and
`READ_ONLY_DATABASE_URL` to Node's replica (defaults to the route database).
Separate read-only identity and replica pools each have one connection,
15 ms acquisition and 50 ms statement limits, under one 75 ms route deadline.
The identity connection is released before replica work. Participation pools
remain separate; no writes or external provider calls occur.

Required verified hybrid identity precedes a fresh canonical UUID lookup.
Only existing mapped OIDC accounts or verified existing participant identities
are admitted. Configure the existing static read JWKS/participant verifier;
missing, invalid and unsupported credentials hand back to Node. Possessing a
UUID alone never authorizes a download. A resolved UUID then uses Node's exact
site-moderator and numeric `ADMIN_UIDS` rule; a verified nonmoderator gets its
403 refusal before any XID query. Unknown UUIDs remain Node's 404. Owner status
alone does not bypass a NULL site id, matching Node's moderator predicate.

CSV keeps participant ordering, quoted XIDs, doubled quotes and final newline.
Empty exports are supported. Duplicate participant IDs, missing or ambiguous
UUIDs, more than 256 rows, XIDs over 4096 bytes or aggregate XID text over
32768 bytes, unsupported request shapes and read failures hand back to Node.
No forward/reverse CID cache is consulted for the UUID. Existing participant
identity resolution retains its separate membership checks.
Counters: `xidReportServed`, `xidReportFallback`.

### Existing email-invite reads

`POLIS_API_EINVITES_READ_READS=1` and nginx `RUST_API_ROUTES=einvitesRead` stage
GET/HEAD `/api/v3/einvites?einvite=<code>`; both default off. Set
`POLIS_API_EINVITES_READ_DATABASE_URL` to Node's primary database. Its separate
read-only pool has one slot, 15 ms acquisition, 50 ms statement limits and a
75 ms configured handler deadline; it never borrows participation connections.
This route performs no writes, minting, email delivery or external calls.

The code is the existing legacy capability. A single 1–100 character ASCII
alphanumeric/underscore/hyphen code admits an exact existing row. JSON preserves
column order, nullable email/created, and BIGINT created as a string. Unknown or
ambiguous codes, oversized email text, cookies/auth headers, bodies, duplicate
or unknown query keys and unsupported shapes hand back to Node and are counted.
Lookup is fresh on each request; there is no CID, PID or math cache dependency.
Counters: `einvitesReadServed`, `einvitesReadFallback`.

### Admin conversation HTML

`POLIS_API_ADMIN_PAGE_READS=1` and nginx `RUST_API_ROUTES=adminPage` opt into
GET/HEAD `/m/` paths beginning with a digit and another alphanumeric character.
Both switches default off. The fixed upstream comes from `STATIC_FILES_HOST`
and `STATIC_FILES_ADMIN_PORT` (or `STATIC_FILES_PORT`, default 8080).
The transport has four independent slots, no wait queue, a 75 ms whole-request
deadline, an 8 KiB response-header cap and a 16 KiB ASCII-document cap. It uses
no database, identity provider, participation pool or shared lock. DNS is resolved
once before listening, with a 75 ms startup bound; restart after an upstream
address change. Failed startup resolution leaves this route on Node while other
API routes remain available. There is no per-request resolver work. Only complete
200 responses with one Content-Length and no content/transfer encoding qualify.
GET bodies must arrive in one body-bearing read; fragmented bodies stay on Node.
Unsupported headers, authentication, query/body bytes, compression requests,
upstream failures and saturation hand back to Node before response emission.
The shared contract carries the request and rendered HTML. The renderer matches
the static stream's metadata replacement and retained suffix; this staged slice
is characterized against the small admin build, not arbitrary streamed content.


### Integration admin page

`POLIS_API_INTEGRATE_PAGE_READS=1` and nginx `RUST_API_ROUTES=integratePage`
opt into GET/HEAD paths beginning with `/integrate`, including suffixes without
an intervening slash, matching Express. Both switches default off. The route
uses the shared typed `integrate_page` contract and the fixed `/index_admin.html`
upstream. It applies the admin-page transport's existing ASCII, size, framing,
header and single-body-read limits. Identity, compression, query/body, unknown
headers, oversized or fragmented replies and upstream failures hand back to Node.

Its client has a separate four-slot semaphore, no queue, a 75ms request limit,
and startup-only bounded DNS. Failure affects only this client. It acquires no
database or participation connections. Neither static route enables the other.
`conformance/integrate-page-run.sh` proves raw Node byte equality and inherited
matrices; `nginx-routing.sh` checks routing and handoff. This browser page has no
CLI requests; the CLI differential makes no positive serving claim for it.


### Delphi report validation

`GET`/`HEAD /api/v3/delphi` is staged behind `POLIS_API_DELPHI_READS=1`
and nginx `RUST_API_ROUTES=delphiRead`, both off by default. Set
`POLIS_API_DELPHI_DATABASE_URL` to Node's read replica. Only missing/empty
report IDs (HTTP 400) and absent reports (HTTP 404) are served, using the shared
`polis-contracts::delphi_read` request/response types. Existing reports and
DynamoDB responses remain Node, as do identity, body, duplicate/structured
query, job-filter and unsupported report-ID shapes. Accepted nonempty IDs
are at most 100 ASCII alphanumeric, underscore or hyphen characters.
The uncached report lookup has its own one-slot read-only pool: 15 ms acquire,
50 ms statement and 75 ms caller deadline. It never borrows a participation
pool or holds a connection over a remote service call. Database errors and
contention hand back to Node; cancellation retains the slot until the query
finishes. `delphiReadServed` and `delphiReadFallback` count the outcomes.
Run `queue-rs/polis-api/conformance/delphi-read-run.sh result.json` for raw
Node/Rust byte replay on the generated fixture stack. This slice does not
serve topics or claim DynamoDB/provider parity.


### Delphi narrative report validation

`GET`/`HEAD /api/v3/delphi/reports` is staged behind `POLIS_API_DELPHI_REPORTS_READS=1`
and nginx `RUST_API_ROUTES=delphiReports`, both off by default. Set
`POLIS_API_DELPHI_REPORTS_DATABASE_URL` to Node's read replica for validation-only
mode. Without `DELPHI_RESULT_BACKEND=postgres`, only missing/empty
report IDs and absent reports (both HTTP 200, matching Node) are served, using the shared
`polis-contracts::delphi_reports` request/response types. Existing reports and
DynamoDB responses remain Node, as do identity, body, duplicate/structured
query, section/topic/job-filter and unsupported report-ID shapes. Accepted nonempty IDs
are at most 100 ASCII alphanumeric, underscore or hyphen characters.
The uncached report lookup has its own one-slot read-only pool: 15 ms acquire,
50 ms statement and 75 ms caller deadline. It never borrows a participation
pool or holds a connection over a remote service call. Database errors and
contention hand back to Node; cancellation retains the slot until the query
finishes. `delphiReportsServed` and `delphiReportsFallback` count the outcomes.
Run `queue-rs/polis-api/conformance/delphi-reports-run.sh result.json` for raw
Node/Rust byte replay on the generated fixture stack. This slice does not
serve narrative reports or claim DynamoDB/provider parity. PostgreSQL mode
extends this route as described in “PostgreSQL narrative reports” below.


### Delphi visualization jobs

`GET`/`HEAD /api/v3/delphi/visualizations` remains behind
`POLIS_API_DELPHI_VISUALIZATIONS_READS=1` and nginx
`RUST_API_ROUTES=delphiVisualizations`, both off by default. The existing
`POLIS_API_DELPHI_VISUALIZATIONS_DATABASE_URL` pool resolves reports (one slot,
15 ms acquire, 50 ms statement). Without the Postgres result backend, only
missing/unknown report validation is served and its 75 ms deadline is unchanged;
existing reports, credentials and S3 work stay with Node.

With `DELPHI_RESULT_BACKEND=postgres`, set `DELPHI_RESULT_ENV`, the same optional
`DELPHI_RESULT_SCOPE` as Node, and the primary
`POLIS_API_DELPHI_VISUALIZATIONS_RESULTS_DATABASE_URL`. Its independent read-only
pool has two slots, 15 ms acquisition and 200 ms statement bounds. It reads the
existing job views/controls and the same native graph/attempt/provider liveness
relations as Node; use the existing Node read login's access, without new grants.
The whole metadata request is bounded at 750 ms; nginx waits up to 1 second.
No participation connection or lock is shared.

The public response keeps `status`, `report_id`, `visualizations: []` and Node's
job fields/order. Native rows hide archived copies, current native liveness is
read separately after the result snapshot, and `job_id` filters the completed
metadata list. This does not invent a static visualization artifact contract.
The first result snapshot must fit a conservative single-page bound (512 KiB,
1,000 jobs); larger listings, unsupported legacy coercions and unavailable reads
hand back to Node, without a partial list, and so does a liveness sweep that
cannot finish within these bounds. `delphiVisualizationsServed` and
`delphiVisualizationsFallback` count outcomes.

`queue-rs/polis-api/conformance/delphi-visualizations-pg-run.sh result.json`
replays the unchanged Postgres baseline and compares native jobs, filters and
terminal liveness. Set unique `COMPOSE_PROJECT_NAME`, `POLIS_RECOVERY_PG_PORT`,
and the local `DELPHI_VISUALIZATIONS_PG_NODE_IMAGE`,
`DELPHI_VISUALIZATIONS_PG_POSTGRES_IMAGE`, and
`DELPHI_VISUALIZATIONS_PG_API_IMAGE` (fixture-clock) images. The shared CLI
DynamoDB differential still proves existing-report handoffs; the dedicated
Postgres run provides serving proof. No Node handler, schema, writer or
production switch changes.

### Topic statistics validation

`GET`/`HEAD /api/v3/topicStats` is staged behind `POLIS_API_TOPIC_STATS_READS=1`
and nginx `RUST_API_ROUTES=topicStats`, both off by default. Set
`POLIS_API_TOPIC_STATS_DATABASE_URL` to Node's read replica. Only missing/empty
report IDs (HTTP 400) and absent reports (HTTP 404) are served, using the shared
`polis-contracts::topic_stats` request/response types. Existing reports and
DynamoDB/Postgres results remain Node, as do identity, body, duplicate/structured
query, extra filters and unsupported report-ID shapes. Accepted nonempty IDs
are at most 100 ASCII alphanumeric, underscore or hyphen characters.
The uncached report lookup has its own one-slot read-only pool: 15 ms acquire,
50 ms statement and 75 ms caller deadline. It never borrows a participation
pool or holds a connection over a remote service call. Database errors and
contention hand back to Node; cancellation retains the slot until the query
finishes. `topicStatsServed` and `topicStatsFallback` count the outcomes.
Run `queue-rs/polis-api/conformance/topic-stats-run.sh result.json` for raw
Node/Rust byte replay on the generated fixture stack. This slice does not
serve topic statistics or claim DynamoDB/Postgres/provider parity.


### Collective statement validation

`GET`/`HEAD /api/v3/collectiveStatement` is staged behind `POLIS_API_COLLECTIVE_STATEMENT_READS=1`
and nginx `RUST_API_ROUTES=collectiveStatement`, both off by default. Set
`POLIS_API_COLLECTIVE_STATEMENT_DATABASE_URL` to Node's read replica. Only missing/empty
report IDs with no statement ID (HTTP 400), and absent reports (HTTP 404), are served, using the shared
`polis-contracts::collective_statement` request/response types. Existing reports and
DynamoDB responses remain Node, as do identity, body, duplicate/structured
query, any statement ID parameter, job-filter and unsupported report-ID shapes. Accepted nonempty IDs
are at most 100 ASCII alphanumeric, underscore or hyphen characters.
The uncached report lookup has its own one-slot read-only pool: 15 ms acquire,
50 ms statement and 75 ms caller deadline. It never borrows a participation
pool or holds a connection over a remote service call. Database errors and
contention hand back to Node; cancellation retains the slot until the query
finishes. `collectiveStatementServed` and `collectiveStatementFallback` count the outcomes.
Run `queue-rs/polis-api/conformance/collective-statement-run.sh result.json` for raw
Node/Rust byte replay on the generated fixture stack. This slice does not
serve collective statements or claim DynamoDB/provider parity.


### Disabled operations identity

`POLIS_API_OPS_WHOAMI_READS=1` and nginx `RUST_API_ROUTES=opsWhoami`
stage GET/HEAD `/api/v3/ops/whoami`. Both switches default off. Serving also
requires `OPS_ENABLED=false` explicitly on the Rust process, matching Node.
Keep that setting synchronized with Node; missing, enabled or other values
hand every request back. The slice returns the existing disabled-policy 404
JSON and private/no-store, Vary: Authorization and nosniff headers.
Enabled operations, authenticated/cookie requests, bodies and nonempty query
strings stay counted Node handoffs. No OIDC verification, policy evaluation,
page registry, database, pool, cache or provider is consulted in Rust.
The shared contract is in `polis-contracts/src/ops_whoami.rs`.


### Disabled operations pages

`POLIS_API_OPS_PAGE_READS=1` and nginx `RUST_API_ROUTES=opsPage` stage
GET/HEAD `/api/v3/ops/page/:id` disabled-policy 404 responses. Both default off.
Rust requires literal `OPS_ENABLED=false`, kept synchronized with Node.
Only nonempty ASCII alphanumeric, underscore or hyphen IDs of at most 128 bytes
are admitted. Other IDs, identity/cookies, bodies, queries and methods hand back.
The Node private/no-store, Vary and nosniff envelope is preserved. Enabled ops
and page/provider/registry evaluation remain Node. No DB or participation
resources are acquired. The shared contract is `polis-contracts/src/ops_page.rs`.


### Operations catch-all

`POLIS_API_OPS_CATCHALL_READS=1` and nginx `RUST_API_ROUTES=opsCatchall`
stage unmatched GET/HEAD `/api/v3/ops` and `/api/v3/ops/...` 404 responses.
Both default off and require literal `OPS_ENABLED=false` synchronized with Node.
The registered `whoami` and `page` path families keep their independent switches.
Only ASCII alphanumeric, underscore or hyphen path segments within 256 total
bytes are admitted, plus the root with or without its slash. Other encodings,
identity/cookies, bodies, queries and methods stay Node. No database, provider
or participation resources are acquired. The no-store response uses the shared
contract in `polis-contracts/src/ops_catchall.rs`.


### Delphi run record

`GET`/`HEAD /api/v3/delphi/run?job_id=<uuid>` serves one Delphi job's run
record, the `delphi-run/1` contract (`polis-contracts/src/delphi_run.rs`),
behind `POLIS_API_DELPHI_RUN_READS=1` and nginx `RUST_API_ROUTES=delphiRun`,
both off by default. It is a Rust-only route: Node has no handler for the
path, so every hand-back (polis-api's 502, no answer within nginx's 3 s, a
request shape the route does not model) reaches Node's 404.

- **The read.** One call to `pd_run_record(env, job)` (migration 000041), a
  SQL function that reads the job, its last attempt, its graph position, the
  finalized manifest, its provider requests and every family of its published
  bundle in one statement, so the record is one snapshot.
  `POLIS_API_DELPHI_RUN_DATABASE_URL` names a login in
  `polis_queue_executor`, the function's only grantee; `DELPHI_RESULT_ENV` is
  the queue env, as for Node. Its own pool: 2 slots, 50 ms acquire, 2 s
  statement timeout. The whole request has 2.5 s.
- **Who may read it.** Node's rule for `GET /api/v3/delphi/logs`
  (`hybridAuth`, then `isModerator(zid, uid)` for the job's conversation: a
  moderator of the owner's site, or an administrator in `ADMIN_UIDS`), with
  Node's refusal shapes: no `Authorization: Bearer` header, 401
  `{"error":"No authentication token found"}` before any read; no job id, 400
  `job_id is required`; no such job (or not a lowercase uuid), 404
  `Job not found`; not a moderator, 403 `polis_err_delphi_run_auth`. Identity
  comes only from a token polis-api verifies (polis-auth's participant
  verifier, or OIDC through `POLIS_API_READ_JWKS_FILE`); any other token (an
  XID token, an unknown subject, a bad signature) hands back. Identity, the
  moderator rule and the conversation's zinvite are read on a second pool,
  `POLIS_API_DELPHI_RUN_AUTH_DATABASE_URL`, else Node's
  `READ_ONLY_DATABASE_URL`, else `DATABASE_URL`: 1 slot, 50 ms acquire,
  100 ms statement timeout. Neither pool is a participation pool, and no
  connection is held across another call.
- **Recorded, and not yet recorded.** From the function: identity, report,
  kind, origin, stage, state, the last attempt (number, lease epoch, outcome,
  started and ended, exit proof), graph id, root and, on a root, the other
  nodes; configuration, code version, the finalized manifest's inputs, its
  embedding, topic-name and narrative models, its clustering model and seed
  (on a run whose manifest names them) and token counts; provider
  requests; pinned; and for each family of the job's published bundle its
  producing run, the run each upstream family came from, its batch (content
  sha256, row count) and its publication (scope and generation; `succeeded`
  while the served pointer still resolves it, else `superseded`). Recorded
  nowhere yet, so always `null`: `math_snapshot`, the statement model,
  prompt versions and `label`. A failure is given
  only when the job was cancelled or its recorded code (before any `:`
  detail) is one of the contract's closed codes; its stage is `null`. A job
  that published nothing lists no family. A full pipeline run still writes
  empty copies of the seven retired math families (clearing the import's);
  the contract has no new run produce a legacy family, so those empty copies
  are left out, and a non-empty one is refused. A record the contract
  refuses is not served (hand-back).
- **Byte stability.** The body is `wire::to_json` of the record.
  `conformance/delphi-run-fixtures/` holds the function's output and the
  route's bytes for a real local sequence (a full pipeline run, a
  collective-statement save over its topics, a second full pipeline run);
  a unit test rebuilds each record and compares the bytes. The db-tests
  check the rule, the refusals and pool isolation. Run
  `queue-rs/polis-api/conformance/delphi-run-run.sh result.json` for real
  runs through polis-jobs and every answer recorded and checked against the
  function. `delphiRunServed` and `delphiRunFallback` count the outcomes.

### Typed Delphi assignments (off by default)

`GET` and `HEAD /api/v3/delphi/runs/:job_id?families=assignments` serve the
existing `delphi-job-result/1` envelope for a moderator of the job's conversation,
using the same verified identity and moderator rule as `/api/v3/delphi/run`.
This first slice requires exactly `families=assignments`; other selectors,
repeats, bodies and unsupported methods hand back to Node. Node has no handler
for this new route, so a hand-back becomes its 404. Missing bearer tokens return
401; unknown or noncanonical job UUIDs return 404; non-moderators return 403.

Both switches default off: `POLIS_API_DELPHI_RESULT_READS=1` in polis-api and
`RUST_API_ROUTES=delphiResult` in nginx are required. The independent result pool
uses `POLIS_API_DELPHI_RESULT_DATABASE_URL` (an executor-member login), two slots,
a 50 ms acquisition timeout and a 2 s statement timeout. Its auth pool uses
`POLIS_API_DELPHI_RESULT_AUTH_DATABASE_URL`, then `READ_ONLY_DATABASE_URL`, then
`DATABASE_URL`, with one slot, 50 ms acquisition and 100 ms statements.
`DELPHI_RESULT_ENV` is required. All transactions are read-only; the whole request
is bounded at 2.5 s. Neither pool shares participation slots. The executor login
has other capabilities: the existing read-replica/enablement requirement for
Delphi reads still applies; this route does not enable itself.

The route calls `pd_run_record(env, job)` and then
`pd_result_artifact_family(env, artifact_id, family)` with the resolved immutable
artifact, never the current publication pointer. Row counts are checked; input
and output documents are limited to 8 MiB and assignments to 100,000 comments.
Malformed consumed tagged values, duplicate comment ids, noncanonical layers or
unrepresentable contract states hand back, with no coercion or invented model.
Ready results require a recorded topic model and completion timestamp; queued
jobs with no attempt return pending, active attempts running, and terminal
failures only when their recorded failure maps to the contract's closed codes.
Retry-wait/parked states and completed imports or synchronous saves without the
required model manifest currently hand back. Unavailable families are omitted;
an explicitly empty produced assignments family is an empty map.

The top-level job/run ids always name the requested job. For each family's actual
producer job/run/batch/digest, use `/api/v3/delphi/run?job_id=...` as the provenance
companion. Inherited assignments keep their original producer there; this route
adds no fields to either contract. Counts not recorded by the job remain null,
and neither live math nor current model defaults are substituted.

`conformance/delphi-result-run.sh` runs two real local pipelines with a generated
local sign-in and a sign-aware public fixture. Its raw replay compares the first
job's body before and after the second publication, constructs expected bytes
from immutable SQL rows, validates both client schemas and tests authentication,
HEAD, unsupported selectors and served/fallback counters. It uses the same
`DELPHI_RUN_*` settings as `delphi-run-run.sh`; `DELPHI_RUN_CODE_VERSION` may supply
the source revision for an archive tree. The worker uses no paid model provider.

The producer reserves nullable slots for hierarchy layers it did not compute.
A stored `{"NULL":true}` layer slot is absent from that comment's assignments;
it is never converted to a cluster id. The explicit unassigned-cluster value
still uses the contract's `Cluster::Unassigned` encoding.

### Statement importance (off by default)

`GET /api/v3/statements/importance?conversation_id=…` returns
`statement-importance/1`: `schema`, `conversation_id`, `read_at_ms` (database
statement start, Unix milliseconds) and `statements`, ordered by `tid`.
Each statement has `tid`, `important` (participants whose latest vote is marked
`high_priority`) and `voters` (participants with a vote, latest vote each).
These count participant numbers, not verified people. No vote signs, identities
or statement text are exposed. Latest means greatest non-NULL `created`; tied
creation times prefer `high_priority` in descending order.
Only active, unmuted (`velocity > 0`), participant-visible statements are included:
`mod >= 1` with strict moderation, `mod >= 0` otherwise. Visible statements with
no votes have both counts zero. A missing conversation returns 404; an empty one
returns `statements: []`. Resolution, visibility and counts share one SQL
statement snapshot. The response
is all-or-nothing with a 10,000-statement bound; larger reads hand back.

Enable only with both `POLIS_API_STATEMENT_IMPORTANCE_READS=1` and nginx
`RUST_API_ROUTES=statementImportance`; defaults stay off. Set the explicit
`POLIS_API_STATEMENT_IMPORTANCE_DATABASE_URL` to a read-only database DSN. The
route has its own two-slot read-only pool (15 ms acquire, 50 ms statement,
75 ms request bound), no identity lookup, and no resource dependency on the
participation pool. Saturation, database errors and unsupported requests return
502 internally so nginx hands back to Node. Node has no handler here; its
existing unmatched-route proxy determines the final response. A sealed fixture
without the static-file upstream returns a proxy 502, while the nginx test also
checks a Node 404. Enabling this switch does not add a Node handler. Cookies and bearer headers
do not change these public aggregate counts. GET/HEAD only, no request bodies,
exactly one alphanumeric conversation_id of at most 100 characters.

`conformance/statement-importance-run.sh` exercises the HTTP contract on an
isolated aggregate-only metadata fixture; it is not a Node parity recording.
The nginx suite covers default-off, opt-in, deduplication, method/body admission
and the 502-to-Node-404 path. The database suite covers query bounds, real lock
shedding, read-only enforcement and independent writer/next-statement resources.


### Legacy Delphi job logs

`POLIS_API_DELPHI_LOGS_READS=1` and `RUST_API_ROUTES=delphiLogs` opt in to
`GET`/`HEAD /api/v3/delphi/logs?job_id=…`. Both are off by default. This route
requires `DELPHI_RESULT_BACKEND=postgres`, `DELPHI_RESULT_ENV` and
`POLIS_API_DELPHI_LOGS_DATABASE_URL` (a primary read login with the existing
result views and queue read functions). `DELPHI_RESULT_SCOPE`, when set, must
match Node. Identity reads use `POLIS_API_DELPHI_LOGS_AUTH_DATABASE_URL`, falling
back to the ordinary read DSN, through a separate pool. OIDC JWKS, participant
verification and `ADMIN_UIDS` must match Node as for the run-record route.

The result pool has two slots, 15 ms acquire and 200 ms statement bounds. The
identity pool has one slot, 15 ms acquire and 50 ms statement bounds. The whole
request has a 750 ms deadline. Neither pool shares participation connections;
all sessions are read-only. Native rows take precedence over archived controls;
job lookup and latest-attempt logs use one repeatable-read snapshot. Native logs
retain the first 1,000 entries before filtering stdout/stderr, as Node does.

The existing response fields and moderator rule are preserved. A complete
legacy archive is limited to 4 MiB and the response to 1 MiB. Unsupported archive
attributes, date grammars, credentials, bounds and database failures hand back
to Node with 502; no partial logs are returned. Naive legacy ISO timestamps are
handled only with explicit `TZ=UTC`; other time zones hand back to Node. No
writer, schema, result contract or production switch changes.


Run `queue-rs/polis-api/conformance/delphi-logs-run.sh result.json` with a unique
`COMPOSE_PROJECT_NAME`, `POLIS_RECOVERY_PG_PORT`, and local
`DELPHI_LOGS_NODE_IMAGE`, `DELPHI_LOGS_POSTGRES_IMAGE`, and
`DELPHI_LOGS_API_IMAGE` (built with `fixture-clock`). It replays all 272
Postgres baseline cases unchanged and compares every log case through Rust,
then adds native attempts, moderator controls, archive precedence and the
pre-filter entry limit. Its reader login has only the existing executor role.
The shared CLI differential retains its DynamoDB fixture and therefore checks
this route's disabled fallback; it does not claim Postgres log-serving coverage.

### PostgreSQL legacy topics

`POLIS_API_DELPHI_READS=1` and `RUST_API_ROUTES=delphiRead` remain off by default.
With `DELPHI_RESULT_BACKEND=postgres`, also set `POLIS_API_DELPHI_TOPICS_DATABASE_URL`
to a primary reader with EXECUTE on `pd_result_page` and SELECT on `reports`
(`report_id`, `zid`), `DELPHI_RESULT_ENV`
and optional `DELPHI_RESULT_SCOPE`. Both database URLs must point to the same primary database in PostgreSQL mode.
The report lookup retains its separate one-slot pool; the new result pool has two read-only slots, 15 ms acquisition and 200 ms statement
limits, and the whole request is bounded to 750 ms. It shares no participation pool.

The legacy response groups by model/date, keeps last topic per layer/cluster, counts
all items, and takes its job UUID from the oldest narrative index row. Narrative and
topics are separate reads, as in Node; this is not an immutable run-result contract.
Numeric object keys preserve JavaScript order. Missing fields stay absent, stored nulls
stay null. Local-time ISO dates require `TZ=UTC`; unsupported date/coercion/prototype
shapes, ambiguous scopes, over 1,000 source rows or 512 KiB of tagged source, and all
query failures hand back to Node with 502. The SQL byte check runs before rows
are transferred to Rust. No partial result is returned. DynamoDB
mode retains validation-only serving. Public auth headers are ignored in PostgreSQL
mode as they are in Node. No handler, schema, writer or production setting changed.

Conformance with locally built Node, migrated Postgres and fixture-clock API images:
```sh
COMPOSE_PROJECT_NAME=topics-proof POLIS_RECOVERY_PG_PORT=58241 \
DELPHI_TOPICS_PG_NODE_IMAGE=topics-node:local \
DELPHI_TOPICS_PG_POSTGRES_IMAGE=topics-postgres:local \
DELPHI_TOPICS_PG_API_IMAGE=topics-api:local \
queue-rs/polis-api/conformance/delphi-topics-pg-run.sh /tmp/topics-results.json
```
The runner replays the unchanged Postgres baseline and checks Rust response bytes,
served/fallback counters, overwrites, ordering, nulls, publication replacement and
an explicit bounded fallback. Images use generated fixtures only.

## PostgreSQL narrative reports

With the existing `POLIS_API_DELPHI_REPORTS_READS=1` and
`RUST_API_ROUTES=delphiReports` switches, `DELPHI_RESULT_BACKEND=postgres`
enables bounded reads of `/api/v3/delphi/reports`. Both switches remain off by
default. The response preserves Node's public access, job selection, section
filters, property ordering and stored timestamp strings, including microseconds
and offset spelling. No timestamp is converted to a Date. The latest timestamp
within each run uses string comparison; run ordering uses Node's characterized
timestamp collation. Unsupported characters remain on Node.

`POLIS_API_DELPHI_NARRATIVES_DATABASE_URL` selects an independent two-connection
result pool; `POLIS_API_DELPHI_REPORTS_DATABASE_URL` selects the separate
one-connection validation pool. Both URLs must use the same primary as Node.
The result login requires EXECUTE on `pd_result_page` and SELECT on `reports`;
sessions are read-only. No participation pool is used. Requests hand back to
Node on a pool/query failure, conflicting scopes, unsupported values, more than
1000 family rows, over 512 KiB of input, or over 1 MiB of output. The complete
request deadline is 750 ms, with a 200 ms result statement timeout.

`conformance/delphi-reports-pg-run.sh` runs the unchanged Postgres baseline plus
native publication, timestamp, grouping, filter and bounded-handoff checks.
It requires unique compose/port settings and the three local fixture images.

The staged [vote read routes](VOTES-READ.md) cover latest/history responses under
`votesRead`, off by default. The route note names the identity quirks, bounded
read pools, exact response subset and Node hand-back conditions.

Conversation link pages (`/iip/:conversation_id`, `/iim/:conversation_id`) have independent default-off switches and read-only pools. See [LINK-PAGES.md](LINK-PAGES.md) for the contract, admission limits and replay.

Current participant rows: [contract and admission](PARTICIPANTS-READ.md).

Social participant rows: [contract and admission](PTPTOIS.md).

Participant invitation CSV: [contract and admission](MY-INVITES-CSV.md).

Bucket membership and group locations: [contract and admission](MATH-MEMBERSHIP.md).

Conversation HTML pages: [contract and bounded admission](CONVERSATION-PAGES.md).


## Run without selecting a public route

The web deployment can keep this process warm while nginx sends every request
to Node. Set `POLIS_API_START=1` and leave `RUST_API_ROUTES` empty in the shared
deployment environment. The start flag defaults to `0`; a nonempty route list
also starts the process. Only `0` and `1` are valid start values. No route switch
is derived from this flag. Keep other `POLIS_API_*_READS`, `POLIS_API_*_WRITES`
and `POLIS_API_OWNER_LIST` switches off for this rollout.

The normal image build and digest-pinned deployment carry the service; no box
specific override is needed. Node, nginx and the participation client start
first; Rust starts separately without dependencies. Failed Rust startup leaves
those services running. It fails the deployment only when a Rust route is
selected; otherwise the failure is logged and the Node deployment continues.
The existing full service replacement still needs the deployment's normal
traffic drain.

Use `POLIS_API_DB_TRANSPORT=tls`, an exact `POLIS_API_DB_HOST_ALLOWLIST`, and
`POLIS_API_DB_CA_FILE=/etc/polis/rds-global-bundle.pem`. The image includes the
same digest-pinned public RDS trust store as Node and Delphi; build and every
container start verify the asset. Other certificate authorities can be supplied
at a separate path. TLS still verifies both trust and the database hostname.
No certificate is downloaded at startup. Database selection remains the
explicit API URL, then the read-only URL, then the primary URL.

Production compose fixes the common read-only pool at eight slots, with 2000 ms
acquisition timeout, 3000 ms statement timeout and 300000 ms connection lifetime.
It caps the process at 0.5 CPU and 512 MiB. Node's participation pools remain
separate. These bounds do not reserve database CPU or I/O; database capacity
must still be checked before serving traffic. Other route pools remain off.

The internal `GET /health` retains its existing counters and reports:

- `status` (`ok` or `degraded`) and `mathEnv`; database failure returns HTTP 503.
- `version` (release base from VERSION) and `commit`, embedded at image build.
  Standalone builds without those inputs explicitly report `unknown`.
- `pools.common`: read-only status, reachability, limit, available slots and
  acquisition/statement/lifetime bounds. Reachability is a real common-pool ping;
  it does not certify unselected routes or their pools.
- `routing.configuredRoutes` and `routing.enabledSwitches`: the process's route
  environment and names of explicit enabled route switches. These are desired
  configuration, not proof of nginx's currently loaded map.

ValidateService checks the running, non-restarting process and requires three
consecutive HTTP 200/ok/python responses with the expected revision, route
configuration, common-pool bounds and no additional enabled switches. Requests
have a four-second abort deadline. When no Rust route is selected, the same
probe logs its result but a Rust failure does not fail the web deployment.
Rust startup failure likewise logs and continues after Node starts. Once a
route is selected, Rust startup and health are required. Invalid deployment
configuration (including unverified database transport) is still rejected.
Node's existing readiness checks remain required in every case.
Health bypasses served/failed route counters, so all-off ingress probes must
leave those counters unchanged. Check nginx's current/routes separately.

The service has no host-published port or logging override. Its logs inherit
the web host's existing Docker awslogs group and stream. To include warm startup
and failure messages, which do not all carry `service=polis-api`, use:

```sh
docker-compose -f docker-compose.yml -f docker-compose.images.yml logs polis-api
```

Read the deployment hook output for image pull and startup failures from
AfterInstall and health results from ValidateService.

An all-off stop uses the existing drained switch helper with an empty list;
`POLIS_API_START=0` plus empty routes keeps it stopped on the next deploy. A
profile-enabled project `--profile rust-api down` removes it with the other
services; a plain `down` can leave it running. The web AfterInstall hook enables
that profile for teardown, even when the next start flag is `0`.

Before rolling back to a release at or before 2.42.2, stop the service explicitly
on each web host, using the current Compose files and project:

```sh
docker-compose -f docker-compose.yml -f docker-compose.images.yml stop polis-api
```

Those older hooks do not enable the profile during teardown and cannot remove
the old container themselves. The explicit stop leaves it stopped across the
rollback. Never stop Rust before selected traffic drains; first use the drained
switch helper with an empty list when any route is selected.
