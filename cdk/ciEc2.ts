/**
 * P-022 §E v1 ("minimal") — disposable EC2 worker for the Delphi certification
 * battery and the recovery matrix.
 *
 * This construct is DORMANT by default. It is only instantiated when the CDK
 * context flag `enableCiEc2` is true:
 *
 *     npx cdk synth                          # unchanged stack, nothing here
 *     npx cdk synth -c enableCiEc2=true      # adds the resources below
 *
 * What it provisions (and nothing else):
 *
 *   1. `PolisCertifyGithubOidc` — an IAM role assumable **only** by GitHub
 *      Actions OIDC from this repository on `edge`, `stable` and pull-request
 *      refs. Its permissions are: RunInstances from exactly one launch
 *      template, the launch-time tags that make the instance findable and
 *      killable, PassRole for exactly the worker role, EC2 Describe, tag-scoped
 *      TerminateInstances, and SSM SendCommand/GetCommandInvocation against
 *      tag-scoped instances. No SSH key, no secrets, no S3 fixture read, no
 *      deployment permissions, no template mutation.
 *
 *   2. `PolisCertifyWorker` — the instance role. SSM core only, plus (optional,
 *      context-gated) read of the private fixture-bundle prefix and write of
 *      the private evidence prefix. The GitHub role can read neither.
 *
 *   3. `CertifyCiLaunchTemplate` — one disposable Graviton box: IMDSv2
 *      required, no public IP, no inbound rules, an encrypted gp3 root volume,
 *      `InstanceInitiatedShutdownBehavior=terminate`, and a user-data script
 *      whose *first* action is `shutdown -h +N` so the instance dies on a hard
 *      deadline even if every later step fails.
 *
 * Deliberately NOT here (P-022 §E v2, explicitly out of scope): the Lambda
 * admission controller, the JWT capability service, the baked trusted AMI, the
 * signed safe-summary publisher. See cost-reduction/04-plans/P-022-E-ci-spec.md.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** Tag key/value that every disposable CI instance must carry. Termination,
 *  SSM access and the manual "kill a stuck box" runbook are all scoped to it. */
export const CI_TAG_KEY = 'polis:ci';
export const CI_TAG_VALUE = 'disposable';
/** Launch-time tag the user-data reads (via IMDS instance tags) to learn which
 *  git ref to check out. Treated as untrusted input and validated in bash. */
export const CI_REF_TAG_KEY = 'polis:ci-ref';
/** Launch-time tag carrying `<run_id>-<attempt>`; diagnostics only. */
export const CI_RUN_TAG_KEY = 'polis:ci-run';

export interface CertificationCiEc2Props {
  /** VPC to place the worker in. A PRIVATE_WITH_EGRESS subnet is used, so the
   *  box reaches GitHub/PyPI/Maven/SSM through the existing NAT gateway and is
   *  not reachable from the internet. */
  readonly vpc: ec2.IVpc;
  /** `owner/repo` allowed to assume the OIDC role. */
  readonly githubRepo: string;
  /** Instance type. Graviton (arm64) by default — see docs/ci-ec2.md. */
  readonly instanceType: ec2.InstanceType;
  /** Must match `instanceType`'s architecture. */
  readonly cpuType: ec2.AmazonLinuxCpuType;
  /** Root volume size, GiB. */
  readonly volumeSizeGiB: number;
  /** Hard deadline, minutes. `shutdown -h +N` + shutdown-behavior=terminate. */
  readonly shutdownMinutes: number;
  /** Optional: bucket holding the private prod-derived fixture bundle. The
   *  WORKER may read it; the GitHub role may not. Absent → battery skipped. */
  readonly fixtureBucket?: string;
  /** Key prefix within `fixtureBucket`. */
  readonly fixturePrefix: string;
  /** Optional: bucket for raw private evidence. Worker writes, GitHub cannot
   *  read (P-022 §E: no private artifact in a public Actions artifact). */
  readonly evidenceBucket?: string;
  /** Key prefix within `evidenceBucket`. */
  readonly evidencePrefix: string;
}

