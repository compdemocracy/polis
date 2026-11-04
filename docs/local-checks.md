# Local verification commands

Run these commands from a disposable checkout. Workflows delegate their work to
the same scripts, keeping runtime setup, event conditions, service provisioning,
artifact transfer and publication in Actions. Missing prerequisites fail the
check. No command reduces the test selection or changes an assertion.

| Job | Entry point | Runtime / services |
| --- | --- | --- |
| Participation alpha | `make check-client-alpha` | Node 24.22.1 |
| Admin | `make check-client-admin` | Node 24.22.1 |
| Report | `make check-client-report` | Node 24.22.1 |
| ESLint | `make check-lint` | Node 24.22.1 |
| Provenance | `make check-job-provenance` | Node 22.23.4 |
| Job views | `make check-job-views` | Node 22.23.4, UTC |
| Vote-sign lint | `make check-vote-sign-lint` | Python 3, Git index |
| Two storage conventions | `make check-vote-conventions` | Node 22.23.4, Python 3.12, Docker |
| Coordinator | `make check-coordinator` | Node 24.22.1, Python 3.12, pinned Rust, Docker, full Git history |
| Queue | `make check-queue-rs` | pinned Rust, Python 3, PostgreSQL 17 |
| Authority | `bash scripts/test-polis-auth.sh` | pinned Rust, PostgreSQL 17 |
| API | `make check-polis-api` | pinned Rust, Python 3, PostgreSQL 17, Docker |
| Migration runner | `make check-polis-migrate` | Node 22.23.4, pinned Rust, Docker |
| Job graphs | `make check-job-graphs` | Node 22.23.4, pinned Rust, Python 3, Docker |
| CLI | `make check-polis-cli` | Python 3.12, pinned Rust |
| CLI differential | `make check-polis-cli-differential` | pinned Rust, Python 3, Docker |
| Mixed identity | `make check-mixed-identity` | Node 24.22.1, pinned Rust, Docker |
| Identity recordings | `make check-identity-recordings` | Docker, pinned Rust, Python 3 |
| Treevite recordings | `make check-treevite-recordings` | Docker, Python 3 |
| Comment recordings | `make check-post-comments-recordings` | Docker, Python 3 |
| Collective statements | `make check-collective-statement-recordings` | Node 22.23.4, Python 3.12, PostgreSQL 17.11, DynamoDB Local |
| Delphi characterization | `make check-delphi-characterization` | Node 22.23.4, Python 3.12, PostgreSQL 17.11, DynamoDB Local |
| Nginx production upstreams | `make check-nginx-upstreams` | Python 3.12, gettext envsubst |
| Routing recordings | `make check-routing-recordings` | Node 22.23.4, PostgreSQL 17.11 |
| Route census | `make check-route-census` | Node 22.23.4, Docker; owned Compose project, three distinct ports below 49152 and server/PostgreSQL/OIDC image tags |
| Server integration | `make check-server-integration` | Node 22.23.4, Python 3, mkcert, Docker |
| Delphi result reads | `make check-delphi-result-reads` | Node 24.22.1, pinned Rust, Docker |
| Delphi writers | `make check-dynamo-writers` | pinned Rust, Docker |
| Importer | `make check-production-import` | Docker, Python 3 |
| Dynamo removal | `make check-dynamo-removal` | Node 22.23.4, Python 3.12, pinned Rust, Docker |
| Embeddings table | `make check-embeddings-table` | Python 3.12, pinned Rust, Docker |
| TLS trust | `make check-tls-trust` | Python 3, Docker; Node 22.23.4 for server selection |
| Clojure math | `cd math && clojure -M:test` | Java 16.0.2, Clojure CLI 1.10.1.693 |
| Test images | `bash ci/local/test-images.sh build --tag TAG` | Docker Buildx |
| E2E shard | `bash ci/local/e2e.sh --shard I/6` | Docker, Node/npm, Python 3, mkcert |
| E2E combine | `bash ci/local/e2e.sh combine DIR...` | Python 3; all six shard receipts |
| Delphi Python tests: images, six shards, combine | `make check-delphi-python-tests` | Docker Buildx, Python 3 |

The unchanged golden guards remain separate jobs: invoke
`sh ci/vote_path_golden_guard.sh BASE` and
`sh ci/collective_statement_golden_guard.sh BASE`. Comment, routing and job-view
PR guards run inside their entrypoints when `GITHUB_EVENT_NAME=pull_request`.
Set `CHECK_BASE_REF` to the actual comparison ref for the comment guard. A push
run and a pull-request run are different inputs; do not claim one for the other.

