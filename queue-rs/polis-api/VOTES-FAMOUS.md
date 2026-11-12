# Featured participants (`GET /api/v3/votes/famous`)

Nothing is served by this handler by default: it is switched off and
unselected.

The legacy participation client asks this route every few seconds for the
participants it draws by name or picture on its opinion map: the requester,
participants a moderator pinned, authors of featured comments who hold an
external id, and the conversation's external-id participants, each with their
choices as one letter a comment and the base cluster the math placed them in.
`participationInit` returns the same object as `famous`; that route is not
touched here.

## Switches

- The process: `POLIS_API_VOTES_FAMOUS_READS=1` and
  `POLIS_API_VOTES_FAMOUS_DATABASE_URL` (the primary; identity, the
  conversation code and the conversation row are read there).
  `READ_ONLY_DATABASE_URL`, when set, supplies the data pool, as for the other
  read routes. Participant verification keys and the read OIDC JWKS admit
  those identities. Unset, every request on the path answers the hand-back 502
  with the reason `off`.
- nginx: the selector `votesFamous` in `RUST_API_ROUTES` sends bodyless GET and
  HEAD on exactly `/api/v3/votes/famous` to polis-api. `/api/v3/votes` and
  `/api/v3/votes/me` keep their own selectors. Unselected, nothing of it is
  rendered.

## Pools and bounds

Two read-only pools of this route's own: a data pool (two connections, 15 ms
to acquire one, 100 ms a statement) and an identity pool (one connection,
15 ms, 50 ms). The request has 150 ms in all; the nginx location waits 250 ms.
A request that finds no free connection, runs out of time or meets a database
error goes back to Node. Neither pool borrows a slot, a connection or a queue
from votes, comments or the next comment: the next-comment isolation test
parks both among its saturated pools, and the startup wiring test checks that
no pool is shared. The executor, the process and the database's own CPU and
I/O remain shared; this is not a claim about an overloaded database. These
numbers have not been tuned against production traffic.

## What Node does, and what is copied

`handle_GET_votes_famous` (`server/src/routes/votes.ts`) answers with
`doFamousQuery` (`server/src/server-helpers.ts`):

1. The math generation for the conversation, whole, kept three seconds
   (`getMathBundle`). Here: the shared math bundle cache
   (`math_bundle.rs`), whose main document now also keeps `consensus` and
   `repness` as stored.
2. The conversation row, and the authors of the featured comments (the
   consensus, agree and disagree, and each group's representative comments)
   who hold an external id under any account.
3. An anonymous conversation (`is_anon`) answers `{}`.
4. `getSocialParticipants` (`server/src/participant.ts`): the featured
   participants and the requester's own row.
   - The featured participants: one statement that ranks moderators' pins
     (`mod >= 2`, 999), those authors (900) and participants with an external
     id under the conversation's account (`org_id`) and a picture (100), keeps
     the first `ptptoiLimit` (30 unless given, at most 99), and returns each
     with the picture, id, name and address of their external id. Only
     participants with at least one row of vote history take part. The
     requester is not in this statement. It is Node's here, with two bounds
     added (below).
   - The requester's own row (1000), decided on every request: see "The
     requester's own row" below.
5. `pullXInfoIntoSubObjects`: a row with a picture, an id or an address gets
   `xInfo: {x_profile_image_url, x_name}` and loses the four columns; any other
   row keeps the four columns as read. A row of priority 1000 gets
   `isSelf: true`.
6. Every row of those participants' vote history (`votes`, not the
   latest-choice table), ordered by participant, comment and time, folded into
   one letter a comment: `a`, `d`, `p`, or `u` for unseen. Each stored value is
   read through the vote convention module (`polis-contracts/src/votes.rs`),
   never by its sign; no value, or a value that is no choice, leaves the letter
   the earlier rows gave.
7. The base cluster of each participant in the same math generation. A
   participant the math has not placed is left out unless they are the
   requester; the requester stays, without `bid`. Math that is present and not
   committed answers `{}`.

## Node's two process caches

Node keeps two things in each server process, and they decide most replies.
This handler keeps the same two things by the same rules, so a request
sequence gives the same bytes on both sides. They are per process: a Node
process and a polis-api process never share them.

- **The featured participants' rows**, 30 seconds, at most 999 entries, under
  a key of the conversation, the limit and the request's `math_tick`. They
  are the same for every requester. No requester's own row is ever among
  them. The replay records them on Node cold, warm and at the 30-second
  boundary, and the handler answers the same.
- **Each participant's letters**, at most 5000 entries, with the `math_tick`
  of the request that read them. They are read again only for a request whose
  `math_tick` is greater. A request without `math_tick` (it defaults to the
  latest, a tick below every real one) therefore reuses whatever is kept, and
  one request with a very large `math_tick` keeps a participant's letters as
  they are until the entry leaves or the process restarts. The letters of one
  read are as long as the greatest comment number among all the rows of that
  read, so one reply can carry strings of different lengths.

Where this handler differs on purpose:

- Both caches also have a bound in bytes (16 MiB of participant rows, 32 MiB
  of letters). Node has none. An entry that leaves early is read again: the
  letters can only be fresher, and the rows are read as they are once their
  30 seconds have passed.
- The authors of featured comments are read only when the participant rows
  are; Node reads them on every request and uses them only then.
- The conversation code is resolved on every request; Node keeps it.
- The math document is presented only as far as this route needs it. Node
  clones, reshapes, serializes and compresses the whole document on every
  request to this route.

## The requester's own row

It is decided on every request, on Node and here alike, and is never kept:

