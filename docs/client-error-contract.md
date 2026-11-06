# Browser diagnostic contract

`POST /api/v3/clientErrors` accepts a JSON object using `application/json` or
`text/plain`. The schema is `client-error/1`, defined by
[`server/src/contracts/clientError.ts`](../server/src/contracts/clientError.ts)
and generated into the server and all four clients with `npm run contract:generate`
in `server/`. The generated schema documents the outgoing shape; the server
independently projects untrusted input before logging it.

Every browser report contains these fields:

| Field | Meaning and bounds |
| --- | --- |
| `client` | `alpha`, `admin`, `report`, or `participation` |
| `build` | A 40- or 64-character lowercase hexadecimal build revision, or `unknown` |
| `page` | Page path after privacy projection, at most 160 characters |
| `kind` | `error`, `unhandledrejection`, `console_error`, `console_warn`, `fetch`, `xhr`, `resource`, or `csp` |
| `message` | Allowlisted error category, at most 256 characters |
| `stack` | Recognized script paths with positions, or a projected document path without positions; at most 1024 characters |
| `resource` | Failed request or resource path after privacy projection, at most 160 characters |
| `method` | Empty or `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `CONNECT`, `TRACE` |
| `status` | Integer from 0 to 599; 0 means unavailable |
| `duration_ms` | Integer milliseconds, capped at 60000 |
| `signature` | 16 lowercase hexadecimal characters, recomputed by the server |
| `count` | New occurrences since the previous transmission, integer from 1 to 1000 |

Nonnetwork kinds have an empty `method`, `status: 0`, and `duration_ms: 0`.
Counts are increments, so ``sum(`count`)`` gives the received occurrence total.
They are bounded, unauthenticated diagnostic observations, not an exact census:
transport failure, client limits, server limits and page closure can lose events.
A direct caller can invent occurrences; a signature does not authenticate a report.

The reporter never includes request or response bodies, cookies, authentication,
identity, or user text. Queries and fragments are removed. Own-origin resources
use path families; third-party resources keep only their host, without credentials
or a port. Dynamic
route segments become `:id`; recognized static path families remain identifiable. Unknown path text is
redacted as well. Messages retain only known error categories or HTTP status;
arbitrary console prose becomes `Error`. The exact browser string `Script error.`
is a separate category; longer messages beginning with it are not preserved.
Stack function names, V8 message lines and free text are removed. Input stacks
are limited to 8192 characters and 12 lines; a line over 1024 characters is
ignored before parsing. Locations must begin with an HTTP(S) URL or `/`;
`data:`, `blob:`, file and extension locations are dropped.

Inline document code can follow server-inserted conversation data. Its line and
column therefore reveal content length. All four clients omit both coordinates
for document frames. If a recognized bundle frame exists, only bundle frames are
kept: this also excludes the inline reporter's fetch and XHR wrapper frames from
the grouping location. Otherwise a document frame becomes the projected page
path alone (for example `/:id`). Inline-only bugs in the same category and page
family can consequently merge; precision is deliberately limited by privacy.
Distinct inline-only bugs in the same category on one page share one signature: the browser sends the first occurrence and counts the rest.
On `/:id` pages, single-segment third-party script frames (including analytics and Cloudflare) show the same page marker as our inline code.
Stackless errors use the browser's supplied location under these same rules.

Only these 15 shipped same-origin PNG basenames keep their exact names under
`/twemoji/14.0.2/72x72/`: `1f1fa-1f1f8`, `1f30d`, `1f30e`, `1f30f`, `1f3ce`,
`1f44b`, `1f479`, `1f47e`, `1f4be`, `1f4d6`, `1f529`, `1f5de`, `2697`, `26a1`,
and `2764`. Other names, versions, extensions and third-party paths stay projected.
Showing separate filenames can spend the per-address budget on one page load.
Directory-level aggregation with an occurrence count would better describe an
all-images outage and preserve room for other diagnostics. It is a recommended
follow-up; this contract still groups these 15 failures by exact filename, and
neither transport nor rate limits change.

The shared reporter program is marked `prettier-ignore` as a single syntax node,
so the clients' different formatter versions preserve byte-identical copies.
 The server applies the same projection again, ignores extra input keys,
and logs an explicit field list. The log event has `message: "client_error"` and
renames the projected message to `error_message`. Its only additional field is
`user_agent`, restricted to recognized browser product/version tokens, at most
256 characters. Within this endpoint, request IPs are used only in the bounded in-memory limiter.
The existing HTTP access logger still runs separately under its configured log
level and can record IP and the original User-Agent as it does for other routes.

The signature joins client, kind, nonzero status (or projected message), and
first projected stack frame (or projected resource when no frame exists) with a
newline. Before hashing, only the content hash in a bundle filename is removed.
Line and column remain part of bundle-frame signatures, so different bundle
positions produce separate reports. Document markers have no coordinates.
The diagnostic stack retains projected bundle filenames and positions. Cross-build comparisons that also ignore
changed offsets are an explicit offline triage view; see
[client error triage](client-error-triage.md). Two unsigned 32-bit hashes start at 2166136261 and 5381. For each UTF-16
code unit, they respectively apply `Math.imul(hash ^ code, 16777619)` and
`Math.imul(hash ^ code, 33)`. Each becomes eight zero-padded lowercase hexadecimal
characters, concatenated in that order. Build, page, method, lower stack frames, duration and
count do not split otherwise identical signatures. This is a grouping key,
not a cryptographic digest; collisions remain possible.

The endpoint returns an empty `204` with `Cache-Control: no-store` for accepted,
invalid, oversized and rate-limited requests. It runs before the shared body
parser, refuses compressed bodies, and retains at most 4096 request bytes. It
allows 32 active bodies, each for at most five seconds. Its per-IP bucket allows
a burst of 10 then one request per minute. Both buckets must admit before either token is spent; refusal by one bucket
never spends the other bucket's budget. Behind a recognized
Cloudflare IPv4 edge, the address is the X-Forwarded-For entry immediately before
the final edge address, as in the nginx access log. Earlier entries are ignored.
The final hop must match the Express trusted hop and the checked-in production
ingress ranges; other or malformed chains use that trusted hop directly. IPv6
clients share one bucket per /64; equivalent and scoped spellings normalize
to the same prefix. IPv4-mapped addresses share the corresponding IPv4 bucket.
A local or self-hosted stack behind one trusted address shares one budget:
10 reports initially, then one per minute. This assumes Node is
reachable only through the configured proxy; it does not change trust proxy.
The process-wide bucket allows a burst
of 100 then one request per second. At most 4096 IP entries are retained; only
an oldest entry idle for ten minutes can be replaced. These limits apply to
this endpoint only. Each accepted body produces at most one log call regardless
of its count; the endpoint uses no database, queue, or shared connection pool.
Participation handlers do not wait for diagnostic processing.

The browser limits each page to 50 distinct signatures, flushes pending repeat
counts, and limits sends to 20 per minute and 200 per session across client
surfaces when session storage is available. With storage unavailable, in-memory
limits still apply but do not survive a reload. The reporter uses the original
transport functions and ignores its own endpoint to avoid feedback loops.

Fetch and XHR responses with status 304 are successful and are not reported.
Network failures, timeouts and HTTP status 400 or above are reported. Navigation
cancellation (fetch rejection or XHR status 0) can still produce a failed-request
category; it carries no response body.

Client errors terminate at the existing `client_error` log line. They do not
feed an automated fixer or another service.
