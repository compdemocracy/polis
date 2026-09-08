# Synthetic recovery CI on a disposable EC2 worker

> **This is not private certification.** It runs the P-022 §C recovery matrix
> and the replay battery restricted to the repository's **public** fixtures
> (`vw`, `biodiversity`), and its verdict is `SYNTHETIC-PASS` precisely so it
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
| Fixed-schema summary validator | `ci/p022_check_summary.py` |

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
| `ciEc2ShutdownMinutes` | `480` | Hard-deadline self-termination (see "Cost backstops"). |
| `ciEc2GithubRepo` | `compdemocracy/polis` | Repository allowed to assume the OIDC role. |
| `ciEc2GithubEnvironment` | `certification-synthetic` | Must equal the workflow job's `environment:`. The trust policy admits this subject and no other. |
| `ciEc2AllowedInstanceTypes` | `r8g.4xlarge,r8g.2xlarge` | Enforced in IAM via `ec2:InstanceType`, so a dispatch input cannot select arbitrary spend. |
| `ciEc2SweeperMaxAgeMinutes` | `ciEc2ShutdownMinutes + 60` | Age past which the independent sweeper kills a CI instance. Must exceed the OS deadline. |

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

Create the `certification-synthetic` environment with `edge` as its only
selected branch before the first run. The environment is not optional — the
role's trust policy admits only `repo:<repo>:environment:certification-synthetic`,
so without it the job cannot obtain credentials at all.

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

Three, layered, because each covers a failure the others do not:

1. **The job's `if: always()` teardown** (`ci/p022_teardown.py`) terminates the
   instance and then *proves* it: every expected instance ID must be observed in
   state `terminated`. `shutting-down` keeps it polling; a missing ID, an
   unrecognised state, or a `describe-instances` that fails outright all **fail
   the job**. A failed discovery is unresolved ownership, not "nothing was
   launched" — that conflation was a real bug in round 1. The job re-assumes its
   role immediately before this step, so a long run cannot arrive here without
   credentials.
2. **The instance kills itself.** `InstanceInitiatedShutdownBehavior=terminate`,
   and the *first* user-data command is `shutdown -h +480`. Failing to arm that
   timer is fatal — the box powers off immediately rather than continuing
   unbounded — and a second, independent in-process timer backs it up.
3. **An independent EventBridge sweeper.** An hourly Lambda terminates any
   `polis:ci=disposable` instance older than the deadline. It does not care
   whether the Actions run finished, was cancelled, lost its runner, or whether
   the instance's kernel is alive. This is the only one of the three that
   survives a wedged host, and it is why the tag is mandatory at launch.

## Running it manually

Actions → **Synthetic recovery and public-fixture battery (EC2)** → Run
workflow. Inputs:

| Input | Default | Notes |
|---|---|---|
| `instance_type` | `r8g.4xlarge` | A dropdown, and IAM enforces the same allowlist. |
| `ref` | the workflow's own ref | Git ref checked out **on the worker**. |
| `run_battery` | `true` | Set false to run only the recovery matrix (much cheaper). |

The nightly cron only proceeds on `edge`: GitHub runs a scheduled workflow from
the **default branch**, so the job carries `if: github.ref == 'refs/heads/edge'`
rather than assuming it.

### What comes back, and what does not

Artifacts (`synthetic-ec2-<run>-<attempt>`) contain a fixed-schema
`summary.json`, pytest's JUnit XML and the battery's dataset selection. They do
**not** contain any log. The worker prints only lines matching

```
p022 <phase> <key>=<value>
```

and `ci/p022_ssm.sh` drops anything that does not match rather than escaping it;
worker stderr is never printed at all. The bundle is returned base64 in bounded
chunks with a declared length and sha256, and a short or corrupt bundle fails
the step rather than being quietly truncated.

`ci/p022_check_summary.py` then **recomputes** the verdict from the component
return codes and rejects extra keys, wrong types, control characters,
out-of-range integers and any dataset slug that is not a public fixture. A
worker cannot declare its own PASS, and cannot smuggle text out through a field
the schema does not allow.

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

Can: `RunInstances` from **this one** launch template, with **this one**
instance profile, IMDSv2 required, an IAM-enforced instance-type allowlist and
the `polis:ci=disposable` and `polis:ci-run` tags mandatory; tag that launch
(three fixed keys, `RunInstances` only); `PassRole` for the worker role to EC2
only; `ec2:DescribeInstances`/`DescribeInstanceStatus`; `TerminateInstances` on
`polis:ci=disposable`; `ssm:SendCommand` with `AWS-RunShellScript` against
instances tagged `ssm:resourceTag/polis:ci=disposable`; and
`ssm:GetCommandInvocation`/`DescribeInstanceInformation`.

After the launch the workflow **re-assumes with an inline session policy** that
pins SendCommand and TerminateInstances to the single instance ARN it just
created, because a tag is shared by every concurrent campaign and was never
proof of run ownership.

Cannot: read any S3 object, use KMS, reach Secrets Manager, create a launch
template version, attach a key pair, touch any deployment role, or terminate
anything untagged.

Two residuals are stated rather than hidden. `ssm:GetCommandInvocation` and
`ssm:DescribeInstanceInformation` support no resource types and no condition
keys in the AWS service authorization reference, so they cannot be narrowed by
any policy — `ListCommands`, `ListCommandInvocations` and `CancelCommand` were
dropped outright rather than kept on `*` for convenience. And the tag-scoped
`TerminateInstances` on the base role can reach another concurrent campaign's
box; the session policy removes that for the normal path, and the grant remains
so the lost-ID sweep and the operator runbook still work.

The worker's role is an explicit minimal SSM-agent policy — deliberately **not**
`AmazonSSMManagedInstanceCore`, which also grants `ssm:GetParameter` and
`ssm:GetParameters` on `*`. It has no S3, no KMS and no Secrets Manager access
of any kind.
