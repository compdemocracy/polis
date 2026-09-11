# Private probe box — operator mode (shape C)

The probe is driven by an active agent/operator with an SSO session. Native
infrastructure is default off and lives in the separate ProbeStack. There are
zero Lambda functions, layers, providers or CloudFormation custom resources;
no standing controller, public Actions dispatch or automatic sweep service.
Stack deployment creates a retained reader secret but never connects to a database.
The operator owns polling, alarm response and cleanup if a worker cannot shut down.

The reviewed job registry contains immutable producer/verifier image digests and
exec-form arguments. It is currently empty; publish reviewed, admitted OCI archives
before adding a real job. No placeholder release is usable. Every target source
revision in a build/admission receipt must be the full 40-character commit SHA.

## Data flow

The reader container connects through a Unix socket relay to the configured read target
on port 5432 using TLS with hostname verification and the reviewed RDS CA.
It admits primary and replica recovery states, but requires read-only transaction
state before extraction. Under Colin's live-primary ruling, set `replicaHost` to
`primaryHost` and `replicaSecurityGroupId` to `primarySecurityGroupId`. These legacy
configuration names identify the read target; a distinct replica remains supported.
Both database ingress rules then target the same group but have different source
groups (worker versus login provisioner), so their rule tuples do not collide.
The owned extractor surveys and selects roles inside one read-only repeatable-read
snapshot. Raw fixtures and provenance remain on the disposable encrypted disk.
The producer runs fresh paired Clojure/Python recordings. The verifier independently
re-admits the original fixture and runs the reviewed certify + G12 gate locally.
The producer never copies fixtures into its output tree.

Producer, reader and verifier have disconnected network namespaces, no host
credentials or metadata access, unprivileged users, read-only roots, no capabilities,
resource limits and separate writable mounts. Only the reader receives the
socket and reader credential. Producer output is read-only to the verifier;
the verifier alone writes the receipt directory. Container storage also resides
on the disposable disk. The root supervisor, baked into the AMI, is trusted.

The host subnet has no default internet route or NAT. Security-group egress is
limited to the read target, a private Secrets Manager endpoint and S3 via a gateway
endpoint whose policy admits only the box's assets/control/receipt paths. Because
security groups do not filter the VPC resolver, the baked firewall restricts DNS
to an exact-name local forwarder. Probe containers have no network route to it.
Cloud-init execution, SSH, SSM, swap and core dumps are disabled.

## Closed receipt and lifecycle boundaries

Only the unchanged `polis-probe-receipt/1` or `/2` schema leaves the worker:
bounded counts, finite errors, fixed verdicts, selection aggregates and digests.
Raw rows, identifiers, fixtures, recordings, paths and logs remain on disposable
storage. The supervisor validates the receipt and writes its own S3 key once.
The local operator library fetches that bounded object and calls the same
`validate_receipt` independently. It prints only run ID, complete and passed;
receipt bytes and SDK error text are never printed. Private receipt access is
limited to the generated operator role and the configured reviewer roles.
Receipt retention remains 90 days. The worker cannot read or overwrite receipts.

`ci/probe_box/run.py` is a local Python library and CLI. Both worker and login
provisioning share one conditional S3 active register. Each run ID is permanently
claimed. A random generation/transition nonce and exact ETag CAS serialize
RESERVED → INTENT → CLEAN. Only the invocation winning INTENT may call
RunInstances; both SDK and application launch retries are disabled. A paused
RESERVED actor loses to cancellation. After INTENT, an empty Describe response
is UNKNOWN even after expiry; do not delete active.json or invent a CLEAN record.
This intentionally blocks another run when launch history cannot be proven.

Admission binds the exact configuration, image, template/version, profile,
subnet, security group, job, start and absolute deadline. Reconciliation checks
actual instance token, image, type, profile, subnet, groups, tags and absence of a
public IP. It records both actual disk IDs before publishing instance-specific
boot JSON. Cancellation, expired budget or stale worker heartbeat requests
termination; accepted termination is not cleanup. CLEAN requires observed
termination and explicit NotFound for both recorded disks. Unknown tagged disks,
changed identity, incomplete disk inventory and failed/empty Describe calls refuse.
Known detached tagged disks may be deleted, then absence must be observed separately.

