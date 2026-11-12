# Comparing Node's answers with the shadow's

`polis-shadow` reads the log lines written for every vote that nginx copies to
the read-only Rust shadow service (`votesShadow` in `RUST_API_ROUTES`), joins
them by nginx's request id, and prints aggregates and a verdict: how many votes
were copied and observed, how many the Rust writer would have admitted and why
it would have handed the rest back, whether its would-be status, stored vote,
next statement and counts agree with what Node actually did, the shadow's
latency, and the stop rule's inputs. It never prints a request id, a
conversation or statement number, a participant or any text, and it writes
nothing.

It does the same for copied comments (`commentsShadow`), with a comparison of
its own: see "The comment route" below. The two routes are entries in one
table:

| `--route` | Copies of | The shadow's name | Node's side |
|---|---|---|---|
| `votes` (the default) | `POST /api/v3/votes` | `votesShadow` | its handler's `vote_reply` line and its access line |
| `comments` | `POST /api/v3/comments` | `commentsShadow` | its access line only |

Every query of a route names that route's own shadow, its own nginx route and
its own path on Node's access line. nginx puts its request id on every route
it copies, so a query that read Node's access lines by method alone would
count one route's requests in another's report; a test holds that neither
report changes by a byte when the other route's lines, and a third route's,
are in the same log.

It is a binary in the queue adapter package, like `polis-version`, and uses that
package's toolchain and dependencies. It has no AWS SDK: it runs the AWS CLI as
a subprocess, with the caller's credentials, region and proxy.

```sh
cd queue-rs
cargo build --locked --release --bin polis-shadow
cargo test --locked --bin polis-shadow
```

For a Linux aarch64 machine, build it there or in a native `rust` container on
an arm64 host (the package needs `pkg-config` and `libssl-dev`).

## The lines it joins

| Line | Written by | What the tool reads |
|---|---|---|
| `shadow_edge` | nginx, each shadowed vote (`file-server/nginx/rust-api/shadow-http.conf.template`) | `request_id`, `edge_status` (Node's status as nginx saw it), `edge_upstream_s` (Node's time) |
| `shadow_mirror` | nginx, each copy | `mirror_status`, `mirror_upstream_status` (empty: not copied), `mirror_s` (how long the copy held the participant's connection) |
| `vote_reply` | Node's vote handler (`server/src/routes/votes.ts`), only for a request carrying nginx's `X-Request-Id` | `node_status`, `node_next` (`statement`, `topical` or `none`), `node_remaining`, `node_total`, `zid`. The line also names the statement Node served (`node_next_tid`); the tool never reads it |
| `http_request` | Node's access line, which carries `request_id` for such a request (`server/src/server-middleware.ts`). Its `message` is written `"http_request http_request"` (winston appends the meta's `message`); the queries accept both spellings, and a test refuses a query that tests the single one. It is read only where `http.route` is the route's own path, so a request Node refused before its router matched a route (its line names none) is not read | `http.status_code`: Node's answer when the route's middleware refused the vote before the handler; for every vote (with or without a request id), `http.route`, `http.status_code` and `duration_ms` for the stop rule's vote inputs |
| `shadow_observation` | the shadow service (`queue-rs/polis-api/src/shadow.rs`) | `outcome`, `admitted`, `status`, `reason`, the durations, `follow_on`, `remaining`, `total`, `prev`, `node_vote` |

