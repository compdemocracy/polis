/**
 * P-022 §E — disposable EC2 worker for the **synthetic** recovery matrix and
 * the **public-fixture** replay battery.
 *
 * ## Scope, after Astra's #2715 review (round 2)
 *
 * This is NOT private certification and must never be described as one. Round 1
 * attached the private fixture-bundle role to a box that GitHub could open a
 * root shell on, which is not a data boundary at all (review E2). Round 2
 * removes the private side outright rather than pretending an instance boundary
 * contains root code:
 *
 *   - no fixture-bundle read anywhere in this construct,
 *   - no evidence-bucket write anywhere in this construct,
 *   - nothing prod-derived is ever staged on the worker,
 *   - the workflow's verdict is named for what it is (`synthetic`), so it can
 *     never be mistaken for a certificate.
 *
 * Private certification (baked trusted AMI, cloud-init disabled, isolated
 * account/VPC, endpoint-only egress, autonomous worker publishing a signed
 * fixed-schema summary that GitHub reads but cannot influence) remains
 * UNIMPLEMENTED. See cost-reduction/04-plans/P-022-E-ci-spec.md and the round-2
 * section of P-022-E-implementation-notes.md.
 *
 * ## Gate
 *
 *     npx cdk synth                       # untouched stack; nothing here exists
 *     npx cdk synth -c enableCiEc2=true   # adds the resources below
 *
 * ## What it provisions
 *
 *   1. `polis-certify-github-oidc` — assumable only by this repository through
 *      the GitHub **environment** subject (no branch subject, no fork/PR
 *      subject). It may launch one pinned template at one of a pinned set of
 *      instance types, tag that launch, Describe, terminate tagged CI boxes,
 *      and SendCommand `AWS-RunShellScript` at tagged CI boxes. The workflow
 *      narrows all of that to the single instance it launched with an inline
 *      session policy at re-assume time.
 *   2. `polis-certify-worker` — the instance role. An explicit minimal SSM
 *      agent policy, NOT `AmazonSSMManagedInstanceCore` (which also grants
 *      `ssm:GetParameter*` on `*` — review E6). No S3, no secrets, no KMS.
 *   3. `polis-certify-ci` launch template — Graviton, IMDSv2 required, no
 *      public IP, no inbound rules, encrypted gp3 root, shutdown-terminates,
 *      and a hard deadline armed as the first user-data action.
 *   4. An **independent EventBridge expiry sweeper** (review E7, BOARD [12]):
 *      an hourly Lambda that terminates any `polis:ci=disposable` instance
 *      older than the deadline, regardless of what GitHub did or failed to do.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Tag key/value every disposable CI instance carries. It is the predicate for
 *  the sweeper, for the operator runbook, and for the terminate/SendCommand
 *  conditions. Nothing else in the account uses it. */
export const CI_TAG_KEY = 'polis:ci';
export const CI_TAG_VALUE = 'disposable';
/** Launch-time tag the user-data reads (over IMDSv2) to learn which ref to
 *  check out. Untrusted input; validated in bash before git sees it. */
export const CI_REF_TAG_KEY = 'polis:ci-ref';
/** Launch-time tag carrying `<run_id>-<attempt>` — run ownership for the
 *  teardown's lost-ID sweep, and diagnostics for the sweeper. */
export const CI_RUN_TAG_KEY = 'polis:ci-run';

