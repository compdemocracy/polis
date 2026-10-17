/**
 * The image build box: an x86_64 EC2 instance the production deploy workflow
 * launches for each deploy. It builds every image a production box runs and
 * pushes it to ECR with its own instance role; the production boxes only pull
 * by digest (scripts/after_install.sh) and never build.
 *
 * ## Gate
 *
 *     npx cdk synth                          # untouched stack; nothing here exists
 *     npx cdk synth -c enableBuildBox=true   # adds the resources below
 *
 * Keep passing the flag once deployed: without it CloudFormation deletes the
 * role the deploy workflow assumes. The two repositories are retained.
 *
 * ## What it provisions
 *
 *   1. `polis-build-box` launch template: Amazon Linux 2023 x86_64 (the web,
 *      Delphi and worker templates are x86_64, cdk/ec2.ts), a public subnet
 *      with a public IPv4 and no inbound rule (a cold build pulls and pushes
 *      gigabytes; through the NAT gateway each gigabyte is billed again),
 *      IMDSv2, encrypted gp3 root, shutdown terminates, and a hard cap armed
 *      as the first user-data action. The workflow launches it as spot across
 *      BUILD_BOX_INSTANCE_TYPES and falls back to on-demand.
 *   2. `polis-build-box` instance role: the SSM agent's own actions, ECR push
 *      to BUILD_REPOSITORIES only, read of build-source/ in the deployment
 *      bucket. No secrets, no Parameter Store, no database route.
 *   3. `polis-deploy-github` role, assumed by the deploy workflow through
 *      GitHub OIDC (one environment, one ref): launch the template at an
 *      allowed type, command and terminate tagged build boxes, upload the
 *      source and the bundle, create the deployment. No stored keys.
 *   4. ECR repositories polis/nginx-proxy and polis/client-participation-alpha
 *      (polis/server, polis/delphi and polis already exist).
 *
 * No Lambda and no scheduled sweeper: the box terminates itself.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CI_BOOTSTRAP_PINS } from './ciEc2';

/** Every build box carries this tag; IAM keys terminate and SendCommand on it. */
export const BUILD_BOX_TAG_KEY = 'polis:build-box';
export const BUILD_BOX_TAG_VALUE = 'deploy';
/** Launch-time tag naming the commit the box builds (diagnostics only). */
export const BUILD_BOX_COMMIT_TAG_KEY = 'polis:build-commit';
/** Spot is tried across these, in order, then on-demand. Enforced in IAM; the
 *  workflow's BUILD_BOX_TYPES must list the same. All x86_64, 16 vCPU. */
export const BUILD_BOX_INSTANCE_TYPES = ['c7i.4xlarge', 'c6i.4xlarge', 'c6a.4xlarge', 'm7i.4xlarge'];
/** Hard cap from boot: the box powers off, which terminates it. */
export const BUILD_BOX_HARD_CAP_MINUTES = 60;
/** Idle stop: no build has held the lock (deploy/build-images.sh) this long. */
export const BUILD_BOX_IDLE_MINUTES = 10;
/** The repositories the box may push to; deploy/build-images.sh pushes these. */
export const BUILD_REPOSITORIES = [
  'polis/server', 'polis/nginx-proxy', 'polis/client-participation-alpha', 'polis/delphi', 'polis',
];

export interface BuildBoxProps {
  readonly vpc: ec2.IVpc;
  /** The CodeDeploy bundle bucket (cdk/codedeploy.ts); build sources go under build-source/. */
  readonly deploymentBucket: s3.Bucket;
  readonly codeDeployApplicationName: string;
  readonly codeDeployDeploymentGroupName: string;
  /** `owner/repo` allowed to assume the deploy role. */
  readonly githubRepo: string;
  /** The `environment:` the deploy jobs declare. */
  readonly githubEnvironment: string;
  /** Exact `ref` claims admitted, e.g. `refs/heads/stable`. */
  readonly githubRefs: string[];
}