None of the five carries a vote value. The shadow's line names no statement,
neither the one voted on nor the one it would serve next: a statement number
beside a conversation number and a time picks out one row of that
conversation's public votes, and with it a participant. The shadow uses the
numbers in process and prints classes (`node_vote`, `prev`, `follow_on`).
Every container on a web box writes into one log stream; each line above says
whose it is (`listener: "shadow"`, or Node's `service: "server"`).

## The queries, and what may leave AWS

The tool runs only the Logs Insights queries compiled into its route table
(`route.rs`); no command accepts query text. `polis-shadow queries` prints them.
Each is a filter, optional computed fields and one or two `stats` stages:

- the one-stage queries count lines by class (outcome, reason, status, the
  readback and membership classes) or take percentiles of durations;
- the join's first stage groups each request id's lines into one row inside
  Logs Insights and never leaves AWS; its second stage counts requests in each
  class, grouped only by Node's status and the shadow's would-be status.

Node is compared with the shadow only inside the join, request by request.
No two counts taken by different queries, or over different spans, are ever
set beside each other as Node's and the shadow's. (The stop rule compares a
metric with itself a week earlier; that is its definition.)

A test fails if any query's final stage groups by anything outside an allowlist
of class and status fields (`query.rs`, `GROUP_ALLOWLIST`), takes a maximum or
percentile of anything but a duration, counts on a request id, participant,
statement number, vote, address or text, or if a first stage groups by anything
but the request id. A second test fails if any query could return a statement
number in any form, and a third if a compiled query reads one at all. Only the
window's two bounds are filled in at run time, as integers.

**What leaves AWS: the aggregate rows of those queries (counts, shares,
percentiles) and the CloudWatch datapoints below; nothing else.** No row holds
a conversation or statement number. Nothing is written to disk.

What is printed is narrower still: counts, shares, durations, HTTP statuses
and words. A status is printed only when it is a number from 100 to 599. A
reason in the vote report is printed only when it is lower-case letters and
underscores; a class or reason in the comment report only when it is one of
the words compiled into the tool; anything else found in such a field is
counted and not printed. A test plants request ids, an address, a user
agent, a conversation's code, conversation, comment and participant numbers
and a text in the log, and in fields where a word or a status belongs, and
finds none of them in either report, in what a run prints as it goes, or in
a refusal.

The stop rule's metrics, read with `cloudwatch get-metric-statistics`: the
database's `CPUUtilization` (5-minute averages), and the load balancer's
`TargetResponseTime` p99 by hour and `HTTPCode_Target_5XX_Count` by day, each
also for the same window a week earlier. The vote inputs come from one more
query, `node_votes` (Node's access lines for every vote, by hour), run over
the window and over the same window a week earlier.

## Running it

From a machine whose AWS CLI is configured with a read-only identity that may
run Logs Insights on the server log group (`logs:StartQuery`,
`logs:GetQueryResults`) and read CloudWatch metrics
(`cloudwatch:GetMetricStatistics`):

```sh
polis-shadow run --route votes \
  --from 2026-11-10T00:00:00Z --to 2026-11-17T00:00:00Z \
  --log-group <server log group> \
  --db-instance <database instance identifier> \
  --load-balancer <app/name/id of the web load balancer>
```

The window is at most eight days for votes. The join reads 60 seconds past
each bound (a request's lines are written up to the shadow's readback retry
apart) and counts only votes whose nginx line falls inside the window. One
week of the server log group is a few gigabytes per query scanned; the run
prints the total.

### A window is read only once it has settled

`run` refuses a window that ended less than **310 seconds** ago, before it
asks anything of AWS, and names the latest `--to` it can read. The number is
two delays added together:

- **10 s**: the shadow prints its line after it has read back what Node
  stored, two seconds after the copy arrived and once more at ten seconds
  when the first look found nothing. Its line is that much later than the
  request it describes, and than Node's line for the same request.
- **300 s**: the log's delivery. Measured once on this log group, each line
  could be queried within about five seconds of being written, and yet a
  query made while its window was still open returned nothing from the
  window's last two minutes. Five minutes is two and a half times that.

A comparison made over a window whose lines are still arriving sets requests
whose Node line has arrived beside observations that have not, and finds
differences that are not there. So a request is always paired by its request
id, never by time, and a window is never judged while it can still change.
`report` prints from saved results and cannot check when they were taken.

### No join is reported from part of its window

Logs Insights returns at most 10,000 rows. Every query's final rows are
groups of classes, a few dozen at most, but a join's first stage has one row
for every request id in its time range, and a busy day of votes has more
than 10,000. So a join is never given that many:

- one more query, `edge_bins`, counts nginx's lines in each five minutes,
  by the same test of a line's time as the join uses (from the window's
  start, up to and not at its end), thirty days of the window at a time so
  that its own rows stay under 10,000;
- the window is cut at five-minute marks into slices that each hold at most
  4,000 requests (a join also reads 60 s on each side of its slice, and ids
  with no nginx line; 4,000 leaves room for 50 requests a second there);
- the join runs once for each slice, a request belongs to the slice its
  nginx line falls in, and the slices' rows, which are counts, are added up;
- each slice's own total of nginx lines must equal `edge_bins` for the same
  span.

When a result may be cut off, the report says so and reports nothing from
it: a result of 10,000 rows, a slice whose total does not match (cut off, or
lines arrived between the two queries), or five minutes that alone hold more
than 4,000 requests. Those criteria read "not evaluated" and the verdict is
then never PASS. A test joins a day of 12,500 votes this way and gets, byte
for byte, the report of the day joined in one piece, also where the stand-in
for Logs Insights keeps only 10,000 rows of a first stage.

`polis-shadow report --route votes --results <dir>` prints the same report
from results saved as `<query>.json` (`get-query-results` output) and
`metric-<name>.json` (`get-metric-statistics` output). A join saved in slices
is `join.0.json`, `join.1.json` and so on.

Exit status: 0 pass, 1 stop (remove the shadow), 2 too little evidence (or a
criterion not evaluated), 3 an error, 4 examine (enough evidence, no stop, a
criterion missed: examine before the flip).

## What each number means

1. **Lines in the window**, by kind.
2. **The copy.** Copies logged; copied (the shadow's upstream status is set) or
   not (an empty upstream status: outside the 1 to 9999-byte body bound, or the
   shadow's host absent); the shadow's 204, 502 or 504; the copy's hold on the
   participant's connection (largest hourly p99, largest).
3. **Node's answers to shadowed votes, as nginx saw them**, by status, and
   Node's time.
4. **The shadow's observations.** Outcomes (`would_serve`, `would_hand_back`,
   `would_fail`, `shed`, `not_observed`); the admitted share; hand-back reasons
   by count; would-be statuses; would-be failures (a CORS refusal is the
   prelude's 500 and is reported on its own, never counted as a would-be
   failure); Node's stored vote read back by the shadow (`same`, `ambiguous`: a
   quick change of vote, `different`: a vote-sign stop, `absent`,
   `unavailable`); the would-be next statement (`complete`, `absent`,
   `degraded`); membership (`hit`, `miss`, `new`, `revote`, `none`).
5. **Joined with Node.** Coverage (copied votes with an observation, where a
   copy nginx answered itself because the shadow's host was absent counts as
   copied, so a down shadow counts against coverage); Node replies from the
   handler and refusals before it; status agreement on admitted copies the
   shadow would serve, on Node's handler status where it replied (nginx's
   where it refused before the handler), with a Node 500 after the vote was
   stored as its own class, and two classes not compared: the participant went
   away (nginx 499) and a 5xx nginx answered with no reply from Node's
   handler; next statement presence and exhaustion where both
   answered 200; `remaining` and `total` equality. A self-check compares the
   second stage's total of nginx lines with the one-stage count: if they differ,
   the account did not run the two stages as written and the joined comparison
   is withheld rather than printed wrong. A query the account refuses is
   reported as refused.