Use the exact service image/digest and configuration in the corresponding
workflow. GitHub service containers are prerequisites, not created implicitly
by the extracted shell scripts. Supply `POLIS_JOBS_TEST_DATABASE_URL`,
`POLIS_AUTH_TEST_DATABASE_URL`, and `POLIS_API_TEST_DATABASE_URL` to the jobs
that use them. Authority and queue databases are separate. The collective and
Delphi characterization safety checks require their fixed localhost ports and
fixture stores; use an exclusive environment for these jobs. Set
`CHECK_DYNAMODB_NAME` to an owned container name. An isolated container runner
can set `CHECK_DYNAMODB_NETWORK=container:OWNED_POSTGRES_CONTAINER` to put
DynamoDB beside its PostgreSQL fixture; the fixed safety ports then remain
inside that owned namespace and any published PostgreSQL port can be unique.

For Compose jobs choose an unused `COMPOSE_PROJECT_NAME`,
`POLIS_RECOVERY_PG_PORT` and matching `RECOVERY_PG_PORT`. Preserve each existing
script's required name prefix. Before starting, verify every image name, port,
container and output directory belongs to this run. Never reuse another run's
project. The entrypoints refuse occupied Compose projects before registering
cleanup. Existing scripts retain their own safety checks.

The route-census target regenerates `server/characterization/inventory.json`
with the existing extractor and prints a route summary, regeneration command and
unified diff on any byte difference.
It retains the recorded extraction commit while checking the source hash and
all route fields. It then starts the characterization server and runs
`cli.cjs coverage` against its mounted routes. Set `COMPOSE_PROJECT_NAME`,
`POLIS_RECOVERY_PG_PORT`, `P027_HTTP_PORT`, `P027_CONTROL_PORT`,
`P027_SERVER_IMAGE`, `P027_POSTGRES_IMAGE` and `P027_OIDC_IMAGE` as in
`route-census.yml`, using owned names and distinct ports below 49152 on every
platform. Readiness and database connections stay on the internal Docker network;
any host-side database probes must use `127.0.0.1`. The target removes its Compose
services and volumes on exit.

Any edit to `server/app.ts`, even a comment, changes the census source hash or
registration lines: after installing dependencies in `server/`, regenerate from
the repository root with the command below and commit `inventory.json` in the
same change.

```sh
out="$(mktemp -d)/census" && node server/characterization/route-inventory.cjs . server/characterization/inventory.json "$out" "$(git rev-parse HEAD)" && cp "$out/inventory.json" server/characterization/inventory.json
```

Recording jobs use `P027_SERVER_IMAGE`, `P027_POSTGRES_IMAGE`,
`P027_OIDC_IMAGE`, `P027_FILE_SERVER_IMAGE`, `P027_SOURCE_COMMIT`,
`P027_PORT_MIN`, `P027_PORT_MAX`, `P027_HTTP_PORT` and `P027_CONTROL_PORT` as
shown by their workflows. Set the image variables to owned tags. The API job
also accepts `POLIS_API_TEST_IMAGE`, `POLIS_VERSION_SERVER_IMAGE`,
`IMPORTANCE_PROJECT`, `IMPORTANCE_PG_PORT`, `IMPORTANCE_API_PORT`,
`IMPORTANCE_OFF_PORT`, and `X54_NGINX_PREFIX`. Its defaults retain the hosted
names; on a shared Docker host supply unique values. Before any tests or builds,
the API job derives `GITHUB_SHA` from the full checked-out commit using Git
when it is unset or empty; an explicitly supplied hosted SHA is preserved.
Local runs therefore need a real Git checkout or an explicit `GITHUB_SHA`.
CLI differential needs
its `CLI_DIFF_*_IMAGE` variables and an independent `SETUP_ADMISSION_PROJECT`.
Mixed identity uses all six `MIXED_*_PORT` / `POLIS_MIXED_WORKER_PORT` values.
Result reads uses `RESULT_READS_PROJECT`, `RESULT_READS_PG_PORT` and
`RESULT_READS_DYNAMO_PORT`. Delphi writers needs a `polis-graph-test-` project
and the importer a `polis-import-test-` project, each with
`POLIS_RECOVERY_PG_PORT`. Their proof logs go to `.ci-out/<project>`, which
must not exist yet: a rerun needs a new project or that directory removed.
Result reads and Delphi writers refuse to start while a container (or, for
the writers, the cargo volume) that their launchers create and remove already
exists. The writers target removes the cargo volume it created and fails if
Docker cannot confirm the volume is gone. These checks belong to the make
targets: the launcher scripts called directly, as the hosted workflows call
them, still remove those container names whoever created them. Refer to the
existing script's usage for each.

Set `OUT` and `VOTE_GATE_PG_PORT` for the two-convention gate. Its advisory v1
comparison may fail, just as the hosted step has `continue-on-error`; the v0
check and v1 ratchet remain required. TLS is a twelve-image matrix: set one
`TLS_IMAGE_SELECTION` from the workflow and an owned `TLS_IMAGE_TAG`, and run
every leg. The server leg also runs the backup-package tests.