export class CertificationCiEc2 extends Construct {
  public readonly githubRole: iam.Role;
  public readonly workerRole: iam.Role;
  public readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: CertificationCiEc2Props) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const { account, region, partition } = stack;

    // ---------------------------------------------------------------- worker
    // Instance role. SSM core is what makes SendCommand work at all; it is the
    // reason there is no SSH key, no public IP and no inbound security-group
    // rule anywhere in this construct.
    this.workerRole = new iam.Role(this, 'WorkerRole', {
      roleName: 'polis-certify-worker',
      description: 'P-022 E disposable certification worker (SSM only, no deploy rights)',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    if (props.fixtureBucket) {
      // Read-only, prefix-bound. No ListBucket over the whole bucket: the
      // prefix condition is what stops a compromised worker enumerating
      // anything else that happens to live there.
      this.workerRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ReadPrivateFixtureBundle',
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [`arn:${partition}:s3:::${props.fixtureBucket}/${props.fixturePrefix}*`],
      }));
      this.workerRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ListPrivateFixturePrefix',
        actions: ['s3:ListBucket'],
        resources: [`arn:${partition}:s3:::${props.fixtureBucket}`],
        conditions: { StringLike: { 's3:prefix': [`${props.fixturePrefix}*`] } },
      }));
    }

    if (props.evidenceBucket) {
      this.workerRole.addToPolicy(new iam.PolicyStatement({
        sid: 'WritePrivateEvidence',
        actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
        resources: [`arn:${partition}:s3:::${props.evidenceBucket}/${props.evidencePrefix}*`],
      }));
    }

    const instanceProfile = new iam.InstanceProfile(this, 'WorkerInstanceProfile', {
      instanceProfileName: 'polis-certify-worker',
      role: this.workerRole,
    });

    // ------------------------------------------------------------------- net
    const securityGroup = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: props.vpc,
      description: 'P-022 E certification worker: no inbound, egress only',
      allowAllOutbound: true,
    });

    // ------------------------------------------------------- launch template
    const userData = buildUserData(props);

    this.launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: 'polis-certify-ci',
      versionDescription: 'P-022 E v1 disposable certification worker',
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: props.cpuType,
      }),
      instanceType: props.instanceType,
      instanceProfile,
      userData,
      // Cost backstop #1: the OS shuts itself down on a hard deadline (see
      // buildUserData) and the shutdown terminates rather than stops, so a
      // wedged job cannot leave a running box or a stopped-but-billed volume.
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
      requireImdsv2: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      // The user-data needs the ref tag; IMDS tags avoid granting the worker
      // any ec2:DescribeTags. Hop limit 1 keeps containers off IMDS.
      instanceMetadataTags: true,
      detailedMonitoring: false,
      associatePublicIpAddress: false,
      disableApiTermination: false,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(props.volumeSizeGiB, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: true,
        }),
      }],
    });

    // Bake the subnet + security group into the template so the caller never
    // supplies them. IAM also pins both by ARN, but a caller may still pass a
    // *matching* value; baking them means the ordinary path passes nothing.
    const subnetId = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds[0];
    const cfnLt = this.launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLt.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      SubnetId: subnetId,
      Groups: [securityGroup.securityGroupId],
      AssociatePublicIpAddress: false,
      DeleteOnTermination: true,
    }]);
    // NetworkInterfaces and top-level SecurityGroupIds are mutually exclusive.
    cfnLt.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');
    // Default tags on instance and volume, so a launch that forgets its own
    // --tag-specifications is still terminable by tag. (RunInstances-supplied
    // tag specs REPLACE these per resource type — the workflow re-sends them.)
    cfnLt.addPropertyOverride('LaunchTemplateData.TagSpecifications', [
      { ResourceType: 'instance', Tags: [{ Key: CI_TAG_KEY, Value: CI_TAG_VALUE }] },
      { ResourceType: 'volume', Tags: [{ Key: CI_TAG_KEY, Value: CI_TAG_VALUE }] },
    ]);

    const launchTemplateArn = `arn:${partition}:ec2:${region}:${account}:launch-template/${this.launchTemplate.launchTemplateId}`;
    const templateCondition = {
      ArnEquals: { 'ec2:LaunchTemplate': launchTemplateArn },
      Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
    };

    // ----------------------------------------------------------- github role
    // Reuse the account's existing GitHub OIDC provider (the deploy workflows
    // already authenticate through it); do not create a second one.
    const oidcProviderArn = `arn:${partition}:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;

    this.githubRole = new iam.Role(this, 'GithubOidcRole', {
      roleName: 'polis-certify-github-oidc',
      description: 'P-022 E: GitHub Actions launches/observes/terminates the certification worker',
      // 6 h: the campaign budget is 6 h of compute, and configure-aws-credentials
      // does not refresh. A 1 h session would expire mid-poll and orphan the box.
      maxSessionDuration: cdk.Duration.hours(6),
      assumedBy: new iam.WebIdentityPrincipal(oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${props.githubRepo}:ref:refs/heads/edge`,
            `repo:${props.githubRepo}:ref:refs/heads/stable`,
            `repo:${props.githubRepo}:pull_request`,
          ],
        },
      }),
    });

    // (a) the instance itself: pinned template, pinned instance profile,
    //     IMDSv2 required, and the disposable tag is mandatory at launch so
    //     the tag-scoped terminate below can never fail to match.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LaunchApprovedInstance',
      actions: ['ec2:RunInstances'],
      resources: [`arn:${partition}:ec2:${region}:${account}:instance/*`],
      conditions: {
        ArnEquals: {
          'ec2:LaunchTemplate': launchTemplateArn,
          'ec2:InstanceProfile': instanceProfile.instanceProfileArn,
        },
        Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
        StringEquals: {
          'ec2:MetadataHttpTokens': 'required',
          [`aws:RequestTag/${CI_TAG_KEY}`]: CI_TAG_VALUE,
        },
      },
    }));

    // (b) the supporting resources the same call creates/consumes. Instance
    //     configuration condition keys apply to the instance ARN, not to these,
    //     so they are a separate statement (P-022-E-ci-spec.md).
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ApprovedLaunchResources',
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:${partition}:ec2:${region}::image/*`,
        `arn:${partition}:ec2:${region}:${account}:subnet/${subnetId}`,
        `arn:${partition}:ec2:${region}:${account}:security-group/${securityGroup.securityGroupId}`,
        `arn:${partition}:ec2:${region}:${account}:network-interface/*`,
        `arn:${partition}:ec2:${region}:${account}:volume/*`,
        `arn:${partition}:ec2:${region}:${account}:launch-template/${this.launchTemplate.launchTemplateId}`,
      ],
      conditions: templateCondition,
    }));

    // Launch-time tagging only. `ec2:CreateAction` pins this to RunInstances,
    // so the role cannot retag anything that already exists; `aws:TagKeys`
    // pins the exact three keys.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TagAtLaunchOnly',
      actions: ['ec2:CreateTags'],
      resources: [
        `arn:${partition}:ec2:${region}:${account}:instance/*`,
        `arn:${partition}:ec2:${region}:${account}:volume/*`,
        `arn:${partition}:ec2:${region}:${account}:network-interface/*`,
      ],
      conditions: {
        StringEquals: {
          'ec2:CreateAction': 'RunInstances',
          [`aws:RequestTag/${CI_TAG_KEY}`]: CI_TAG_VALUE,
        },
        'ForAllValues:StringEquals': {
          'aws:TagKeys': [CI_TAG_KEY, CI_REF_TAG_KEY, CI_RUN_TAG_KEY],
        },
      },
    }));

    // Attaching an instance profile requires PassRole in addition to
    // RunInstances. Exactly one role, only to EC2.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassOnlyWorkerRole',
      actions: ['iam:PassRole'],
      resources: [this.workerRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    }));

    // EC2 Describe* has no resource-level authorization; it is read-only.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ObserveInstances',
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeTags',
        'ec2:DescribeLaunchTemplates',
        'ec2:DescribeLaunchTemplateVersions',
      ],
      resources: ['*'],
    }));

    // The `if: always()` teardown, and the manual kill-by-tag runbook.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TerminateOwnDisposableInstances',
      actions: ['ec2:TerminateInstances'],
      resources: [`arn:${partition}:ec2:${region}:${account}:instance/*`],
      conditions: { StringEquals: { [`ec2:ResourceTag/${CI_TAG_KEY}`]: CI_TAG_VALUE } },
    }));

    // SendCommand is authorized against BOTH the document and the targets, so
    // it takes two statements: only AWS-RunShellScript, only tagged instances.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RunShellScriptDocumentOnly',
      actions: ['ssm:SendCommand'],
      resources: [`arn:${partition}:ssm:${region}::document/AWS-RunShellScript`],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SendCommandToDisposableInstancesOnly',
      actions: ['ssm:SendCommand'],
      resources: [`arn:${partition}:ec2:${region}:${account}:instance/*`],
      conditions: { StringEquals: { [`ec2:ResourceTag/${CI_TAG_KEY}`]: CI_TAG_VALUE } },
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadOwnCommandResults',
      actions: [
        'ssm:GetCommandInvocation',
        'ssm:ListCommandInvocations',
        'ssm:ListCommands',
        'ssm:DescribeInstanceInformation',
        'ssm:CancelCommand',
      ],
      resources: ['*'],
    }));

    // --------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'CertifyOidcRoleArn', {
      value: this.githubRole.roleArn,
      description: 'Set as the CERTIFY_OIDC_ROLE_ARN repository variable',
    });
    new cdk.CfnOutput(this, 'CertifyLaunchTemplateId', {
      value: this.launchTemplate.launchTemplateId!,
      description: 'Set as the CERTIFY_LAUNCH_TEMPLATE_ID repository variable',
    });
    new cdk.CfnOutput(this, 'CertifyWorkerRoleArn', {
      value: this.workerRole.roleArn,
      description: 'Instance role of the disposable worker (not assumable by GitHub)',
    });
  }
}

/**
 * User data for the disposable worker.
 *
 * Ordering matters: the shutdown timer is armed BEFORE anything that can fail,
 * so a broken bootstrap still costs at most `shutdownMinutes` of instance time.
 * The git ref arrives as an instance tag read through IMDSv2 and is validated
 * against a strict character class before it is ever handed to git — it is
 * caller-controlled input and is never eval'd or interpolated into a shell
 * command that could break out of its quoting.
 */
