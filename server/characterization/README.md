# P-027 API characterization, corrections round 1

This is a generated-data, validation-heavy characterization corpus. Record and fresh-stack replay each completed 533 cases with zero differences and zero oracle failures. Of 128 targeted registrations, 29 have a 2xx and 99 have none; 54 are role-invariant across their recorded scenarios (58 invariant scenario groups / 232 cases). There are 19 DB-effect cases, two participant creations and two verified client-visible JWTs. 339 responses are 400 and six are 500. Dispatch coverage is 129/201 with 72 exclusions. Dispatch of
129 registrations is not 129 successful authorization/effect contracts. The
boundary requests retain three temporary defect workarounds: P-029/r11 (invalid
UUID), P-029/r88 (empty UPDATE), P-029/r102 (NULL conversation on report creation).
The nominal diagnostic generator retains the failing variants. No API replacement
is authorized; concurrency, consumers and production-shaped data remain separate
admission requirements.
The current baseline uses development JSON formatting. Production-format
re-recording and explicit serialization settings remain required before deriving
a production serializer contract (P-032 review C4).

## Isolated operation

Use three unused host ports in 55950–55999 and a fresh random project suffix:

```sh
export COMPOSE_PROJECT_NAME=p027fix-$(openssl rand -hex 4)
export POLIS_RECOVERY_PG_PORT=55970 P027_HTTP_PORT=55971 P027_CONTROL_PORT=55972
python3 server/characterization/run.py record recording
python3 server/characterization/run.py down
python3 server/characterization/run.py replay recording
node --test server/characterization/test.cjs server/characterization/corrections.test.cjs server/characterization/recorded.test.cjs
python3 -m unittest discover -s server/characterization -p 'test_pseudonymize.py'
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
Object-key order and JSON whitespace are intentionally not semantic. Response
array order, vote sign, count/multiplicity, namespaces, cookies and DB timestamps
are significant. Server Date and disposable SQL now_as_millis use the declared generated instant
1700000000000; native timers and driver deadlines remain real. Only named
server-minted response clocks are normalized, including
PCA lastVoteTimestamp/lastModTimestamp. Date/ETag/content-length/connection/keep-alive
headers and transport chunk boundaries are excluded from semantic equality; their
raw evidence stays byte-pinned. Truncation still fails body/completion comparison.
Required response timings stay in hashed artifacts and are checked against bounds;
independent recordings need not have the same raw hash.

The runtime route census observes all 302 Express 3 entries and preserves ALL
origin IDs. Normalized tuples include path kind/source, regex flags, enabled
condition and ordered callback fingerprints. Global middleware installation order
is also recorded and compared before replay.

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
The original small synthetic differ examples are labelled unit examples, not
recorded migration gates. The historical eight live controls comprise six failure
detectors and two successful egress-block assertions.