export interface CertificationCiEc2Props {
  /** VPC for the worker. A PRIVATE_WITH_EGRESS subnet is used. */
  readonly vpc: ec2.IVpc;
  /** `owner/repo` allowed to assume the OIDC role. */
  readonly githubRepo: string;
  /**
   * GitHub Actions **environment** whose subject is trusted. The workflow job
   * declares the same name. Round 1 trusted branch and `pull_request` subjects
   * while the job declared an environment, so the role could not actually be
   * assumed by its own workflow and could have been assumed by a fork-visible
   * subject from some other one (review E3).
   */
  readonly githubEnvironment: string;
  /**
   * Exact `job_workflow_ref` values the token must carry — the reviewed
   * workflow file at a reviewed branch. The environment subject binds neither
   * the workflow nor the event (review R2-F5): a job in ANY workflow that
   * references this environment gets the same subject. These claims do bind
   * them, and they fail closed.
   */
  readonly githubWorkflowRefs: string[];
  /** Exact `event_name` values admitted. Excludes `pull_request` at the token. */
  readonly githubEventNames: string[];
  /** Default instance type baked into the template. */
  readonly instanceType: ec2.InstanceType;
  /** Must match `instanceType`'s architecture. */
  readonly cpuType: ec2.AmazonLinuxCpuType;
  /**
   * Every instance type the OIDC role may launch. Enforced in IAM through
   * `ec2:InstanceType`, so a dispatch input cannot select arbitrary spend
   * (review E6 / divergence 4).
   */
  readonly allowedInstanceTypes: string[];
  /** Root volume size, GiB. */
  readonly volumeSizeGiB: number;
  /** Hard deadline, minutes: `shutdown -h +N` + shutdown-behavior=terminate. */
  readonly shutdownMinutes: number;
  /**
   * Age, in minutes, past which the independent sweeper kills a CI instance.
   * Must exceed `shutdownMinutes` so the sweeper is a backstop to the OS timer
   * rather than a competitor to it.
   */
  readonly sweeperMaxAgeMinutes: number;
}

