# Comment handler in polis-api (off by default)

`POST /api/v3/comments` can be handled by the Rust API for one kind of request:
an ordinary comment, with or without its author's vote, from a person who is
already a participant of the conversation. Everything else is handed back to
Node before anything is written. The handler is switched off, and no nginx
route sends a comment to it.

## The switch

`POLIS_API_POST_COMMENTS`:

| Value | Main role | Shadow role |
|---|---|---|
| unset, empty, `0` | off | off |
| `1` | the live handler | startup error |
| `observe` | startup error | accepted; nothing is built for it yet |
| anything else | startup error | startup error |

The live handler also requires `SHOULD_USE_TRANSLATION_API=false` (Node detects
a comment's language when that setting is on, and that stays Node's),
`POLIS_API_POST_COMMENTS_DATABASE_URL` (the primary), `POLIS_JWT_ISSUER`,
`POLIS_JWT_AUDIENCE`, and a participant public key: the file named by
`POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE`, or else the participant keys the
process loads at startup. With the switch off nothing is built: no pool, no
verifier, no connection.

## What is admitted

A request of at most 65,536 bytes, `Content-Type` one of `application/json`,
`application/json; charset=utf-8` or `application/json; charset=UTF-8`, no
`Content-Encoding`, no query string, and a JSON object with these keys only:

| Key | What the handler does |
|---|---|
| `conversation_id` | the conversation |
| `txt` | the text: at most 997 UTF-16 units, then leading and trailing ASCII spaces removed, as Node parses it |
| `vote` | the author's vote, when present and not null |
| `is_seed` | `false` or null is admitted; `true` is handed back |
| `pid`, `agid` | not parameters of this route in Node; never read |
| `xid`; `x_name`, `x_profile_image_url`, `x_email` | handed back |
| any other key | handed back |

A cookie neither admits nor refuses a request. The token must be a participant
token (anonymous or standard user) issued for this conversation, and the
conversation must have a participant with the token's user and participant
numbers.

## What is handed back, and why

Every hand-back is a 502 with the header `X-Polis-Comment-Dispatch`. Its
value is `not-started` when nothing was dispatched, and `refused` when the
write was dispatched and PostgreSQL refused it before any commit (the last
two rows of the table); either way nothing is stored. While the handler is on, each is counted
by reason in `/health` (`postComments.handBackReasons`); with the handler off
there is nothing to count on, so `unconfigured` is never counted.

| Reason | The request |
|---|---|
| `shape_method`, `shape_query`, `shape_size`, `shape_encoding`, `shape_content_type`, `shape_json`, `shape_keys`, `shape_conversation_id` | a shape the handler does not model |
| `xid_key`, `xid_profile_key` | names an external identity |
| `txt_invalid`, `vote_invalid`, `is_seed_invalid`, `txt_empty` | Node answers 400 |
| `txt_nul` | a character PostgreSQL cannot store |
| `is_seed` | a seed comment |
| `not_https`, `not_production`, `unconfigured` | the process or the request is outside the handler's configuration |
| `no_token` | no token: a person's first action, for which Node creates the participant |
| `token_oidc`, `token_xid`, `token_other_conversation`, `token_refused` | a token the handler does not accept |
| `admin` | a listed admin |
| `unknown_conversation` | no such conversation |
| `treevite` | a Treevite conversation |
| `not_a_participant` | no existing membership |
| `moderator` | the conversation's owner, or a user on the owner's site: their comments start approved |
| `xid_required`, `xid_allowlist` | the conversation requires or lists external identities |
| `strict_moderation` | a comment Node would store in a conversation with strict moderation (below) |
| `admission_unavailable`, `admission_timeout` | admission could not read in time |
| `writer_unavailable` | no writer connection was obtained, and nothing was sent |
| `insert_lock_timeout`, `insert_canceled` | PostgreSQL refused the comment's insert at one of this handler's bounds (below); marked `refused` |
| `author_vote_lock_timeout`, `author_vote_canceled`, `author_vote_refused`, `closed_before_vote` | the author's vote could not be stored; the comment's insert was rolled back with it (below); marked `refused` |

## What is answered

- 409 `polis_err_post_comment_duplicate` when the conversation already has the
  text, before
- 403 `polis_err_conversation_is_closed`, in Node's order;
- 200 `{"tid": …, "currentPid": …}` after the insert.

