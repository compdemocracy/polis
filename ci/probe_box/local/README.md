# Run the worker before a bake

`rehearse_worker.py` runs the current checkout's worker on Linux with public
fixtures. Use it after a worker, relay, daemon or failure-reporting change and
before preparing a new AMI. It fails on stage errors, wrong failure readback or
surviving regression controls. It never launches an instance or calls AWS.

Requires an ARM64-capable Docker daemon with privileged containers and private
cgroups (Docker Desktop on Apple Silicon works), Compose, Python 3 and OpenSSL.
The pipeline host also requires the existing fixture generator dependencies;
reuse the public-image test environment. The provisioner uses the pinned
psycopg2 dependency inside the isolated runtime network.
The initial runtime build installs the existing pinned bake requirements; it
needs package-network access. Execution uses an internal Compose network; nested
candidate containers use the real `--network=none` sandbox. Do not run this on a
production host. Do not supply production data or mount cloud credentials.

Choose a new project, unused loopback PG port and **new** results directory:

```sh
COMPOSE_PROJECT_NAME=p027worker-mychange \
POLIS_RECOVERY_PG_PORT=55881 RECOVERY_PG_PORT=55881 \
python3 -B ci/probe_box/local/rehearse_worker.py \
  --results /absolute/private/worker-mychange
```

With no archive argument it builds three public-fixture OCI archives from local
bash/Python/libpq binaries, following `rehearsal.py`'s small-rootfs approach. The
reader connects as `polis_probe_reader`, producer checks and transforms a fixed
value, and verifier independently checks both and emits a valid job-bound
receipt. This tests plumbing, not engine certification.

To additionally exercise the reviewed census images, supply a directory
containing `reader.oci.tar`, `producer.oci.tar`, and `verifier.oci.tar`:

```sh
COMPOSE_PROJECT_NAME=p027worker-census \
POLIS_RECOVERY_PG_PORT=55882 RECOVERY_PG_PORT=55882 \
python3 -B ci/probe_box/local/rehearse_worker.py \
  --results /absolute/private/worker-census \
  --archives /absolute/private/roles-census-release
```

Expected manifest digests come from this checkout's `jobs.json`, never from a
mutable tag or caller-provided digest. `worker.load_image()` checks the actual
archives, Skopeo verifies the layers, and Docker runs the resulting config IDs.
The archive directory remains read-only. The PostgreSQL 17 fixture has an
isolated ephemeral CA/server certificate, plus the public role/grant layout
from `roles_rehearsal.py`. The reader uses the real `ReplicaSocket` TLS relay;
its own container has only the Unix socket mount, not TCP access.
Host connections require SCRAM-SHA-256 with an explicitly seeded public fixture
password; the worker writes that password into the reader's real pgpass file.
The rehearsal first observes the PG17 mechanism offer over a direct verified
TLS connection and requires both `SCRAM-SHA-256-PLUS` and `SCRAM-SHA-256`.
A wrong-password control must fail. No host trust-authentication shortcut is used.

`--job sampled-paired-battery-v1` without `--pipeline` retains the small
catalog seed and therefore tests the real extractor's missing-data failure.
Use `--pipeline` with the admitted public-image archive directory to seed the
unchanged initial application schema with public VW/biodiversity vote patterns,
declared revote/moderation/meta/ban variants, sixteen large-rank candidates,
and the existing generated participant/dense boundary cases:

```sh
COMPOSE_PROJECT_NAME=p027worker-pipeline-review \
POLIS_RECOVERY_PG_PORT=55556 RECOVERY_PG_PORT=55556 \
python -B ci/probe_box/local/rehearse_worker.py --pipeline \
  --results /absolute/private/pipeline-review \
  --archives /absolute/private/paired-release \
  --runtime-image local-worker-runtime
```

The default population has 26 conversations and 1,086,247 vote events. All
seventeen selection predicates are satisfiable by these public database rows;
the representative sampler still chooses its real twenty entries. Source CSV
signs are translated back to PostgreSQL signs, source row order is preserved,
and local identities/timestamps replace source coordinates. Comments contain
neutral fixture text; these are declared fixture variants, not unmodified
public conversation histories or a production data sample. Initial-schema
constraints/indexes remain; only participant/comment ID-allocation triggers
are disabled during the owned load and reenabled before reading.

`--pipeline-replacements` deliberately leaves out the dense DB case, exercising
the config's already approved replacements for both dense roles. It must not
relax manifest admission. The v4 reader exposes missing ordering/compatibility
metadata on that path; the fixed reader must admit it without changing a rule.
A failing run is retained as a failure, never converted to PASS.

