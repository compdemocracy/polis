# Conversation link pages

Observable changes: none while the switches are off (the default).

`GET /iip/:conversation_id` returns a participation anchor. `GET
/iim/:conversation_id` returns the same anchor with the conversation's topic
(or its creation timestamp), a moderation anchor and an optional description.
The contract follows `server/app.ts` and
`server/src/routes/conversations.ts` on the recorded source. HEAD, ETag
freshness, CORS and compression use the existing Express-compatible envelope.

Each route has an independent nginx selector (`iip`, `iim`) and process switch
(`POLIS_API_IIP_READS=1`, `POLIS_API_IIM_READS=1`). Both default off. The common
`POLIS_API_LINK_PAGES_DATABASE_URL` configures their independent read-only
pools; no write pool is used. Choosing a selector does not enable the handler.
The nginx method/body gate sends writes directly to Node. Unavailable Rust,
resource pressure and unsupported requests return to Node before any response
is started. After headers have reached the client, a truncated response cannot
be retried by nginx.

Admitted requests have one ASCII alphanumeric path ID (1–100 bytes), an optional
trailing slash, no query parameters, no credentials and no body. The ID is
resolved with an indexed `zinvites.zinvite` lookup on every request. Missing IDs,
unsupported encodings, cookies, authorization, parameter variants and database
errors stay with Node. The moderation route admits exactly one conversation,
and at most 16 KiB of combined topic/description data. It preserves bigint
creation timestamps as decimal strings.

The source sends topic and description markup verbatim and constructs the
moderation URL with `m` immediately followed by the ID. These behaviors predate
the JavaScript-to-TypeScript conversion (the 2021 conversion) and remain unchanged here.
The conversion added types and formatting on these handlers and their parameter
and conversation helpers; no semantic conversion slip was found.

Known cache difference: Node has process-local conversation-ID caches. Rust
performs a direct lookup. A warm reverse cache may retain the previous code
when an owner adds one. These pages use the path's supplied ID without a reverse
lookup, so that difference does not alter their successful link output.

Participation isolation: each enabled page has one read-only connection, a
15 ms pool acquisition deadline, a 50 ms statement deadline and a 75 ms request
deadline. No transaction or row lock is acquired. Cancellation retains the pool
slot until the blocking database operation actually finishes. No database
connection is held across network or model work. The real-database test parks a
moderation read behind a table lock and verifies an independent participation
pool continues to answer; the shared pool's cancellation tests remain in force.

`conformance/link-pages-run.sh` records complete HTTP bytes against unchanged
Node, compares admitted Rust responses without normalization, checks explicit
Node handbacks and replays every case against a process with both switches off.
A Date-only rollover causes a fresh capture, never a masked comparison.
`conformance/nginx-routing.sh` checks both independent selectors, default-off,
method/body boundaries and the pre-response fallback. The contracts crate
shares the page request/HTML response types with the route.
