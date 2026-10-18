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

1. Start the program: `docker compose --profile rust-api up -d polis-api`.
2. Tell nginx to send it the route: `RUST_API_ROUTES=pca2` in the
   environment of `nginx-proxy`, then recreate `nginx-proxy`.

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

- **Database transport.** The compose default `docker-internal` is plain TCP
  to the dev Postgres container. Against RDS set `POLIS_API_DB_TRANSPORT=tls`,
  `POLIS_API_DB_CA_FILE` and `POLIS_API_DB_HOST_ALLOWLIST`; with the default
  it refuses the RDS host and exits, and nginx keeps sending pca2 to Node.
- **Which database.** Like Node's read pool, it reads `READ_ONLY_DATABASE_URL`
  when that is set and not empty, else `DATABASE_URL`
  (`POLIS_API_DATABASE_URL` overrides both).
- **Database login.** It uses the same login as Node's read pool. A dedicated
  read-only login (SELECT on `zinvites`, `math_main`, `comments` only) is a
  role change and is left out until Colin rules on it; until then the
  session is set read-only, which is the only guard.
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


## Public comment reads

`POLIS_API_COMMENT_READS=1` enables the public, bodyless GET/HEAD
`/api/v3/comments` slice. It requires `POLIS_API_COMMENTS_DATABASE_URL` for
conversation lookup and statement rows. Pagination counts use a separate pool
on `READ_ONLY_DATABASE_URL`, falling back to the comments DSN when unset, as
Node does. The pools have two and one connections respectively, a 100 ms
acquisition deadline and a 1 s statement deadline; sessions are read-only.
They do not borrow connections from other route pools or math reads. This bounds
waiting within this process; it does not prove shared database load isolation.

Both this process flag and nginx's `RUST_API_ROUTES=comments` switch are off by
default. Requests carrying credentials or cookies, report/moderation views,
unsupported parameters, missing conversations and database failures return the
existing 502 handoff to Node. Node retains optional identity creation, provider
calls and error behavior for those requests. They are **not** implemented by
this Rust slice. No participant resolution or voting behavior moves here.

The moved views preserve legacy arrays and limit/offset pagination, visibility,
statement IDs, field order, bigint strings, nullable fields and Node's
created-only ordering. The count and row queries remain separate observations,
including when a read replica lags; no snapshot consistency is promised.

`conformance/comments-run.sh` seeds the unchanged generated characterization
fixtures, then replays all 396 archived comments requests against live Node and
Rust. Responses served by Rust must match raw HTTP bytes (including headers,
compression and chunk framing); Node handoffs are counted separately, and an
eligible public success falling back is a failure. Only a Date-only mismatch
may be retried and is counted. `conformance/nginx-routing.sh` checks the
independent switch, body/method guards and failure handoff. Authentication,
moderation/report equivalence and concurrent participation-load acceptance
remain outside this partial implementation's evidence.

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
projection; moderation and report views remain with Node.

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

### About redirect

`POLIS_API_ABOUT_READS=1` and nginx `RUST_API_ROUTES=about` opt into GET/HEAD
`/about`. Both default off. `polis-contracts::about` supplies shared request and
redirect-response types. The 302 points to `/home` using the request Host and
Node's development/production scheme selection, with the existing normal HTTPS
redirect before it. No API CORS headers are added. Missing Host, query parameters,
credentials, cookies, bodies and other methods hand back to Node and are counted
in `aboutServed`/`aboutFallback`. No database/provider or participation work occurs.
`conformance/about-run.sh` records full response bytes and replays the crawler
policy and connection probe as regressions on the same isolated fixture stack.

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
