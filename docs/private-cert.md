# Disposable private certification (P-053)

`enablePrivateCertBox` is **off by default**. It adds a separate `PrivateCertStack`,
without changing the existing `CdkStack` or the synthetic CI worker. Enabling it
creates the isolated network, private storage, pinned launch template and control
function. **It does not launch an instance or stage private data during deploy.**
Only a scoped operator invocation launches the one admitted instance. There is
no GitHub/OIDC role, SSM access, SSH key, public IP, NAT or production connection.

The trusted execution/collection boundary uses the step-2 paired-recording gate
(certify + G12, absolute 1e-6, relative 1e-4, zero outliers), per the orchestrator
ruling in BOARD [677]. Stage comparisons are diagnostic only; recovery and
consumption inference belong to the separate shadow-run diagnostic. The
[image implementation and admission](../ci/private_cert/images/README.md) defines
the producer, independent verifier, offline dependency closure and digest pins. An arbitrary image that prints PASS is not admissible. No private
certificate, ARM boot, capacity fit, IAM simulation or cloud canary is established
by the local unit tests and synth comparison.

## One-time operator decisions and prerequisites

Colin chooses the payer account/region and distinct existing operator, curator and
private-reviewer role ARNs, the admission-signing public key, the maintainer SNS
topic, retention (30 days routine or 90 days failure), and the exact image/source/
policy/schedule/inventory tuple. The public key is independently reviewed; a key
inside an untrusted admission does not establish its own trust. Private key,
admission JSON, manifests, object keys, data and all synth output from a real
admission stay **outside this public checkout and public Actions artifacts**.

The deployment principal is privileged infrastructure administration. The runtime
operator receives only the function invocation and control-record reads from this
stack. Curator receives one exact staging-object PutObject/KMS GenerateDataKey;
reviewer receives exact-version evidence reads. Existing principals should not
carry broader deployment/session policies. Never attach the synthetic CI role.
Environment-form OIDC subjects do not identify a workflow; neither unsupported
STS claims nor root SSM commands are an acceptable future private-data boundary.

The trusted lifecycle function must DescribeInstances/DescribeVolumes in the
payer account because these EC2 APIs cannot be resource-scoped. This exposes
account metadata to that trusted function, **not** to candidates, workers, public
CI or the operator response. Mutation checks additionally require the stored
admission digest/client token, template version, image, instance profile, subnet,
security group, instance type and tag. A tag by itself never authorizes cleanup.

## Bake, then sign

Use the existing private ARM64 image-builder process. `ci/private_cert/bake.sh`
performs offline installation/hardening only; it does not build an AMI or download
packages. Preinstall and independently pin Linux/systemd, Python 3.12, boto3,
cryptography, podman, nftables and ebsnvme-id on the host. Put the pinned
engine/JVM/BLAS dependency closure in the OCI images; paired replay needs no
Postgres service. Preload the OCI images and verify their manifest digests against the reviewed
`image-lock.json`; pass its path to the bake as `PRIVATE_CERT_IMAGE_LOCK`. Verify the base image's root mapping is `/dev/xvda` and its root
filesystem accommodates those dependencies in 32 GiB. No credentials or fixture
bytes belong in the AMI or image-builder snapshots.

Bake `/opt/polis-private/bootstrap.json` via `PRIVATE_CERT_BOOTSTRAP` with exactly
these public bootstrap fields: `id` (32 lowercase hex opaque random characters),
`account`, `region`, `signerPublicKey` (32-byte Ed25519 public key as lowercase hex).
Run the bake script as root only on that disposable builder. It installs the
supervisor/service, masks cloud-init/SSM/SSH/serial login/swap, disables cores,
installs the DNS/IMDS firewall and outputs the actual supervisor/runtime digests.
Save those digests in the private admission. The runtime lock hashes the installed
bootstrap, control module, DNS forwarder, start script, firewall,
`image_admission.py` and canonical `image-lock.json`. Before fetching fixtures the
supervisor checks preloaded manifest/config digests, platform and execution
configuration against this signed runtime binding. The AMI itself
binds all other installed bytes; admit its provenance before signing.

