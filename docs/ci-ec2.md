# Public battery recovery CI on a disposable EC2 worker

> **This is not private certification.** It runs the P-022 §C recovery matrix
> and the replay battery restricted to the repository's **public** fixtures
> (`vw`, `biodiversity`), and its verdict is `PUBLIC-BATTERY-PASS` precisely so it
> cannot be mistaken for a release certificate. Private certification — the
> prod-derived fixture bundle, a baked trusted AMI, an isolated account and VPC,
> and a signed summary GitHub reads but cannot influence — is specified in
> `cost-reduction/04-plans/P-022-E-ci-spec.md` and **is not implemented**.

The recovery matrix and the replay battery are too heavy for a GitHub-hosted
runner: the battery replays conversations against both the Clojure and the
Python engine.

`.github/workflows/certification-ec2.yml` therefore launches **one disposable
EC2 instance per run**, drives it over SSM, and destroys it. The instance is
never registered as a GitHub runner, has no public IP, no inbound
security-group rule and no SSH key. It also has **no credential that can reach
private data**: there is no fixture bucket and no evidence bucket in this
design, so there is nothing on the box that is not already public in this
repository. That is the data boundary — not the instance, which runs repository
code as root and could never have contained data it was given.

## Pieces

| Piece | Where |
|---|---|
| IAM role GitHub assumes, worker instance role, launch template | `cdk/ciEc2.ts` |
| Wiring, behind the `enableCiEc2` context flag | `cdk/lib/cdk-stack.ts` |
| The workflow | `.github/workflows/certification-ec2.yml` |
| SSM send-and-wait helper, with the output allowlist | `ci/p022_ssm.sh` |
| The phases that run on the worker | `ci/p022_ec2_run.sh` |
| Teardown: terminate and prove it | `ci/p022_teardown.py` |
| Fixed-schema summary validator, and the one definition of `SCHEMA` | `ci/p022_check_summary.py` |
| Packing the battery's recordings + their inventory manifest | `ci/p022_recordings_manifest.py` |
| Pulling that bundle off the worker, verified | `ci/p022_collect_recordings.sh` |
| Which battery entries have a Clojure↔Python pair on disk | `delphi/scripts/battery_coverage.py` |

## Enabling it

Everything is off by default. A normal `npx cdk synth` / `cdk deploy` produces
exactly the stack it produced before this landed — the construct is not
instantiated at all unless the context flag is set.

```bash
cd cdk

# unchanged stack (126 resources)
npx cdk synth

# with the CI worker (139 resources; the 13 additions are all under CertificationCi/)
npx cdk synth -c enableCiEc2=true
```

### Context flags

| Flag | Default | Meaning |
|---|---|---|
| `enableCiEc2` | `false` | Master switch. Nothing below matters while this is false. |
| `ciEc2InstanceType` | `r8g.4xlarge` | 16 vCPU / 128 GiB, the class P-022 §E asks for. |
| `ciEc2Arch` | `arm64` | Must match the instance type. `x86_64` picks the x86 AL2023 AMI. |
| `ciEc2VolumeGiB` | `200` | Encrypted gp3 root volume. |
| `ciEc2ShutdownMinutes` | `480` | Campaign ceiling, including bootstrap/cleanup: integer 1–480. Armed at boot (see "Cost backstops"). |
| `ciEc2GithubRepo` | `compdemocracy/polis` | Repository allowed to assume the OIDC role. |
| `ciEc2GithubEnvironment` | `certification-public` | Must equal the workflow job's `environment:`. The trust policy admits this subject and no other. |
| `ciEc2Refs` | `refs/heads/edge,refs/heads/stable` | Exact `ref` claim values. This is what excludes pull-request jobs at the token. Empty or non-branch entries are refused at synth. |
| `ciEc2AllowedInstanceTypes` | `r8g.4xlarge,r8g.2xlarge` | Enforced in IAM via `ec2:InstanceType`, so a dispatch input cannot select arbitrary spend. |

### One-time deploy

```bash
cd cdk
npx cdk diff   -c enableCiEc2=true      # read this before deploying
npx cdk deploy -c enableCiEc2=true
```

The deploy prints three outputs. Set the first two as **repository variables**
(Settings → Secrets and variables → Actions → Variables):