function buildUserData(props: CertificationCiEc2Props): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  ud.addCommands(
    'set -euo pipefail',
    'exec > >(tee -a /var/log/polis-ci-userdata.log) 2>&1',
    'echo "polis-ci bootstrap starting at $(date -u --iso-8601=seconds)"',
    '',
    '# --- cost backstop: arm the hard deadline before anything that can fail.',
    '# The launch template sets InstanceInitiatedShutdownBehavior=terminate, so',
    '# this halt is a termination, not a stop.',
    `shutdown -h +${props.shutdownMinutes} "polis-ci hard deadline" || true`,
    '',
    'fail() { echo "polis-ci bootstrap FAILED: $*" >&2; touch /var/lib/polis-ci-failed; exit 1; }',
    '',
    '# --- docker + compose (v2 CLI plugin) + the tools the suites shell out to.',
    'dnf update -y || true',
    'dnf install -y docker git jq tar gzip make awscli-2 || dnf install -y docker git jq tar gzip',
    'systemctl enable --now docker',
    'usermod -a -G docker ec2-user',
    '# $(uname -m) resolves to aarch64 on Graviton and x86_64 otherwise; a',
    '# hardcoded arch here is how a boot script dies with "Exec format error".',
    'COMPOSE_VERSION=v2.40.0',
    'mkdir -p /usr/libexec/docker/cli-plugins',
    'curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" -o /usr/libexec/docker/cli-plugins/docker-compose',
    'chmod +x /usr/libexec/docker/cli-plugins/docker-compose',
    'ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose',
    'docker compose version',
    '',
    '# --- which ref to test: an instance tag, read over IMDSv2.',
    'IMDS_TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 600")" || fail "no IMDSv2 token"',
    `POLIS_REF="$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/tags/instance/${CI_REF_TAG_KEY}" || true)"`,
    'if [ -z "$POLIS_REF" ]; then POLIS_REF=edge; fi',
    '# Untrusted input. Allow only ref-shaped characters, and no ".." segment.',
    'if ! printf %s "$POLIS_REF" | grep -Eq \'^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$\'; then fail "rejected ref"; fi',
    'case "$POLIS_REF" in *..*) fail "rejected ref" ;; esac',
    '',
    `git clone --filter=blob:none https://github.com/${props.githubRepo}.git /opt/polis || fail "clone"`,
    'cd /opt/polis',
    'git fetch --no-tags origin "$POLIS_REF" || fail "fetch $POLIS_REF"',
    'git checkout --detach FETCH_HEAD || fail "checkout"',
    'git rev-parse HEAD > /var/lib/polis-ci-sha',
    'chown -R ec2-user:ec2-user /opt/polis',
    '',
    'mkdir -p /var/log/polis-ci',
    'chown ec2-user:ec2-user /var/log/polis-ci',
    '# The workflow polls for this marker before it sends any SSM command.',
    'touch /var/lib/polis-ci-ready',
    'echo "polis-ci bootstrap ready at $(date -u --iso-8601=seconds) sha=$(cat /var/lib/polis-ci-sha)"',
  );
  return ud;
}