The supervisor cannot have a final AMI ID baked into itself: that ID does not
exist until image creation. After baking, the signed admission binds the returned
AMI ID. At boot the supervisor reads only its tiny control record, verifies it
against the **baked** public key, checks its own IMDS identity and runtime hashes,
and only then fetches the admitted bundle VersionId. User-data is absent and no
boot service executes it. The instance profile has no user-data/launch permissions.

The host resolver forwards only the three exact bucket hostnames to the VPC DNS
resolver. nftables blocks all other direct DNS and non-root IMDS. Containers run
without a connected network, host PID namespace, credentials or host sockets;
SGs alone do not filter Amazon-provided DNS. Synthetic canaries must verify these
host and container boundaries on the actual admitted AMI.

## Private admission and two-phase staging

`PrivateAdmission` in `cdk/privateCertBox.ts` is the authoritative field list.
Besides bootstrap fields it requires:

- `schema: polis-private-admission/1`, `ami`, and the public-key `signature`;
- the one `fixtureKey`, exactly `staging/ID/bundle.tar`, its non-null `fixtureVersion`,
  SHA256 and byte length, plus maximum expanded bytes/member count;
- 40-character `candidateSha`/`oracleSha`, 64-character supervisor/runtime/policy/
  schedule/inventory digests, and complete expected check count;
- `runnerImage` and `verifierImage`, preloaded names of the form
  `localhost/polis-NAME@sha256:DIGEST` (no mutable tag or boot pull);
- absolute UTC `stagingExpiresAt` and later `expiresAt`;
- the three distinct role ARNs, existing notification topic ARN, regional S3
  managed `s3PrefixListId`, and 30/90-day evidence retention.

Storage is encrypted gp3: 32-GiB root plus 256-GiB scratch, DeleteOnTermination on
both. Instance class is fixed at ARM64 r8g.4xlarge (128 GiB); the container ceiling
is 112 GiB, 14 CPUs, 4,096 processes, no swap and fixed single-thread BLAS. The
worker checks available disk space before extraction; the admitted producer must
check the complete manifest dimensions and record peak RSS/disk/OOM before a full
largest-entry run. If these bounds do not fit, the result is INCOMPLETE. Do not
silently resize, sample, shorten schedules or replace entries.

A bucket must exist before S3 can assign a VersionId. Therefore staging is two
reviewed deployments, **with no launch between them**:

1. Sign an initial staging admission using a conspicuously synthetic placeholder
   VersionId/hash/size, the real baked AMI and a future ingestion cutoff. Synthesize
   and review the isolated stack; deploy it under the scoped deployment session.
   The placeholder grants no access to the subsequently uploaded real version.
   Launch refuses while ingestion is open. No instance starts during deploy.
2. The authorized curator packages an uncompressed tar containing only uniquely
   named regular files with relative paths (no explicit directory entries, links,
   traversal, duplicate paths or devices). Validate the owned bundle and full
   lossless inventory in its private source environment. Upload the single object with a **single-part PutObject** (admission
   maximum 4 GiB; larger bundles require a reviewed staging extension),
   with explicit `aws:kms` encryption and the **FixtureKey ARN**. The deployment
   operator supplies that ARN from the deployed private stack resource inventory. Capture the actual
   VersionId, SHA256 and byte length locally. This adds no extraction/prod grant.
3. Replace the placeholder with those exact values, choose the immutable schedule,
   policy and complete inventory, sign the final admission, and update only the
   private stack. Ingestion closes before launch; bucket policy denies all later
   uploads, so cleanup cannot be invalidated by a curator restaging after CLEAN.
   Launch must fall after `stagingExpiresAt` and before `expiresAt`, with at most
   12 instance-hours remaining. The sweeper's clock and IAM expiry enforce the
   same absolute admission deadline.

Sign locally using the already admitted private key (never commit it):

```sh
python3 ci/private_cert/sign.py --unsigned /private/path/admission-unsigned.json \
  --private-key /private/path/signing-key.pem --output /private/path/admission.json
```

