# P-027 API characterization

The current public-fixture reference was recorded for #2753 at
`58d95a60375a7f6f31ff88af1245680af5a69fec`. Recording and a fresh full replay
each completed **1,265 cases with zero differences and zero oracle failures**,
including all 869 prior requests and 396 comments requests. All **3,873 P-025
records** validate. Baseline SHA-256:
`961b3c0703758bd61ef25262a3b939e65091e271c9c5cacd47477cce67814b8b`.

Against the round-7 reference (`e9fcf5cf73ba5008f3e7a8af6a568942b99c2bd4a684a80a58687d09922b5c1b`),
all 1,265 request artifacts are byte-identical and all comparable outcomes match.
The census retains 302 entries and identical middleware; the sole changed
callback fingerprint is `handle_POST_topicMod_moderate`, attributed to #2753.

**The standing r19/r20 ordering issue remains open.** Round 7's fresh replay had
two order-only differences; this replay happened to match both complete response
bodies. Those queries still lack `ORDER BY`. This observation does not retire the
earlier residuals or waive exact-order comparison. Reference refresh and full
migration admission remain separate decisions.

**340/1,265 bodies are the identical opaque "Bad Request" string (HTTP 400,
trailing newline); case counts are not distinct response shapes.** Of 128 targeted
registrations, 30 have a 2xx and 98 have none. There are 19 DB-effect cases, two
participant creations and two verified client-visible JWTs. Status totals include
384 HTTP 400s and six HTTP 500s. Dispatch remains 129/201 with 72 exclusions.
The legacy four-label invariance diagnostic reports 52 registrations; it is not
a six-actor authorization/effect equivalence claim.

The retained general/PCA2 corpus uses anonymous, participant, owner and
admin(=moderator) labels; its moderator token aliases uid 2. The comments profile
adds six actor classes: anonymous, bound participant, owner, distinct site-sharing
moderator (uid 200004), foreign owner and admin (uid 2). Owner replicas use three
different generated identities. Parsed uid/pid/mode context is captured and replayed.
The 396 comments requests establish 96 three-fixture cells, 102 dispatch witnesses
and six identity witnesses; all add zero recorded writes/provider/JWT-issuance effects.
The plan test pins the governing notes plan and also compares its current file when
available; set P027_NOTES_ROOT to require that external-checkout comparison explicitly.

The 336 PCA2 requests cover 112 cells with three independent fixtures each,
using 60 conversations and 4,450 public fixture votes. They add no DB, filesystem,
JWT-issuance or provider effects. Populated data comes from 36 real Python-engine
conversations (72 writer publications); 12 are scoped only to a different math_env.
The original three temporary generator workarounds remain: P-029/r11 invalid UUID,
P-029/r88 empty UPDATE, and P-029/r102 NULL conversation on report creation. Their
nominal diagnostic variants remain. No API replacement is authorized; Rust/client,
concurrency, consumer and production-shaped-data gates remain separate.

The baseline uses production-compact serialization: NODE_ENV and Express env are
production; json spaces/replacer are unset (recorded as null), ETag is weak, and
development-only error details are absent. Finalhandler also replaces internal
error messages with standard HTTP status text under production (331 cases).
Each case manifest pins settings.json;
run.json and index metadata repeat and cross-check the effective settings and Node
version. DEV_MODE=true separately retains generated auth/domain fixtures, request
logging and stopped notifications; this is a production serialization profile,
not a claim that all development-only application branches model production.
The harness entrypoint does not import index.ts's production dd-trace bootstrap.
Express compress() uses its installed defaults, with coding/Vary and exact gzip
bytes recorded; legacy cases send no Accept-Encoding, while the new subset
cases explicitly exercise gzip negotiation. PCA's explicit full-mode gzip remains.
AWS_ENDPOINT_URL_SQS resolves to a closed local server:4566 endpoint even under
production (runtime.test.cjs probes the actual SDK resolver without transport).
No SQS emulator/success coverage is claimed; any real SQS attempt still fails
ordinary admission. No egress exception was added.

