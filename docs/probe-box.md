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
limited to the read target, private Secrets Manager and EC2 endpoints, and S3 via a gateway
endpoint whose policy admits only the box's assets/control/receipt paths. Because
security groups do not filter the VPC resolver, the baked firewall restricts DNS
to an exact-name local forwarder. Probe containers have no network route to it.
Cloud-init execution, SSH, SSM, swap and core dumps are disabled.

### Resolver ownership across DHCP renewal

The offline bake stops/disables `systemd-resolved` and persistently masks its
service, then replaces `/etc/resolv.conf` with a regular mode-0644 file containing
only `nameserver 127.0.0.1` and `options timeout:2 attempts:2`. It checks the
actual `/etc/nsswitch.conf` hosts entry and preserves it if its providers are
already exactly `files dns`; otherwise it normalizes that entry to `files dns`.
Missing or duplicate hosts entries refuse the bake. Other NSS databases are
unchanged. Host lookup therefore does not depend on `resolve` or `myhostname`.

At boot, the `dns` phase refuses a symlink (including a dangling one), missing
file, nonregular file, or a resolved unit that is not persistently masked and
inactive. Only after those checks does it rewrite the resolver file and start
the exact-name forwarder. Refusal uses the existing fixed `dns` boot-failure
record and poweroff trap; delivery is best effort when DNS itself is unavailable.
Both worker and provisioner modes pass through this check before private work.

