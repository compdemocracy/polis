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
only the exact path `/api/v3/math/pca2` goes to polis-api. If polis-api is
down, slow, or answers 502, nginx asks Node instead. An unknown name in
`RUST_API_ROUTES` stops nginx from starting, so a typo is never silently
ignored.

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
and the approved comment ids. The session is set read-only. Connections use
this workspace's shared transport rules (`queue-rs/src/jobs/transport.rs`):
verify-full TLS to listed hosts, a Unix socket, or plain TCP to loopback.
`docker-internal` (plain TCP to named hosts) exists for the dev and test
compose stacks, whose Postgres has no TLS.

## Configuration

It reads the Node server's env file, so these match Node: `MATH_ENV`
(required; there is no default, as in Node), `DEV_MODE`, `NODE_ENV`,
`DOMAIN_OVERRIDE`, `USE_NETWORK_HOST`, `TESTING`, `API_DEV_HOSTNAME`,
`API_PROD_HOSTNAME`, `DOMAIN_WHITELIST_ITEM_01..08`, `CACHE_MATH_RESULTS`.
It refuses to start if `POLIS_REACHABLE_ERROR_HANDLER` is on, because it only
implements Node's default error pages.

Its own settings: `POLIS_API_DATABASE_URL` (else `DATABASE_URL`),
`POLIS_API_DB_TRANSPORT` (`tls` default, `local`, `loopback`,
`docker-internal`), `POLIS_API_DB_CA_FILE` and `POLIS_API_DB_HOST_ALLOWLIST`
(tls), `POLIS_API_DB_PLAIN_HOSTS` (docker-internal),
`POLIS_API_DB_PASSWORD_FILE`, `POLIS_API_DB_POOL` (8),
`POLIS_API_DB_ACQUIRE_TIMEOUT_MS` (5000), `POLIS_API_LISTEN`
(`127.0.0.1:5100`; the image uses `0.0.0.0:5100`). `GET /health` reports
database reachability and counts; it is not routed by nginx.

## Known differences from Node (none reached by any recorded request)

- A database error gives the same 500 status, but Node's body lists the
  Postgres error's fields and this one prints `{}`.
- With `NODE_ENV` other than `production`, an unparseable JSON body gets
  Node's stack trace on Node and a plain message here.
- A `math_main.data` value that is not a JSON object (no writer produces one)
  is answered 500 here.
- Request bodies over 1 MB, chunked request bodies and multipart bodies are
  refused or ignored; Node accepts up to 50 MB. The route reads no body field
  that a client sends in practice.

## Running the checks

```sh
cd queue-rs
cargo fmt -p polis-api --check
cargo clippy --locked -p polis-api --all-targets -- -D warnings
cargo test --locked -p polis-api
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