## Isolated operation

Use three unused host ports and a fresh random project suffix. The shared host/
seed guard defaults to 55930–55939; set P027_PORT_MIN/MAX together to use your
assigned window. The project must stay in the p027 namespace:

```sh
export COMPOSE_PROJECT_NAME=p027-review-$(openssl rand -hex 4)
export P027_PORT_MIN=55930 P027_PORT_MAX=55939
export POLIS_RECOVERY_PG_PORT=55930 P027_HTTP_PORT=55931 P027_CONTROL_PORT=55932
python3 server/characterization/run.py record recording
python3 server/characterization/run.py down
python3 server/characterization/run.py replay recording
python3 server/characterization/run.py test
# Equivalent inside the running sealed server (includes both live runtime tests):
docker compose -f server/characterization/compose.yml exec -T server node --test characterization/test.cjs characterization/corrections.test.cjs characterization/recorded.test.cjs characterization/round2.test.cjs characterization/pca2.test.cjs characterization/runtime.test.cjs
python3 -m unittest discover -s server/characterization -p 'test_*.py'
python3 server/characterization/run.py down
```

Check that the example ports are available before use. The runner requires explicit
project and port settings, checks network ownership, rejects privileged/cap-add
containers and tears down only that project. `BUILDX_CONFIG` defaults to a directory
named for the project. Existing p027 images are reused read-only; source is mounted
from this checkout. The six services use one Docker internal network. No cloud
access, host CA installation or edits to another checkout's test.env are needed.

Ordinary recording has `P027_NEGATIVE_CONTROLS=0`. Only explicit negative runs arm
the sabotage endpoints. The pinned run configuration records the effective flag;
ordinary admission rejects an armed corpus. `P027_MARKERS=0` allows marker parity
replay, suppressing only instrumentation hits from semantic comparison.

`seed` accepts only the disposable database named p027. It resets SQL identities,
generated actors and capabilities, approved comments, and OIDC subject mappings.
Six generated narrative rows force real DynamoDB pagination beyond 1 MiB and a
multi-chunk HTTP response. No external provider is called. Ordinary notification
polling remains stopped. Only the exact blocked Akismet verify-key boot control is
exempt from attempted-egress admission; any other forbidden attempt fails even
when the network blocks it.

## PCA2 round-4 slice

The boundary profile appends 336 PCA2 requests: 112 auth/scenario/environment/tick/
media/coding/mode cells, each with two independent derivation fixtures and one
held-out fixture. The `pca2` profile generates exactly this slice, so it can be
recorded and replayed independently while retaining strict required-inventory
admission. Global coverage gaps remain visible for that scoped profile.

`pca2-fixtures.json` declares 60 independent public fixture conversations. Each has
its own seeded votes and distinct input hash. Public fixture user site IDs are explicit;
the random database default is never used by this seed. `seed-pca2.py` reads the SQL votes
and moderation, runs the actual Python Conversation engine, and uses MathWriter
for two publications (ticks 0 then 1). There are 36 populated conversations,
including 12 published only under `p027-other`; the server remains pinned to
`MATH_ENV=p027`. No math blob is hand-crafted. Twelve zero-approved fixtures have
votes but all comments unmoderated. Twelve not-ready fixtures have no math rows
and are queried cold before their warm-cache controls.

The temporary `math-seed` Compose profile runs the existing local
`p011-delphi-test:latest` image on the same sealed network, then removes its
container. `run.py build` does not build this prerequisite image: a clean machine
must obtain it from the reviewed local Delphi build first; recording cannot yet
be described as clone-and-record. Its entrypoint directly invokes the seed script; it does not start the
image's normal jobs/providers. The image ID, Python/library versions, engine
source digest, input/row witnesses and credential-safe JWT binding assertions are
pinned. Published host ports may be unavailable on Docker's internal network;
seeding and requests use service names inside that network.

