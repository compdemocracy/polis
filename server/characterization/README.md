# P-027 API characterization v1

This harness lives under `server/characterization/` because it needs the exact
Node dependencies, Express 3 runtime and migrations from the server image. The
recording format and HTTP/effect adapter protocol are independent of Node so that
a Rust implementation can be compared later. It is a characterization scaffold,
not permission to replace any route. Boundary coverage alone is insufficient for
migration admission; see the generated report and the limitations below.

## Local operation

From the repository root, with Docker available:

```sh
python3 server/characterization/run.py build
python3 server/characterization/run.py record
python3 server/characterization/run.py replay
python3 server/characterization/negative.py
python3 server/characterization/run.py record nominal nominal
node --test server/characterization/test.cjs
python3 -m unittest discover -s server/characterization -p 'test_pseudonymize.py'
python3 server/characterization/run.py down
```

The default boundary recording has 513 cases. The separate 525-case `nominal`
diagnostic profile supplies required fields, generated metadata fixtures and 18
empty Dynamo tables, and retains malformed UUID, empty-update and missing-
conversation cases. Existing application defects make that diagnostic run red;
its recordings remain available for review. Use `replay nominal nominal` to
recreate the same diagnostic corpus. A matching defect is still a failed gate.
The diagnostic run can terminate early when the application exits. An optional
final route ID starts a separate segment on a fresh fixture, for example
`record nominal-tail nominal 83`. This never appends to or repairs a failed
recording: each segment has its own corpus/manifest and still fails coverage for
omitted routes. The initial diagnostic run dies in `POST /api/v3/trashes` (#82);
the tail segment records the remaining registrations for review.

The project is always `p027`. The isolated topology is derived from
`docker-compose.test.yml` and reuses its server/Postgres build targets, real
OIDC simulator, static file server and DynamoDB Local, plus a separate driver container. It does not run math,
Delphi pollers or the import worker. Every container has exactly one network,
`p027_sealed`, with Docker `internal: true`; it has no external route. Declared
loopback ports 55459, 55027 and 55028 are unique, but Docker Desktop may not
publish ports on internal networks. The recorder runs in a separate driver container via `compose exec`, so it survives a web-process exit. Process events are also synchronously journaled to the shared artifact volume.
The driver rejects any additional network, a non-internal network, privileged
container or added capabilities before recording. No cloud tooling is used.

Build before starting: a sealed container cannot download dependencies. The build command creates all four p027 images using the existing test compose targets. This run reused matching locally available static/OIDC images under p027 tags; their image content IDs are recorded. OIDC TLS
certificates are generated inside the isolated simulator, with a disposable
named volume mounted read-only into the web server as its CA trust. Nothing
installs a CA into the host or modifies `test.env`. Participant signing keys
exist only in the web process's memory. `down -v` removes only the p027 stack.

`seed` refuses any database name except `p027`. It truncates the disposable DB,
resets sequences and inserts generated users, a conversation, comments, a report,
OIDC mappings and the zid=0 reservation sentinel. The server restarts between
record and replay to clear its per-process caches; DynamoDB restarts into its
empty in-memory state. The corpus content hash must match before replay. The OIDC Faker seed makes generated subject mappings stable across a full teardown/rebuild.
The OIDC simulator's users and password grant come from the existing test
fixtures. Owner is `test.user.0`, admin is `admin`, and participant is an actual
locally signed conversation-scoped anonymous token. This does not cover all JWT
variants, scopes, expiries or signature failures.

## Format and comparison

`artifacts/` is ignored by git. Each recording directory contains:

* `manifest.json`: version, ordered input digest, inventory digest and original
  inventory digest, app commit **and dirty source hash**, migration digest,
  actual catalog hash, corpus hash, seed, scope and normalization hashes, image
  content IDs, sealed topology attestation, case count and blocking failures.
* `cases.jsonl`: one versioned case per line, validated against `schema.json`.
  Request: method/path/query/header subset/body, with `$auth:role` substitutions.
  Response: completed/status/header subset/body/TTFB/TTLB. Effects: per-table
  row-multiset additions/removals, per-file content-hash changes, attempted
  outbound calls, participant-created and JWT-issued booleans (successful JWT signing is counted independently of whether a token reached the response). Process events,
  runtime route hits and oracle verdicts are first-class fields.
* `routes.json`, `schema.json`, `boot.json`, `normalization.json`: runtime census,
  exact column catalog, import effects, and the applied normalization map.
* `results.json`, `report.md`: route × auth × case results and first differing
  field. Replay writes a sibling `<recording>-replay` directory.

Object keys are canonicalized; response array order and row multiplicity remain
significant. Database table snapshots use a repeatable-read transaction and
include every public base table, not only tables inferred by static analysis.
Dynamo snapshots page through ListTables and Scan with consistent reads. Row
updates appear as remove+add. Files are tracked by path and SHA-256. The scanner
covers the server working tree, excluding immutable dependencies/build outputs,
the mounted source mirror and harness artifacts. Writes outside that tree are
not currently observed and block admission of file-producing routes.

Normalization is code, never a hand-edited transcript: `normalize.cjs` lists
exact timestamp field names and capability/ID namespaces. Known generated
fixture IDs remain literal; newly minted capabilities bind in encounter order.
JWT claims and TTL are compared, with ephemeral signatures removed. The two explicitly named PCA fields (`pca.asJSON` and `pca.asBufferOfGzippedJson`) are decoded before applying the same clock rules; malformed/truncated gzip fails. PCA cache expiration is an explicitly normalized clock value, not a certified cache-duration assertion. Clock values
retain type, sentinel and fractional precision. TTFB/TTLB are recorded but only
the completion deadline is asserted, not exact latency. Other response fields,
vote signs, counts, namespaces, array order, nulls and missing keys compare
exactly. This normalization is **not a redaction mechanism**. Arbitrary timestamps
embedded in HTML/CSV, IDs embedded in text, unclassified random strings and
cross-field aliases require explicit additional rules and currently fail closed
as differences. Capability IDs embedded in typed URL path segments reuse the same bindings as their sibling ID fields. No generic deep-JSON tolerance is allowed.

## Readiness, census and coverage

`appReady` is the actual helper/route-registration promise, and `moderationReady`
is the prompt-read promise. The driver waits for both, with CWD `/app` (the image's
server directory). The observer wraps registration calls before importing the
application, attaches registration identity to the real `app.routes` objects,
and records dispatch hits before route middleware. It does not inspect an
Express 4 router stack. `app.all` groups must each contain all 35 distinct method
entries; identical path strings do not collapse distinct registrations.

The checked-in P-025 inventory contains 201 source registrations, **200 enabled**.
Runtime therefore has **302** entries: 197 ordinary + 3×35. The disabled 404 branch
is an explicit exclusion and must remain absent. Ordered method/path/index
comparison must match all 200 enabled registrations. Added, deleted, reordered
or partially fanned-out routes fail before a request is replayed. This corrects
the review's 303 count, which included the disabled registration.

`scope.json` enumerates 72 exclusions individually, with their method/path and
reason. These are static/page/proxy registrations plus the disabled branch.
The implicit-conversation `/polis_site_id…` route is included because it can write.
The remaining 129 registrations comprise 127 directly driven routes and two
API ALL middleware registrations witnessed by the same requests. OPTIONS is explicitly driven for all four auth roles, in addition to middleware dispatch coverage. Every directly
driven route has unauthenticated, participant, owner and admin cases. Dispatch
coverage means the registration was entered; a 400 does not prove successful
handler coverage. Missing routes/auth modes and incomplete cases block.

The unmatched `/api/v3/p027-unmatched` GET has a separate mandatory oracle:
record its actual proxied HTML and flag it. It must never be silently changed to
404. The actual static image is pinned in the manifest.

## Effects, process and determinism

Requests and routes are serialized in inventory order. Per-route generators use
SHA-256 of the corpus seed, route and auth role. `/begin?seed=...` resets a portable xorshift32 Math.random stream before every case; cryptographic randomness is untouched. The real OIDC simulator’s Faker identity generator is seeded separately so a complete stack rebuild preserves generated subjects. Fixture creation timestamps are distinct, avoiding unspecified ordering ties. No second case may execute while
one is active. Each response has a 2-second completion deadline, including body
completion; a healthy process with a hanging request is a failure. After the
response, wait 200 ms for the known 100 ms post-response writes, then require two
identical database snapshots separated by 100 ms, bounded by eight attempts.
Queue consumers are paused; enqueued rows remain observable effects. Quiescence
is bounded evidence, not proof that no later timer exists.

Both process events and matching process-error log lines are recorded. Any
unhandledRejection or uncaughtException fails the case even if HTTP answered.
The swallowed `23505` behavior remains blocking: the proposed
APPROVED_DIFFERENCE has **no named approver yet**, so this implementation does not
invent approval or waive it.

Concurrency cases must use a declared barrier schedule and seed, record the
actual release/arrival trace, and compare a finite predeclared set of acceptable
interleavings. This v1 executes only the serial schedule. Concurrent creation,
reordering, and retries across process death are not certified; adding arbitrary
parallel requests without those barriers is prohibited. Full migration admission
must stay blocked until those scenarios are implemented.

Notification polling now starts explicitly from `server/index.ts`, preserving
normal web-entrypoint behavior while making route imports inert with respect to
that loop. Ordinary recording asserts the loop is stopped. Akismet import-time
attempts are recorded and blocked. Pre-import HTTP/TCP guards reject destinations
outside the local service allowlist; Docker routing independently blocks egress.
The live email negative control explicitly starts the real notification loop
with `DEV_MODE=false` and generated subscribed rows, configures the real AWS SES
v2 endpoint, and requires both a SendEmailCommand and a blocked transport attempt.
It never permits external email delivery. SDK command inputs are recorded for
SES v2, S3, SQS, DynamoDB and CloudWatch Logs; other HTTP clients record method/host/path and request bodies when they use Node HTTP. Raw non-HTTP/fetch transports still require an additional payload adapter before provider effects can be certified.

The import worker (`src/workers/start-import-worker.ts`) is a **second process on
the same server image**, not part of this web process. It must remain available
until separately characterized, including intentional vote inversion and its
hardcoded math_env. PG worker_tasks, notification_tasks, byod_import_jobs/SQS and
Dynamo Delphi_JobQueue are separate producer/consumer contracts. A route recording
can certify enqueue behavior only; it cannot certify absent consumers.

## Negative controls and admission

Keep the original mutation specification verbatim:

> Delete a recording, change auth result, flip vote, swap report/job namespace, remove page two, duplicate an external effect, alter only comments/config/runtime, and truncate a stream: each must turn its designated gate red.

Unit controls exercise these fields and route/case deletion; live controls change
one recorded response field, one DB effect, remove a real Express route, force a hang, unhandled rejection and fatal exception, enable
the real email loop, and attempt an unobserved raw TCP connection. A response or
effect mutation must exit 1 with a semantic diff, not merely a bad file checksum.
The controls keep complete input manifests and stop live replay at the first
observed difference. Process/completion defect recordings stay red even when
the same defect reproduces. Matching failure is never PASS.

For a Rust candidate set `P027_BASE_URL` and `P027_CONTROL_URL` on the driver and
provide the same observer protocol (`/ready`, `/state`, `/tokens`, `/begin?seed=…`) from an isolated
adapter. `/ready` supplies declared registration identity and route inventory;
`/state` supplies append-only process/outbound/hit ledgers and files. The DB and
external provider fakes must start from the pinned corpus. Tokens are generated
outside the candidate but verified by it normally. The included host wrapper
currently provisions Node only; a Rust adapter is not included.

## Build-time pseudonymization hook

`pseudonymize.py` is a generated-JSON-only skeleton. Production integration must
run once **before the server starts** inside an isolated clone-builder. Extract
all catalog columns, including empty tables, generate an unreviewed policy with
`skeleton()`, and require a reviewed action/reason for every column. Unknown
columns, omitted row fields, unreviewed policy entries and unsupported Unicode
shapes are hard errors. No real database access is implemented or authorized. `catalog.json` pins the generated stack catalog; `column-policy.skeleton.json` lists every column as REVIEW, deliberately blocking prodclone admission.

Policy requirements: share identity namespaces across primary/foreign references;
use a fresh 256-bit HMAC key per corpus; replace emails with example.invalid
addresses; mint new conversation/report/invite capabilities; replace free text
while preserving length, Unicode class, supported script and language tags;
preserve vote values/signs, geometry/counts/ticks and timestamp precision.
Complex JSON, URL, binary and free-text columns require explicit recursive
policies, not a blanket preserve. Integer identity remapping and a complete Polis
column policy remain production-integration work; the skeleton cannot admit a
prodclone. Unsalted hashing and regex-shaped transcript redaction are forbidden.

The map is memory-only, cleared after transformation; the mutable key is zeroed.
Python cannot guarantee erasure of allocator copies, so the production builder
must destroy its enclave/process and encrypted scratch volume, disallow memory
snapshots, then publish only the safe corpus + policy/catalog/content hashes.
Rotate keys for every published corpus. The recorder must validate that the live
catalog matches the approved policy before any DB delta can be emitted. Tests
exercise this contract exclusively with generated data.