6. **The shadow's latency** on admitted copies: queue, admission, selection,
   total and readback, append excluded.
7. **The stop rule** (any one is a stop):
   1. database CPU above 60 % in two consecutive 5-minute periods;
   2. the copy's hold above 10 ms p99 in an hour, or any copy above 60 ms;
   3. the load balancer's p99 (all routes) more than 20 % **and** more than
      100 ms above the same hour a week earlier, in three hours in a row;
   4. vote errors: at least 10 of Node's 5xx on `POST /api/v3/votes` in the
      window, a share more than three times the same span's a week earlier
      **and** more than half a percentage point above it;
   5. vote latency: Node's `duration_ms` p99 for votes more than 20 % **and**
      more than 50 ms above the same hour a week earlier, in three hours in a
      row, counting only hours with at least 20 votes in both weeks.

   Target 5xx over all routes are printed as context and are not a stop:
   they are non-zero on nearly every day and swing from 15 to 1,999 a day
   (deploys among them), so a day above the week before says nothing about
   the shadow. The floors and the three-hour runs exist for the same reason:
   one slow hour or one bad day happens every week; what the shadow could
   cause (database contention, a held connection) persists while it runs.

   A metric is read only when it has datapoints for at least 95 % of the
   window (database CPU: its five-minute averages; the load balancer: hours
   with a p99 in both weeks). Both exist for every period of a deployment
   that is up and has traffic: the database reports its CPU whether or not
   anything happens, and the load balancer has a p99 for every hour in which
   it answered one request. A load balancer with empty hours in more than
   one hour in twenty would read "not evaluated" here; the count of target
   5xx, which has no datapoint for a day without one, is for that reason
   not held to this. CloudWatch answers a wrong instance or load
   balancer name, and a span older than it keeps a period for, with no
   datapoints and no error; with fewer, rules 1 and 3 read "not evaluated"
   and the verdict is too little evidence, never "never fired". A breach in
   whatever was read still stops. Rules 4 and 5 are likewise not evaluated
   when no access line of Node's for the route was found in the window, or
   in the week before it.