Anonymous, participant JWT, owner and moderator cells each have three independent
fixtures. Moderator uses the configured uid-2 global admin credential; r5 has no
auth middleware. Valid foreign capabilities therefore return 200; malformed and
missing capabilities return 400. Participant requests use individually verified,
conversation-bound JWTs; the cross-capability request intentionally uses another
conversation's token. Credential values never enter recordings.

Conditional coverage includes ETag equality/older/newer, weak prefixes, lists,
wildcard and conflicting math_tick/header inputs. Express turns wildcard freshness
into 304 while retaining Content-Encoding gzip: the body is empty. Cold and warm
math-not-ready are distinct scenarios. The route never sends its commented-out 404. Keys coverage includes reverse order, duplicates, unknown/prototype/integer
names, empty string (subset), JSON array and empty array (full), and both large
(gzip) and small (identity) subsets requesting gzip. GET JSON bodies carry their
actual Content-Length.

```sh
P027_ONLY="$(node server/characterization/pca2-cases.cjs)" python3 server/characterization/run.py record p032-slice1 pca2
node server/characterization/pca2-audit.cjs server/characterization/artifacts/p032-slice1
python3 server/characterization/run.py down
python3 server/characterization/run.py replay p032-slice1 pca2
python3 server/characterization/run.py down
```

The audit validates all P-025 records, every new cell's independent-fixture floor,
wire-derived subset order, ETags, coding, and zero writes/provider effects.
Populated decoded schema review, Rust replay and client validation remain separate
admission gates; a successful Node replay does not authorize route replacement.

## P-025 artifacts and comparison

`P-025-recording.schema.json` is an unchanged copy of the governing Draft-07 schema.
Ajv validates every manifest, request, response, effect, external and process record
on writing and reading. The superseded bespoke schemas have been removed.

Each case directory contains `manifest.json`, `request.json`, `response.json`,
`effects.jsonl`, `external.jsonl`, `process.jsonl`, and `comparison.json`. Empty
JSONL files are present. `index.json` pins the exact bytes and lengths of every case
manifest, plus boot/routes/database-schema/normalization/run/generated-policy and
recording-schema files. Manifests pin every case artifact. Reader admission checks
schema, bytes, lengths, references, counts, identities and the generated required
scenario inventory. Deleting a case and regenerating a smaller index still fails.
Only `artifacts/baseline.json.gz` and `artifacts/baseline.sha256` are unignored;
recordings, replay outputs and diagnostics remain ignored. The trusted baseline archive is pinned separately; a regenerated index alone is
not a trusted replacement baseline.

Requests retain target bytes, ordered headers and chunks. Responses retain ordered
repeated headers and chunks, terminal reason, process survival, and bounded first/
last-byte timings. Raw gzip is retained and decoded for field-level comparison.
Credential bytes are replaced only after local signature/claim/expiry/binding
verification. JWT signing calls and client-visible verified tokens have separate
integer counts. Participant effects retain row identities and counts.

`comparison.json` is a named normalized projection, not a seventh P-025 record.
Object-key order and JSON whitespace are checked by the separate wire comparator. Response
array order, vote sign, count/multiplicity, namespaces, cookies and DB timestamps
are significant. Server Date and disposable SQL now_as_millis use the declared generated instant
1700000000000; native timers and driver deadlines remain real. Only named
server-minted response clocks are normalized, including
PCA lastVoteTimestamp/lastModTimestamp. Date/connection/keep-alive and transport chunk boundaries are excluded from
equality; their raw evidence stays pinned. Concatenated response bytes compare
exactly, including gzip, with only typed capability and bound URL substitutions
applied lexically, without JSON reserialization. Content-Length and ETag compare
exactly; for capability substitutions their original byte derivation must verify
before comparing the corresponding derived normalized header. Seeded clocks and
randomN remain exact in wire equality; this introduces no new random masking.
JWT values are verified before replacement with a deterministic claims-digest
symbol; surrounding JSON bytes are preserved. Original Content-Length and weak
ETag are verified before substitution and retained as a pinned recorder assertion;
replay compares the derived headers for the credential-safe bytes. Cookie behavior is uncharacterized: zero admitted responses
issue Set-Cookie. The fail-closed cookie unit policy alone is not live evidence. Truncation still fails body/completion comparison.
Required response timings stay in hashed artifacts and are checked against bounds;
independent recordings need not have the same raw hash.