| Output | Repository variable |
|---|---|
| `CertifyOidcRoleArn` | `CERTIFY_OIDC_ROLE_ARN` |
| `CertifyLaunchTemplateId` | `CERTIFY_LAUNCH_TEMPLATE_ID` |
| `CertifyWorkerRoleArn` | (record only — GitHub never assumes it) |

Also set `CERTIFY_REGION` (variable) if the stack is not in `us-east-1`.

There is **no fixture or evidence secret**: this workflow has no private-data
path at all.

### The environment is a control you must configure, not a name

Create the `certification-public` environment **before** the first run, with:

- **Deployment branches and tags** limited to `edge` and `stable` (the trust
  policy's `ref` allowlist admits both; keep the two in step),
- a **required reviewer**,
- no admin bypass where your plan supports disabling it.

Round 2's claim that "without the environment the job cannot obtain credentials"
was wrong, and the correction matters: GitHub **automatically creates a
referenced environment that does not exist, with no protection rules at all**.
An environment name in YAML is not an approval gate.

The environment subject also does **not** by itself exclude pull-request jobs —
a job that references an environment gets the environment subject even on a PR.
Be precise about what excludes them, because the trust policy alone does not:

1. the `ref` claim pins `refs/heads/edge` / `refs/heads/stable`, which excludes
   an **ordinary** pull-request job — its ref is `refs/pull/<n>/merge`;
2. **this workflow file has no pull-request trigger at all**, only
   `workflow_dispatch` and `schedule`;
3. the environment's **deployment-branch rule and required reviewer** gate every
   job that references it.

(2) and (3) are load-bearing, not decoration. A `pull_request_target` job runs
trusted default-branch code and can carry an allowed base-branch ref, and
neither the repository claim nor the environment-form subject distinguishes it —
so any *other* trusted workflow in this repository that references
`certification-public` could match this trust policy. Nothing in the role
prevents that; reviewing what may use the environment does. If strict
per-workflow isolation is ever required, the answer is a dedicated reviewed
reusable-workflow boundary (whose token then really does carry
`job_workflow_ref`) or a customized subject — not a claim key AWS does not
support.

An earlier revision pinned `job_workflow_ref` and `event_name` instead. Both
were wrong and worth recording: `job_workflow_ref` is the claim a job gets when
it **calls a reusable workflow**, and this job runs directly on a runner, so the
condition could never match — the trust policy could not admit its own workflow.
`event_name` is emitted by GitHub but is not among the context keys AWS makes
available for this provider, so it was not a gate STS would evaluate. Only
claims AWS documents as supported are used now: `sub`, `aud`, `ref`,
`repository`.

Verify those against your repository's actual OIDC claims before the first run —
if immutable IDs or a customized subject template are enabled, the exact strings
change. A wrong claim value makes the assume fail, which is the right direction
to fail, but it will look like a broken workflow.

Because the flag is a CDK **context** value, everyone who deploys the stack must
pass it. If it is omitted on a later deploy, CloudFormation deletes the role,
launch template and security group and the workflow stops working. Consider
adding `"enableCiEc2": true` to `cdk/cdk.json`'s `context` block once the
feature is accepted, so it is not a per-invocation footgun.

## Why Graviton

The worker is arm64 (`r8g.4xlarge`, Amazon Linux 2023 arm64 AMI):

- The math tier this certifies is already Graviton (`instanceTypeMathWorker` is
  `r8g.2xlarge` in `cdk/ec2.ts`), and P-022 §E asks for a worker matching the
  existing math architecture.
- The compose bootstrap in `cdk/launchTemplates.ts` has been architecture
  agnostic since #2699 — it downloads `docker-compose-linux-$(uname -m)`, which
  resolves to `aarch64` here. The same idiom is reused in `cdk/ciEc2.ts`.
- Nothing in `docker-compose*.yml`, `delphi/Dockerfile*` or `math/Dockerfile*`
  pins `platform:` or `linux/amd64`, and both toolchains the battery shells out
  to (`uv run python`, `clojure -M:replay` on Corretto 21) publish aarch64
  builds.

Set `-c ciEc2Arch=x86_64 -c ciEc2InstanceType=r7i.4xlarge` if a dependency turns
out to lack an aarch64 wheel. Architecture is a certificate input: record which
one produced a given certificate.

## Cost per run

Published us-east-1 on-demand rates (AWS Price List API, queried while writing
this; re-check before quoting):

| Item | Rate |
|---|---|
| `r8g.4xlarge` (16 vCPU, 128 GiB) | $0.94256 / instance-hour |
| `r8g.2xlarge` (8 vCPU, 64 GiB) | $0.47128 / instance-hour |
| gp3 storage | $0.08 / GB-month → 200 GiB ≈ $0.022 / hour |
| NAT gateway data processing | $0.045 / GB (the gateway itself already exists) |

So a `r8g.4xlarge` run costs roughly **$0.97 per wall-clock hour**. Against the
P-022 six-hour compute budget that is about **$5.80 per campaign**, and the
480-minute shutdown ceiling on a responsive host is about **$7.75**. A dead
boot or wedged kernel can outlive that ceiling until an operator terminates it;
this is not an absolute cost bound. Add a few tens of cents of NAT
egress for the docker/pip/Maven pulls.

The nightly cron is the number to watch: 30 six-hour runs is on the order of
**$175/month**. Turn the schedule off, shorten it, or drop to `r8g.2xlarge`
(halving the instance line) if the battery fits in 64 GiB — but size down only
from measured peaks, per P-022 §E.

Storage costs only while the instance lives: the root volume is
`DeleteOnTermination`, so a terminated run leaves nothing behind. Actions
artifacts are kept 7 days.

## Cost backstops

1. **Workflow teardown** (`ci/p022_teardown.py`) re-assumes with the reviewed
   instance/run-scoped policy, terminates, and observes every expected instance
   in `terminated`. A missing ID, API error, or unresolved launch acknowledgement
   fails the job; none is evidence of disposal. A failed policy builder does not
   fall back to the unrestricted role.
2. **On-box deadline.** The campaign ceiling `ciEc2ShutdownMinutes` (default and
   maximum 480, including bootstrap and teardown) is rendered into
   `shutdown -h +N` before downloads, package installs, or checkout. Invalid,
   fractional, non-finite, zero, and over-ceiling values fail synthesis. Failure
   to arm triggers `poweroff -f` and stops bootstrap; a separate detached timer
   also powers off at that ceiling. The launch template uses
   `InstanceInitiatedShutdownBehavior=terminate` and deletes its root disk.
3. **Operator reconciliation.** There is no Lambda, EventBridge rule, or
   independent automatic expiry sweep for this CI construct. The OS timers do
   not cover a dead boot, wedged kernel, or privileged cancellation of both
   timers. A cancelled workflow, failed teardown, or missing completion requires
   the operator procedure below. Keep ownership of a campaign until termination
   and root-volume deletion are observed; never infer cleanup from elapsed time.

`ciEc2SweeperMaxAgeMinutes` has been removed. Stop passing that obsolete context
key in operator commands; the only deadline input is `ciEc2ShutdownMinutes`.

## Running it manually

Actions → **Public battery certification (EC2)** → Run
workflow. Inputs:

| Input | Default | Notes |
|---|---|---|
| `instance_type` | `r8g.4xlarge` | A dropdown, and IAM enforces the same allowlist. |
| `ref` | the workflow's own ref | A branch **short name** (`edge`) or a full 40-hex commit. Fully-qualified refs and tags are rejected before launch; the value is resolved once to an immutable commit. |
| `run_battery` | `true` | Only an **explicit manual false** selects recovery-only. A scheduled run has no inputs and always runs the full battery. |

The nightly cron only proceeds on `edge`: GitHub runs a scheduled workflow from
the **default branch**, so the job carries `if: github.ref == 'refs/heads/edge'`
rather than assuming it.

### The trust model

The summary is produced by the same recipe that ran the tests, so it is
**self-reported**. `ci/p022_check_summary.py` checks that the record is
coherent, complete and matches the run's declared scope — it does not and cannot
establish that the tests really ran. The artifact says so itself:
`trust: reviewed-recipe-self-reported`. That is the trust appropriate to a
public battery smoke over public fixtures; an adversarial certificate needs the
independent control boundary in `P-022-E-ci-spec.md`, which is not built.

### What comes back, and what does not

A run with the battery enabled uploads **two** artifacts.

`public-battery-ec2-<run>-<attempt>` (7 days) is the evidence bundle: a fixed-schema
`summary.json`, pytest's JUnit XML and the battery's dataset selection. It does
**not** contain any log. The worker prints only lines matching

```
p022 <phase> <key>=<value>
```

and `ci/p022_ssm.sh` drops anything that does not match rather than escaping it;
worker stderr is never printed at all. The bundle is returned base64 in bounded
chunks through the S3 result transport with a declared length and sha256, and a short or corrupt bundle fails
the step rather than being quietly truncated.

### Fetching the recordings and putting them where certify looks

`certification-recordings-<run>-<attempt>` (90 days) is the second artifact: the
battery's Clojure↔Python **recordings**, the one output of the run that cannot
be recomputed without paying for another instance. Until this existed the
battery wrote them under `/var/log/polis-ci/certify-run` and the box was then
terminated with them still on it, so a dispatch came back with a verdict and
nothing to measure. It holds one gzipped tar per battery entry under `entries/`
plus a `recordings-manifest.json` naming, for every entry, its dataset, schedule
id, per-engine step count, the sha256 of every step file, total bytes, and the
battery `inventory_digest` that binds it to the run's own `summary.json`. Only
entries the public inventory admitted are packed, and only an allowlist of file
names inside each recording directory (`schedule.json`, `provenance.json`,
`{clj,py}/step-*`, `{clj,py}/cache_manifest.json`); a `provenance.json` records
the worker's own repository path, which is the only path information that
leaves. Expect roughly 1.5–3 MB compressed for the six public entries. To fetch
one and drop it into the canonical store (`polismath/replay/store.py`), from the
repository root:

```bash
RUN=<run-id>; ATTEMPT=1
gh run download "$RUN" --name "certification-recordings-$RUN-$ATTEMPT" --dir /tmp/certify-recordings

# Re-hash every archive against the manifest before trusting a byte of it.
python3 ci/p022_recordings_manifest.py --verify /tmp/certify-recordings

# Each archive's members are already <dataset>/<schedule_id>/..., so this
# reproduces real_data/.local/replays/<dataset>/<schedule_id>/{clj,py}/ exactly.
mkdir -p delphi/real_data/.local/replays
for a in /tmp/certify-recordings/entries/*.tar.gz; do
  tar -xzf "$a" -C delphi/real_data/.local/replays
done

# Which battery entries now have a usable clj+py pair, and which still do not.
python3 delphi/scripts/battery_coverage.py
```

`--verify` fails on a missing or altered archive, and prints the manifest's own
list of entries that have **no** recording — so an incomplete download and an
incomplete run are told apart, and neither is inferred from silence.

`ci/p022_check_summary.py` is then given the run's **declared scope** and
rejects, on top of extra keys, wrong types, control characters and non-public
dataset slugs:

- a "pass" with any failure or error, with fewer executed (non-skipped) tests
  than the pinned per-phase floor, or with **any single report** that executed
  nothing — a JUnit `tests` count includes skips, so an all-skipped run and
  nineteen empty race invocations both used to look healthy;
- a report set that is not one report per pytest **invocation**. §C's race
  target runs pytest twenty separate times; the plugin names each report
  `<tag>-<pid>-<uuid>.xml` and the worker requires as many distinct pids as
  reports, so twenty files written by one process is a failure rather than
  twenty iterations. The expected counts (one matrix report, twenty race
  reports) are pinned by this recipe and must be re-pinned if §C's loop count
  changes — a mismatch fails the phase, it is never inferred from what turned
  up;
- any XPASS. A non-strict `@pytest.mark.xfail` that passes renders in JUnit as
  an ordinary pass, so `-o xfail_strict=true` and XML parsing between them
  cannot see it; the injected pytest plugin hooks the report itself, fails the
  process, and reports the count;
- a report inventory that is not exactly one JUnit file for the matrix and one
  per race iteration — so nineteen overwritten reports cannot look complete;
- a battery shortened from the six pinned public cases, or with a dataset set
  that is not the pinned one;
- an absent battery result claiming to be an intentional skip, unless the
  *caller* declared `--run-battery false`;
- a candidate SHA that is not the commit the workflow resolved — the ref is
  resolved once, on the runner, to an immutable commit that is both the launch
  tag and the validation expectation, and the worker no longer falls back to
  `edge` if its tag read fails;
- a battery whose **inventory digest** is not the admitted one. The digest
  covers each public entry with its value **types preserved** (`8` and `"8"` are
  different inventories) plus the canonical **contents** of every referenced
  schedule file — so deleting `restart_after` from a same-named schedule moves
  it — and the public fixture descriptors;
- a battery that declares fewer restart seams than the admitted inventory does,
  so a candidate whose schedules stopped restarting cannot quietly shrink the
  smoke;
- report counts that disagree with the JUnit files actually returned. The
  validator re-parses them: a summary claiming twenty-one reports with no XML
  present is rejected, and the counts are aggregates over every report rather
  than a maximum scraped from the tail of a log.

## Operator cleanup of one campaign

Use the operator's existing SSO session. Record the campaign's `<run_id>-<attempt>`
from Actions **before** launch. On cancellation, failed/missing teardown or a
missed deadline, reconcile only that campaign. The operator does not rely on the
CI OIDC role's session surviving. Commands below are operator instructions, not
a new service or scheduled task.

```bash
RUN_TAG=<run_id>-<attempt>
# Record the IDs, launch state and attached root volume IDs before terminating.
aws ec2 describe-instances \
  --filters "Name=tag:polis:ci,Values=disposable" \
            "Name=tag:polis:ci-run,Values=$RUN_TAG" \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,Launched:LaunchTime,Volumes:BlockDeviceMappings[].Ebs.VolumeId}' \
  --output json

# Substitute only the IDs reviewed above for this campaign.
aws ec2 terminate-instances --instance-ids <reviewed-instance-id>
aws ec2 wait instance-terminated --instance-ids <reviewed-instance-id>
aws ec2 describe-instances --instance-ids <reviewed-instance-id> \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name}'
aws ec2 describe-volumes --volume-ids <recorded-root-volume-id>
```

Require every known instance to be `terminated` and each recorded root volume to
be absent (`InvalidVolume.NotFound` for that exact ID). An authorization error or
other API failure is unresolved, not absent. An extant volume needs separate
operator investigation and cleanup; do not delete unrelated volumes. Repeat the
campaign tag query and reconcile late-visible instances after a lost launch
acknowledgement. Zero results immediately after an attempted launch do not prove
absence. Preserve the observation in the campaign handoff. Do not use a wildcard
all-CI terminate command.

## What the GitHub role can and cannot do

Can: `RunInstances` from **this one** launch template, with **this one**
instance profile, IMDSv2 required, an IAM-enforced instance-type allowlist and
the `polis:ci=disposable` and `polis:ci-run` tags mandatory; tag that launch
(three fixed keys, `RunInstances` only); `PassRole` for the worker role to EC2
only; `ec2:DescribeInstances`/`DescribeInstanceStatus`; `TerminateInstances` on
`polis:ci=disposable`; `ssm:SendCommand` with `AWS-RunShellScript` against
instances tagged `ssm:resourceTag/polis:ci=disposable`; and
`ssm:DescribeInstanceInformation` (registration metadata only); read/list public results in the dedicated results bucket.

After the launch the workflow **re-assumes with an inline session policy** that
pins SendCommand and TerminateInstances to the single instance ARN it just
created, because a tag is shared by every concurrent campaign and was never
proof of run ownership.

Cannot: read objects outside the public-results campaign prefix, use KMS, reach Secrets Manager, create a launch
template version, attach a key pair, touch any deployment role, or terminate
anything untagged.

### Residuals, stated rather than hidden

**Result reads are restricted to the dedicated public-results bucket.** The base
OIDC role can GetObject under `campaigns/*` and ListBucket only with that prefix.
The supplied working session further narrows those permissions to
`campaigns/<instance-arn>/*`. An admitted caller can omit that session restriction
and read another campaign in this public-only bucket; this is an accepted
residual, not proof of authenticated per-run reader isolation. The worker's
PutObject prefix uses `${ec2:SourceInstanceARN}`, supplied by IAM, and cannot
write another instance's results. EC2 tags are not used as S3 principal tags.
There is no SSM command-output read permission. Registration metadata remains
account-wide. This does not admit production data or credentials onto the box.

**The base role's SendCommand and TerminateInstances reach any instance sharing
the CI tag**, because an identity policy cannot name an instance that does not
exist yet. What is fixed is that no *live session* carries that reach: the
launch session subtracts SSM entirely, the working session pins SendCommand and
TerminateInstances to the one instance ARN, and the teardown session holds no
SSM at all and pins terminate to the instance when its ID is known. A tag is
still not a run-ownership fence.

**The worker can read AWS-owned SSM documents** (`document/AWS-*`), which the
agent needs. It can no longer read this account's private documents.

The worker's role is an explicit minimal SSM-agent policy — deliberately **not**
`AmazonSSMManagedInstanceCore`, which also grants `ssm:GetParameter` and
`ssm:GetParameters` on `*`. It can only create encrypted objects under its own result prefix; it has no S3 read/list/delete, KMS or Secrets Manager access.


## Bootstrap failure evidence

The wait command returns a bounded, credential-filtered tail on failure or
timeout. An EXIT trap records the current phase and creates the failed marker
for unexpected shell failures; it never prints shell commands or environment
values. The independent collector sends its stdlib-only helper from the control
checkout, so a failed clone does not prevent log recovery. It places the complete
filtered `bootstrap.log` in both the worker evidence directory and the uploaded
artifact directory, checking transfer length, SHA-256 and decompression bounds.
Oversized transfers fail explicitly. Raw logs stay on the worker; credential
lines, private-key blocks and opaque tokens are redacted before transport.

The ARM64 AL2023 package repository lacks `rlwrap`; the noninteractive battery
invokes `clojure`, so bootstrap installs Corretto without that interactive wrapper
dependency. Python synchronization includes the locked `dev` extra and verifies
`pytest`/`xdist` before the ready marker. The failed historical run's exact phase
cannot be recovered after termination; local package reproduction establishes a
concrete bootstrap defect, not the missing historical log.

Both the workflow/helper merge and a CDK redeploy are required: the latter updates
launch-template user data for future instances. The revised transport also requires the dedicated results bucket and its scoped IAM grants. A local test pass does not attest an entire ARM cloud boot.

## Bootstrap download integrity

`CI_BOOTSTRAP_PINS` in `cdk/ciEc2.ts` binds uv **0.12.12**, Clojure tools
**1.12.6.1673**, and Compose **v2.40.0** to SHA-256 of their downloaded bytes.
The uv/Clojure versions match the recorded successful public bootstrap; Compose
keeps its existing version. Both supported Compose architectures have separate
pins; other architectures fail before download.

Every download goes to a root-private temporary directory, follows HTTPS-only
redirects, and must pass `sha256sum -c` before a script executes or Compose is
installed. The uv installer embeds archive SHA-256 values for the supported Linux
architectures; the Clojure installer checks its tools archive before extraction.
The script hashes therefore also bind those archive checks. These checks do not
freeze `dnf` repositories, Python/Maven resolution, or container image tags.

To update a pin, download the exact versioned URL in `CI_BOOTSTRAP_PINS` as data,
compute SHA-256 locally, inspect the script and its nested archive checks, and
review the URL/hash change together. For Compose, compare both downloaded
binaries with the upstream release's `checksums.txt`. Never read an expected hash
from the network during bootstrap; a content change must fail until reviewed.

## Instance-owned S3 command results

Deploy the revised construct and set `CERTIFY_RESULTS_BUCKET` from its
`CertifyResultsBucket` output before using the revised workflow. The new bucket
blocks public access, enforces TLS, uses SSE-S3, and expires results after seven
days. It is separate from private probe evidence. The worker IAM statement
requires `AES256` and `If-None-Match: *` on every write. No deletion or overwrite
is granted. Bucket retention on stack removal requires operator lifecycle review.

`p022_ssm.sh` sends the control checkout's `p022_results.py` wrapper with each
command, allowing bootstrap diagnostics even if repository checkout failed.
The wrapper writes bounded stdout first, then a closed completion receipt with
instance ARN, unique command token, label, exit status, byte count and SHA-256.
The workflow polls S3 and verifies all those bindings. Delivery failure, missing
receipt, timeout, oversize, wrong identity/token, short data or changed bytes
cannot report success. SSM send acknowledgement is not completion evidence.
Raw command stderr remains on neither the output channel nor the public log.
The existing status/bootstrap allowlists and bundle/recordings checks still
apply after transport verification. Receipts are self-reported public battery
evidence; they are not private certification or an independent execution oracle.

The shared helper changes transport for the summary, JUnit, recordings and
bootstrap collectors together. Teardown still proves EC2 termination separately;
missing result delivery never substitutes for cleanup. Egress remains unchanged:
public package and repository downloads are still permitted. No production
credential or data is allowed on this host. Local transport tests use fakes and
do not claim a successful cloud boot, IAM evaluation or live S3 transfer.
