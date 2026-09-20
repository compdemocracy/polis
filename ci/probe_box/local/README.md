# Run the worker before a bake

`rehearse_worker.py` runs the current checkout's worker on Linux with public
fixtures. Use it after a worker, relay, daemon or failure-reporting change and
before preparing a new AMI. It fails on stage errors, wrong failure readback or
surviving regression controls. It never launches an instance or calls AWS.

Requires an ARM64-capable Docker daemon with privileged containers and private
cgroups (Docker Desktop on Apple Silicon works), Compose, Python 3 and OpenSSL.
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

`--job sampled-paired-battery-v1` accepts the corresponding `producer.oci.tar`
(reader and producer) and `verifier.oci.tar`. The built-in database seed is a
catalog fixture, not a full paired-battery conversation dataset: this option
intentionally reports the real extractor's failure if its tables/data are
missing. It is **not** evidence of a successful battery rehearsal. Do not fetch
private battery archives or input data as part of this command. The fully
exercised real-image path is the census release; the fallback always checks all
three public plumbing stages.

A previously built `worker.Dockerfile` image may be reused with
`--runtime-image <local-image>`. Source is mounted afresh each run. Rebuild when
bake packages or Python requirements change. The runtime must match the bake's
Docker/Skopeo/Python requirements; a PASS is not a new runtime admission.

## What is exercised

* The exact `docker.json` and Skopeo policy extracted from `bake.sh`, a private
  daemon socket/data-root/containerd root on `nodev,nosuid,noexec` storage, with
  default daemon roots unchanged.
* Root worker execution with umask 0077, HOME=/root and TMPDIR=/probe-work/tmp;
  real nonroot candidate sandboxes, bind permissions, read-only input and rootfs.
* Unmodified `worker.run()` stage orchestration, image import, reader/producer/
  verifier mounts, receipt validation, failure handler and heartbeat thread.
* Real PostgreSQL 17 TLS and relay outcomes `relayed`, `tls_verify`, `connect`.
* A deliberate reader exception, `last_exception_token`, a closed `ENOENT`
  reason, the worker's actual failure record in MinIO's heartbeat key, and
  `run.py`'s `Session.status()` readback as complete/failed with that record.
* Private scratch copies reverting shared-directory chmod (must reproduce
  `PG_SERVICE_FILE` with an empty relay summary) and replacing missing-receipt
  failure readback with `RECEIPT_READ_UNKNOWN` (must fail the positive check).
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
and disk-reserve ceilings, and strips the two AWS KMS headers unsupported by
this MinIO. Image streams come from the mounted OCI archives instead of an S3
asset download; control objects, heartbeats and receipts use real MinIO S3.
The operator starts from a locally prepared CLEAN register to test readback;
there is no EC2 lifecycle, deployed IAM, endpoint, KMS, DNS/firewall or AMI
boot proof. Systemd itself is not run: its worker environment and daemon config
are reproduced. The earlier missing-evidence ListBucket incident was an IAM
error; this harness must not be described as proving deployed ListBucket access.