Server integration needs an owned `RUNNER_TEMP`, `POLIS_TEST_IMAGE_TAG`,
Compose project and database port. It generates certificates and edits only
the disposable checkout's test environment. Other service ports follow the
existing test stack. Choose published ports below 49152 (for example 45000–48999);
the entrypoint refuses any published Compose port at or above 49152 before
setup. macOS can allocate an IPv6 ephemeral socket on a port already held by
an IPv4 container forwarder, sending database connections to a test listener
or back to themselves. The test database URLs use `127.0.0.1` to reach the
IPv4 forwarder directly; use that host for an explicit migration `DATABASE_URL`
override too. It retains the original 60-iteration readiness loop,
contract generation check, migration check and Jest arguments. A redundant,
nonfatal AWS CLI localhost diagnostic is omitted; Dynamo readiness still uses
the same HTTP request. No cloud account is needed.

For E2E use an exclusive host with the fixed stack ports free. Set
`E2E_CHECK_PROJECT` and `E2E_CHECK_OUT` per shard, and leave `E2E_CHECK_KEEP`
unset so each owned stack is removed. Build or load the exact pinned images
first and set `POLIS_TEST_IMAGES` to the owned image tag. Combine only
complete six-shard receipts; a missing shard is a failed check.

The Delphi target runs the workflow's eight jobs in order. It builds the
postgres and delphi images as `polis-test-*:$COMPOSE_PROJECT_NAME`, runs every
shard from them as project `$COMPOSE_PROJECT_NAME-shard-I`, and combines only
when all six shard processes exited 0. Results go to
`.ci-out/$COMPOSE_PROJECT_NAME`. Set `DELPHI_PYTHON_LEG` (`images`, `shard-1`
to `shard-6`, `combine`) to run one job. A job run on its own also needs
`DELPHI_PYTHON_RUN`, a run name chosen new for every run; the jobs of one run
share it and `COMPOSE_PROJECT_NAME`. The full run makes and prints one when it
is unset. The `images` job starts the run: it first removes every receipt of
the previous one, and records the run, the source identity and the image ids
only after its build succeeds. A shard job first removes its own receipt and
runs only against its run's images and an unchanged source, so it can be
retried within the run; any source change needs a new run. The combine
accepts only six shard receipts of the run it is asked for, with one source
and one image build, so receipts that a new run could not remove are refused.
If the source identity or the image ids cannot be read, the job fails. Leave
`DELPHI_CHECK_KEEP` unset.

`python3 ci/tests/test_local_entry_points.py` tests these entry points'
refusals, receipts and cleanup with stub executables; it needs no Docker. No
hosted job runs it yet.

These targets keep their own results under `.ci-out`, but some of what the
suites they run write is not confined there:
- crate targets (`queue-rs/target`, `polis-cli/target`) and
  `server/node_modules`, because the launchers run
  `queue-rs/target/debug/polis-migrate` and install with `npm ci`; result
  reads skips `npm ci` when `server/node_modules` already exists;
- the importer's launcher-mount test (`scripts/test-import-launcher-mounts.py`),
  which makes its own temporary directory and UUID-named Docker resources
  outside the caller's project, and removes them when it ends;
- host caches, which follow `CARGO_HOME`, `npm_config_cache` and
  `UV_CACHE_DIR`.
Run them from a disposable checkout with owned cache locations.

The coordinator workflow deliberately keeps its literal inline work steps:
its existing required-job control asserts those commands. The matching local
target additionally requires `COORDINATOR_TLS_PROJECT` (a unique
`coordinator-tls-` name), `COORDINATOR_TLS_PORT`, and a new `COORDINATOR_OUT`
outside the checkout. Both ports must differ and be at least 55432. Use a
clean full-history source. `CHECK_SOURCE_ROOT` can select that pristine source
when reviewing an uncommitted launcher; it changes the execution directory,
not the campaign's source checks or admission rules. The recorded platform and
compressor pins still apply. Do not substitute a different runtime or weaken
admission to claim parity.

Use a private Python environment and checkout-local Cargo targets. Unset an
inherited `CARGO_TARGET_DIR` when a harness locates binaries in its crate's
`target` directory. On Docker Desktop or Colima, put `TMPDIR` in an owned,
shared directory so TLS certificate mounts resolve. Retain exit codes, counts,
runtime versions and wall times before deleting owned stacks, volumes,
node_modules, targets and images. Release and deployment workflows are not
local verification commands.

The API entrypoint defaults `IMPORTANCE_API_IMAGE` to `POLIS_API_TEST_IMAGE`, so the final statement-importance proof uses the same image built by the job. Set either override only to images owned by this run.