In `cdk/`, the reviewed operator's synth/deploy input is
`PRIVATE_CERT_CONFIG=/private/path/admission.json` and context
`-c enablePrivateCertBox=true`. Missing/invalid signatures, pins, identities,
versions, bounds and expiry fields fail synthesis. Synthesize `PrivateCertStack`
with `--no-lookups`; the S3 prefix list is explicitly supplied from the reviewed
regional inventory. No lookup or deployment is performed by the local tests.
`enablePrivateCertBox=false` or omission reads no private admission at all.

Never update the template/admission, remove the flag, replace roles/keys, or destroy
this stack while an admission has a launch claim or unknown teardown. Such
privileged changes can remove its active sweeper; they are outside the runtime
isolation boundary. One immutable admission and one launch attempt per stack;
create a fresh stack only after the previous admission's verified disposal.

## Launch, reconcile, cancel

The operator uses `ci/private_cert/operator.py` with `--function` set to the
private stack's `ControlFunctionName` output, `--region`, `--admission-id`, and
one of `launch`, `status`, `cancel`. The payload accepts **only** the action and
admission ID. All template, profile, image and network arguments come from the
reviewed function configuration. The function has reserved concurrency one.

The function writes a create-only claim before calling RunInstances, with a fixed
ClientToken and MinCount/MaxCount of one. Repeated launch requests reconcile that
token; they never blindly reissue the launch. Lost acknowledgement plus an empty
Describe stays TEARDOWN_UNKNOWN. Operator failure/cancellation does not stop the
independent five-minute sweep. Missing S3-observed heartbeat after a bounded boot
grace also requests termination; worker-supplied timestamps cannot renew it.

A terminate/delete API acknowledgement is not a disposal receipt. CLEAN requires
observed `terminated`, exact stored volume ownership, explicit absence of both
volume IDs, and fresh empty staging-version and multipart inventories. Failed or
empty volume Describe is UNKNOWN. Unknown tagged disks are never deleted. If a
launch disappeared before its disks were inventoried, manual privileged review is
required; the function keeps this uncertainty visible instead of declaring CLEAN.
Absolute fixture expiry is enforced even when EC2 reconciliation fails.

All staging versions, delete markers and multipart uploads are removed; the
curator's original source bundle is outside this stack. Control records, evidence
buckets and KMS keys are retained on stack removal. Routine/failure evidence
prefixes expire after the admitted 30/90 days, including noncurrent versions.
Release evidence requiring longer rollback/support retention must be transferred
by the separate governed private archive process before that deadline; this
worker receives no release-archive permission. No Object Lock is set on staging.

Wire and test both maintainer alarms: control errors/UNKNOWN and missing sweep
invocations. Control logs contain fixed health counts and fixed errors only.
Never work around UNKNOWN by starting another admission. Investigate the exact
owned resources, restore the sweeper if needed, and retain the uncertainty in the
private run record until disposal is verified.

## Admitted image ABI and independent publication

The producer accepts `produce`, with `/fixture` read-only, only the six data
commitments in `/run-spec/inputs.json` read-only, and `/output` writable. It has no
admission/control mount, credentials, object keys, signatures, host sockets or
verifier output. It validates the original bundle manifest/configuration and the
complete planned scope, resolves lossless private event inputs, and runs the two
engines serially from a fresh directory. It retains every raw checkpoint, engine
exit and child peak RSS/output byte count. Nonzero exits or missing evidence are
INCOMPLETE. An OOM that kills the collector is retained by the supervisor's
failure path; capacity still needs measurement on the admitted host.

The verifier is built separately from independently reviewed source, and pinned
by its own OCI manifest digest. It accepts `verify`, with `/evidence` read-only,
`/admission` read-only (including `evidence-sha256`), and `/verdict` writable. It
independently admits the bundle, derives schedules/checkpoints and file inventory,
validates both raw schemas, and runs certify + G12. Stage comparisons cannot
change the verdict. The bounded `receipt.json` uses `polis-private-gate/2`, with
fixed reasons, count and admission/evidence/inventory/schedule/policy digests plus
`negativeControlsSha256`. The corresponding `negative-controls.json` contains the
17 G12 controls and four checkpoint schema/inventory controls. The supervisor
checks that artifact's actual bytes against the receipt. Missing checkpoints,
short entry inventories or failed controls cannot yield PASS.