8. **The criteria and the verdict.**

## The criterion for the week

| Criterion | Pass |
|---|---|
| The copy's cost | largest hourly p99 at most 5 ms, largest at most 60 ms |
| Coverage | observations for at least 99.5 % of copied votes, a down shadow's included |
| Evidence volume | at least 5,000 admitted observations across at least 50 conversations, else too little evidence |
| Admitted share, copied share | reported, no threshold |
| Would-be failures | none (CORS refusals excepted and reported); a failure is a stop |
| Status agreement | 100 % on admitted would-serve copies, a Node 500 after store its own class; a disagreement is a stop |
| `node_vote` | `different` zero (a stop); `same` or `ambiguous` at least 99.9 % of admitted would-be 200s (a readback that never ran counts against it); no would-be 403 that Node stored |
| `remaining` and `total` | equal on at least 99.5 % where both served a statement |
| Exhaustion and presence | agreement at least 99.9 % |
| Membership | `hit` at least 98 % of `hit` and `miss` |
| Writer latency | admission p99 at most 100 ms, total p99 at most 400 ms |
| Follow-on and admission | `degraded` at most 1 % of admitted would-be 200s; no `admission_timeout` |
| The stop rule | never fired |

The verdict is STOP if any criterion is a stop, then TOO LITTLE EVIDENCE if
any is short or not evaluated, then EXAMINE if any other criterion missed,
else PASS. Every miss is examined before the flip.

## What it cannot compare

- **The drawn statement, and how the draws are weighted.** The shadow's line
  names no statement, so neither the two picks nor their distributions are
  compared (Node and the shadow draw independently at random, so an equal pick
  would be luck in any case). What is compared: whether each served a
  statement, the two counts, and membership. A difference in how the two
  weight their draws (the comment priorities of the math result) is therefore
  not detected here; the weighted draw itself is held, on fixed draws, by the
  vote writer's own tests.
- **Membership** detects only a candidate set that is too small, and about
  half of next votes land on the other web box (`prev: none`).
- **Ticks.** Both sides pick for the same request, so they are usually on the
  same math generation; a generation change between Node's pick and the
  shadow's is not excluded, because the shadow's line carries no tick age.
- **Topical picks.** Node's topic-agenda picks (`node_next: "topical"`) are
  excluded from every next-statement comparison.
- **The append.** Observe mode does not append, so its latency and degraded
  share are optimistic; its reads run beside Node's own pick, so its database
  load is pessimistic.
- **Not covered at all:** append contention, 202 unknown, 406 duplicates, the
  star write, notification state, the no-more-comments row, the live write
  location's hand-back replay, mixed routing and retries, drain on stop, and
  what clients do with the writer's answers.
- **Not copied:** requests that miss the exact location (a case variant, a
  trailing slash) and bodies outside 1 to 9999 bytes; a copy carries no query
  string.

## The comment route

```sh
polis-shadow run --route comments \
  --from 2026-11-10T00:00:00Z --to 2026-12-01T00:00:00Z \
  --log-group <server log group> \
  --db-instance <database instance identifier> \
  --load-balancer <app/name/id of the web load balancer>
polis-shadow queries --route comments
polis-shadow report --route comments --results <dir>
```

