# Certification CI on a disposable EC2 worker

The Delphi certification battery and the P-022 §C recovery matrix are too heavy
and too data-sensitive for a GitHub-hosted runner: the battery replays real
conversations against both the Clojure and the Python engine, and the fixture
bundle it replays is private production-derived data that must never reach a
public runner or a public artifact.

`.github/workflows/certification-ec2.yml` therefore launches **one disposable
EC2 instance per run**, drives it over SSM, and destroys it. The instance is
never registered as a GitHub runner, has no public IP, no inbound security-group
rule and no SSH key.

This is P-022 §E **v1 ("minimal")**. The v2 admission controller (Lambda,
per-run JWT capabilities, a baked trusted AMI, a signed safe-summary publisher)
is deliberately not built. See `cost-reduction/04-plans/P-022-E-ci-spec.md`.

## Pieces

| Piece | Where |
|---|---|
| IAM role GitHub assumes, worker instance role, launch template | `cdk/ciEc2.ts` |
| Wiring, behind the `enableCiEc2` context flag | `cdk/lib/cdk-stack.ts` |
| The workflow | `.github/workflows/certification-ec2.yml` |
| SSM send-and-wait helper (runs on the GitHub runner) | `ci/p022_ssm.sh` |
| The phases that run on the worker | `ci/p022_ec2_run.sh` |

## Enabling it

Everything is off by default. A normal `npx cdk synth` / `cdk deploy` produces
exactly the stack it produced before this landed — the construct is not
instantiated at all unless the context flag is set.

```bash
cd cdk

# unchanged stack (126 resources)
npx cdk synth

# with the CI worker (132 resources; the 6 additions are all under CertificationCi/)
npx cdk synth -c enableCiEc2=true
```

### Context flags

| Flag | Default | Meaning |
|---|---|---|
| `enableCiEc2` | `false` | Master switch. Nothing below matters while this is false. |
| `ciEc2InstanceType` | `r8g.4xlarge` | 16 vCPU / 128 GiB, the class P-022 §E asks for. |
| `ciEc2Arch` | `arm64` | Must match the instance type. `x86_64` picks the x86 AL2023 AMI. |
| `ciEc2VolumeGiB` | `200` | Encrypted gp3 root volume. |
| `ciEc2ShutdownMinutes` | `480` | Hard-deadline self-termination (see "Cost backstops"). |
| `ciEc2GithubRepo` | `compdemocracy/polis` | Repository allowed to assume the OIDC role. |
| `ciEc2FixtureBucket` / `ciEc2FixturePrefix` | unset / `p022/bundle/` | Private fixture bundle the **worker** may read. |
| `ciEc2EvidenceBucket` / `ciEc2EvidencePrefix` | unset / `p022/evidence/` | Private raw evidence the **worker** may write. |

### One-time deploy

```bash
cd cdk
npx cdk diff   -c enableCiEc2=true      # read this before deploying
npx cdk deploy -c enableCiEc2=true \
  -c ciEc2FixtureBucket=<private-bundle-bucket> \
  -c ciEc2EvidenceBucket=<private-evidence-bucket>
```

The deploy prints three outputs. Set the first two as **repository variables**
(Settings → Secrets and variables → Actions → Variables):

| Output | Repository variable |
|---|---|
| `CertifyOidcRoleArn` | `CERTIFY_OIDC_ROLE_ARN` |
| `CertifyLaunchTemplateId` | `CERTIFY_LAUNCH_TEMPLATE_ID` |
| `CertifyWorkerRoleArn` | (record only — GitHub never assumes it) |

Also set, if you have them:

- `CERTIFY_REGION` (variable) — defaults to `us-east-1`.
- `CERTIFY_FIXTURE_S3_URI` (**secret**) — `s3://bucket/prefix/` of the private
  bundle. Unset is fine: the battery then runs only the public `vw` and
  `biodiversity` fixtures and reports the private cases as skipped.
- `CERTIFY_EVIDENCE_S3_URI` (variable) — `s3://bucket/prefix/` for raw run
  evidence. The worker writes it; GitHub cannot read it back.

