# Ordinary comment writer (off by default)

POST `/api/v3/comments` can be handled by the Rust process only when
`POLIS_API_POST_COMMENTS=1` and `SHOULD_USE_TRANSLATION_API=false` are both
explicit. No nginx route selection is added. An unset switch constructs no
writer, reads no signing key and opens no writer or notification connections.
Provider-enabled and unspecified provider settings also construct no writer.

The admitted request is fixed-length JSON of at most 65,536 bytes, with a valid
conversation-scoped anonymous or standard participant bearer token whose uid
and pid match an existing participant in the primary database. The text uses
the shared POST-comments parser (997 UTF-16 units before ASCII-space trimming).
Empty text and NUL text hand back. Optional null vote and false/null seed are
accepted; an actual author vote or true seed flag hands back. Unknown body
fields, query parameters, cookies, encoded bodies, unsupported content types,
malformed parameters and unsupported identities hand back before writes.

The conversation must have no strict moderation, Treevite, XID requirement or
XID allowlist, and the author must not be an administrator or site moderator.
First contact, OIDC provisioning, signed-pid mismatch, missing membership,
provider detection (including timeout fallback), strict-moderation email and
seed/author-vote effects remain with Node. The writer creates no identity and
issues no token. Exact duplicate text returns 409 before the closed-conversation
403 check. Success is exactly `{tid,currentPid}`.

Insertion leaves `tid` null for the existing `tid_auto` trigger, which acquires
its transaction advisory lock and holds it until commit or rollback. It uses
migration `000042_tid_auto_transaction_lock.sql`, already selected by the base
release. There is no migration, private allocator or schema change here. Only
the named text uniqueness constraints map to 409; allocator uniqueness and
other failures remain 500. The existing participant foreign-key error retains
its specific response code.

Admission uses a separate two-connection read-only primary pool. Its acquisition
and statement budgets are 100 ms, with a 250 ms outer admission deadline;
failure there hands back. The four-connection writer has a 100 ms acquisition
budget, a 100 ms lock budget and a 1 s statement budget. Once dispatch starts,
no error returns a hand-back: the request owns a detached completion task,
and the 1 s response deadline returns terminal 500 if completion is unknown.
A client must not infer rollback from that response or retry through Node.
No provider call or report work uses these connections or the tid transaction.
CPU, executor and database I/O still share their host resources.

After successful insertion, notification-task upsert and participant
last-interaction/nsli updates use an independent two-connection pool with
250 ms acquisition and lock budgets and a 1 s statement budget, matching Node. A
semaphore caps active plus pending work at 64 **before** tasks are spawned;
overflow drops softly and increments the drop counter. A permit stays with its
blocking database operation until it ends. Notification errors are best effort,
with bounded acquisition, lock and statement waits; there is no durable retry
queue or shutdown flush. No vote, counter scan, conversation-modified write or
next-statement selection is bundled with a comment.

The database tests exercise admission, duplicate/closed order, allocator locks
through commit/rollback, precise constraint errors, the off switch and bounded
background admission, independent notification session limits and acquisition
waits below and above the notification budget. The retained corpus has 153 serial
responses plus four concurrent responses. Under their recorded provider configurations, the single
disabled-provider response is compared byte-for-byte through the real route
and HTTP serializer, with its recorded Date and test clock; its comment,
notification and participant effects are also compared exactly. The other 156
responses hand back with no database mutation because detection is enabled.
This is route/serializer replay, below TCP framing. Direct TCP tests separately
prove that chunked and oversized bodies hand back immediately and close the
connection without dispatch. The replay does not claim to implement the
provider-enabled cases.

`queue-rs/polis-api/conformance/post-comments-mixed.cjs` runs real Node and Rust
HTTP writers against one generated conversation: both first-writer orders,
unique and duplicate text, observed allocator waiters, and a 24-request burst.
It also compares both background effects under row locks released after 150 ms
and verifies that over-budget lock waits drop softly after comments succeed.
It requires a disposable, migrated loopback `DATABASE_URL`, installed server
dependencies, `POLIS_API_BIN`, a free `POST_COMMENTS_RUST_PORT`, and
`TS_NODE_PROJECT=server/tsconfig.json`. Run from the repository root. It generates
its signing keys in memory, removes its temporary public-key file, and stops
only the child it spawned. Run it once per fresh database.

The existing participation-under-load and model-held result-reader guards stay
unchanged; they remain required qualification alongside the writer tests.
