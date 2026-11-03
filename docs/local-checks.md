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
| CLI | `scripts/test-polis-cli.sh` | Python 3.12, pinned Rust |
| CLI differential | `make check-polis-cli-differential` | pinned Rust, Python 3, Docker |
| Mixed identity | `make check-mixed-identity` | Node 24.22.1, pinned Rust, Docker |
| Identity recordings | `make check-identity-recordings` | Docker, pinned Rust, Python 3 |
| Treevite recordings | `make check-treevite-recordings` | Docker, Python 3 |
| Comment recordings | `make check-post-comments-recordings` | Docker, Python 3 |
| Collective statements | `make check-collective-statement-recordings` | Node 22.23.4, Python 3.12, PostgreSQL 17.11, DynamoDB Local |
| Delphi characterization | `make check-delphi-characterization` | Node 22.23.4, Python 3.12, PostgreSQL 17.11, DynamoDB Local |
| Routing recordings | `make check-routing-recordings` | Node 22.23.4, PostgreSQL 17.11 |
| Server integration | `make check-server-integration` | Node 22.23.4, Python 3, mkcert, Docker |
| Delphi result reads | `bash scripts/test-delphi-result-reads.sh --ci` | Node 24.22.1, pinned Rust, Docker |
| Delphi writers | `bash scripts/test-dynamo-writers.sh` | Docker |
| Importer | `bash scripts/test-production-import.sh` | Docker, Python 3 |
| Dynamo removal | `make check-dynamo-removal` | Node 22.23.4, Python 3.12, pinned Rust, Docker |
| Embeddings table | `make check-embeddings-table` | Python 3.12, pinned Rust, Docker |
| TLS trust | `make check-tls-trust` | Python 3, Docker; Node 22.23.4 for server selection |
| Clojure math | `cd math && clojure -M:test` | Java 16.0.2, Clojure CLI 1.10.1.693 |
| Test images | `bash ci/local/test-images.sh build --tag TAG` | Docker Buildx |
| E2E shard | `bash ci/local/e2e.sh --shard I/6` | Docker, Node/npm, Python 3, mkcert |
| E2E combine | `bash ci/local/e2e.sh combine DIR...` | Python 3; all six shard receipts |
| Delphi shard | `bash ci/local/delphi-python.sh --shard I/6` | Docker, Python 3 |
| Delphi combine | `python3 ci/tests/test_delphi_python_results.py` then `bash ci/local/delphi-python.sh combine DIR...` | Python 3; all six shard receipts |

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
`RESULT_READS_DYNAMO_PORT`. Refer to the existing script's usage for each.

Set `OUT` and `VOTE_GATE_PG_PORT` for the two-convention gate. Its advisory v1
comparison may fail, just as the hosted step has `continue-on-error`; the v0
check and v1 ratchet remain required. TLS is a twelve-image matrix: set one
`TLS_IMAGE_SELECTION` from the workflow and an owned `TLS_IMAGE_TAG`, and run
every leg. The server leg also runs the backup-package tests.

Server integration needs an owned `RUNNER_TEMP`, `POLIS_TEST_IMAGE_TAG`,
Compose project and database port. It generates certificates and edits only
the disposable checkout's test environment. Other service ports follow the
existing test stack. It retains the original 60-iteration readiness loop,
contract generation check, migration check and Jest arguments. A redundant,
nonfatal AWS CLI localhost diagnostic is omitted; Dynamo readiness still uses
the same HTTP request. No cloud account is needed.

For E2E use an exclusive host with the fixed stack ports free. Set
`E2E_CHECK_PROJECT` and `E2E_CHECK_OUT` per shard, and leave `E2E_CHECK_KEEP`
unset so each owned stack is removed. Delphi shards use `DELPHI_CHECK_PROJECT`
and `DELPHI_CHECK_OUT`; leave `DELPHI_CHECK_KEEP` unset. Build or load the
exact pinned images first and set `POLIS_TEST_IMAGES` to the owned image tag.
Combine only complete six-shard receipts; a missing shard is a failed check.

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