A comments window may be up to 92 days. That is a bound on what a run reads,
not a definition of enough evidence: enough evidence is the minimum counts
below, whatever span it takes to reach them. The stop rule is read over the
same window, and CloudWatch keeps five-minute datapoints for 63 days: a
window that reaches further back than that cannot have its database CPU
rule read, and its verdict is then too little evidence.

### Its lines

| Line | Written by | What the tool reads |
|---|---|---|
| `shadow_edge` | nginx, each shadowed comment | `request_id`, `edge_status`, `edge_upstream_s` |
| `shadow_mirror` | nginx, each copy | `mirror_status`, `mirror_upstream_status`, `mirror_s` |
| `http_request` | Node's access line for `POST /api/v3/comments` with a request id | `http.status_code`: Node's answer. Node writes no line of its own for a comment, so this is all of Node's side |
| `shadow_observation` | the shadow (`docs/post-comments-rust-handler.md`, "Observe mode") | `outcome`, `admitted`, `status`, `reason`, `strict`, `vote_present`, `seed_present`, `body_class`, the durations, and the classes of what it read in the database: `text_row`, `node_comment`, `node_txt`, `node_txt_difference`, `node_author`, `node_row`, `node_lang`, `node_vote` |

The shadow's line carries no conversation, comment, participant or user
number and no text; the request id is the only thing that joins it to Node's
line. The tool reads none of the line's four text lengths, and its allowlist
refuses any query that would. A test reads the line's 32 keys and every
closed set of words from the observer's own tests and fails when the tool's
lists, or the fixture lines its tests are built from, differ from them.

### What its report says

1. **Lines in the window**, by kind.
2. **The copy**, as for votes.
3. **Node's answers to shadowed comments, as nginx saw them.**
4. **The shadow's observations.** Outcomes: `would_serve` (the handler would
   store the comment), `would_answer` (it would answer 409, 403, 401 or 400
   itself), `would_hand_back` (to Node, by reason), `would_fail`, `unknown`
   (no database-time anchor), `shed`, `not_observed`. The admitted share, how
   many admitted copies are in conversations with strict moderation, and what
   the copies carry (a vote, a seed flag, a size class).
5. **What the shadow read in the database** for admitted copies: the row
   that already had the text at admission, and Node's stored comment read
   back two and ten seconds later, as classes.
6. **Paired with Node by request id.** A request is paired when it has one
   nginx line inside the window, one Node access line and one observation.
   Printed with it: observations with no Node line, and Node lines with no
   observation. Only paired requests are judged.
7. **The shadow's latency** on admitted copies.
8. **The stop rule**, as for votes, with Node's 5xx and p99 on
   `POST /api/v3/comments` in rules 4 and 5, and two differences. Rule 5
   compares Node's p99 by day, not by hour: it needs 20 requests in the span
   in both weeks, and comments come at about eight an hour. And the rule is
   read over the last eight days of the window at most, however long the
   window is: it is about what the copy is doing to production now, not
   about the evidence, and over months it would report any three slow hours
   there ever were (five-minute database CPU is not kept that long either).
   The copy's hold, rule 2, is read over the whole window. So a report
   over a long window does not say whether rules 1, 3, 4 and 5 fired before
   its last eight days, and it prints that. Rules 3, 4 and 5 compare a span
   with the same span a week earlier: once the copy has run for more than a
   week both spans are copied ones, and a slowdown that began with the copy
   no longer shows. The stop rule is therefore read while the copy runs, in
   a report whose window ends within the first eight days after
   `commentsShadow` is switched on (its verdict will be too little evidence;
   its stop rule section is what is read), and again each week; the report
   that reaches the minimum counts is not where it is first read. For either
   route, when not one span holds 20 requests in both weeks, rule 5 has
   compared nothing and reads "not evaluated", never a pass.
9. **The criteria, the minimum counts and the verdict.**

### Agreement, disagreement, not known

Node's status is the one on its access line. `N` is Node's status.