The pipeline seeds application tables before invoking `provision_login.provision()`
itself over verified TLS. The fixture reader receives the production six-table
SELECT grants and role settings. The runtime asserts `current_schema() = pg_catalog`,
`search_path = pg_catalog, public`, `default_transaction_read_only = on`, and
`statement_timeout = 30min`, recording them in `reader-session.json`. The separate
catalog-census fixture retains its reviewed grants and applies the exact same
three ALTER ROLE settings. A default-public search path cannot hide extractor
column-discovery failures in either mode.

`pipeline-seed.json` records public input hashes and each rule's coverage.
`pipeline-reader/` retains the actual reader's manifest/config/plan and payload
census when available; `admitted-archive-three-stages-receipt.json` is the real
closed receipt. Missing receipt, reader error, science failure or INCOMPLETE
makes the rehearsal fail. The word "production" in the immutable reader's
source labels means its database-extract path; this harness's database is
exclusively public fixture data and proves no production coverage.

A previously built `worker.Dockerfile` image may be reused with
`--runtime-image <local-image>`. Source is mounted afresh each run. Rebuild when
bake packages or Python requirements change. The runtime must match the bake's
Docker/Skopeo/Python requirements; a PASS is not a new runtime admission.

When the relay fix is in a separate pending worktree, add
`--relay-source /absolute/worktree/ci/probe_box/replica.py`. The harness saves
and hashes those exact bytes, mounts the copy read-only, and verifies both the
original and mounted copy at completion. `relay-source.json` identifies the
source; this is explicit combined-candidate evidence. By default the relay comes
from the current checkout. An unfixed relay fails the positive reader stage
with `PG_SSL`; the rehearsal must not pass until the relay rewrite is included.

## What is exercised

* The exact `docker.json` and Skopeo policy extracted from `bake.sh`, a private
  daemon socket/data-root/containerd root on `nodev,nosuid,noexec` storage, with
  default daemon roots unchanged.
* Root worker execution with umask 0077, HOME=/root and TMPDIR=/probe-work/tmp;
  real nonroot candidate sandboxes, bind permissions, read-only input and rootfs.
* Unmodified `worker.run()` stage orchestration, image import, reader/producer/
  verifier mounts, receipt validation, failure handler and heartbeat thread.
* Real PostgreSQL 17 TLS/SCRAM and relay outcomes `plain_scram`, `relayed`,
  `tls_verify`, `connect`.
* A deliberate reader exception, `last_exception_token`, a closed `ENOENT`
  reason, the worker's actual failure record in MinIO's heartbeat key, and
  `run.py`'s `Session.status()` readback as complete/failed with that record.
* Private scratch copies reverting shared-directory chmod (must reproduce
  `PG_SERVICE_FILE` with an empty relay summary) and replacing missing-receipt
  failure readback with `RECEIPT_READ_UNKNOWN` (must fail the positive check).
* A private scratch relay restoring raw upstream forwarding: the reader must
  fail with `psycopg2.OperationalError`, `PG_SSL`, and exactly `relay={relayed:1}`.
  The failure must reach MinIO's heartbeat and the operator's status readback.
  Production sources are never changed by these controls.

`report.json` lists passed checks; `commands.json`, source hashes and local logs
retain the execution evidence. An unsuccessful attempt exits nonzero and keeps
its logs. The command tears down only its own project in `finally` and records
zero remaining owned containers/networks/volumes. A forced host kill may require
manual `docker compose ... down -v` for that exact project. Generated test TLS keys
are temporary and are removed; they do not enter results. Results are private
because runtime logs are diagnostics, not admitted exports.

## Deliberate local substitutions

The runtime adapter supplies fixture metadata and a public fixture secret,
intercepts shutdown (the outer harness disposes the stack), lowers CPU/memory
to two CPUs/eight GiB per candidate
and disk-reserve ceilings, and strips the two AWS KMS headers unsupported by
this MinIO. Image streams come from the mounted OCI archives instead of an S3
asset download; control objects, heartbeats and receipts use real MinIO S3.
The operator starts from a locally prepared CLEAN register to test readback;
there is no EC2 lifecycle, deployed IAM, endpoint, KMS, DNS/firewall or AMI
boot proof. Systemd itself is not run: its worker environment and daemon config
are reproduced. The earlier missing-evidence ListBucket incident was an IAM
error; this harness must not be described as proving deployed ListBucket access.