The runtime route census observes all 302 Express 3 entries and preserves ALL
origin IDs. Normalized tuples include path kind/source, regex flags, enabled
condition and ordered callback fingerprints. Global middleware installation order
is also recorded and compared before replay.

Replay diagnostics visit semantic response body fields first, then effects/process and
other response evidence. When the body differs, verified Content-Length/ETag
derivations are reported as consequences of that body difference; header-only
regressions still fail. Generated reports and coverage-stats.json include opaque-400
counts for each targeted registration.

## Completion, ownership and scope

The 200 ms initial settle window is followed by matching snapshots **and** a named
`request-effects-drained` barrier. Async ownership tracks timers, filesystem work,
DB calls and provider operations through request continuations. Pending work or
unclassified late work yields INCONCLUSIVE and stops the run. Runtime disposal exceptions are limited to Node TLS `onSocketCloseDestroySSL`,
Node HTTP `resOnFinish` keep-alive expiry and pg-pool idle-client removal.
Application timers, including unref timers, remain pending work. A delayed-write control beyond the former stable pair
proves that a response and two equal snapshots alone cannot close a case.

The response/process oracle also catches live hangs and swallowed process errors.
The 23505 behavior has no named approver and remains blocking. Serial request order
is declared; no claim of controlled concurrent interleavings is made. Snapshot row
deltas capture committed net state, not a transaction-by-transaction audit. Workers,
math/Delphi consumers, unobserved filesystem locations and non-HTTP transports need
additional adapters before their routes can become migration gates.

`column-policy.skeleton.json` and pseudonymization tests remain a fail-closed
production-clone skeleton. The recording's generated-column policy applies only to
the fixture built here and never admits imported production data.

## Mutation evidence

> Delete a recording, change auth result, flip vote, swap report/job namespace, remove page two, duplicate an external effect, alter only comments/config/runtime, and truncate a stream: each must turn its designated gate red.

`recorded.test.cjs` binds these controls to named recorded cases, checks each
precondition, explicitly repins test-only semantic mutants, and requires a named
case/field difference. Integrity mutations separately delete or alter each required
artifact. `corrections.test.cjs` covers JWT corruption/wrong binding/extra issuance,
delayed work, blocked attempts and the actual PCA serializer's C7 failure class.
The original small public fixture differ examples are labelled unit examples, not
recorded migration gates. The historical eight live controls comprise six failure
detectors and two successful egress-block assertions.

## Repacking and runtime checks

After a reviewed full recording, `node server/characterization/baseline.cjs pack
server/characterization/artifacts/recording` packs only manifest/index-referenced
files in sorted order and updates baseline.sha256. It uses UTF-8 JSON, gzip level
9/windowBits 15/memLevel 8/default strategy, zero mtime, no filename and OS byte 3.
`round2.test.cjs` unpacks and repacks twice to the committed digest. Do not repin
merely to make a failing replay pass. `run.json.harnessHash` (also carried in
the index metadata) identifies the harness that produced the recording; it is not
a digest of the current checkout and is not a replay compatibility check. Harness
maintenance alone does not change historical run.json or the archive pin.

Inside the running isolated stack, run `docker compose -f
server/characterization/compose.yml exec -T driver node --test
characterization/runtime.test.cjs`. This checks all three barrier exemptions
against actual TLS/HTTP/pg-pool resources and verifies the SQS endpoint override.
Replay rejects a changed Node version or exemption inventory. The standard npm
lint commands now include .ts, .js and .cjs explicitly.