| The shadow's line | Node | Class |
|---|---|---|
| `would_serve`; `node_comment: own`, `node_txt: same`, `node_author: same`, `node_row: as_expected`, `node_lang: unset`, `node_vote: same` or `not_sent` | 200 | **agreement** |
| `would_answer` with status 409, 403, 401 or 400 | the same status | **agreement** |
| `would_serve` | 403, 400 or any other status below 500 that is not 200 or 409 | **disagreement**: a would-be status Node contradicts |
| `would_serve`; neither `text_row` nor `node_comment` is `own` | 409 | **disagreement**: Node found a duplicate the shadow did not |
| `would_answer` 409, `queue_ms` at most 2,000 | 200 | **disagreement**: the shadow calls a duplicate what Node stored |
| `would_answer` | any other status below 500 that differs | **disagreement** |
| `would_serve` or strict moderation; `node_comment: absent` | 200 | **disagreement**: no row has the text the handler parsed, ten seconds after Node said it stored the comment. This is the only form a text Node stored differently can take here |
| the same; `node_comment: other` | 200 | **disagreement**: the row with the text is not this request's |
| the same; `node_txt: different`, `node_author: different`, `node_row` naming a column, `node_lang: set`, `node_vote: different`, or `node_vote: absent` | 200 | **disagreement**: stored otherwise than the handler would store it |
| `node_vote: different` or `node_txt: different` on any line at all, paired or not | | **disagreement** |
| `would_answer` 409, `text_row: other`, `queue_ms` above 2,000 | 200 | **not known**: an observation that starts late finds Node's own row older than the five seconds within which it is taken for this request's, and calls it someone else's. That can happen only when the observation starts more than five seconds after Node stored the row, so 2,000 ms errs toward not known: a would-be duplicate on a copy observed between two and five seconds late is filed here although it is a disagreement |
| `text_row: own`, or `would_serve` with `node_comment: own` | 409 | **not known**: the same text sent twice by one person within five seconds. The shadow reads the first request's row as this request's own: at admission, or, when the second copy's admission ran before Node had stored the first (a double submit), at the read-back |
| `node_comment` `unknown`, `unavailable` or `not_checked`; `node_vote` `ambiguous`, `unavailable` or `not_checked`; outcome `unknown` (no anchor); a Node line with no status | any | **not known** |
| any | 5xx | **Node's failure**, its own class, with how many of those comments were stored all the same and how many without their author's vote |
| `would_hand_back` | any | not judged: Node's answer is the answer. A strict-moderation hand-back's stored comment is still judged |
| an observation with no Node line, or a Node line with no observation | | counted, never judged. Where the handler would store the comment or answer it itself, the request has no Node line, and nginx saw Node answer another status (the participant staying, and no 5xx), the count is printed and the verdict is EXAMINE: Node's own status is not in hand, and the two cannot both be right |

What is not known is never an agreement and never a disagreement, however
many there are, and never counts toward a minimum. A pass over the judged
part says nothing of an unjudged part, though, and a read-back that fails or
never runs does not fall evenly on all comments: when more than 5 % of the
comments the handler would store, or of the stored comments read back, are
not known, the verdict is EXAMINE.

### What stops it

The verdict is STOP on any one of:

- any disagreement in the table above (each is definite, and stays a stop
  until it is explained);
- `would_fail`, or a would-be 5xx other than a hand-back's 502;
- the stop rule (database CPU, the copy's hold, the load balancer's p99,
  Node's errors and p99 on comments).

A stored language (`node_lang: set`) is among the disagreements on purpose.
The handler stores no language, and Node stores one only when its
translation service is switched on (`SHOULD_USE_TRANSLATION_API`). The
shadow service does not start unless that setting is `false`, and it is
off where this comparison is run. So a comment stored with a language
means the setting changed under the comparison, and the handler would no
longer store what Node stores: a finding, not noise. If it is ever switched
on deliberately, every stored comment will read as a disagreement until the
handler stores a language too.

Two of the design's stop conditions are not this tool's to see: a line found
to carry text, a participant or a vote value (the observer's own tests hold
that), and the vote shadow's coverage or latency worsening once comments are
copied (read the vote route's report before and after; the tool compares no
two runs).

### The minimum counts

Enough evidence is a count of judged observations for each class. No number
of days stands in for it, and a class below its minimum makes the verdict
TOO LITTLE EVIDENCE, never PASS.

| Class | Minimum | Why this number |
|---|---|---|
| Observed copies | 1,000 | the admitted share and the reasons: a share of 1,000 is known to about three percentage points |
| Comments the handler would store, judged against Node | 300 | with none disagreeing, the disagreement rate is under 1 % with 95 % confidence (three divided by the count). About one comment in six is of this kind |
| Stored comments read back and judged (those, and the ones under strict moderation) | 600 | under 0.5 % by the same rule. About two comments in three are read back |
| Authors' votes compared | 300 | under 1 %. A vote read with the wrong sign would differ on every line at once |
| Would-be duplicates judged against Node | 20 | duplicates are rare, so this bounds nothing tightly (15 %); it says the lookup met real traffic |

A would-be 403 for a closed conversation has no minimum: there are too few
to wait for, and their count is printed.

### Its verdicts

- **STOP**: remove `commentsShadow` until what stopped it is explained.
- **TOO LITTLE EVIDENCE**: a class is below its minimum, or a criterion could
  not be evaluated: a query refused, cut off or withheld; a stop-rule metric
  not read for the window; or a word on the shadow's lines that is in none
  of the tool's sets (a line that carries one is counted in no class, so one
  such word anywhere withholds the verdict until the tool knows it). The
  report names the classes. Every share in it is then a count, not a result.
