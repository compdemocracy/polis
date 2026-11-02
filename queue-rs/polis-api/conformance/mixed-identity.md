# Mixed participant admission

`bash queue-rs/polis-api/conformance/mixed-identity-run.sh` starts disposable
Postgres and DynamoDB containers, the unchanged Node server and polis-api,
a local generated-key OIDC provider, and a test-only Rust admission worker.
Set unique `COMPOSE_PROJECT_NAME`, `MIXED_PG_PORT`, `MIXED_DYNAMO_PORT`,
`MIXED_NODE_PORT`, `MIXED_API_PORT`, `POLIS_MIXED_WORKER_PORT` and
`MIXED_PROVIDER_PORT`. Node dependencies and Docker images must already be
installed. Cargo builds from the current source. Use `CARGO_NET_OFFLINE=true`
when dependencies are cached. Only loopback service endpoints are used.

CI runs eight callers per case, one round. `MIXED_FULL=1` selects 200 callers
per case and three rounds, split equally between writers. Inputs are generated
from the case, round and caller index. Every round uses a fresh conversation.
The first admission wave is synchronized with the unchanged topical
next-statement guard. Failure stops offered work; requests are never retried.
Artifacts include per-caller outcomes, committed-row audit evidence, sampled
lock waits, aggregate numbers and the unchanged guard's output. Cleanup removes
only the owned compose project and native processes, and deletes private keys.

The Rust worker calls `polis_auth::admission::admit` and `oidc::provision` with
16 primary connections. There is no Rust first-vote serving handler on this
base. The test mints tokens after admission commits, using the real key loader
and the recorded Node claim set. Both writers' votes go through the real Node
route and vote convention module. The unchanged polis-api reads back anonymous
participants' votes. This is admission-library interoperability under load,
not a claim of Rust first-write HTTP parity or serving readiness.

Anonymous and unique bare-XID callers must have a one-to-one token/member
relationship. Repeated calls for the same OIDC subject must converge on one
UID, mapping and participant: multiple callers intentionally share that row.
Node uses the provider token without returning a participant JWT for OIDC;
Rust's test adapter returns a generated participant JWT. Every minted token is
checked by Node's actual JWT middleware and Rust's request verifier, and mapped
to a committed member. Invite contention permits exactly one successful accept;
Node's pre-consumption user/member writes are separately counted as the known
partial-state delta. Rust losers must leave no orphan or stranded membership.

Lock statistics are **sampled wait episodes**, classified by the allocator's
advisory lock key or the invite SQL, with a nominal 5 ms sampling interval.
Sub-interval waits can be missed. p50/p99 are not precise per-acquisition
percentiles; null means no episode was observed, not zero contention. Total
caller latency and Rust admission duration provide conservative upper bounds
on their contained waits. Participation retains the existing 5000 ms budget
and 10000 ms client give-up boundary. The guard's own budget is unchanged.

The guard owns a separate database on the same Postgres instance: its existing
`pg_stat_activity` assertion counts *all* idle transactions in its database as
result snapshots. Admission transactions would invalidate that fixture
assumption. Node, Rust admission and polis-api share the other database.
Twelve existing-participant votes, twelve comments and twelve next-statement
requests per wave additionally exercise the live Node process and that shared
database; vote/comment rows are reconciled before the next wave.

The first wave holds the allocator's session advisory lock until the guard has
measured its next-statement read. Invite waves briefly park both writers on the
same invite row before release, making the known Node race reproducible. Both
barriers have a five-second limit, and their waits are included in the reported
latencies. Other admission waves have no injected blocker. These are finite
contention tests, not steady-state capacity measurements.

Run `bash scripts/test-polis-auth.sh` with its required disposable database and
`bash scripts/test-delphi-result-reads.sh --ci` with its required unique project
and ports as independent controls. The existing authority CI job retains its
full suite; the mixed admission workflow runs this stack's small profile.
