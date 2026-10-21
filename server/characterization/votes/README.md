# POST votes characterization

This profile records the existing Node route. It does not implement a writer,
change a route, or authorize migration. Votes use `semanticToWire` and the real
HTTP handler; there are no fixture INSERTs into vote tables.

The profile reuses `runCase`, ordered wire records, verified JWT substitution,
database snapshots, effect drain, and the exact comparator. `control.cjs` runs
only with `P027_VOTES_PROFILE=1` in the isolated characterization entrypoint.
SQL failures are labeled controls, not natural application failures. Real auth,
membership, vote-convention and handler chains run throughout.

The 72-case matrix covers anonymous first contact; pid zero, nonzero, standard,
XID, owner and admin identities; foreign, expired and invalid tokens; Treevite
membership and refusal; XID policy; vote changes and repeats; moderated-out and
missing comments; closed conversations; star and priority coercions; malformed
fields; no next comment; and explicit vote/star/next-selection SQL failures.
The six identity sequences use distinct existing comment keys. Each new-vote
case asserts a first latest-row insertion; later cases assert history appends
and current latest state. A fresh seed and server restart precede each run.

`contract-cases.json` holds all 72 captured response bodies, with passing
recording oracles. Its Rust test decodes and re-encodes every body byte for byte.
Credential VALUES use verified symbols; surrounding whitespace, field order
and bytes remain intact. A fresh 72-case replay also matched ordered headers,
bodies, database and external effects with the existing comparator.
These are the declared matrix's coverage, not all possible HTTP/parser/provider
failures. The static error catalog distinguishes source-traced and unreachable
branches from live observations. The SQLSTATE duplicate case is injected; the
published history schema does not naturally enforce that uniqueness.

The profile alone classifies an HTTPS Agent's idle TLSSocket timer as settled.
`idle-tls.cjs` retains the timer association and checks the socket is in the
Agent's free pool, absent from its active pool, and its request/response complete.
A reused active socket is pending again. Non-TLS sockets, unrelated timers,
SQL and provider operations do not qualify. Drain deadlines are unchanged.
The runtime test uses a real local TLS issuer, tests both strict and classified
barriers, and checks active reuse, an ordinary timer and explicit SQL work.
Both earlier cold-owner diagnostic controls remain in the delivery evidence.
A cold OIDC vote still performs the existing outbound JWKS request; this change
does not alter authentication or network behavior.

Within the generated-data compose profile, run:

```sh
docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml exec -T driver node --test characterization/votes/idle-tls.test.cjs
docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml exec -T driver node characterization/cli.cjs seed
docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml restart server
# Wait for the characterization ready endpoint before each run.
# Install provider-signed fixture tokens without writing them to disk:
docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml exec -T oidc-simulator node < server/characterization/votes/provider-tokens.cjs | docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml exec -T driver node characterization/votes/install-tokens.cjs
docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml exec -T driver node characterization/votes/run.cjs /artifacts/votes-record
# Seed and restart again, then replay:
docker compose -f server/characterization/compose.yml -f server/characterization/votes/compose.yml exec -T driver node characterization/votes/run.cjs /artifacts/votes-replay /artifacts/votes-record
```

Use a unique compose project and ports and the harness's internal network.
Source provenance comes from `P027_SOURCE_COMMIT`. No general-corpus admission
rule is widened for this separate profile.

Latest-state behavior comes from `000006_update_votes_rule.sql`: every INSERT
appends history, then upserts vote/modified for `(zid,pid,tid)` without comparing
created times or updating the existing latest weight. high_priority exists on
history only. Star writes and next-comment selection follow that commit.
Both injected post-commit failures save a vote before HTTP 500; retry after the
next-comment failure appends again. No next comment means the field is omitted.
A failed response must not be treated as a safe retry signal. Mixed-writer load
qualification is still a separate prerequisite; no load result is claimed here.

The original 72 bodies remain unchanged in `contract-cases.json`. Additional
cases are appended by `additional.cjs`; their captured bodies live separately
in `additional-cases.json`. See [COVERAGE.md](COVERAGE.md) for source references,
identity distinctions, unrecorded branches and codec-only evidence.

The checked-in compose topology sends HTTP directly to Node (`P027_BASE_URL`
in `../compose.yml`); it has no deployment gateway. A direct run is not gateway
qualification. A separately supplied gateway must be identified in its evidence;
its presence cannot be inferred from a successful replay.

Byte equality uses `../normalize.cjs` policy version 3 and `../wire.cjs`, through
`../compare.cjs`: JWT values are signature/binding verified then substituted;
typed capabilities and bound URLs are substituted lexically; original affected
Content-Length and ETag are checked before deriving replacement headers. Body
chunks are concatenated. Chunk boundaries, timing, date, connection, keep-alive
and provider metadata are excluded from equality. Ordered remaining headers,
body bytes and database effects are compared. Clocks and randomN remain exact.
This is not an unmodified TCP transcript.

Additional identity bindings are declared from request credentials before the
response is decoded, including signed XID fallback and standard-user subjects.
They do not disable signature, issuer, audience, expiry, participant-row or
conversation verification. SQL-fault cases name the injected operation; they
exercise real middleware and route behavior after that dependency fails.

Before each fresh run, restart the owned in-memory DynamoDB service as well as
seeding Postgres and restarting Node, then install the provider tokens again.
The additional fixture creates its two DynamoDB tables only after the original
72 cases. This keeps their initial topology and effects unchanged.

To retain a failing deferred-write reproduction, set
`P027_VOTES_DEFERRED_FAILURE` on the driver to exactly one of
`deferred-conversation`, `deferred-participant`, or `deferred-count`. This selects
a single fault case; it retains the ordinary passing-oracle assertion and exits
nonzero if Node emits an unhandled rejection. Run each against a fresh seed and
server process, in a separate output directory. Never count these as green
recordings or discard their captured response/effects.
