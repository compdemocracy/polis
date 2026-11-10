# Comparing Node's answers with the vote writer's shadow

`polis-shadow` reads the log lines written for every vote that nginx copies to
the read-only Rust shadow service (`votesShadow` in `RUST_API_ROUTES`), joins
them by nginx's request id, and prints aggregates and a verdict: how many votes
were copied and observed, how many the Rust writer would have admitted and why
it would have handed the rest back, whether its would-be status, stored vote,
next statement and counts agree with what Node actually did, the shadow's
latency, and the stop rule's inputs. It never prints a request id, a
conversation or statement number, a participant or any text, and it writes
nothing.

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
| `vote_reply` | Node's vote handler (`server/src/routes/votes.ts`), only for a request carrying nginx's `X-Request-Id` | `node_status`, `node_next` (`statement`, `topical` or `none`), `node_next_tid`, `node_remaining`, `node_total`, `zid` |
| `http_request` | Node's access line, which carries `request_id` for such a request (`server/src/server-middleware.ts`). Its `message` is written `"http_request http_request"` (winston appends the meta's `message`); the queries accept both spellings, and a test refuses a query that tests the single one | `http.status_code`: Node's answer when its middleware refused the vote before the handler; for every vote (with or without a request id), `http.route`, `http.status_code` and `duration_ms` for the stop rule's vote inputs |
| `shadow_observation` | the shadow service (`queue-rs/polis-api/src/shadow.rs`) | `outcome`, `admitted`, `status`, `reason`, the durations, `follow_on`, `next_tid`, `remaining`, `total`, `prev`, `node_vote` |

None of the five carries a vote value. Every container on a web box writes into
one log stream; each line above says whose it is (`listener: "shadow"`, or
Node's `service: "server"`).

## The queries, and what may leave AWS

The tool runs only the Logs Insights queries compiled into its route table
(`route.rs`); no command accepts query text. `polis-shadow queries` prints them.
Each is a filter, optional computed fields and one or two `stats` stages:

- the one-stage queries count lines by class (outcome, reason, status, the
  readback and membership classes) or take percentiles of durations;
- the join's first stage groups each request id's lines into one row inside
  Logs Insights and never leaves AWS; its second stage counts requests in each
  class, grouped only by Node's status and the shadow's would-be status.

A test fails if any query's final stage groups by anything outside an allowlist
of class and status fields (`query.rs`, `GROUP_ALLOWLIST`), takes a maximum or
percentile of anything but a duration, counts on a request id, participant,
vote, address or text, or if a first stage groups by anything but the request
id. Only the window's two bounds are filled in at run time, as integers.

**What leaves AWS in a default run: the aggregate rows of those queries
(counts, shares, percentiles) and the CloudWatch datapoints below; nothing
else.** With `--distributions` the tool also fetches, for the weights test,
the number of paired draws per conversation number and statement number. Those
rows stay in the tool's memory; only the combined statistic is printed. Nothing
is written to disk.

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
  --load-balancer <app/name/id of the web load balancer> \
  --distributions
```

The window is at most eight days. The join reads 60 seconds past each bound
(a request's lines are written up to the shadow's readback retry apart) and
counts only votes whose nginx line falls inside the window. One week of the
server log group is a few gigabytes per query scanned; the run prints the
total.

`polis-shadow report --route votes --results <dir>` prints the same report
from results saved as `<query>.json` (`get-query-results` output) and
`metric-<name>.json` (`get-metric-statistics` output).

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
8. **Draw distributions** (`--distributions`): for each copy that both Node and
   the shadow served with a statement, Node's draw and the shadow's draw for
   the same request; a chi-square of homogeneity per conversation (statements
   drawn fewer than ten times in all pooled), summed over conversations with at
   least 200 paired draws and tested once.
9. **The criteria and the verdict.**

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
| Weights | the combined test not rejected at 0.01 |
| Writer latency | admission p99 at most 100 ms, total p99 at most 400 ms |
| Follow-on and admission | `degraded` at most 1 % of admitted would-be 200s; no `admission_timeout` |
| The stop rule | never fired |

The verdict is STOP if any criterion is a stop, then TOO LITTLE EVIDENCE if
any is short or not evaluated, then EXAMINE if any other criterion missed,
else PASS. Every miss is examined before the flip.

## What it cannot compare

- **The drawn statement itself.** Node and the shadow draw independently at
  random, so an equal pick is luck; sets, counts and distributions are
  compared instead.
- **Membership** detects only a candidate set that is too small, and about
  half of next votes land on the other web box (`prev: none`).
- **Ticks.** Draws are paired by request, so both sides are usually on the
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

## Unproven in a given account

The queries use two `stats` stages, `sum()` of conditions, `in [...]` inside a
`sum()`, `like` inside a `sum()`, `toMillis(@timestamp)`, `count_distinct`, and
percentiles of a quoted number (`edge_upstream_s`). The tests run the same
queries through an evaluator with Logs Insights' documented semantics (`eval.rs`:
JSON fields flattened with dots, a JSON `null` treated as absent). Where an
account behaves differently, the run reports the query as refused, or the
join's self-check withholds the comparison; it does not print a different
number.

## Adding a route

A shadowed route is an entry in `route.rs` (`Route`: its selector name, route
string, method and Node line). The queries are built from those names, and the
allowlist test runs over every entry's queries.