Create the `certification-private` environment with a required reviewer and
`edge` as its only selected branch before the first real run.

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
absolute worst case a single run can reach — the 480-minute shutdown backstop
firing on a wedged box — is about **$7.75**. Add a few tens of cents of NAT
egress for the docker/pip/Maven pulls.

The nightly cron is the number to watch: 30 six-hour runs is on the order of
**$175/month**. Turn the schedule off, shorten it, or drop to `r8g.2xlarge`
(halving the instance line) if the battery fits in 64 GiB — but size down only
from measured peaks, per P-022 §E.

Storage costs only while the instance lives: the root volume is
`DeleteOnTermination`, so a terminated run leaves nothing behind. Actions
artifacts are kept 7 days.

## Cost backstops

Two independent ones, because neither is sufficient alone:

1. **The job's `if: always()` teardown** terminates the instance, polls until it
   observes the instance leave `pending/running/stopping/stopped`, and **fails
   the job** if it cannot confirm that — a green run with an unconfirmed
   termination would be the expensive kind of green. If the launch step lost its
   response, the teardown sweeps by the `polis:ci-run` tag first.
2. **The instance kills itself.** The launch template sets
   `InstanceInitiatedShutdownBehavior=terminate`, and the *first* command in
   user-data — before docker, before the clone, before anything that can fail —
   is `shutdown -h +480`. A cancelled Actions run, a dead runner or a broken
   bootstrap therefore still costs at most the deadline.

Neither covers a host whose kernel dies without terminating. P-022 §E flags an
account-level expiry sweeper as a remaining requirement before private
activation; this v1 does not provide one.

## Running it manually

Actions → **Certification (EC2)** → Run workflow. Inputs:

| Input | Default | Notes |
|---|---|---|
| `instance_type` | `r8g.4xlarge` | Must be arm64 unless the stack was deployed with `ciEc2Arch=x86_64`. |
| `ref` | the workflow's own ref | Git ref checked out **on the worker**. |
| `run_battery` | `true` | Set false to run only the recovery matrix (much cheaper). |

The nightly cron only proceeds on `edge`: GitHub runs a scheduled workflow from
the **default branch**, so the job carries `if: github.ref == 'refs/heads/edge'`
rather than assuming it.

Artifacts (`certification-ec2-<run>-<attempt>`) contain the recovery log, its
JUnit XML, a counts summary and the certify verdict lines. They deliberately do
**not** contain raw battery output.

## Killing a stuck instance by tag

Every CI instance carries `polis:ci=disposable`, applied by the launch template
and re-applied by the workflow, and the IAM policy makes that tag the condition
on `ec2:TerminateInstances` — so this is both the runbook and the only thing the
CI role is allowed to kill.

```bash
# what is running
aws ec2 describe-instances \
  --filters "Name=tag:polis:ci,Values=disposable" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,Launched:LaunchTime,Run:Tags[?Key==`polis:ci-run`]|[0].Value}' \
  --output table

# kill them
aws ec2 terminate-instances --instance-ids $(
  aws ec2 describe-instances \
    --filters "Name=tag:polis:ci,Values=disposable" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
```

Add `"Name=tag:polis:ci-run,Values=<run_id>-<attempt>"` to target one run.

Nothing outside the CI worker carries `polis:ci`, so a blind sweep of that tag
cannot touch the web, math, delphi or ollama tiers.

## What the GitHub role can and cannot do

Can: `RunInstances` from **this one** launch template with **this one** instance
profile and IMDSv2 required; tag that launch (three fixed keys, `RunInstances`
only); `PassRole` for the worker role to EC2 only; EC2 `Describe*`;
`TerminateInstances` on `polis:ci=disposable`; `ssm:SendCommand` with
`AWS-RunShellScript` against `polis:ci=disposable` instances, and read those
commands' results.

Cannot: read the private fixture bundle or the evidence bucket, create a launch
template version, attach a key pair, reach Secrets Manager, touch any deployment
role, or terminate anything untagged.

The worker's own role is SSM core plus, when configured, prefix-bound read of
the fixture bundle and prefix-bound write of the evidence prefix. The two roles
are disjoint on purpose: private data is readable by the box, never by the
runner.