export class BuildBox extends Construct {
  public readonly boxRole: iam.Role;
  public readonly githubRole: iam.Role;
  public readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: BuildBoxProps) {
    super(scope, id);
    // An empty list renders as no condition at all; refuse it (cdk/ciEc2.ts).
    if (!props.githubRefs.length || props.githubRefs.some((r) => !r.startsWith('refs/heads/'))) {
      throw new Error('BuildBox githubRefs must be a non-empty list of full branch refs');
    }
    const { account, region, partition } = cdk.Stack.of(this);
    const instanceArns = `arn:${partition}:ec2:${region}:${account}:instance/*`;

    for (const [repoId, name] of [['NginxProxyRepository', 'nginx-proxy'],
      ['ClientParticipationAlphaRepository', 'client-participation-alpha']]) {
      new ecr.Repository(this, repoId, {
        repositoryName: `polis/${name}`,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        imageScanOnPush: true,
        // Enough history for a CodeDeploy rollback to pull an earlier digest.
        lifecycleRules: [{ description: 'Keep the last 50 images', maxImageCount: 50 }],
      });
    }
    // Production boxes pull these through AmazonEC2ContainerRegistryReadOnly
    // on the shared InstanceRole (cdk/iamRoles.ts); no grant is needed here.
    props.deploymentBucket.addLifecycleRule({
      id: 'ExpireBuildSources',
      prefix: 'build-source/',
      expiration: cdk.Duration.days(14),
      noncurrentVersionExpiration: cdk.Duration.days(1),
    });

    // ------------------------------------------------------------ box role
    // Not AmazonSSMManagedInstanceCore: it also grants ssm:GetParameter* on
    // "*". These are the agent's own actions, as in cdk/ciEc2.ts.
    this.boxRole = new iam.Role(this, 'BoxRole', {
      roleName: 'polis-build-box',
      description: 'Image build box: SSM agent, ECR push to the Polis repositories, read of build sources',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    this.boxRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmAgentRegistration',
      actions: ['ssm:UpdateInstanceInformation', 'ssm:ListAssociations',
        'ssm:ListInstanceAssociations', 'ssm:DescribeAssociation'],
      resources: ['*'],
    }));
    this.boxRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadAwsOwnedDocumentsOnly',
      actions: ['ssm:GetDocument', 'ssm:DescribeDocument'],
      resources: [`arn:${partition}:ssm:${region}::document/AWS-*`],
    }));
    this.boxRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmAgentChannels',
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
        'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage',
        'ec2messages:GetEndpoint', 'ec2messages:GetMessages', 'ec2messages:SendReply',
      ],
      resources: ['*'],
    }));
    // GetAuthorizationToken has no resource type; the push itself is scoped.
    this.boxRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrLogin', actions: ['ecr:GetAuthorizationToken'], resources: ['*'],
    }));
    this.boxRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PushPolisImagesOnly',
      actions: [
        'ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer', 'ecr:DescribeImages',
      ],
      resources: BUILD_REPOSITORIES.map((r) => `arn:${partition}:ecr:${region}:${account}:repository/${r}`),
    }));
    this.boxRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadBuildSources',
      actions: ['s3:GetObject'],
      resources: [props.deploymentBucket.arnForObjects('build-source/*')],
    }));
    const instanceProfile = new iam.InstanceProfile(this, 'BoxInstanceProfile', {
      instanceProfileName: 'polis-build-box',
      role: this.boxRole,
    });

    // ------------------------------------------------------ launch template
    const securityGroup = new ec2.SecurityGroup(this, 'BoxSg', {
      vpc: props.vpc,
      description: 'Image build box: no inbound, egress only',
      allowAllOutbound: true,
    });
    this.launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: 'polis-build-box',
      versionDescription: 'Image build box (deploy/build-images.sh)',
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      instanceType: new ec2.InstanceType(BUILD_BOX_INSTANCE_TYPES[0]),
      instanceProfile,
      userData: buildBoxUserData(),
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
      requireImdsv2: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      detailedMonitoring: false,
      disableApiTermination: false,
      blockDevices: [{
        deviceName: '/dev/xvda',
        // Cold builds of all five images (the Delphi image is the large one).
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: true,
        }),
      }],
    });
    const subnetId = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds[0];
    const cfnLt = this.launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLt.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      SubnetId: subnetId,
      Groups: [securityGroup.securityGroupId],
      AssociatePublicIpAddress: true,
      DeleteOnTermination: true,
    }]);
    cfnLt.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');
    cfnLt.addPropertyOverride('LaunchTemplateData.TagSpecifications', [
      { ResourceType: 'instance', Tags: [{ Key: BUILD_BOX_TAG_KEY, Value: BUILD_BOX_TAG_VALUE }] },
      { ResourceType: 'volume', Tags: [{ Key: BUILD_BOX_TAG_KEY, Value: BUILD_BOX_TAG_VALUE }] },
    ]);
    const launchTemplateArn =
      `arn:${partition}:ec2:${region}:${account}:launch-template/${this.launchTemplate.launchTemplateId}`;

    // ---------------------------------------------------------- github role
    // The account's GitHub OIDC provider already exists (cdk/ciEc2.ts).
    const oidcProviderArn = `arn:${partition}:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
    this.githubRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'polis-deploy-github',
      description: 'Production deploy workflow: drives the image build box, uploads the bundle, creates the deployment',
      maxSessionDuration: cdk.Duration.hours(2),
      assumedBy: new iam.WebIdentityPrincipal(oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            `repo:${props.githubRepo}:environment:${props.githubEnvironment}`,
          // The environment subject carries no ref; this claim keeps the role
          // to the deploy branch (cdk/ciEc2.ts explains why).
          'token.actions.githubusercontent.com:ref': props.githubRefs,
          'token.actions.githubusercontent.com:repository': props.githubRepo,
        },
      }),
    });
    const allowedTagKeys = { 'ForAllValues:StringEquals': { 'aws:TagKeys': [BUILD_BOX_TAG_KEY, BUILD_BOX_COMMIT_TAG_KEY] } };
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LaunchBuildBoxFromTemplate',
      actions: ['ec2:RunInstances'],
      resources: [instanceArns],
      conditions: {
        ArnEquals: { 'ec2:LaunchTemplate': launchTemplateArn, 'ec2:InstanceProfile': instanceProfile.instanceProfileArn },
        Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
        StringEquals: {
          'ec2:MetadataHttpTokens': 'required',
          'ec2:InstanceType': BUILD_BOX_INSTANCE_TYPES,
          [`aws:RequestTag/${BUILD_BOX_TAG_KEY}`]: BUILD_BOX_TAG_VALUE,
        },
        ...allowedTagKeys,
      },
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BuildBoxLaunchResources',
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:${partition}:ec2:${region}::image/*`,
        `arn:${partition}:ec2:${region}:${account}:subnet/${subnetId}`,
        `arn:${partition}:ec2:${region}:${account}:security-group/${securityGroup.securityGroupId}`,
        `arn:${partition}:ec2:${region}:${account}:network-interface/*`,
        `arn:${partition}:ec2:${region}:${account}:volume/*`,
        launchTemplateArn,
      ],
      conditions: { ArnEquals: { 'ec2:LaunchTemplate': launchTemplateArn } },
    }));
    // The spot request RunInstances creates for --instance-market-options. It
    // cannot exist without the instance launch the statements above constrain.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BuildBoxSpotRequest',
      actions: ['ec2:RunInstances'],
      resources: [`arn:${partition}:ec2:${region}:${account}:spot-instances-request/*`],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TagBuildBoxAtLaunch',
      actions: ['ec2:CreateTags'],
      resources: [instanceArns, `arn:${partition}:ec2:${region}:${account}:volume/*`],
      conditions: {
        StringEquals: {
          'ec2:CreateAction': 'RunInstances',
          [`aws:RequestTag/${BUILD_BOX_TAG_KEY}`]: BUILD_BOX_TAG_VALUE,
        },
        ...allowedTagKeys,
      },
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassOnlyBuildBoxRole',
      actions: ['iam:PassRole'],
      resources: [this.boxRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    }));
    // Read-only calls with no resource-level authorization.
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ObserveBuildBox',
      actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus',
        'ssm:DescribeInstanceInformation', 'ssm:GetCommandInvocation'],
      resources: ['*'],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TerminateBuildBoxesOnly',
      actions: ['ec2:TerminateInstances'],
      resources: [instanceArns],
      conditions: { StringEquals: { [`ec2:ResourceTag/${BUILD_BOX_TAG_KEY}`]: BUILD_BOX_TAG_VALUE } },
    }));
    // SendCommand authorizes the document and the target separately; the
    // instance resource takes ssm:resourceTag, not ec2:ResourceTag (cdk/ciEc2.ts).
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RunShellScriptDocumentOnly',
      actions: ['ssm:SendCommand'],
      resources: [`arn:${partition}:ssm:${region}::document/AWS-RunShellScript`],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SendCommandToBuildBoxesOnly',
      actions: ['ssm:SendCommand'],
      resources: [instanceArns],
      conditions: { StringEquals: { [`ssm:resourceTag/${BUILD_BOX_TAG_KEY}`]: BUILD_BOX_TAG_VALUE } },
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'UploadSourceAndBundle',
      actions: ['s3:PutObject'],
      resources: [
        props.deploymentBucket.arnForObjects('build-source/*'),
        props.deploymentBucket.arnForObjects('deployments/*'),
      ],
    }));
    const codedeployArn = (resource: string) => `arn:${partition}:codedeploy:${region}:${account}:${resource}`;
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CreateTheDeployment',
      actions: ['codedeploy:CreateDeployment', 'codedeploy:GetDeployment'],
      resources: [codedeployArn(
        `deploymentgroup:${props.codeDeployApplicationName}/${props.codeDeployDeploymentGroupName}`)],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RegisterTheRevision',
      actions: ['codedeploy:RegisterApplicationRevision', 'codedeploy:GetApplicationRevision'],
      resources: [codedeployArn(`application:${props.codeDeployApplicationName}`)],
    }));
    this.githubRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadDeploymentConfig',
      actions: ['codedeploy:GetDeploymentConfig'],
      resources: [codedeployArn('deploymentconfig:*')],
    }));

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.githubRole.roleArn,
      description: 'Assumed by .github/workflows/deploy-alpha-aws.yml (DEPLOY_ROLE_ARN)',
    });
    new cdk.CfnOutput(this, 'BuildBoxLaunchTemplateName', {
      value: 'polis-build-box',
      description: 'Launched by deploy/build-on-box.sh',
    });
  }
}

