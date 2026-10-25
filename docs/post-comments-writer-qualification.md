# Qualifying simultaneous Node and Rust comment writers

Plan only. No Rust writer, gateway rule, deployment authorization or claim of
mixed-writer execution accompanies this document. Baseline Node source:
`19873803fa2b84ddca841a50cfb57009650554de`.

Use disposable generated databases migrated by the real runner, isolated HTTP
processes, distinct application names and connections, and the shared vote
convention modules. Each input has a unique generated text marker. Never mirror
one participant request to both writers as a parity technique. Run Node-only,
Rust-only and alternating Node/Rust phases from independent identical fixtures.
Persist ordered response bytes, auth bindings, raw and latest vote rows, comments,
participants, participant counts, notification tasks, process errors and database
lock observations. Report configuration and source/image hashes with results.

## Admission and durable boundaries

Choose one serving authority before hybrid authentication, since first-use OIDC
can provision an account. Unsupported identities or response branches go wholly
to Node before any mutation. Exercise pid zero, standard users, first-use OIDC,
existing and new XID, request-XID precedence, Treevite existing members/refusals,
owner and site moderator. Verify the response identity against the durable
membership, including cold/warm caches, removed membership and rotated codes.
A signed pid is not by itself a database membership check. Preserve or obtain an
explicit decision on every discrepancy; do not insert stricter eligibility as a
side effect of the port.

Comments commit before the optional author vote. No supplied vote means zero
history and latest-vote rows, including for seeds. Each supplied semantic choice
must produce exactly one history row and one matching latest row under the
configured storage convention, zero weight and false high_priority. Apply both
convention configurations; do not rewrite numbers in assertions. Unknown fields
must not override uid/pid/tid/lang/weight. Check the exact baseline parsing and
response decoder for each identity. Closed conversations reject; duplicate-text
checking precedes the closed check. Strict moderation affects visibility and
notifications; ordinary submissions remain active and unmoderated, while owner
and site-moderator submissions are approved. Only moderators can set is_seed.

Inject a failed author vote after the comment INSERT has committed. Assert one
comment, no vote, the exact 500 body, and 409 on a same-text retry with no new
comment or vote. Separately lose the HTTP response after both writes commit,
kill the writer by its owned PID after commit, and lose a COMMIT acknowledgement.
Assert no automatic gateway retry, no dispatch to the other writer, no invented
success receipt and no missing durable input. Record the ambiguous client result
separately from stored facts. Deliberate new text is a new operation; do not
confuse it with transport retry. A different receipt/atomicity contract requires
a separately approved change, never a baseline refresh.

## Statement allocation and conflicting writes

The shared authority is `tid_auto`, migration 000042: transaction advisory lock
`(873791984,zid)` and MAX(tid)+1. Every writer inserts with NULL tid and reads the
returned value. Keep default READ COMMITTED and the real triggers enabled.

1. Node inserts text A inside an explicitly held transaction. Observe its
   granted transaction advisory lock, then start Rust text B on the same zid.
   Confirm B is waiting on that key with no response. Commit A; B must commit
   with tid A+1. Repeat reversing writers and rolling A back: B must receive
   A's uncommitted number. After either outcome, no lock remains owned by A.
2. Start 12 simultaneous unique-text submissions to one conversation, six per
   writer, through the full HTTP/auth chains. Repeat for existing members and
   concurrent first joins. Every valid input returns 200, each marker exists
   once, assigned tids are distinct and form the contiguous allocated interval,
   every `(zid,pid)` reference exists and each response tid/pid matches its row.
   Do not assume request order equals allocation order. No 409 allocator
   collision, lost comment, deadlock or leaked advisory lock is acceptable.
3. Submit identical text concurrently from both writers. Exactly one comment is
   durable, one request returns 200 and the other 409; an explicit author vote
   belongs only to the winning author. Repeat trimmed duplicate text, distinct
   letter case, closed conversation and strict moderation. Check text-key
   SQLSTATE 23505 independently from tid-key 23505 (which is not text conflict).
4. Hold a tid transaction for conversation A while submitting to conversation B.
   B completes within the participation budget without acquiring A's advisory
   lock. Include imports using the same allocator, with bounded short batches.
   Record row locks as well: different lock keys alone do not prove isolation.
5. Mix comment author votes, direct votes and import latest-state refresh for
   the same participant/comment. History remains append-only. The latest rule
   is last executed insert, not MAX(created); test equal and backdated clocks,
   retained latest weight and changed/repeated choices. Exercise both languages
   in both lock orders. Check full keys and semantic values, not counts alone.
6. Race close/open and moderation with submissions. Record the exact Node
   read-before-write windows, including close between comment and author vote.
   Keep source behavior as evidence; obtain a decision before changing atomicity.
   Verify participant_count equals the allocator's result and that notification
   last_interaction/nsli work cannot reject an already committed submission.
   Do not invent comment_count/vote_count/modified updates absent at this pin.

Participant allocation is a separate shared lock contract. Pin the actually
installed participant trigger, including session-lock release and error-client
discard behavior. Test failed/skipped inserts and duplicate joins with both
writers; require one `(zid,uid)` membership and no retained session lock after
client discard. Do not assume a proposed future allocator migration is installed.

## Participation under slow work

Retain the guards and budgets from
`server/__tests__/integration/participation-under-load.test.ts:1-108` and
`server/__tests__/delphi-results-pg/concurrency.pgtest.ts:1-97` unchanged.
For each Node-only, Rust-only and mixed phase, start 12 participants each issuing
one comment, one vote and one nextComment concurrently. Each must return 200
within 5000 ms; 10000 ms is the unanswered-request cutoff, not a widened pass
budget. Match every submitted marker and semantic vote to durable rows.

Run independently and together: eight parked export requests; twelve report
loads; all general read/write, export, agent-exchange and result pool connections
occupied; unresolved identity-management, translation and topic providers; math
and bounded imports on the same and different conversations. Use database-side
holds on actual statements and confirmed provider waiters, not a fixed sleep.
Sample only after every slow request has reached its hold. No slow request may
hold a participation connection. For long model requests, park exactly
RESULT_SNAPSHOT_POOL_MAX requests after snapshot release, then require checked-out
snapshot connections = 0 and idle-in-transaction snapshots = 0 before calling
nextComment. Its selected tids must equal the quiet baseline. Release holds in
finally blocks and require all owned requests to drain and all connections to
return. The translation fallback's configured timeout is part of the measured
budget; it does not grant permission to widen the participation budget.

The pinned participation suite explicitly labels existing waits with
`test.failing` (`participation-under-load.test.ts:36-43,760-769`). Preserve that
baseline classification and report each expected failure separately: a green
suite containing those cases is not proof that every request met the budget.
Future qualification requires the actual per-request latency and durability
assertions above. The separate comments provider-timeout recording profile has
a 10000 ms observation deadline solely to capture the eventual fallback; it
must never be used to pass this 5000 ms participation gate.

Record request latency and database/provider wait evidence together. Any failed,
rejected or missing vote/comment, starvation, unresolved process error, lock leak,
or unexplained byte/state difference fails qualification. Never skip, quarantine,
reduce participants/parked work, widen timeouts or re-record an unexplained
failure to make the result green. A failed guard is a finding requiring a decision.