The baked host arms shutdown before mount/DNS/credentials, then an absolute job
deadline before private work. Containers remain bounded by the same deadline.
A dead boot/kernel still needs the operator. Native per-run AWS/EC2 status-check
alarms, bound to the observed worker instance, send directly to the configured
SNS topic; missing data breaches while active. The operator installs them during
status polling and deletes only that run's alarms after proven cleanup. The two
native disabled unbound stack alarms describe the default definitions; they do
not assert worker health while idle. No timer/service independently installs or
repairs alarms. A healthy EC2 status check does not prove a live supervisor:
the S3 heartbeat is checked by the operator library (boot grace 600 seconds,
stale after 300 seconds). SNS destination delivery remains an operator acceptance
check, including any downstream service the configured topic actually uses.

## Prepare the native stack and image

Configure `ProbeConfig` with existing VPC/subnet CIDR, primary/read endpoint and
security groups, AMI, admin secret ARN, stable `provisionOwner`, publisher,
reviewers, `operatorRoleArns` (the SSO source roles) and notification topic. Old
layer inputs are rejected. No GitHub/OIDC dispatch configuration is required.
Review only ProbeStack with `enableProbeBox=true` and `PROBE_BOX_CONFIG`; absent
or false keeps it off. The deploy session is operator-owned.

The image must be rebaked from this committed shape-C source: its mode-aware
bootstrap, provision CLI and absolute deadline differ from the earlier AMI.
On the reviewed AL2023 2023.12.20260831 ARM64 builder, prepare dependencies with
`ci/probe_box/ami/prepare.sh`, then run `ci/probe_box/bake.sh` offline as root.
Retain the exact RPM/wheel/source/AMI inventory. The independent RDS CA pin is
now `ci/probe_box/ami/rds-ca.json`; no layer recipe is used. Docker/containerd/
runc/Skopeo remain pinned to the Amazon package versions in prepare.sh. Default
daemons stay masked; the worker's daemon, socket, image state and temporary
files remain on `/probe-work`. The provisioner never starts that daemon.

Save the deployed `WorkerConfig` and `ProvisionConfig` JSON outputs in a private
operator directory, verbatim. Configure an AWS CLI/SDK profile that assumes
`OperatorRoleArn` from the active SSO source profile. Pass that assuming profile
to the commands below: bucket policies intentionally refuse a direct source-role
write to authoritative control objects. The operator role cannot read the admin
secret; only the in-VPC provisioner role can. Do not store credentials in these
files or the repository. Run from the reviewed source with boto3 available.

## One-off in-VPC reader login

The separate fixed provisioning template uses a t4g.small with no inbound access,
public address, SSM or internet route. Its profile reads only its provision boot
object and the two exact secrets, and writes one closed provisioning receipt.
It reaches primary PostgreSQL and the private Secrets Manager/S3 endpoints.
Worker and provisioner boot paths and profiles are distinct.

The operator reads secret **version IDs** from Secrets Manager metadata using
the deploy session and creates a private request file with exactly `run_id`
(32 lowercase hex), `adminVersion` and `readerVersion`. No secret values go in
that file, argv or boot JSON. Do not rotate versions during an unresolved run.
Choose `provisionOwner` once; reuse its exact admitted identity, never adopt a
foreign role. `provision_login.provision()` retains its existing transaction,
advisory lock, six-table SELECT inventory, role attributes, timeouts and drift
refusals. `provision_login.execute()` reads the admitted versions into memory,
verifies primary TLS/CA and invokes it. Failures roll back and produce only a
closed failure receipt. Stack removal never drops the role or secret.