/**
 * User data. The hard cap is armed before anything that can fail, and a box
 * that cannot arm it powers off at once (cdk/ciEc2.ts). The idle stop starts
 * next, so a box whose workflow died, or whose bootstrap failed, terminates
 * itself without a sweeper. The toolchain is the production boxes' own
 * (dnf docker, Compose v2.40.0; cdk/launchTemplates.ts), so an image builds
 * here exactly as it built on them; the Compose binary is checksum-pinned.
 */
function buildBoxUserData(): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  const capSeconds = BUILD_BOX_HARD_CAP_MINUTES * 60;
  const idleSeconds = BUILD_BOX_IDLE_MINUTES * 60;
  const compose = CI_BOOTSTRAP_PINS.compose;
  ud.addCommands(
    'set -euo pipefail',
    'exec > >(tee -a /var/log/polis-build-box.log) 2>&1',
    'trap \'rc=$?; [ "$rc" -eq 0 ] || touch /var/lib/polis-build-failed\' EXIT',
    `if ! shutdown -h +${BUILD_BOX_HARD_CAP_MINUTES} "polis build box hard cap"; then poweroff -f; exit 1; fi`,
    `setsid bash -c 'sleep ${capSeconds}; poweroff -f' </dev/null >/dev/null 2>&1 &`,
    'mkdir -p /run/polis-build && touch /run/polis-build/last-activity',
    // flock -n succeeds only while no build holds the lock.
    `setsid bash -c 'while sleep 60; do if flock -n /run/polis-build/lock true && ` +
      `[ $(( $(date +%s) - $(stat -c %Y /run/polis-build/last-activity) )) -ge ${idleSeconds} ]; ` +
      `then poweroff; fi; done' </dev/null >/dev/null 2>&1 &`,
    'dnf install -y docker git jq',
    'systemctl enable --now docker',
    `curl --proto "=https" -fsSL --retry 3 -o /usr/local/bin/docker-compose ` +
      `https://github.com/docker/compose/releases/download/${compose.version}/docker-compose-linux-x86_64`,
    `echo "${compose.x86_64}  /usr/local/bin/docker-compose" | sha256sum -c -`,
    'chmod 755 /usr/local/bin/docker-compose',
    'docker-compose version',
    // The build command waits for this marker (deploy/build-on-box.sh).
    'touch /var/lib/polis-build-ready',
  );
  return ud;
}