Image release admission additionally requires the reviewed source closure and
synthetic wrapper/isolation controls described in the image README. Labels and
a successful build cannot establish correctness or reviewer independence. A
paired-recording PASS does not confer writer transfer or close shadow diagnostics.

The supervisor uploads bounded create-only 16-MiB chunks, records exact VersionIds
and SHA256s, and uploads the private manifest last. Failure envelopes/log chunks
are private and explicitly INCOMPLETE; upload failure leaves incomplete evidence.
The worker has no evidence read/list/delete or public publication permissions.

The private reviewer retrieves the exact manifest key/version from its private run
record. It runs `ci/private_cert/verify.py` on an isolated private Linux verifier
host with the admitted verifier image preloaded, passing `--admission`,
`--trusted-public-key` (file containing the independently admitted hex key),
`--manifest-key`, `--manifest-version`, the reviewed `--image-lock` and
`--runtime-lock`, a fresh `--private-workspace`, and `--summary`. The CLI binds the
image lock to the signed runtime digest and inspects the preloaded verifier
before it downloads evidence.
This downloads and hashes every exact chunk version, safely extracts the complete
evidence, **reruns** the independent gate, requires agreement with the bound private
receipt, and reads the matching immutable CLEAN record before writing any summary.
A zero producer exit, valid transport hash or worker PASS is insufficient.

The resulting local summary has only schema, opaque admission ID, candidate SHA,
fixed verdict/reason and check count. It includes no bundle hash, object key,
VersionId, private name/path, free text, log or raw JUnit. Sharing that reviewed
summary is a separate authorized publication step; the tool does not upload it.
No public certificate is emitted while cleanup or verification is unknown.

## Acceptance before private bytes

Run the entire canary matrix on synthetic bundles in the admitted payer account:
wrong version/object/endpoint/principal; public/synthetic role reads; candidate
DNS/internet/prod/IMDS access; cross-instance write/delete; missing conditional
write; image/profile/network/user-data overrides; unsigned/forged boot; traversal,
symlink and expansion bombs; absent/forged/truncated/short-inventory evidence;
cancel, lost launch acknowledgement, dead boot, killed supervisor and expired
credentials. Verify actual terminal EC2 state, both disks absent, every staged
version/delete marker/upload absent, and maintainer notification for unknown or
missing sweep. Local tests are not substitutes for IAM or ARM canaries.

After those pass, run the complete largest private entry and report capacity
separately. Existing public recording/schedule coverage and private gate admission
remain required; provisioning this box does not waive them.

## Local checks and cost accounting

Run `npm test -- --runInBand` and `npx tsc --noEmit` from `cdk/`, and
`python3 -m unittest discover -s ci/private_cert -p 'test_*.py' -v` from the root.
Synthesize the same base and edited checkout with identical environment/context,
then use `ci/private_cert/check_synth.py BASE_TEMPLATE OFF_TEMPLATE`. It compares
**all** resource fields and the complete template, with no normalization exceptions.
The opt-in stack should also synthesize under a signed synthetic admission and be
checked for dependency cycles. Never place a real admission in a test fixture.

Use measured EC2 hours, attached gp3 GiB-hours, retained S3 GiB-months, requests,
KMS and control costs. No NAT/public IPv4/interface-endpoint hourly fee is designed
in. A 12-hour campaign ceiling is a budget, not a completion estimate. Pin the
current regional rate at activation and measure actual largest-entry capacity;
local tests make no cost or runtime measurement claim.

IAM references: [S3 conditional write enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html),
[EC2 instance credential source condition](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-policies-for-amazon-ec2.html).

Multipart inventory is bucket-scoped metadata in this dedicated per-admission
staging bucket: IAM does not support `s3:prefix` for ListBucketMultipartUploads.
The API call still filters the staging prefix, and abort/deletion grants are
prefix-scoped. [S3 action authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_s3.html).