```bash
# Set these to private local files and an already configured assuming profile.
: "${PROBE_PROFILE:?operator role profile}"
: "${PROBE_PROVISION_CONFIG:?private ProvisionConfig JSON file}"
: "${PROBE_PROVISION_REQUEST:?private version-ID request JSON file}"
python3 -B ci/probe_box/run.py launch --profile "$PROBE_PROFILE"   --config "$PROBE_PROVISION_CONFIG" --job "$PROBE_PROVISION_REQUEST"
```

Launch normally exits 1 while running; 0 means complete+passed; 2 means unresolved.
Retain the request's run ID and poll with the **same** configuration:

```bash
: "${PROBE_PROFILE:?operator role profile}"
: "${PROBE_PROVISION_CONFIG:?private ProvisionConfig JSON file}"
: "${PROBE_PROVISION_RUN:?same provision run ID}"
python3 -B ci/probe_box/run.py watch --profile "$PROBE_PROFILE"   --config "$PROBE_PROVISION_CONFIG" --run-id "$PROBE_PROVISION_RUN"
```

Admission is complete only when the closed provisioning result is successful
and both disks are observed absent. A lost DB acknowledgment can leave an owned
login even with a failure receipt. Reconcile the old instance/disks first; an
explicitly reviewed retry uses the same owner and secret versions with a new run
ID only after CLEAN. Never create a second provisioner merely because the first
CLI invocation failed.

## Run a probe; resume and terminate a dead box

Build a private job file from one reviewed registry entry, adding a new opaque
32-hex run ID. The job ceiling is at most 18000 seconds; it does not reset when
polling reconnects. Complete reader provisioning and source/image admission first.

```bash
: "${PROBE_PROFILE:?operator role profile}"
: "${PROBE_WORKER_CONFIG:?private WorkerConfig JSON file}"
: "${PROBE_JOB_FILE:?reviewed job JSON file}"
python3 -B ci/probe_box/run.py launch --profile "$PROBE_PROFILE"   --config "$PROBE_WORKER_CONFIG" --job "$PROBE_JOB_FILE"
```

```bash
: "${PROBE_PROFILE:?operator role profile}"
: "${PROBE_WORKER_CONFIG:?same WorkerConfig JSON file}"
: "${PROBE_RUN_ID:?same admitted run ID}"
python3 -B ci/probe_box/run.py watch --profile "$PROBE_PROFILE"   --config "$PROBE_WORKER_CONFIG" --run-id "$PROBE_RUN_ID"
```

If watch exits unresolved, renew the SSO session as needed and use `status` with
that same run ID/configuration. Never retry with a new run ID or override the
launch template. To terminate a dead worker, use the cancellation path:

```bash
: "${PROBE_PROFILE:?operator role profile}"
: "${PROBE_WORKER_CONFIG:?same WorkerConfig JSON file}"
: "${PROBE_RUN_ID:?same admitted run ID}"
python3 -B ci/probe_box/run.py cancel --profile "$PROBE_PROFILE"   --config "$PROBE_WORKER_CONFIG" --run-id "$PROBE_RUN_ID"
python3 -B ci/probe_box/run.py status --profile "$PROBE_PROFILE"   --config "$PROBE_WORKER_CONFIG" --run-id "$PROBE_RUN_ID"
```

Repeat status until cleanup is observed, preserving UNKNOWN when it cannot be.
Provisioning cancellation uses ProvisionConfig with the same CLI. No console
output, raw disk copy, snapshot or public artifact is part of recovery. If no
instance or initial disk inventory can ever be recovered, escalation stays with
the operator; the library cannot safely release the box. A failed receipt may
finish complete=true/passed=false; a PASS receipt never excuses missing cleanup.

## Local Docker mode

The committed `ci/probe_box/local/docker-compose.test.yml` rehearses the exact
worker image loader and sandbox using Amazon's pinned ARM64 Docker/Skopeo runtime.
It generates a public-fixture OCI archive locally, checks original manifest and
loaded config identity, refuses corrupt/mismatched images, exercises nonroot /
read-only / network-none execution and verifies disposable daemon storage.
Only CPU/memory ceilings are reduced to fit the local VM. The outer test container
needs privileged mode and a private delegated cgroup namespace for nested Docker;
its runtime network is disabled. No AWS credential, private data or DB is used.