export class CertificationCiEc2 extends Construct {
  public readonly githubRole: iam.Role;
  public readonly workerRole: iam.Role;
  public readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: CertificationCiEc2Props) {
    super(scope, id);

    if (props.sweeperMaxAgeMinutes <= props.shutdownMinutes) {
      throw new Error(
        'ciEc2SweeperMaxAgeMinutes must be greater than ciEc2ShutdownMinutes: ' +
        'the sweeper is the backstop for the OS timer, not a race against it');
    }
    if (props.allowedInstanceTypes.length === 0) {
      throw new Error('ciEc2AllowedInstanceTypes must not be empty');
    }

    const stack = cdk.Stack.of(this);
    const { account, region, partition } = stack;
    const instanceArnPattern = `arn:${partition}:ec2:${region}:${account}:instance/*`;

    // ---------------------------------------------------------------- worker
    // Explicitly NOT AmazonSSMManagedInstanceCore. That managed policy grants
    // ssm:GetParameter and ssm:GetParameters on "*" alongside the agent
    // actions, so "SSM only, no secrets" would have been false: any plaintext
    // Parameter Store value in the account would have been readable from the
    // box (review E6). These are the agent's own actions and nothing else.
    this.workerRole = new iam.Role(this, 'WorkerRole', {
      roleName: 'polis-certify-worker',
      description: 'P-022 E synthetic CI worker: SSM agent actions only, no data access',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    this.workerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmAgentRegistration',
      actions: [
        'ssm:UpdateInstanceInformation',
        'ssm:ListAssociations',
        'ssm:ListInstanceAssociations',
        'ssm:DescribeAssociation',
      ],
      // These four have no resource types in the service authorization
      // reference, so `*` is the only expressible scope.
      resources: ['*'],
    }));
    // GetDocument and DescribeDocument DO take document ARNs, and GetDocument
    // returns document CONTENT — round 2's comment claiming otherwise was
    // wrong (review R2-F5). Scoped to the AWS-owned namespace (no account id in
    // the ARN), which is what the agent needs; any private document this
    // account owns is now out of reach from the box.
    this.workerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadAwsOwnedDocumentsOnly',
      actions: ['ssm:GetDocument', 'ssm:DescribeDocument'],
      resources: [`arn:${partition}:ssm:${region}::document/AWS-*`],
    }));
    this.workerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmAgentChannels',
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
        'ec2messages:AcknowledgeMessage',
        'ec2messages:DeleteMessage',
        'ec2messages:FailMessage',
        'ec2messages:GetEndpoint',
        'ec2messages:GetMessages',
        'ec2messages:SendReply',
      ],
      resources: ['*'],
    }));

    const instanceProfile = new iam.InstanceProfile(this, 'WorkerInstanceProfile', {
      instanceProfileName: 'polis-certify-worker',
      role: this.workerRole,
    });

    // ------------------------------------------------------------------- net
    const securityGroup = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: props.vpc,
      description: 'P-022 E synthetic CI worker: no inbound, egress only',
      allowAllOutbound: true,
    });

    // ------------------------------------------------------- launch template
    this.launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: 'polis-certify-ci',
      versionDescription: 'P-022 E synthetic recovery + public-fixture battery worker',
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: props.cpuType,
      }),
      instanceType: props.instanceType,
      instanceProfile,
      userData: buildUserData(props),
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
      requireImdsv2: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
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
    cfnLt.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');
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
    // The account's GitHub OIDC provider already exists (the deploy workflows
    // authenticate through it); reference it, do not create a second one.
    const oidcProviderArn = `arn:${partition}:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;

    this.githubRole = new iam.Role(this, 'GithubOidcRole', {
      roleName: 'polis-certify-github-oidc',
      description: 'P-022 E: launches, drives and destroys the synthetic CI worker',
      maxSessionDuration: cdk.Duration.hours(6),
      // ENVIRONMENT subject, exactly, and nothing else. No branch subject: an
      // environment job's token carries the environment form, so a branch
      // subject would not have matched anyway. No `pull_request`: fork-authored
      // code must never be able to request this role from any workflow in the
      // repository, whether or not THIS file has a pull_request trigger.
      assumedBy: new iam.WebIdentityPrincipal(oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            `repo:${props.githubRepo}:environment:${props.githubEnvironment}`,
          // The subject alone binds neither workflow nor event. These two
          // claims do. A StringEquals against a list is an OR, so each is an
          // explicit allowlist. Both must be validated against the repository's
          // actual token claims before the first real run: a wrong claim name
          // fails the assume, which is the correct direction to fail.
          'token.actions.githubusercontent.com:job_workflow_ref': props.githubWorkflowRefs,
          'token.actions.githubusercontent.com:event_name': props.githubEventNames,
        },
      }),
    });

    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LaunchApprovedInstance',
      actions: ['ec2:RunInstances'],
      resources: [instanceArnPattern],
      conditions: {
        ArnEquals: {
          'ec2:LaunchTemplate': launchTemplateArn,
          'ec2:InstanceProfile': instanceProfile.instanceProfileArn,
        },
        Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
        StringEquals: {
          'ec2:MetadataHttpTokens': 'required',
          [`aws:RequestTag/${CI_TAG_KEY}`]: CI_TAG_VALUE,
          // Pinned in IAM, not merely defaulted in the template: a dispatch
          // input must not be able to select an arbitrary hourly rate.
          'ec2:InstanceType': props.allowedInstanceTypes,
        },
        // Every launch must carry the run tag, so the teardown's lost-ID sweep
        // and the sweeper's forensics always have an owner to name.
        'ForAllValues:StringEquals': {
          'aws:TagKeys': [CI_TAG_KEY, CI_REF_TAG_KEY, CI_RUN_TAG_KEY],
        },
        StringLike: { [`aws:RequestTag/${CI_RUN_TAG_KEY}`]: '?*' },
      },
    }));

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

    // Two statements, not one. Round 2 required `aws:RequestTag/polis:ci-run`
    // for CreateTags on instances, volumes AND network interfaces, but the
    // launch template tags the root volume with `polis:ci` only — so the volume
    // tagging half of the very launch this policy authorises would have been
    // denied (review R2-F1). Run ownership is required where it means
    // something, on the instance; volumes and ENIs may carry the same allowed
    // keys without being forced to prove ownership. The workflow sends the run
    // tag on volumes too, so in practice they carry it — but the authorisation
    // no longer depends on a tag the template alone cannot supply.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TagInstanceAtLaunchWithRunOwnership',
      actions: ['ec2:CreateTags'],
      resources: [instanceArnPattern],
      conditions: {
        StringEquals: {
          'ec2:CreateAction': 'RunInstances',
          [`aws:RequestTag/${CI_TAG_KEY}`]: CI_TAG_VALUE,
        },
        StringLike: { [`aws:RequestTag/${CI_RUN_TAG_KEY}`]: '?*' },
        'ForAllValues:StringEquals': {
          'aws:TagKeys': [CI_TAG_KEY, CI_REF_TAG_KEY, CI_RUN_TAG_KEY],
        },
      },
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TagLaunchVolumesAndInterfaces',
      actions: ['ec2:CreateTags'],
      resources: [
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

    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassOnlyWorkerRole',
      actions: ['iam:PassRole'],
      resources: [this.workerRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    }));

    // EC2 Describe* has no resource-level authorization (confirmed against the
    // service authorization reference); it is read-only metadata.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ObserveInstances',
      actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'],
      resources: ['*'],
    }));

    // `ec2:ResourceTag` IS a supported condition key for ec2:TerminateInstances
    // on the instance resource. The workflow narrows this to the single
    // instance it launched with an inline session policy; the tag condition is
    // the floor, for the lost-ID sweep and the operator runbook.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TerminateDisposableCiInstances',
      actions: ['ec2:TerminateInstances'],
      resources: [instanceArnPattern],
      conditions: { StringEquals: { [`ec2:ResourceTag/${CI_TAG_KEY}`]: CI_TAG_VALUE } },
    }));

    // SendCommand authorizes against the document AND the target, so two
    // statements. Round 1 used `ec2:ResourceTag/...` here, which the SSM
    // service authorization reference does not list for this action — the
    // instance resource type supports `aws:ResourceTag/${TagKey}` and
    // `ssm:resourceTag/${TagKey}` only, so the intended target would have been
    // denied (review E6). Corrected to `ssm:resourceTag/`.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RunShellScriptDocumentOnly',
      actions: ['ssm:SendCommand'],
      resources: [`arn:${partition}:ssm:${region}::document/AWS-RunShellScript`],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SendCommandToDisposableInstancesOnly',
      actions: ['ssm:SendCommand'],
      resources: [instanceArnPattern],
      conditions: { StringEquals: { [`ssm:resourceTag/${CI_TAG_KEY}`]: CI_TAG_VALUE } },
    }));
    // ssm:GetCommandInvocation and ssm:DescribeInstanceInformation support NO
    // resource types and NO condition keys (service authorization reference),
    // so they cannot be narrowed here or in a session policy. State the reach
    // plainly: GetCommandInvocation returns a command's stdout AND stderr, so
    // for any command/instance id pair this role can guess or learn, it can
    // read that command's output anywhere in the account. Dropping the List
    // APIs removed discoverability, not authorisation. Only running this in an
    // isolated account closes it, which is why that remains the activation
    // gate (review E6, R2-F5).
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadCommandResults',
      actions: ['ssm:GetCommandInvocation', 'ssm:DescribeInstanceInformation'],
      resources: ['*'],
    }));

    // ------------------------------------------------------- expiry sweeper
    // Independent of GitHub entirely: it runs whether or not a workflow ever
    // reaches its teardown, whether or not the OS timer armed, and whether or
    // not the instance's kernel is alive (review E7, BOARD [12]).
    const sweeperRole = new iam.Role(this, 'SweeperRole', {
      description: 'P-022 E expiry sweeper: kill overdue disposable CI instances',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    sweeperRole.addToPolicy(new iam.PolicyStatement({
      sid: 'FindOverdueCiInstances',
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));
    sweeperRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TerminateOverdueCiInstances',
      actions: ['ec2:TerminateInstances'],
      resources: [instanceArnPattern],
      conditions: { StringEquals: { [`ec2:ResourceTag/${CI_TAG_KEY}`]: CI_TAG_VALUE } },
    }));

    // An explicit log group rather than the `logRetention` prop: that prop
    // drags in a shared LogRetention custom-resource Lambda and its role, which
    // is three extra account-wide resources for a retention setting.
    const sweeperLogs = new logs.LogGroup(this, 'ExpirySweeperLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    sweeperLogs.grantWrite(sweeperRole);

    const sweeper = new lambda.Function(this, 'ExpirySweeper', {
      description: 'Terminates polis:ci=disposable instances older than the hard deadline',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role: sweeperRole,
      timeout: cdk.Duration.minutes(2),
      logGroup: sweeperLogs,
      environment: {
        MAX_AGE_MINUTES: String(props.sweeperMaxAgeMinutes),
        CI_TAG_KEY,
        CI_TAG_VALUE,
      },
      code: lambda.Code.fromInline(SWEEPER_SOURCE),
    });

    new events.Rule(this, 'ExpirySweeperSchedule', {
      description: 'Hourly expiry sweep for P-022 E disposable CI instances',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(sweeper)],
    });

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
 * The expiry sweeper. Deliberately tiny, dependency-free and independent of the
 * Actions run: it is the only teardown guarantee that survives a dead runner, a
 * forced cancellation, an expired credential or a wedged kernel.
 */
const SWEEPER_SOURCE = `
import datetime, os
import boto3