- **EXAMINE**: enough evidence and no stop, and a threshold missed: coverage
  below 99.5 % of copied comments, the copy's cost, admission above 100 ms
  at p99 or any `admission_timeout`, an observation with no Node line whose
  would-be answer is not the status nginx saw, or more than 5 % of a judged
  class not known.
- **PASS**: every minimum reached, no disagreement, no threshold missed.

### What the comment report cannot show

- **Which comment.** No line carries a comment number. Node's stored comment
  is found by its text, never by its number, and a would-be duplicate cannot
  be shown to be the comment Node refused.
- **Which conversations.** No line carries a conversation number, so nothing
  is counted by conversation: many comments in one busy conversation read
  the same as the same number spread over many.
- **A comment Node stored under a different text.** It is looked for by the
  text the handler parsed and not found. It reads only as `absent` beside
  Node's 200; how the two texts differ is not shown.
- **Email and notifications.** The moderators' email for a comment awaiting
  moderation, the notification task and the author's last-interaction time
  are not read.
- **What Node did besides answer.** Whether Node created the participant,
  and what Node took the conversation's moderation to be, are not paired
  with the shadow's reading: Node writes no line of its own for a comment.
- **The write.** Observe mode stores nothing: the insert, the comment's
  number, the wait for the comment-number lock, a duplicate arriving between
  admission and the insert, the author's vote as a write and the reply
  deadline are not covered.
- **Rare texts and votes.** Texts at the length limit, with surrogates,
  control characters or surrounding spaces, and an author's vote other than
  agree, hardly occur in real comments.
- **Requests Node refused before its router.** Their access line names no
  route; they are counted as observations with no Node line and never
  judged. Only where nginx's status for one is not what the handler would
  answer does the report say so (EXAMINE).

## Unproven in a given account

The comment route's join also uses `min()` and an `or` of conditions inside
an `and` inside a `sum()`, and both routes use `bin(5m)`. Whether Logs
Insights limits the rows of a first `stats` stage is not known; the slices
make it not matter.

The queries use two `stats` stages, `sum()` of conditions, `in [...]` inside a
`sum()`, `like` inside a `sum()`, `toMillis(@timestamp)`, `count_distinct`, and
percentiles of a quoted number (`edge_upstream_s`). The tests run the same
queries through an evaluator with Logs Insights' documented semantics (`eval.rs`:
JSON fields flattened with dots, a JSON `null` treated as absent). Where an
account behaves differently, the tool is built to report the query as
refused or to withhold the join (each slice's total against `edge_bins`).
That has not been shown against the service: a difference in how a condition
on an absent field is summed, or in how a boolean is returned, would pass
both checks, so the first run in an account is to be checked against counts
taken by hand.

## Adding a route

A shadowed route is an entry in `route.rs` (`Route`: its selector name, route
string, method, path and kind). The filters are built from those names, and
the allowlist test runs over every entry's queries. A route whose lines carry
other fields than an existing kind's gets a query set and a report of its own,
as comments have (`route_comments.rs`, `report_comments.rs`).