P-032 C4's recording prerequisite and C5's observed full/subset key orders are
addressed here. Broader JS numeric-boundary cases, randomN portability policy and C6's
fail-closed classifier for unknown embedded encodings remain typed-contract work.
The existing two admitted PCA codec paths are enumerated in normalization.json;
round2.test.cjs verifies all five participationInit PCA cases agree across POJO,
JSON-string and gzipped Buffer representations, before and after normalization.

## Comments round-6 recording profile

`comments-plan.json` is the exact revision-2 P-032 inventory: 396 requests =
96 three-fixture cells (288) + 102 dispatch witnesses + 6 identity witnesses.
`comments-read` selects those requests; `round6` retains all 869 prior requests
and appends them, for 1,265 requests. Both profiles use checked inventory admission.

`comments-cases.cjs` and `seed-comments.cjs` generate 71 independent conversations,
9,452 comment rows and 9,452 votes. Shape/coding replicas are shared across the six
actors, but each cell uses three different conversations, owners and input digests
(two derivation, one held out). Empty conversations intentionally have no votes.
Three owner credentials are distinct; the separate site-sharing moderator is uid
200004, foreign owner uid 4, and global admin uid 2. They are public fixture SQL
identities mapped to real local OIDC simulator tokens. Bound participant JWTs
exercise pid zero and nonzero in separate cells. An expired token is locally
signed, signature/binding-verified at its historical clock, and then sent expired;
the cross-conversation witness deliberately sends a valid token for another fixture.
Credential bytes and signing keys are never persisted.

Ordinary comments are produced by the real application SQL and projection, with
no fabricated response JSON or changes to the public route. The harness records
selected parsed request-context fields after completion to distinguish actual uid,
pid and mode outcomes. `comments-audit.cjs` checks exact inventory, the P-025 records,
fixture independence, input visibility predicates/counts, ordinary item order,
created-as-string, CORS/Vary and four size/negotiation coding profiles. The tied-created
fixture changes insertion order; replay compares the resulting arrays exactly.
The non-moderation projection excludes zid, so addConversationIds cannot add a
conversation_id in ordinary or paginated non-moderation mode. Moderation=true is a
separate witness and may add it. Witnesses describe existing Node behavior; this
harness contains no Rust dispatch implementation or authorization for routing.

```sh
# Use a fresh project and assigned 55950–55959 ports as in Isolated operation.
python3 server/characterization/run.py record round6 round6
python3 server/characterization/run.py down
python3 server/characterization/run.py replay round6 round6
node server/characterization/comments-audit.cjs server/characterization/artifacts/round6
node server/characterization/pca2-audit.cjs server/characterization/artifacts/round6
node server/characterization/baseline.cjs pack server/characterization/artifacts/round6
python3 server/characterization/run.py test
python3 server/characterization/run.py down
```

The six-file Node command remains the runner/README source of truth; round 6 adds
two comments tests within the existing pca2.test.cjs file. The round-5 maintenance
alone passed 80/80 before this expansion. Host audit commands require the existing
server Node dependencies (or run their equivalents inside the sealed driver).

## Dispatchable corpus re-record

The **Characterization corpus re-record** Actions workflow accepts `target`, a
full 40-character commit SHA in this repository (short hashes are not supported).
Empty means the immutable SHA of the dispatching ref. The workflow must first be
present on the default branch for dispatch to be available. It keeps its dispatch tools separate from the resolved target checkout,
uses read-only repository permissions, and persists no checkout credentials.
It does not create or merge a PR.