MAX_AGE = datetime.timedelta(minutes=int(os.environ["MAX_AGE_MINUTES"]))
TAG_KEY = os.environ["CI_TAG_KEY"]
TAG_VALUE = os.environ["CI_TAG_VALUE"]
ACTIVE = ["pending", "running", "stopping", "stopped"]


def handler(event, context):
    ec2 = boto3.client("ec2")
    now = datetime.datetime.now(datetime.timezone.utc)
    overdue, seen = [], 0
    paginator = ec2.get_paginator("describe_instances")
    pages = paginator.paginate(Filters=[
        {"Name": "tag:" + TAG_KEY, "Values": [TAG_VALUE]},
        {"Name": "instance-state-name", "Values": ACTIVE},
    ])
    for page in pages:
        for reservation in page["Reservations"]:
            for inst in reservation["Instances"]:
                seen += 1
                age = now - inst["LaunchTime"]
                if age > MAX_AGE:
                    overdue.append(inst["InstanceId"])
                    print("OVERDUE %s age=%s state=%s tags=%s" % (
                        inst["InstanceId"], age, inst["State"]["Name"],
                        {t["Key"]: t["Value"] for t in inst.get("Tags", [])}))
    if overdue:
        # Let a failure here raise: an unswept overdue instance must show up as
        # a Lambda error metric, not as a silent success.
        ec2.terminate_instances(InstanceIds=overdue)
        print("TERMINATED %s" % overdue)
    return {"seen": seen, "terminated": overdue}
