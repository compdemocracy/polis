# POST comments characterization

This profile calls unchanged Node through its real authentication, participant,
parsing, convention and SQL paths. It defines a contract and recordings, not a
Rust writer or migration authorization. Source pin:
`19873803fa2b84ddca841a50cfb57009650554de`.

The main serial profile captures 129 cases. Together with 23 additional
seed/account cases, the disabled-provider case and four concurrent responses,
157 completed responses are preserved in `contract-cases.json` and strictly
decoded/re-encoded by polis-contracts. Each CI replay starts from a fresh fixture.

Standard bearer first join starts with a generated user and no membership; its
repeat must reuse the same pid without another participant. Absent and null text
are separate cases: each returns exact `Bad Request\n` bytes after creating one
participant, without a comment or attached token. Empty text remains a distinct
handler error. The site-recipient case associates the page with both the owner
and an emailed site moderator. Exactly two SDK and HTTP messages must match the
complete templates; the owner appears in both SELECT branches and is deduplicated
by UNION. Existing owner-only cases remain in the matrix.

The `language-timeout` case explicitly declares the separate
`post-comments-provider-timeout/1` observation profile: a 10000 ms sender/oracle
deadline, above Node's unchanged 5000 ms detection budget. This captures the
actual fallback response and its durable effects. It is **not** a participation
latency qualification. The default sender/oracle retains its 2000 ms deadline;
every other case and all participation guards are unchanged. The profile rejects
use on any other case, method or route, or outside the sealed comments harness.
Its metadata is retained and compared in every recording. Completion, process
errors, effect settling and outbound admission remain mandatory.

The earlier default-observer failure remains in
`golden/default-timeout-observation.json`: the HTTP observer aborted before Node's
fallback, while a comment later committed. It is historical evidence, separate
from the approved eventual-response baseline. Comparing the new capture with
the original 125-case corpus found only this declared observation difference;
the other 124 cases were identical under the existing wire/effect comparator.
No serving behavior or expected-differences entry was changed to absorb it.

`concurrent.cjs` records two requests queued behind the actual tid transaction
lock, with both pre-insert reads completed while the first writer is uncommitted.
Unique texts return 200/200 with two rows; identical text returns 200/409 with one
row. Both pairs replayed exactly. Order is established by observed allocator
waiters, not arbitrary delays. No serving SQL or Node handler is replaced.

`control.cjs` injects named SQL failures and controls the Translate SDK boundary,
as the existing comment-stored-first test does. The real detectLanguage parser,
validation, timeout and fallback run. Normal cases use a null-result provider
fixture; success/error/malformed/timeout are separately named. A separate
`COMMENTS_LANGUAGE_DISABLED=1` driver with `POST_COMMENTS_TRANSLATION=false`
server configuration checks the truly disabled branch. No real provider identity,
credentials or provider calls are used; the generated credential document is `{}`.

The SES capture is an HTTP server on the sealed compose network. It cannot
forward mail. Each case declares count, recipient class and exact subject/body
policy before execution. SDK and HTTP payloads must match that policy; the
ordinary outbound assertion handles every other attempt unchanged. Only the
comments profile may connect to comments-ses:8025. Unrelated services, cloud
transports, wrong ports/paths, templates and recipients fail admission. The
emulator retains the received messages as an additional witness.

`run.cjs` retains each response, ordered wire evidence, database effects, process
errors, provider attempts and assertion failures, then continues the matrix.
Failed response delivery is not interpreted as rollback. An injected author-vote
failure yields 500 after one comment commits; the identical-text retry is 409 and
does not repair the missing vote. Every valid vote uses the shared convention
module, including test expectations; there is no default author or seed vote.

Replay uses the existing characterization comparator and verified JWT symbols,
not JSON-body-only equality. Timing, chunk boundaries and standard transport
metadata are excluded under that existing policy. Expected changes use the
existing collective-statement literal expected-differences mechanism (the same
rules as vote-path): one exact case/find/replace, why and explicit ruling, no
unknown case, pending ruling or silent broad mask. The entries file is empty.
No observed difference has been approved or masked.

Use the dedicated compose overlay with a unique project and ports. Seed and
restart Node/DynamoDB before each run and wait for readiness from the sealed
driver. Node source stays mounted from the pinned tree. Commands from the repo:

```sh
node --test characterization/post-comments/admission.test.cjs
node characterization/post-comments/run.cjs /artifacts/comments-record
node characterization/post-comments/concurrent.cjs /artifacts/comments-concurrent
# Fresh seed/restart/readiness before replay:
node characterization/post-comments/run.cjs /artifacts/comments-replay /artifacts/comments-record
node characterization/post-comments/concurrent.cjs /artifacts/comments-concurrent-replay /artifacts/comments-concurrent
```

Run Node commands in the compose driver with working directory /app. Full wire
and effect evidence belongs in the recording artifacts; contract-cases.json is
only the complete response-body codec fixture, not a substitute for that corpus.
The hosted workflow runs `bash server/characterization/post-comments/check.sh`.
The golden guard prevents recording/rule changes together with serving changes;
its existing literal expected-differences mechanism is exercised by the CI entrypoint.
See `docs/post-comments-writer-qualification.md` for the mixed-writer plan.
