# D07 rollback groundwork and observation boundary

This is a plan plus a runnable **boundary harness**, not the full rehearsal.
The reviewed rev6 migration remains unchanged. Full D07/T04–T08 acceptance is
blocked on D06 independent read-only operation observation and its separately
reviewed authority. Do not give the observer control/publisher membership or
turn a privileged test driver's query into an independent observer receipt.

`boundary.py` inventories the two tracked public battery inputs, pins the seven
cached images by content ID/platform, then executes 17 ordered real PostgreSQL
controls. It installs the existing 21 migrations only in a disposable local
project. Missing images or changed inputs fail; there is no build, pull, input
map, private fallback, or migration amendment. Only PostgreSQL executes: the
other six images are inventoried for the future rehearsal.

The negative controls precede the successful transition: an ordinary control
login cannot invoke the operator transition; absent coherent fallback refuses.
The tiny SQL metadata fixture contains empty objects, deliberately not science
output. A P→L transition reticks all four rows above the old P token and removes
the Python dispatch capability. The stale admission refuses. These are SQL
controls, not a Python-child publication or Clojure/HTTP execution claim.

Two further counterexamples prevent a false kill-switch claim:

- The admitted operation remains pending after transition, and reconciliation
  without an exact receipt remains unresolved. It is not successful drain.
- The unchanged production acquire SQL can reacquire the Python lease with a
  new epoch. Lease withdrawal alone is not a restart or credential fence.

Finally, a mapped login with no writer authority receives SQLSTATE 42501 reading
operation metadata; the publisher can read it but also execute publication.
The schema catalog seal remains identical. The harness stops there: no observer
role grants, policies, functions or rev7 draft are introduced.

## Run and verify

Use the existing environment with psycopg2 and Docker. Choose an unused project
and port, and a new output directory outside the checkout:

```sh
COMPOSE_PROJECT_NAME=p027-d07-boundary-example \
POLIS_RECOVERY_PG_PORT=56227 RECOVERY_PG_PORT=56227 \
python -B coordinator-rs/tools/d07/boundary.py --output /tmp/p027-d07-boundary-example
```

Expected result: exit **2**, `status: BLOCKED`, 17 boundary controls, zero owned
resources. An unexpected exception/failed control is a failure, never the
expected boundary result. The runner retains the command log, resolved compose
file, migration/source/input/image hashes and ordered results.

```sh
python -B coordinator-rs/tools/d07/verify.py /tmp/p027-d07-boundary-example --controls
```

Expected result: verification exit 0, 17 boundary controls and 12 receipt refusal
controls; D07 still BLOCKED. This does not authenticate a forged receipt or
replace review of the retained commands. Verify source digests against the
reviewed handoff as well. Historical D05/required-campaign results remain
separate evidence; this harness does not rerun or supersede them.

## Work order after the boundary is released

Use only `vw` (4,683 vote events) and `biodiversity` (29,802), each at quarter,
half and full cuts. Retain each public CSV hash, row/cell/participant/comment
census, CSV second-resolution limitation, and export-sign-to-storage conversion.
Do not resample or multiply the public battery to imply production capacity.
Record actual source rows after each cut, including duplicate/revote handling.
Future arrivals are the remaining suffix of that same public battery.

Resolve all cached tags to immutable image IDs before starting any service.
Bind read-only source mounts, executable digests, Python/Rust/JVM/Node versions,
OS/architecture/BLAS, PostgreSQL settings and all 21 SQL hashes. Cached image
identity alone cannot attribute mounted runtime code. The Clojure image must
execute its real DB poller and publisher; replay-only output or Python rows
copied to L cannot establish rollback to Clojure. Match same-platform science
and served comparisons; compare decompressed JSON, not gzip containers. Preserve
array order and the already admitted lifecycle-specific clock rules.

Start with the current single coordinator, serial per-conversation work and
fresh Python science process. Pin shard allowlists, worker/cache settings and
CPU/memory limits; describe this scope honestly. Warm or multiple-worker
capacity remains unadmitted until its own campaign is dispatched. Measure source
catch-up, drain, compute, publication/lock waits, restart, HTTP latency/error
counts, DB/process CPU/memory and maximum pending age. Numerical release budgets
must be explicitly admitted before capacity can PASS; unset budgets block.

| Phase | Failing control first | Real execution and retained evidence |
|---|---|---|
| T04/P preparation | Missing cut or dormant conversation must refuse coverage | Actual bridge consumes both input allowlists at every cut; retain source census, publication identity and D06 observation completeness |
| T05/legacy exclusion | Old session and reconnect can still write if only its process was stopped | Exercise process/backend exclusion plus external legacy credential/network isolation under the reviewed isolated-shadow rule; no new policy on existing math tables; retain denied writes and restart configuration |
| T06/P reader switch | Config-only switch with old L ETag yields the known incorrect 304; one surviving L replica is detected | Reuse D05's real app and per-lifecycle cold/warm/prefetch, auth/report/CSV tests; floor and republish P, replace every reader, require old ETag→200/new token and current token→304 |
| T07/continued input | Skip a public suffix and the source census/lag check must fail | Feed the next suffix while P serves, keep Clojure shadow externally isolated, retain current source and coherent outputs without equating the two engines' science |
| T08/kill and recompute | Withdrawal-only permits reacquisition; missing exact publication receipt cannot become successful drain | Stop admission/renewal/restarts, remove Python publication access, drain or terminate known backends, retain every operation's outcome via the admitted observer; restart real Clojure on current durable source in L and verify coherence before reader routing |
| T08/content recovery | Restore only main or an old tick and the coherent/ETag checks must fail | Restore Clojure's own coherent four-row snapshot under exclusion, retain all post-snapshot source votes, catch up through the real Clojure process, establish ticks above last P, then replace all readers |
| T08/served return | Undrained P reader, stale child, old credential reconnect or no tick floor must fail | Compare each L HTTP lifecycle against that same L publication, prove old P ETag→200 and new L ETag→304, record denied stale publication/reconnect and no mixed Bundles |

The test controller may use administrative connections to provision and tear
down its owned database and to capture diagnostic process/catalog snapshots.
Those credentials are not the observer. Independent pending-work scope and
zero unresolved-lost outcomes need D06's read-only role plus completeness and
delivery receipts. A test intentionally leaving work unresolved demonstrates
refusal; it must not count as a successful rollback scenario.

Each future phase receipt must bind source/image/SQL/profile/input hashes,
process/container/backend identities, source cuts, operation/epoch/transition
identities, served-body/header artifacts, numerical measurements and budgets,
exact positive/negative case inventory, and owned cleanup. Record both recovery
paths separately. Missing, skipped, stale or mismatched evidence blocks the
phase. No production transfer, private science admission or O1/O8/full-gate
closure follows from this public groundwork.