The insert is Node's: `tid` null for the `tid_auto` trigger, which assigns the
comment number under the conversation's comment-number lock, `active` true,
`mod` 0, `velocity` 1, no language. The author's vote is Node's row too: only
when the request carries a vote, with the value the vote convention gives for
the choice, weight 0 and no priority, after reading the conversation again and
refusing a closed one.

Where this differs from Node on purpose: the comment and its author's vote are
one transaction, so both are stored or neither is. Node stores them as two
separate statements, and a vote that fails there leaves the comment for good
without its author's vote. Here a vote that cannot be stored (the database
refuses it, or the conversation was closed in between) rolls the comment back
and the request is handed back, marked `refused`, so Node answers it in its
own way. The transaction has the vote writer's bounds (100 ms for a lock, the
pool's one second for a statement, one second idle), and its statements share
one second in all.

The transaction holds the conversation's comment-number lock until it commits,
across the vote's statements. That is only true of the comment-number trigger
of migration `000042_tid_auto_transaction_lock.sql`, which holds its lock to
the end of the transaction. The trigger before it released the lock when the
insert's statement ended: a second comment in the conversation could then be
given the same number while this transaction was still open, and fail on the
number's unique key (500, nothing stored); and an insert that failed after
taking that older lock kept it on its pooled connection, so that later
comments in the conversation waited on it and were handed back. The handler
must not be switched on in a database that has not applied that migration.

After a stored comment the notification task is upserted and the author's last
interaction updated, on a pool of their own, never awaited, dropped and counted
when 64 are already running or waiting.

Once the write is dispatched, a failure is handed back only when PostgreSQL
itself refused a statement of the transaction before any commit was asked
for, which proves nothing is stored. The insert has two bounds Node does not
have, so Node would have waited and stored the comment: it waits at most
100 ms for a lock (the conversation's comment-number lock above all) and runs
at most one second. PostgreSQL refuses it at either bound with an error for
the statement (SQLSTATE 55P03 or 57014), which aborts the transaction. That
request is handed back, marked `refused`, and Node stores the comment.
Nothing else is handed back after dispatch: a connection that ends, a fatal
error, or a commit that fails is answered 500, because Node asked to repeat a
stored comment would tell its author "duplicate".

Any other failed insert is answered as Node answers the same database error
(409 for the text's unique key under either of its names, the two foreign-key
codes, otherwise 500). A reply that is not ready in 1.5 seconds (the wait for
a connection and the statement bound, with a margin, so that a refusal
arrives first) is answered 500 `polis_err_post_comment`; the write is not
cancelled, so the comment and its vote may be stored.

## Strict moderation

A conversation with strict moderation stores a participant's comment exactly
as any other conversation does. What differs is what Node does next: it counts
the unmoderated comments and emails the moderators, and does not upsert the
notification task. The handler sends no email, so it reaches the decision (the
row Node would store, Node's reply) and then hands the request back with the
reason `strict_moderation`. The decision's types do not let the live handler
insert that row: the insert takes a value that is built only for a
conversation that is not strict.

## The text is never printed

The text is held in a type with no `Display`, a `Debug` that prints a byte
count, and no access to the characters except as a query parameter. Database
errors are not formatted: PostgreSQL's detail for a duplicate text contains
the text. A test runs the handler in a child process with failing inserts,
failing votes and a panic that formats everything the write holds, and finds
no part of the text in anything the process printed.

## Pools and the participation path

Three pools, all the handler's own: admission (2 read-only connections, 100 ms
to get one, 100 ms a read, under a 250 ms deadline), the insert and vote (4
connections, 100 ms to get one, 100 ms lock wait, 1 s a statement), and
notification work (2 connections). It shares no pool, lane or queue with votes
or the next comment. The only lock it takes is the comment-number lock any
writer of comments takes; a vote never takes it. A test holds that lock so
that all four insert connections are stuck, then casts votes in the same
conversation through the vote writer: each is stored and answered without
waiting for a connection.

## Tests

`cargo test -p polis-api --features db-tests post_comments` runs the handler's
tests against PostgreSQL, including a replay of every recorded Node response
in `server/characterization/post-comments/golden`: each request the handler
admits is answered with Node's recorded bytes and writes Node's recorded rows,
and each it hands back leaves the database untouched. `make check-polis-api`
runs them on a database built by the migrations and again on the shape of an
installation older than the migrations.
