# Private probe box

`ProbeBox` is a reusable, default-off sibling stack inside the existing VPC.
A job is a reviewed registry entry containing immutable image digests and
exec-form argument arrays. Certification is its first probe. Adding another
probe changes its images and registry entry; it does not require another stack.

The GitHub environment `probe-box` approves dispatch from `edge`. The dispatch
role can only invoke the controller. Its trust binds audience, exact repository
and environment subject, and branch. Configure environment reviewers and branch
protection before dispatch. The registry is currently empty: release image
manifests must be built from the reviewed committed source and independently
validated before real digests can be entered. There are no placeholder releases.

## Data flow

The reader container connects through a Unix socket relay to the fixed replica
on port 5432 using TLS with hostname verification and the reviewed RDS CA.
It checks `pg_is_in_recovery()` and read-only transaction state before extraction.
The owned extractor surveys and selects roles inside one read-only repeatable-read
snapshot. Raw fixtures and provenance remain on the disposable encrypted disk.
The producer runs fresh paired Clojure/Python recordings. The verifier independently
re-admits the original fixture and runs the reviewed certify + G12 gate locally.
The producer never copies fixtures into its output tree.

Producer, reader and verifier have disconnected network namespaces, no host
credentials or metadata access, unprivileged users, read-only roots, no capabilities,
resource limits and separate writable mounts. Only the reader receives the
socket and replica credential. Producer output is read-only to the verifier;
the verifier alone writes the receipt directory. Container storage also resides
on the disposable disk. The root supervisor, baked into the AMI, is trusted.

The host subnet has no default internet route or NAT. Security-group egress is
limited to the replica, a private Secrets Manager endpoint and S3 via a gateway
endpoint whose policy admits only the box's assets/control/receipt paths. Because
security groups do not filter the VPC resolver, the baked firewall restricts DNS
to an exact-name local forwarder. Probe containers have no network route to it.
Cloud-init execution, SSH, SSM, swap and core dumps are disabled.

## Only closed receipts leave

The supervisor validates `polis-probe-receipt/1` before one create-only S3 write.
Its schema allows bounded counts, finite error maxima, per-entry verdicts, control
counts, selection counts/sizes/seed when available, and digests of inputs, images,
policy and recordings. Entry positions refer to the digest-bound inventory; they
are not conversation identifiers. The role-based certification job is deterministic
and has no sampling seed, so its selection field is null. The sampled-payload
battery is a separate admission item.

No raw rows, identifiers, recordings, blobs, paths, error strings or logs are
exported, including to the private evidence bucket. Additional numeric aggregates
require explicit schema review. Raw inspection is a separate live-box operation,
not an export option. The bucket is private, encrypted, versioned and retained;
receipt versions expire after 90 days. Only configured authenticated reviewer
roles and the private controller can read receipts. The public dispatch role
cannot read the bucket. The worker can write only its own receipt key and cannot
read receipts or overwrite an existing one.

Public application output is exactly `run_id=<opaque value>` followed by `PASS`
or `FAIL`. The dispatcher captures both child OS descriptors before validating
the result; a stray native or Python print makes it fail without releasing the
captured text. There are no Actions artifacts. GitHub's static workflow scaffolding
is distinct from application output. No private application runs on the runner.

## Reviewable login schema item

`ci/probe_box/provision_login.py` is the primary-side schema operation. The stack
creates a generated Secrets Manager credential and invokes this code via a
separate custom-resource Lambda with a separate security group and admin-secret
permission. The probe worker never receives the primary connection or admin secret.
The reviewed ARM64 Lambda layer must contain psycopg2 and `/opt/rds-ca.pem`.

It creates `polis_probe_reader` with no superuser, inheritance, role/database
creation, replication or RLS bypass; four connections; read-only and statement
limits; schema usage, database connect, and SELECT on exactly conversations,
votes, comments, participants, math_main and math_ticks. Provisioning locks and
marks its role ownership, refuses a foreign role or unexpected membership/write
authority, and rolls back partial failure. Role creation on primary replicates to
the physical replica. The runtime additionally refuses a primary target.

Deleting the stack retains the role and secret. Disabling/removing that role is
an explicit separately reviewed schema action after all readers stop; stack
rollback never drops an adopted or possibly used role. Review the primary-side
operation with the infrastructure change before deployment. No existing math
schema, write path or application login is altered.

## Lifecycle and release

The controller serializes requests, durably claims each run ID, and binds launch
to a fixed template/version, AMI, instance profile, subnet and security group.
A lost launch acknowledgement is reconciled by its exact token; it never causes
a second blind launch. A missing/ambiguous observation is uncertainty, not cleanup.
The independent scheduled sweeper terminates expired or heartbeat-lost instances.
PASS requires both a valid verifier receipt and an observed terminated instance
with both captured disk IDs absent. Delete/terminate acknowledgements alone fail.
Unknown disks are never deleted solely on a tag. A prior run must be clean before
a different run is admitted. Error and missing-sweep alarms use the existing SNS
topic. The controller logs fixed errors, never probe data.

After source review, build the producer and verifier independently with the existing
source/image admission tools in `ci/private_cert/images/`. Use the new `probe.py`
entrypoint. A certification registry entry uses the producer digest for reader
`["extract"]` and producer `["produce"]`, and an independent verifier digest with
`["verify"]`. The job schema is `polis-probe-job/1`; `run_id` is supplied by the
dispatcher, and `max_seconds` is bounded by 18000. Store actual digest references
in `ci/probe_box/jobs.json`. OCI archives are loaded from the private assets bucket
by manifest digest; mutable tags and remote image pulls are refused.

Historical explicit full-stream vote-count schedules retain their relative cut
positions against the new snapshot. Empty schedules, moderation, restart indices,
engine options and checkpoint count remain bound by the verifier. Incompatible
role selection or collapsed cuts fail admission; the pipeline never shortens the
battery or accepts a partial result to obtain PASS.

Bake the supervisor with `ci/probe_box/bake.sh` on the reviewed offline ARM64 builder.
The launch template carries JSON boot configuration only, never executable commands.
Set `enableProbeBox=true` and `PROBE_BOX_CONFIG` only when reviewing the separate
`ProbeStack`; absent/false leaves the existing stack unchanged. Configuration names
existing VPC/replica/primary endpoints, security groups, CA-bearing Lambda layer,
admin secret ARN, asset publisher, reviewer roles and notification topic.

Before private use, retain actual target receipts for the AMI/OCI source admission,
read-only replica login, DNS/metadata/egress isolation, cancellation/lost launch,
boot failure, killed supervisor and observed disk disposal. Local mocks and
public-fixture data establish code behavior; they do not establish those AWS facts.
The old signed-admission, fixture-upload and download-to-verify runbook is superseded.
No migration, image release, deployment or private run is authorized by local tests.

Validation commands (local, no cloud):

```
python3 -B -m unittest discover -s ci/probe_box -p 'test_*.py' -v
PYTHONPATH=delphi python -B -m unittest discover -s ci/private_cert -p 'test_*.py' -v
# From cdk/:
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/jest --runInBand --runTestsByPath test/probeBox.test.ts
```

The explicit local Postgres rehearsal is `login_rehearsal.py`; start only
`test.compose.yml` with unique COMPOSE_PROJECT_NAME and both recovery ports,
then provide PROBE_TEST_DATABASE_URL for that local instance and tear it down.

References: [AWS OIDC claim conditions](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html),
[launch-template IAM](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ExamplePolicies_EC2.html),
[VPC DNS](https://docs.aws.amazon.com/vpc/latest/userguide/AmazonDNS-concepts.html).