The job builds the test images explicitly on an ephemeral `ubuntu-24.04` runner,
including the CPU Delphi `final` image used only by `math-seed`. It builds the
repository's Postgres, server, file-server and OIDC images, then starts the existing
six-service internal-network topology. Build-time package downloads precede sealed
execution. No EC2 worker, production data, provider job or cloud credentials are
needed. Sequential builds limit peak resource use; the build log records image
sizes and available disk. The public runner has 4 CPUs, 16 GB RAM and 14 GB SSD
([GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
A hosted cold-build capacity measurement is still required; local image reuse is
not evidence that the whole build fits that disk budget.

`ci/p027_rerecord.sh` runs the complete `round6` profile, verifies and retains the
committed archive, and writes `artifacts/rerecord-job/`. It records, computes the
offline old/new accounting, packs the candidate, verifies an exact unpack/repack,
destroys the owned stack, then replays the candidate on a fresh stack. Node and
Python characterization tests and all eight live negative controls follow even
when replay reports differences. r19/r20 remain exact-order-sensitive: either
residual makes the job red. No difference is waived by this automation.

The upload retains the old/new archives and SHA files, accounting, replay results
and comparisons, repack receipt, per-stage logs/exit codes and final summary for
14 days, including failed runs. Ordinary failures stop before packing a partial
recording. Teardown runs on failure/cancellation, only for the unique `p027` project.
The script restores the original tracked archive and SHA file on exit; the new
candidate lives only in the artifact. Reviewers apply its two candidate files
explicitly after reviewing the evidence.

`rerecord-accounting.cjs` reads both P-025 recordings with integrity and inventory
admission (the historical reader is loaded from its recorded commit, preserving
its own required inventory). Cases are keyed by identity, with independent
unchanged/changed/added/removed counts, serial-order and exact request-artifact
checks. The served comparator is `compare.cjs::firstDifference`; checker changes
are reported and prevent automatic eligibility. Shared-file hashes remain visible.
Before self-tests, the workflow verifies the archive digest and agreement of its
source/run pins, then fetches that exact object from origin. Fetch failure is
fatal; no historical reader is substituted. The archive's source commit must be
an ancestor of target HEAD, or a nonempty single-parent commit with exactly one
`git patch-id --stable` equivalent on the target's complete first-parent history
(merge commits are not candidates). Missing, empty, ambiguous or shallow history
refuses resolution. `baseResolution` in accounting and summary records the original
pin, resolved commit, method and patch ID; ancestral pins retain their identity.

Patch identity proves a changeset, not the whole recorded source tree. Historical
admission, old callback fingerprints and checker-file diffs still use the original
pin. Only ancestry and attribution traversal use the resolved commit. A callback
whose recorded hash differs at that history anchor remains unattributed; rebase
context or whitespace differences cannot silently disappear through the mapping.

The census preserves registration/verb identities, ordered callbacks and global
middleware. A changed callback is attributed only when both runtime hashes match
one named function in the old and new TypeScript output. Its parent/commit hash
transitions are listed from Git history, without executing historical application
code. Anonymous/dependency wrappers, ambiguous function identities and unavailable
history remain explicitly unattributed. Commit subjects alone never justify a
fingerprint. `reviewEligible` requires unchanged cases and requests, unchanged
route structure/middleware/runtime, attributed callback changes, unchanged
checkers and shared fixtures/schema, and all live checks passing. New fixtures or
schema still produce an artifact for review; their presence makes the job red. It is a review convenience, not API migration admission.

For a local check with already reviewed images, use fresh ports/project per the
isolation section and `bash ci/p027_rerecord.sh --reuse-images`. The optional
`P027_POSTGRES_IMAGE` selects a uniquely named local test image without retagging
another agent's shared image. The fresh-image builder deliberately refuses to run
outside an ephemeral GitHub-hosted runner because its historical tags are shared.
Do not reuse an existing `rerecord-job` directory.

The former recording catalog described 423 columns and no `polis_queue` tables.
A fresh database with migration `000019` exposed 71 additional columns in six
queue/provenance tables. The catalog now includes those columns; all 423 existing
entries are unchanged. The shared historical Postgres image omitted that migration
and masked the incompatibility. The hosted job therefore always builds Postgres
from the target's migrations; it never reuses a historical database image or
regenerates the catalog automatically. Any future schema mismatch still requires
an explicit catalog review before recording.