`;

/**
 * User data for the synthetic worker.
 *
 * Two things in order matter here. First, the hard deadline is armed before
 * anything that can fail, and — round 2 — a failure to arm it is fatal rather
 * than swallowed by `|| true`: an instance that cannot promise to kill itself
 * kills itself now. Second, a redundant in-process timer is started, so the
 * deadline does not depend on a single `shutdown` implementation.
 *
 * The git ref arrives as an instance tag read through IMDSv2 and is validated
 * against a strict character class before git sees it. Nothing prod-derived is
 * ever staged here: there is no fixture bucket, and the instance role cannot
 * read one.
 */
function buildUserData(props: CertificationCiEc2Props): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  const deadlineSeconds = props.shutdownMinutes * 60;
  ud.addCommands(
    'set -euo pipefail',
    'exec > >(tee -a /var/log/polis-ci-userdata.log) 2>&1',
    'echo "polis-ci bootstrap starting at $(date -u --iso-8601=seconds)"',
    '',
    'fail() { echo "polis-ci bootstrap FAILED: $*" >&2; touch /var/lib/polis-ci-failed; exit 1; }',
    '',
    '# --- cost backstop, armed before anything that can fail. The launch',
    '# template sets InstanceInitiatedShutdownBehavior=terminate, so a halt is',
    '# a termination. An instance that cannot arm its own deadline is a cost',
    '# leak waiting to happen, so failing to arm it is fatal immediately.',
    `if ! shutdown -h +${props.shutdownMinutes} "polis-ci hard deadline"; then`,
    '  echo "could not arm the shutdown timer; terminating now" >&2',
    '  poweroff -f',
    '  exit 1',
    'fi',
    '# Redundant timer, independent of shutdown(8) and of this script surviving.',
    `setsid bash -c 'sleep ${deadlineSeconds}; poweroff -f' </dev/null >/dev/null 2>&1 &`,
    '',
    '# --- docker + compose + the tools the suites shell out to.',
    'dnf update -y || true',
    'dnf install -y docker git jq tar gzip make || fail "dnf install"',
    'systemctl enable --now docker || fail "docker"',
    'usermod -a -G docker ec2-user',
    '# $(uname -m) is aarch64 on Graviton and x86_64 otherwise; a hardcoded',
    '# arch here is how a boot script dies with "Exec format error".',
    'COMPOSE_VERSION=v2.40.0',
    'mkdir -p /usr/libexec/docker/cli-plugins',
    'curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" -o /usr/libexec/docker/cli-plugins/docker-compose || fail "compose download"',
    'chmod +x /usr/libexec/docker/cli-plugins/docker-compose',
    'ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose',
    'docker compose version || fail "compose"',
    '',
    '# --- which ref to test: an instance tag, read over IMDSv2.',
    'IMDS_TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 600")" || fail "no IMDSv2 token"',
    `POLIS_REF="$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/tags/instance/${CI_REF_TAG_KEY}" || true)"`,
    'if [ -z "$POLIS_REF" ]; then POLIS_REF=edge; fi',
    '# Untrusted input. Ref-shaped characters only, and no ".." segment.',
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
    '',
    '# --- the recovery runtime, BEFORE the ready marker. P-022 section C\'s',
    '# target runs host `uv run --no-sync pytest`, so a box that has only',
    '# docker and git cannot run the matrix at all; round 2 installed uv in the',
    '# battery phase, which never ran with run_battery=false (review R2-F2).',
    'export HOME=/root',
    'curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh || fail "uv download"',
    'sh /tmp/uv-install.sh || fail "uv install"',
    'install -m 0755 /root/.local/bin/uv /usr/local/bin/uv || fail "uv place"',
    '(cd /opt/polis/delphi && uv sync) || fail "uv sync"',
    '# The battery additionally shells out to `clojure -M:replay`.',
    'dnf install -y java-21-amazon-corretto-headless rlwrap || fail "jvm"',
    'curl -fsSL -o /tmp/clojure-install.sh https://download.clojure.org/install/linux-install.sh || fail "clj download"',
    'chmod +x /tmp/clojure-install.sh && /tmp/clojure-install.sh || fail "clj install"',
    '# Verify rather than assume: a phase must never silently repair a',
    '# bootstrap that should have failed.',
    'uv --version || fail "uv missing after install"',
    'clojure --version || fail "clojure missing after install"',
    'java -version || fail "java missing after install"',
    'chown -R ec2-user:ec2-user /opt/polis',
    '',
    'mkdir -p /var/log/polis-ci',
    '# The workflow polls for this marker before it sends any SSM command.',
    'touch /var/lib/polis-ci-ready',
    'echo "polis-ci bootstrap ready at $(date -u --iso-8601=seconds) sha=$(cat /var/lib/polis-ci-sha)"',
  );
  return ud;
}