```bash
export COMPOSE_PROJECT_NAME=astra-probe-shape-c-local
export POLIS_RECOVERY_PG_PORT=56291 RECOVERY_PG_PORT=56291
: "${PROBE_LOCAL_RESULTS:?absolute private local results directory}"
mkdir -p "$PROBE_LOCAL_RESULTS"
docker compose -f ci/probe_box/local/docker-compose.test.yml build
docker compose -f ci/probe_box/local/docker-compose.test.yml run --rm runtime
# Tear down only this project, including after a failing rehearsal.
docker compose -f ci/probe_box/local/docker-compose.test.yml down --volumes --remove-orphans
```

The independent local Postgres rehearsal exercises the unchanged provisioning
transaction. It does not connect to the real primary:

```bash
export COMPOSE_PROJECT_NAME=astra-probe-shape-c-login
export POLIS_RECOVERY_PG_PORT=56292 RECOVERY_PG_PORT=56292
docker compose -f ci/probe_box/test.compose.yml up -d --wait
PROBE_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${POLIS_RECOVERY_PG_PORT}/probe_test"   python3 -B ci/probe_box/login_rehearsal.py
docker compose -f ci/probe_box/test.compose.yml down --volumes --remove-orphans
```

Local runtime/DB evidence does not admit AWS networking, IMDS/DNS isolation, a
new AMI, real secret permissions, SNS delivery or EBS disposal. Retain those
operator-run acceptance receipts before using private data.

## Source/image and science admission

After source review, build the producer and verifier independently with the existing
source/image admission tools in `ci/private_cert/images/`. Use the new `probe.py`
entrypoint. A certification registry entry uses the producer digest for reader
`["extract"]` and producer `["produce"]`, and an independent verifier digest with
`["verify"]`. The job schema is `polis-probe-job/1`; `run_id` is supplied by the
operator, and `max_seconds` is bounded by 18000. Store actual digest references
in `ci/probe_box/jobs.json`. OCI archives are loaded from the private assets bucket
by manifest digest; mutable tags and remote image pulls are refused. The AL2023
supervisor uses Docker 25 with Skopeo from the pinned Amazon repository. The worker
checks the original OCI manifest bytes returned by Skopeo against the admitted
digest before local conversion; the worker verifies the resulting Docker image ID against that
manifest's config digest and checks Linux/ARM64. It executes only that immutable
image ID. Docker's imported image metadata is not used as a registry-digest proof.
The admitted job and exported receipt continue to identify the original manifest.
Single-image OCI manifests are required; multi-platform indexes fail admission.

Historical explicit full-stream vote-count schedules retain their relative cut
positions against the new snapshot. Empty schedules, moderation, restart indices,
engine options and checkpoint count remain bound by the verifier. Incompatible
role selection or collapsed cuts fail admission; the pipeline never shortens the
battery or accepts a partial result to obtain PASS.

A reviewed `representative_selection` config also extracts the selected sample
in that same read-only transaction. Manifest/4 and paired-plan/2 require every
sample alongside the 14 existing private entries. The gate orders actual sizes,
preserves restart pairs, and reconstructs the sample's ceiling-six full-stream
cuts and final-source-state moderation in both engines. Empty or unsupported
inputs remain required and can fail the gate. Payloads, maps and byte census
remain box-only; receipt/2 exports only the closed numeric selection report.
See [representative payload admission](../delphi/docs/representative-selection.md).

## Local verification

```bash
python3 -B -m unittest discover -s ci/probe_box -p 'test_*.py' -v
(cd cdk && ./node_modules/.bin/tsc --noEmit)
(cd cdk && ./node_modules/.bin/jest --runInBand --runTestsByPath test/probeBox.test.ts)
```

The synthesis test recursively refuses AWS::Lambda::*, Custom::*, service tokens
and AWS::CloudFormation::CustomResource. No deployment or private run is performed
by these tests.
