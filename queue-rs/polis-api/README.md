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
