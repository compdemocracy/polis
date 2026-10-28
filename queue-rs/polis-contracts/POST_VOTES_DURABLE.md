# Admitted participant votes: durable acceptance

`post-votes-durable/1` is an intentional difference from `post-votes/1`.
`post_votes::Response` continues to decode the recorded Node contract unchanged;
`post_votes::DurableSuccess` decodes the Rust acceptance body. The writer is off
by default (`POLIS_API_POST_VOTES` must equal `1`), with no nginx selection.
It admits only verified, conversation-bound, existing memberships. It does not
create users, participants, XID mappings or tokens. Unsupported identity, bare
XID, cookies, first contact, topical selection and translation remain Node work,
classified before any write. No new `auth` field is issued by this slice.

## HTTP 200 receipt

Required fields, in serialization order after optional `nextComment`:

- `currentPid`: the admitted participant number (including zero).
- `vote`: `{ "tid": integer, "vote": wireInteger, "created": integer,
  "replayed": boolean }`. `vote` uses the shared wire convention; `created`
  is the stored vote timestamp, or latest `modified` on a repeat.
- `followOn`: `{ "star": state, "nextComment": state,
  "notifications": notificationState }`.

`state` is `absent`, `complete` or `degraded`. Star is absent when not supplied;
nextComment is absent when selection successfully finds nothing. A failed,
timed-out or unconfirmed follow-on is degraded. `nextComment` is included only
when its state is complete, with the existing ordinary selection shape and raw
field order, otherwise omitted (never null). If star fails, nextComment is
omitted and degraded because it was not attempted. An overall deadline after
commit acknowledgement conservatively marks requested star and nextComment
degraded even if detached work subsequently completes.

Notifications are `best_effort` once scheduling succeeds, or `degraded` on
known admission overflow. Best effort is not a delivery promise: later SQL,
acquisition or process failures cannot rewrite a sent body. The separate bounded
lane reports these drops in health/log counters. No response claims that a
notification, suppression update or exhausted-statements event is durable.

Once SQL acknowledges the vote commit, every normal response path is HTTP 200,
including star failure, nextComment failure, dispatch timeout, task failure and
optional-body encoding failure. The receipt is published before follow-on work.
No follow-on failure rolls back, hands back or automatically retries the vote.
Connection loss or process death can still prevent delivery of any HTTP reply.

## Retry rule

The key is the admitted `(zid, pid, tid)` and the **current semantic choice**.
The handler opens one Rust-managed transaction and serializes on the existing
`votes_latest_unique` key, establishing a provisional row for a missing key. It
locks that row with `SELECT … FOR UPDATE` and compares the convention-encoded
choice in Rust under that lock. No new schema or Postgres function is needed. If
it matches, append no history row and do not update latest timestamp/weight or
historical priority; return `replayed:true`. Otherwise append once and let the
existing INSERT rule replace latest vote/modified, retaining existing weight.
Equal and backdated timestamps do not reorder this rule: the last serialized
choice wins. An append failure rolls the provisional latest row back too.
There is no history scan, recount, new participant lock or conversation lock.

Changing `high_priority` alone is not a new vote: priority is history-only.
An explicit star is still an independent per-request operation, and selection
and best-effort notifications may run again; this rule deduplicates votes only.
A lost-reply retry of the same current choice is safe even after restart or on
another Rust process. A changed choice is a revote. A delayed old choice after
an intervening different choice is also a revote: there is no request nonce or
permanent request receipt to distinguish it. Clients must serialize their own
choice changes and must not retry an older choice after a newer choice.

The row lock serializes with Node's latest-state INSERT rule, but **Node still
appends on every request**. This guarantee applies to Rust admissions; a retry
routed to Node (including rollback or another unselected box) may append again.
A one-box rollout therefore needs sticky assignment for admitted write retries
or an equivalent reviewed routing policy; arbitrary round-robin mixed routing
cannot promise cross-engine deduplication. This is an activation gate, not an
implemented routing change.

## Unknown outcome and pre-commit failures

If the one-second dispatch deadline or a transport/task failure occurs before
commit acknowledgement is available, return HTTP 202 with exactly
`{"acceptance":"unknown","retry":"same_vote"}`. This is not an acceptance
receipt or a rejection; the detached operation may still commit. Retry only the
same choice through the idempotent writer. Never automatically replay to Node.
Database-reported statement rejection before commit retains the existing 406
`polis_err_vote_duplicate` or 500 `polis_err_vote`. Pre-write hand-back is 502
and never follows dispatch. An uncertain connection failure uses 202, not 500.

## Node evidence and rationale

At source `4ca9f6369`, `server/src/routes/votes.ts` commits in `doVotesPost`, then
awaits `addStar` and `getNextComment` in `handle_POST_votes`; its catch maps their
failures to 500 `polis_err_vote`. The original sealed `contract-cases.json`
records `star-failure-after-commit` and `next-failure-after-commit` as 500 after
one history append, and `retry-after-next-failure` as another append. Those
fixtures and the Node decoder stay unchanged. The Rust replay reports those
status/history differences explicitly; successful legacy nextComment bytes
and pre-commit errors still compare with the Node recordings. This avoids
presenting a saved vote as rejected and avoids inflating history on a lost reply.
The Node source and its current behavior are intentionally unchanged.

Pre-dispatch 502 responses carry `X-Polis-Vote-Dispatch: not-started`, including
parser-level chunked/oversized hand-backs. A future write gateway must require
that upstream marker before sending to Node; a proxy-generated 502, timeout or
EOF is not evidence that no vote committed. The read-route fallback template
is unsafe for writes and is not enabled by this change.

The replay's existing-choice `vote-failure` and `duplicate-sqlstate` cases do
not execute an INSERT under the retry rule, so Rust returns 200 despite Node's
injected INSERT error. Separate fresh-key tests still prove 500/406 and complete
rollback. Health also exposes detached `inFlight` and `notificationsInFlight`
counts: a future rollback must drain these before stopping the process.