This fixes the write-through-link path identified after runs 11–13. The
[AL2023 network package](https://github.com/amazonlinux/amazon-ec2-net-utils)
uses networkd for link configuration and resolved for DNS; its
[installation script](https://github.com/amazonlinux/amazon-ec2-net-utils/blob/main/amazon-ec2-net-utils.spec)
links `/etc/resolv.conf` into `/run/systemd/resolve/`. Resolved maintains that
[uplink file](https://github.com/systemd/systemd/blob/v252/man/systemd-resolved.service.xml)
as DNS information changes, so writing through the link does not survive a
DHCP update. Masking the writer and removing the link prevents that replacement.

No networkd drop-ins, restarts or link reconfiguration are added, at bake or boot.
No `UseDNS=no` override is applied: coverage of all generated per-interface
configurations was not established for the pinned image. Networkd keeps DHCP
addresses and routes; resolved is the resolver-file writer in this AL2023 setup,
and it is stopped and masked. Cloud-init is already masked and the offline bake
adds no alternative resolver manager. Do not enable one on this dedicated image.
Local tests execute the bake block and boot DNS phase with real temporary files
and a systemctl double; they do not claim an AL2023 DHCP-renewal rehearsal.

## Closed receipt and lifecycle boundaries

The verifier emits the closed `polis-probe-receipt/4` schema: bounded counts,
finite errors, fixed verdicts, selection aggregates, digests and comparison
diagnostics. The supervisor and operator continue to read historical `/1`, `/2`
and `/3` receipts.
On an empty (zero-vote) conversation the legacy engine omits fields that Python emits; Python's complete empty structure is the canonical output and the legacy behaviour is a recorded defect, never an accepted variant. An entry may also carry `legacy_defects`: `legacy-defect-empty-omits-keys` with a sorted,
unique, nonempty subset of the 15 fixed public keys in the committed
[`pc-zerovote-01-empty.json`](../delphi/scripts/schedules/pc-zerovote-01-empty.json)
contract. `lastVoteTimestamp` is 0 for both engines on an empty conversation,
because the replay driver floors an empty conversation's clock to 0 exactly as
the production poller does; it is compared like any other present value.
The omission list includes three explicit PCA leaves; it does not permit replacing
a whole PCA object. The observation describes only actual reconciliations at the
zero checkpoint. Thirteen keys belong to the constant `empty_output` contract;
`mod-in` and `mod-out` belong to the separate closed `legacy_absent_moderation`
declaration. Python emits sorted moderation lists, never null on an empty compute.
Omitted legacy lists compare to those Python lists; emitted lists compare normally.
The exact Python compute values and present legacy values remain checked.
Arbitrary names, values, duplicates, reordered defects and additional fields are
rejected; entries without an observation retain their existing shape. Deploy the
updated supervisor/operator receipt validator with the verifier images.
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
boot JSON. Cancellation and expired budget request termination. A stale worker
heartbeat first requires the independent liveness checks below; accepted termination is not cleanup. CLEAN requires observed
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


### Independent liveness when S3 stops responding

The supervisor publishes an S3 pulse and an EC2 `polis-probe-pulse` tag on
independent 60-second loops. Each channel has its own monotonic counter; the
counters must only be compared within that channel. The tag is
`counter:stage:phase[:last_error]`, using the same closed stage/phase/error
vocabulary as the S3 reader. A stuck S3 call cannot hold the tag loop's lock,
and the EC2 client uses a separate SDK session to avoid sharing S3's credential
refresh lock. A stage change updates local state without waiting for a pending
S3 write. Candidate containers cannot call either service.

The S3 body adds `credential_expiry` (`expired`, `le-5m`, `le-15m`, `le-30m`,
`le-60m`, `gt-60m`, or `unknown`) and, after a failed pulse on either channel,
`last_error`. That error is retained in subsequent pulses and tags, including
after recovery. Only allowlisted SDK error codes or exception classes pass;
unknown classes become `UnknownError`. No exception message, credential, URL,
raw metadata or exact expiry leaves the supervisor. Expiry is sampled from the
S3 signing client's cached credential expiry without initiating refresh; an
unrecognized SDK shape yields `unknown`. Legacy bare pulses and stage/phase
pulses remain readable. Receipts are unchanged.

On a missing/stale S3 pulse, the operator reads the owned instance's tag and
queries `AWS/EC2` `CPUUtilization` for that exact InstanceId over the last five
minutes. Any fresh finite Average sample above 2 percent establishes activity.
A tag must advance relative to a durable `liveness-baseline.json`; the first
observation alone is not proof, and gets at most 120 seconds to advance. The
baseline survives operator restarts. Counter regression, malformed tags and
unknown tokens do not establish activity. Missing, stale, malformed or failed
CPU reads are UNKNOWN, not proof of silence: status reports the run incomplete
and watch keeps observing under its ceiling, never killing on that evidence;
admission expiry or an explicit cancel still terminates the owned instance.

Positive CPU or tag evidence is written once to
`control/<run-id>/liveness.json`, bound to the admission and instance. Its only
observations are fixed CPU/tag categories, a sanitized pulse, and the operator's
observation time. Per the fallback policy, this durable decision suppresses
further missing-S3 termination for the rest of that run, including after an
operator restart. A later engine death can therefore consume the remaining
admitted budget. Cancellation, admission expiry and the box's own shutdown
still win. Without positive evidence, termination requires both a quiet CPU
observation and a tag that is absent/invalid or did not advance within the
baseline grace. A termination request still does not mean CLEAN.

The new EC2 interface endpoint has no public route and admits only the worker
role's `CreateTags` call. Role and endpoint policies bind the source credential's
`ec2:SourceInstanceARN` to the target ARN formed from `ec2:InstanceID`, require
the box ownership tag, and allow only `polis-probe-pulse`. The worker cannot
change ownership tags or tag another instance. The worker role also requires
the new endpoint. The launch template adds only its exact DNS name and `ec2Url`
to trusted bootstrap; provisioning bootstrap stays unchanged. IAM supports these
instance condition keys and ARN-valued variables in conditions
([EC2 authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html),
[IAM policy variables](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_variables.html)).
The operator adds `cloudwatch:GetMetricStatistics` (no resource-level scope is
available); the worker receives no CloudWatch permission. Local policy tests
inspect the generated template; actual endpoint/IAM behavior requires the
operator's deployment acceptance.

Roll out the operator, the stack/worker launch template (endpoint, IAM and
bootstrap), and the newly baked image together before the next run. Baking alone
cannot create the endpoint or grant tag/metric access. Existing admissions bind
the old template version; do not mutate their configuration to retrofit a run.

### Thirty-minute horizon investigation

Source inspection found `statement_timeout = '30min'` on the reader login. This
is a per-statement database timeout, not a supervisor lifetime; the reader and
its relay are already closed before the producer starts. It does not explain
loss of S3 writes during producer computation. Run 15 completed reader admission for the same selected set that later exhausted
an engine's old limit. That shows those reader statements finished; engine CPU
time does not measure SQL latency. The aggregate population survey and each
conversation's vote/comment/participant query still inherit the fixed limit, so
another size class or database load can hit it with campaign budget remaining.
Proposed follow-up: give the reader its admitted absolute `deadline - 180` and
set each query's session/transaction timeout to the remaining reader budget
immediately before execution (including the initial census), preserving read-only
repeatable-read isolation. A one-time session duration would incorrectly reset
that budget for each statement. This needs extractor query-boundary plumbing and
is not part of the engine change; the login setting is unchanged.

The host metadata helper requests a fresh IMDSv2 token for each call with a
300-second TTL, and five-second HTTP timeouts. SDK credentials come from
botocore's separate refreshable IMDS provider; their actual cached expiry is now
observable as a bucket. Inspection of the pinned botocore 1.43.89 source shows
a six-hour IMDS token TTL and credential refresh thresholds of 15 minutes
(advisory) and 10 minutes (mandatory) before expiry. Its IMDS fetcher can extend
its cached expiry by 12–20 minutes when metadata returns near-expiry credentials;
the bucket reports that client view, not an independently verified AWS expiry.
There is no fixed thirty-minute credential lifetime in this source, but a
refresh event at that point cannot be excluded without runtime evidence. S3/KMS permissions carry no thirty-minute condition or local key
cache timer. The relay has five-second socket and six-second shutdown waits,
no lifetime timer; DNS uses a three-second upstream timeout, no local cache or
expiry timer, and systemd restarts it on failure. The worker unit's
`TimeoutStartSec=43200` and startup `shutdown +720` are twelve-hour ceilings;
worker shutdown and container timeouts use the absolute admitted deadline.
`CAMPAIGN_CEILING_SECONDS` in `ci/probe_box/contracts.py` is the single source
for that ceiling; the operator derives its bounds from it in `ci/probe_box/run.py`,
so no bound can be left behind to cut a legitimate run short. The launch and
claim sanity bounds are the ceiling plus one hour of margin and never end a run
themselves, and the `watch` ceiling is the job ceiling plus a 900-second grace,
so watch outlasts the box it observes. The receipt boundary keeps no ceiling of
its own: `ci/probe_box/receipt.py` validates the job through the same
`validate_job`, so a run the job boundary admitted cannot be refused at the
receipt after the comparisons have already been paid for. Both files are in the
verifier image closure, so a ceiling change is only live in the box once the
image is rebaked from the changed source. The baked `shutdown` and
`TimeoutStartSec` in `bake.sh` must be changed to match by hand, and that needs
a new AMI.

The worker's own host fallback, `shutdown -h +N` at startup, rounds N **up** to
whole minutes (`worker.shutdown_minutes`, minimum 1). It is a backstop behind
the admitted deadline, not a competitor to it: flooring would have powered the
host off up to 59 s early and cut a run short before its own expiry.
For certification jobs, the worker writes `/run-spec/deadline.json` read-only
immediately before starting the producer. Its `engine_deadline_unix` is one
absolute Unix timestamp: `D - 120 - 0.10 * max(0, D - 120 - now)`, where `D`
is the original admitted start plus job `max_seconds`. Existing reader/producer/
verifier container reserves remain `D - 180`, `D - 120`, and `D - 30`; they are
stage-specific, not cumulative. Ten percent of the remaining producer window is
reserved for the verifier's expected comparison work, in addition to the existing
cleanup reserves. This is a documented allocation, not a measured guarantee that
verification will fit. It is frozen once, never recalculated per conversation.
Every legacy/Python invocation uses only the time remaining to that timestamp;
there is no independent one-hour engine cap. An exhausted budget starts no child.
The ProbeBox entrypoint requires this file even for public fixtures; it cannot
silently fall back to a fresh local duration. Outside the box, certify uses
`POLIS_CERTIFY_DRIVER_TIMEOUT_SECONDS` (positive finite seconds, default 43200).
Direct local `gate.produce` exercises freeze that default once for the producer.

On engine expiry, the failure record container includes closed `engine`
(`legacy`/`python`), `recipe` (the receipt /3 vocabulary; all sample entries map
to `sample-uniform6`), and `elapsed_bucket` (`le-1h`/`le-2h`/`le-4h`/`gt-4h`).
Elapsed time is monotonic per invocation. The worker validates the final marker
and the operator independently validates its three fields; no command, path,
conversation identity or raw exception message is exported. This remains a
failure record, not a completed comparison receipt. Ship v10 images, updated
operator receipt/vocabulary modules, and bake 13 together: the old worker supplies
no absolute engine deadline and cannot export the new context.

A separate benchmark
helper, `polismath.replay.shard_bench`, has a 1800-second child timeout, but the
probe producer invokes the engine drivers directly and does not use that helper.
The operator's heartbeat grace/staleness are 600/300 seconds. No thirty-minute
supervisor/DNS/systemd timer was found in the probe source. The subsequent
run-13 investigation identified the platform DHCP-renewal path described above;
the offline checks here do not independently establish the lease timing or
runtime state of those instances.

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
Carry the same exported `PROBE_BUILD_DIR` into the bake to retain
`resolver.json` beside the existing inventory. It records resolver-file
link/regular state and permission mode before and after the change, resolved's
masked/inactive state, and the actual NSS hosts providers before and after.
When supplied, that directory must be absolute and already exist. No new
evidence service or runtime export is involved. The builder's original hosts
providers are read at bake time; they are not inferred from a local workstation.
Retain the exact RPM/wheel/source/AMI inventory. The independent RDS CA pin is
now `ci/probe_box/ami/rds-ca.json`; no layer recipe is used. Docker/containerd/
runc/Skopeo remain pinned to the Amazon package versions in prepare.sh. Default
daemons stay masked; the worker's daemon, socket, image state and temporary
files remain on `/probe-work`. The provisioner never starts that daemon.

Resolver-fix rollout: review/merge, bake 11, redeploy the launch-template AMI,
then run 14 with the existing v8 workload images. This change needs no additional
worker/operator source, IAM or endpoint update beyond the liveness rollout above.
Verify the new resolver evidence before admitting the AMI; the next cloud run
must establish that resolution and pulses survive DHCP renewal.

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
32-hex run ID. The job ceiling is at most 43200 seconds; it does not reset when
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

`watch` and `status` are not read-only: each observation reconciles the
lifecycle and can publish control/boot records, manage the run's two alarms,
terminate the owned instance and delete its recorded disks. Watch binds to the
run's register generation, admission and configuration on the first valid read
and refuses if they change. Expected teardown states (shutting down, disks
detaching or still being deleted) are observed again every 30 seconds until the
watch ceiling. Classified transient SDK failures (throttling, service errors,
timeouts, an expired token refreshed by the SDK's own provider) get two further
observations; ownership, inventory, binding, receipt and permission failures
refuse at once. Complete requires observed instance/disk cleanup and deletion of
both alarms before the register is closed. Each retry or refusal prints one
closed `PROBE_DIAGNOSTIC` line to stderr (UTC time, reason, operation,
disposition, attempt); stdout keeps the JSON result or the fixed unresolved
sentence. `status` and `cancel` stay single observations: a pending state is
exit 1 with `complete: false`, a transient failure exit 2.

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
export COMPOSE_PROJECT_NAME=p027probe-shape-c-local
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
export COMPOSE_PROJECT_NAME=p027probe-shape-c-login
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
operator, and `max_seconds` is bounded by 43200. Store actual digest references
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
remain box-only; receipt/3 retains the closed numeric selection report and adds
its seed-source token. Historical receipt/2 reports remain readable.
See [representative payload admission](../delphi/docs/representative-selection.md).

## Receipt /3 diagnostics and selection variety

Every entry carries a fixed `recipe` token derived from the verifier's admitted
role and schedule. The fourteen role recipes and six public recipes have
separate tokens; all twenty representative samples use `sample-uniform6`.
Receipt order remains data-dependent. Selection-size rows are independently
sorted and must never be zipped to receipt entries.

`diagnostics` contains only `checkpoint` (zero-based ordinal), `family`, `kind`
and `magnitude`. Families are `projection`, `clusters`, `repness`, `moderation`
and `meta`. Kinds are `numeric-tolerance`, `strict-tolerance`, `exact-value`,
`shape` and `nonfinite`. A strict numeric failure is reported separately when
G12 has no numeric failure at the same family/checkpoint resolution. Finite
G12 failures use ratio buckets `over1-to2`, `over2-to10`, `over10` (inclusive
upper bounds); other kinds use `not-applicable`. No field paths or values are
exported. Unknown recipe or exported enum tokens fail closed. An unmapped
comparison field uses `meta`; missing strict context and diagnostic-context
exceptions produce a fixed `meta/shape/not-applicable` tuple. A step-count
mismatch uses that same tuple at ordinal zero. Root-key inventory faults name
the affected families in both comparers without multiplying divergence counts.

Tuples are deduplicated and sorted by checkpoint and published enum order.
The projection reserves one tuple for every failing entry, then fills up to
8 per entry and 256 per receipt. `diagnostics_truncated` records omissions;
comparisons always run to completion. PASS entries have no diagnostics and
FAIL entries have at least one. The existing 131,072-byte limit is enforced
on the completed projection. The verdict rules, 21 controls and comparison
policy digest are unchanged. A failed control yields an overall FAIL receipt
with the actual passed count, even when every entry passes. The decoder checks
passed versus expected instead of requiring all controls to pass before it
will decode the receipt.

The probe config's `representative_selection.seed_source` is `run-id` by
default. Derivation v1 is SHA-256 of the admitted run ID's 32 lowercase ASCII
hex characters, with no other input. The reader freezes this seed into the
box-local config; producer and verifier independently check that config
against their own shipped source and supervisor context. The reader and
producer receive only a read-only `/selection/context.json` containing
`run_id` and any explicit selection override. The producer still cannot mount
the full job/control directory. The verifier derives context directly from
the admitted job. The existing stratifier and target of 20 are unchanged.

To reproduce a selection, add this optional block to a job JSON, using the
previous receipt's seed (the example is a public test value):

```json
{"representative_selection":{"seed_source":"config","seed":"1111111111111111111111111111111111111111111111111111111111111111"}}
```

The job boundary accepts only `config` plus an explicit 64-digit lowercase
hex seed as an override. Configs without `seed_source` retain their historical
explicit-seed behavior. Receipt `selection.seed` is the actual seed and
`selection.seed_source` is `config` or `run-id`. Without a job override, the
decoder requires `run-id` and the derived seed; with an override, both fields
must match it exactly. Reproduction also needs the
same source snapshot and selection rules; a seed does not freeze a changing
database population.

Roll out the operator validator, v9 image closure/registry pins and bake 12
worker together. The new worker supplies selection context and validates /3;
old AMIs cannot run this contract. The ceiling base already includes 43,200
seconds and shutdown rounding. Existing v8 registry pins are still held for
replacement by the reviewed v9 release; this source edit does not build or
register images.

## Local verification

```bash
python3 -B -m unittest discover -s ci/probe_box -p 'test_*.py' -v
(cd cdk && ./node_modules/.bin/tsc --noEmit)
(cd cdk && ./node_modules/.bin/jest --runInBand --runTestsByPath test/probeBox.test.ts)
```

The synthesis test recursively refuses AWS::Lambda::*, Custom::*, service tokens
and AWS::CloudFormation::CustomResource. No deployment or private run is performed
by these tests.

### Disk inventory and attested release

`run.py` records an instance's disposal inventory only once it observes both
EBS volumes the launch template defines; EBS attaches after `RunInstances`
returns, so an earlier observation is partial and the lifecycle reports
`ATTACHING` until the set is complete (the boot object is written with it).
A terminated instance no longer carries `SubnetId` or its security groups in
`DescribeInstances`; ownership still requires the client token, instance
profile, image, type and both tags.

If an older record holds a partial inventory, `status` cannot prove disposal
and the register stays held. `run.py release --run-id ID --attest-volume A
--attest-volume B` closes such a run only when the instance is observed
terminated, the recorded volumes are a subset of the attested set, every
attested volume is observed absent by ID, and no tagged disk remains. It
deletes nothing, never releases a running box, and never reports PASS; the
resulting `clean.json` is marked `attested`.


### Reader provisioning findings

The provisioner inspects ACL provenance without changing existing PUBLIC grants.
Database CREATE/TEMP, CREATE on schema `public`, and EXECUTE on application
routines are reported when they reach the reader only through PUBLIC. A redundant
direct grant to the reader still refuses, even when PUBLIC grants the same right.
Broad role attributes, membership (including indirect/NOINHERIT membership),
ownership, DML, grant authority, extra table/sequence access, and explicit default
ACLs remain refusals. CREATE/USAGE on other application schemas also refuses.
PostgreSQL's absent ACLs are expanded using `acldefault`, so implicit routine
EXECUTE is reported too. Reporting does not remove or constrain these privileges.

New provisioning receipts use `polis-probe-provision/2` with the existing
`admissionSha256` and boolean `success`, plus required `public_defaults`: an ordered,
duplicate-free subset of `database-create`, `database-temp`, `schema-create`,
`routine-execute`. Only a successful transaction supplies verified findings; failed
provisioning writes `success: false` and an empty list, which is not an assertion
that PUBLIC grants are absent. No object names or ACL text enter the receipt.
The operator validates and returns this list; it also reads historical `/1`
receipts without inventing findings for them. Update the operator before running
a provisioner baked with `/2`. This is separate from the science receipt schemas.

The local pipeline rehearsal uses the same provisioner and retains the fixture's
PUBLIC defaults, printing only the closed finding list into `provision-reader`
output. The isolated `login_rehearsal.py` tests revoke grants solely to construct
negative and absent-grant controls. No production REVOKE is required.


### Early boot evidence (runs 16/17 follow-up)

The baked `boot_report.py` uses only the standard library at import time. Boot
configuration and failure reporting no longer import the worker. Worker user-data
now includes the public `controlKey` ARN, validated against its account/region;
boot failures send that exact `SSEKMSKeyId` required by the existing IAM policy.
Provisioner user-data keeps its existing schema. Install the operator module,
redeploy the worker launch template and bake the new AMI together. An old template
without `controlKey` fails the new boot-config check. No science image change is
required for this reporting fix.

On shell failure the supervisor emits only a fixed console phase/exit marker,
then invokes the independent reporter under a 30-second wall-clock limit before
poweroff. The trap is armed before the first shutdown command. Worker exceptions
before any successful S3 pulse/failure write invoke the same reporter before the
worker's own poweroff. It attempts both the existing self-only EC2 tag channel and
S3; either service can succeed when the other rejects a request. The new closed
record is `polis-probe-boot-failure/2` with `phase` and `exit` tokens. Existing /1
records remain readable. The S3 boot report is create-only, preserving any richer
worker failure already in the pre-job mailbox. A shell failure after a worker
pulse uses the last real stage/phase/pulse or saved failure in operator output;
coarse boot evidence is the fallback when neither is available.
The terminal tag is a failure, never positive liveness;
the operator saves it create-only in `control/<run>/boot-failure.json` while the
instance is observable, including during disposal. This does not change receipt
verdicts or CLEAN's requirement to observe the instance and disks gone.

Before DNS works, only the fixed console markers can leave the ordinary local
logging path. General worker, SDK and container stdout/stderr remain suppressed.
Console delivery/retention after termination is not guaranteed; neither a dead
kernel nor unavailable remote sinks can guarantee a causal diagnostic. Runtime
source analysis did not identify the runs 16/17 cause. The offline worker
rehearsal bypasses systemd startup, real IMDS, DNS and AWS KMS enforcement, so its
passing result does not certify those boot paths. Inspect the next run's new
closed evidence before attributing the shutdown to a particular phase.

### Receipt /4 comparison detail rollout

Each diagnostic now includes one closed `detail` token. Representative roots
are `representatives`, `consensus`, `group-consensus`, and `priorities`;
representative sites refine to `representatives-member-set`,
`representatives-record-keys`, `representatives-list-shape`,
`representatives-direction`, `representatives-counts`, or `representatives-scores`.
Projection details are `components`, `centering`, `comment-coordinates`,
`participant-coordinates`, `group-centers`, and `extremities`; unclassified sites
use `other`. These are schema contexts, never parsed private paths or labels.
The strict/G12 union deduplicates at checkpoint/family/detail/kind/magnitude;
strict numerical reporting is suppressed only at the same G12 detail site.
Comparison predicates, policy digest, controls, 8/entry and 256/receipt tuple
caps, first-failure reservation, truncation and byte bound are unchanged.

Roll out the operator receipt decoder, matching AMI worker decoder, and v11
image pins together. A /3-only decoder rejects /4; images must not go first.
Readers preserve /1–/3 bytes unchanged. The roles-census job's separate /3
schema is unchanged. Strict verdict caches bind report version /4 and all
comparer/diagnostic source bytes; recording and acceptance policy are unchanged.