- A limit of zero has no rows at all, the requester's included.
- A requester who is one of the featured participants (a pin, a featured
  author, an external id) gets that row as their own: priority 1000 and
  `isSelf: true`, in their reply only. Nobody gives up a place. In every other
  requester's reply the row keeps its own priority.
- Any other identified requester costs one small statement: an account that
  is a participant of the conversation with at least one row of vote history
  gets a row of the same columns as a featured participant's (their external
  id under the conversation's account, when they hold one with a picture),
  at priority 1000. It takes the first of the limit's places; when the
  featured participants already fill the limit, the last of their ranking
  (the lowest priority, then the greatest account) gives up its place for
  this reply.
- Anyone else (no credential, an account that takes no part, a participant
  without a vote) gets the featured participants and no row of their own.

So within the 30 seconds of the kept rows each requester gets their own row
and nobody else's, and a participant's first vote shows in their own row on
their next request.

## What goes back to Node

Every hand-back is the pre-response 502 with its reason in
`X-Polis-Handback`; `/health` counts them under `votesFamousHandbacks`.

| Reason | When |
|---|---|
| `off` | The process switch is off. |
| `request` | Not a bodyless GET or HEAD; a cookie; a missing, repeated or unknown parameter; an integer not in its plain decimal spelling; `math_tick` beyond JavaScript's exact integers; `ptptoiLimit` outside 0 to 99; a conversation code that is empty, over 100 bytes or not alphanumeric. Node answers its own 400s and 404s. |
| `identity` | An external-id token, a token of another conversation, a participant token whose holder is not a member with that number, a credential that is not a Bearer token, an OIDC identity with no account yet, or any token that does not verify. |
| `conversation` | No conversation for the code, or not exactly one row for it. |
| `math_unreadable` | The math generation could not be read whole: a main or mapping document over 64 KiB, a malformed one, or the database not answering that read. |
| `math_incoherent` | The four math tables are not at one tick, or one is missing, at a committed tick. Node still reads the featured comments from the main document then; this process does not hold it. |
| `math_shape` | `consensus` or `repness` is not in the shape the math writes (objects with an integer `tid`, groups keyed by a plain number). Node empties, reshapes or fails on those in ways not copied here. |
| `ambiguous_rows` | A featured participant, or the requester, has more than one row, which happens when one person holds two external ids under the conversation's account. Node keeps whichever row the database returns last. |
| `oversize` | More than 200 participant rows, a row with more than 8192 bytes of external-id text, more than 4096 featured comments, more than 1000 featured authors, more than 100,000 rows of history, a comment number above 32,767, or a reply over 1 MiB. |
| `database` | No free connection in time, a statement over its time, or a refused statement. |
| `deadline` | The request's 150 ms. |

Node's failures (`polis_err_famous_proj_get`, 500) are never produced here.

Two limits of this form, stated plainly:

- **A math document over 64 KiB costs a statement on every request.** The
  shared math read measures the stored document in the database and refuses
  one over the bound; the refusal is not kept, so each request for such a
  conversation runs that statement again before it goes back to Node (about
  2 ms for a 0.3 MB document and 7 to 18 ms for a 6 MB one on the development
  box, by column type). The conversations with the largest documents are the
  ones this route costs Node the most for. Reading only the parts this route
  uses (`consensus`, `repness`, the base cluster ids and the mapping), and
  keeping a refusal for the three seconds a read is kept, are not in this
  change; the route should not be selected or observed before they are.
- **Only the exact path is this route's.** Another spelling of the path (a
  trailing slash, an encoded character, a dot segment) is not matched here:
  it gets the plain hand-back 502 without a reason and is not counted in
  `votesFamousHandbacks`. The nginx location is exact as well.

## Checks

`conformance/votes-famous-run.sh` starts the sealed characterization stack,
writes its fixtures (every valid choice through the fixture vote writer), and
sends each request as the same bytes to the unchanged Node listener and to
polis-api, in the same order: anonymous, member, signed-in and external-id
requesters; an anonymous conversation; no math, complete math and the states
in between; `ptptoiLimit`; a current, a stale and a newer `math_tick`; both
caches cold and warm, at their boundaries; the requester's own row for
requesters who follow one another within the 30 seconds (featured, not
featured, without a vote, without a credential, at a limit the featured
participants fill, and after a first vote); the error replies. Complete HTTP
bytes are compared with nothing removed; a difference in the `Date` second
repeats the exchange on both sides. Every hand-back is checked against the
reason the case names, and every request is also sent to a polis-api with the
switch off, which must hand all of them back. With
`VOTES_FAMOUS_RECORD_ONLY=1` the same driver records Node alone; the
checked-in contract fixture (`polis-contracts/src/fixtures/votes-famous.json`)
holds those replies, decoded, not hand-written.

Set unique `COMPOSE_PROJECT_NAME`, `POLIS_RECOVERY_PG_PORT`, `P027_HTTP_PORT`
and `P027_CONTROL_PORT`, and supply the characterization images as for the
other read routes; `X54_POLIS_API_IMAGE` must be built with
`FEATURES=fixture-clock`.

The unit tests rebuild recorded replies from their inputs. The database tests
(`--features db-tests`, on both database shapes) replay two recorded
conversations through the route's pools and both caches, check the bounds and
the named hand-backs, refuse a write on each pool, and shed a request when a
pool is full. `nginx-routing.sh` checks the selector off, unselected beside
the other vote routes, on, its location against its template, methods and
bodies, and the fallback.

Not covered: the CLI's `polis vote famous` has no entry in the CLI
differential run for this selector, and no measurement against production
traffic has been made.
