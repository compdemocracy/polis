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
| `observe` | startup error | the observer (below): it reads, and writes nothing |
| anything else | startup error | startup error |

The live handler also requires `SHOULD_USE_TRANSLATION_API=false` (Node detects
a comment's language when that setting is on, and that stays Node's),
`POLIS_API_POST_COMMENTS_DATABASE_URL` (the primary), `POLIS_JWT_ISSUER`,
`POLIS_JWT_AUDIENCE`, and a participant public key: the file named by
`POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE`, or else the participant keys the
process loads at startup. The observer requires the same, and
`POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND` (1 to 10000). With the switch at
`observe` and any of these missing or out of range, the shadow process does
not start, and the vote observer in that process stops with it: the switch
and what it requires have to arrive in one change. With the switch off
nothing is built: no pool, no verifier, no connection.

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

Observe mode (below) reads the same decision otherwise: it compares a strict
conversation's comment with what Node stored, as it does any other, and its
line says the conversation is strict (`strict: true`) and that the
moderators' email follows the insert (`after_insert: "moderator_email"`). It
takes the decision as a row for comparison only, of a type the insert does
not accept, so observing a strict comment gives the live handler no way to
write one.

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

## Observe mode

In the shadow role (`POLIS_API_ROLE=shadow`) with the switch at `observe`, the
shadow listener serves a second mirrored route beside the vote route: a copy
of `POST /api/v3/comments` carrying `X-Polis-Shadow: commentsShadow`. Node
answers the participant; the copy is answered 204 at once and then observed.
nginx sends such copies when `RUST_API_ROUTES` names `commentsShadow`
(`file-server/nginx/ROUTING.md`, "The comment shadow"), and the web deploy
then sets this switch for the shadow service, and only then.

The observer holds two read-only pools (admission: 2 connections; the
read-back: 1; each 100 ms to get a connection and 100 ms a statement) and
nothing that can write. It runs the live handler's own shape check, token
verification, admin refusal and admission statement under the live deadline,
and says what the live handler would do:

| `outcome` | The live handler would |
|---|---|
| `would_serve` | dispatch the write (would-be status 200); or, in a conversation with strict moderation (`strict: true`, `after_insert: "moderator_email"`), hand it to Node, which stores the same row and then emails the moderators. Either way Node stores the comment, and what it stored is read back and compared. The write itself is not modelled: the insert, the comment's number, the author's vote, the notification work or the email, the reply deadline |
| `would_answer` | answer without writing: 409 (`reason: duplicate`), 403 (`reason: closed`), or the answer the route's prelude gives a revoked session (`reason: revoked`) |
| `would_hand_back` | hand the request to Node, for the `reason` in the table above. Never `strict_moderation`: that comment is a `would_serve`. A line printed by an observer older than this has `would_hand_back` with `reason: strict_moderation` for it |
| `would_fail` | answer a 5xx before the write; nothing in the handler does |
| `unknown` | not known (`reason: no_anchor`, below) |
| `shed`, `not_observed` | the copy was not observed: over the lane's rate (`rate_cap`) or its room (`lane_full`), or the process also holds a live handler |

Node may have stored the comment before the copy's admission reads, so the
row admission finds with the same text is classified (`text_row`): `none`;
`own`, this participant's row created no earlier than five seconds before the
copy's database-time anchor, which is Node's row for this very request and
not a duplicate; `other`, any other row, a duplicate as it is for Node; and
`unknown`, this participant's row when the anchor could not be read. An
unknown copy has no would-be status and is never counted as agreeing or
disagreeing with Node. The same person sending the same text twice within
five seconds is `own` on the second copy while Node answers it 409.

Two seconds after the copy arrived, and once more at ten seconds when the
comment is not there yet (or it is and the vote the copy carried is not), the
observer reads what Node stored, by the unique key on (zid, txt), holding no
connection while it waits. `node_comment` is `own`, `other`, `absent`,
`unknown` (no anchor: not looked for), `unavailable` (the read failed) or
`not_checked`. For Node's own row it compares, in process: the text
(`node_txt`: `same`, or `different` with a class `space`, `control`, `case`,
`truncated` or `other` and the two lengths in UTF-16 units and bytes); the
user (`node_author`); the columns against what the live insert stores
(`node_row`: `as_expected`, or the first of `mod`, `active`, `is_seed`,
`velocity`, `anon` that differs, or `moderated` when only `mod` or `active`
differs and the row's `modified` is no longer its `created`: a moderator
approved or rejected the comment after Node's insert and before the read, so
the insert's own values are not known); the language (`node_lang`: `unset`, `set`);
and the author's vote through the vote convention (`node_vote`: `same`,
`different`, `ambiguous`, `absent`, `not_sent`, `unavailable`,
`not_checked`). Because the row is found by its text, a comment Node stored
under a text other than the one this handler parsed is not found: it reads
`absent`, beside Node's 200.

One `shadow_observation` line is printed per copy (`shadow:
"commentsShadow"`). It names the conversation by its number (`zid`) once the
copy is admitted, as the vote observer's line does; a copy handed back before
it is admitted names none. It carries no comment, participant or user
number, no text or part or hash of text, no vote value, token, address or
header value; nginx's request id joins it to Node's and nginx's lines for the
same request. Every other value is a number that names nothing, a boolean or
a word from a closed set: the outcome, `admitted`, the would-be `status`,
`reason`, `queue_ms`, `admission_ms`, `total_ms`, `readback_s`, `strict`,
`after_insert` (on a `would_serve` line only: `notification_task`, or
`moderator_email` where the conversation has strict moderation),
`vote_present`, `seed_present`, `body_class`, `write: "not_modelled"`, and
the classes above. A copy's body is dropped when
its admission ends; the parsed text alone is kept, in the type that cannot be
printed, until the read-back ends. A process that builds the observer prints
a panic's location and never its message, and prints once, at startup, the
server's settings that decide whether a statement's parameters can reach its
log (`shadow_post_comments_database_logging`): the text is a query parameter
here, as it is in Node.

The comment route has a lane of its own: at most 8 observations in admission,
at most 64 waiting for their read-back, and its own rate
(`POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND`). The vote route's lane, rate and
pools are the vote route's alone. `/health` on the shadow listener gains a
`postComments` key when the observer is built, with its counters, lane and
pools; every other key is unchanged, and `status` then also needs the comment
observer's read-back database to answer.

## Tests

`cargo test -p polis-api --features db-tests post_comments` runs the handler's
tests against PostgreSQL, including a replay of every recorded Node response
in `server/characterization/post-comments/golden`: each request the handler
admits is answered with Node's recorded bytes and writes Node's recorded rows,
and each it hands back leaves the database untouched. `make check-polis-api`
runs them on a database built by the migrations and again on the shape of an
installation older than the migrations.
