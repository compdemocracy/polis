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
