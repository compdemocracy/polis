/**
 * Light shadow host (P-067 rev 2): a dedicated ARM64 box that runs the Python
 * math poller against production under MATH_ENV=python-shadow, set up the way
 * Python will run after the cutover. OFF by default: nothing here is
 * built unless `-c enableLightShadow=true` and LIGHT_SHADOW_CONFIG are
 * given, and it lives in its own stack (LightShadowStack), so an ordinary
 * CdkStack deploy is unchanged. See docs/light-shadow-host.md.
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as fs from 'fs';
import * as path from 'path';

export const SHADOW_MATH_ENV = 'python-shadow';
export const INSTANCE_TYPE = 't4g.large';
export const REPOSITORY_NAME = 'polis/math-python';
export const LOG_GROUP_NAME = '/polis/light-shadow/math';
export const RUN_PARAMETER_NAME = '/polis/light-shadow/run';
export const METRIC_NAMESPACE = 'Polis/LightShadow';
export const SERVICE_NAME = 'polis-math-shadow';

export interface LightShadowConfig {
  schema: 'polis-light-shadow/1';
  account: string; region: string;
  vpcId: string;
  /** PrivateWithEgress subnets (NAT egress, no public address). */
  subnetIds: string[];
  /** Pinned Amazon Linux 2023 arm64 AMI. */
  ami: string;
  /** The RDS instance's security group; the stack adds one ingress rule from the host. */
  databaseSecurityGroupId: string;
  databaseHost: string;
  /** The secret the Clojure math service reads today (SSM /polis/db-secret-arn). */
  databaseSecretArn: string;
  /** Must be exactly 'python-shadow'. 'prod' is refused. */
  mathEnv: string;
  /** Git commit the image was built from (engine tree equal to 057bd9dc1 or later). */
  engineCommit: string;
  /** Digest of the linux/arm64 delphi `final` image in polis/math-python. */
  imageDigest: string;
  /** Optional conversation allowlist (fallback if the database needs relief). */
  pollAllowlist?: number[];
}

const KEYS = ['schema', 'account', 'region', 'vpcId', 'subnetIds', 'ami', 'databaseSecurityGroupId',
  'databaseHost', 'databaseSecretArn', 'mathEnv', 'engineCommit', 'imageDigest', 'pollAllowlist'];

export function validateLightShadowConfig(a: LightShadowConfig): LightShadowConfig {
  if (a.mathEnv === 'prod') throw new Error('Light shadow refuses MATH_ENV=prod');
  if (a.mathEnv !== SHADOW_MATH_ENV) throw new Error(`Light shadow requires MATH_ENV=${SHADOW_MATH_ENV}`);
  const extra = Object.keys(a).filter(k => !KEYS.includes(k));
  if (extra.length) throw new Error('Invalid light shadow configuration: unknown keys');
  if (a.schema !== 'polis-light-shadow/1' || !/^\d{12}$/.test(a.account) ||
      !/^[a-z]{2}-[a-z]+-\d$/.test(a.region) || !/^vpc-[a-f0-9]+$/.test(a.vpcId) ||
      !Array.isArray(a.subnetIds) || a.subnetIds.length < 1 || a.subnetIds.length > 3 ||
      !a.subnetIds.every(s => /^subnet-[a-f0-9]+$/.test(s)) ||
      !/^ami-[a-f0-9]{17}$/.test(a.ami) || !/^sg-[a-f0-9]+$/.test(a.databaseSecurityGroupId) ||
      !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(a.databaseHost) ||
      !new RegExp(`^arn:aws:secretsmanager:${a.region}:${a.account}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`).test(a.databaseSecretArn) ||
      !/^[a-f0-9]{40}$/.test(a.engineCommit) || !/^sha256:[a-f0-9]{64}$/.test(a.imageDigest) ||
      (a.pollAllowlist !== undefined && (!Array.isArray(a.pollAllowlist) || a.pollAllowlist.length > 500 ||
        !a.pollAllowlist.every(z => Number.isInteger(z) && z > 0))))
    throw new Error('Invalid light shadow configuration');
  return a;
}

/** Every file the host writes. Pure strings, no tokens, so they can be reviewed as a snapshot. */
export function renderHostFiles(a: LightShadowConfig): Record<string, string> {
  const registry = `${a.account}.dkr.ecr.${a.region}.amazonaws.com`;
  const env = [
    '# Non-secret constants for the light shadow. Written by user data.',
    `REGION=${a.region}`,
    `REGISTRY=${registry}`,
    `IMAGE=${registry}/${REPOSITORY_NAME}@${a.imageDigest}`,
    `ENGINE_COMMIT=${a.engineCommit}`,
    `MATH_ENV=${SHADOW_MATH_ENV}`,
    'DATABASE_SSL_MODE=require',
    `DB_SECRET_ARN=${a.databaseSecretArn}`,
    `DB_EXPECTED_HOST=${a.databaseHost}`,
    `LOG_GROUP=${LOG_GROUP_NAME}`,
    `RUN_PARAMETER=${RUN_PARAMETER_NAME}`,
    `POLL_ALLOWLIST=${(a.pollAllowlist ?? []).join(',')}`,
    '',
  ].join('\n');
  const enabled = `#!/bin/bash
# ExecCondition: the unit starts only when the run switch reads exactly "on".
# Any error reading it (missing, no network) counts as off.
set -u
. /etc/polis-shadow/shadow.env
value=$(aws ssm get-parameter --region "$REGION" --name "$RUN_PARAMETER" --query Parameter.Value --output text 2>/dev/null || true)
[ "$value" = on ] && exit 0
echo "light shadow run switch is not on; not starting"
exit 1
`;
  const start = `#!/bin/bash
set -euo pipefail
# Exported so the bare \`-e NAME\` flags below pass the values into the container.
set -a
. /etc/polis-shadow/shadow.env
set +a
if [ "$MATH_ENV" != python-shadow ]; then echo "refusing: MATH_ENV must be python-shadow"; exit 64; fi
if [ "$DATABASE_SSL_MODE" != require ]; then echo "refusing: DATABASE_SSL_MODE must be require"; exit 64; fi
case "$IMAGE" in *@sha256:*) ;; *) echo "refusing: image must be pinned by digest"; exit 64;; esac
docker pull --quiet "$IMAGE" >/dev/null
arch=$(docker image inspect --format '{{.Architecture}}' "$IMAGE")
if [ "$arch" != arm64 ]; then echo "refusing: image architecture is $arch, not arm64"; exit 64; fi
docker rm -f ${SERVICE_NAME} >/dev/null 2>&1 || true
echo "starting ${SERVICE_NAME}: engine $ENGINE_COMMIT image $(docker image inspect --format '{{.Id}}' "$IMAGE")"
# The credential is read inside the container by launch.py; only non-secret
# names are passed here. Host networking lets the container reach instance
# metadata with the hop limit left at 1.
exec docker run --rm --name ${SERVICE_NAME} --network host \\
  --memory 6g --memory-swap 6g --cpus 2 --pids-limit 512 \\
  --cap-drop ALL --security-opt no-new-privileges \\
  --log-driver awslogs --log-opt awslogs-region="$REGION" --log-opt awslogs-group="$LOG_GROUP" \\
  --log-opt awslogs-stream="$(cat /var/lib/cloud/data/instance-id 2>/dev/null || hostname)" \\
  -e AWS_REGION="$REGION" -e MATH_ENV -e DATABASE_SSL_MODE -e DB_SECRET_ARN -e DB_EXPECTED_HOST \\
  -e POLL_VOTE_INTERVAL_MS=10000 -e POLL_MOD_INTERVAL_MS=10000 -e POLL_FROM_DAYS_AGO=10 \\
  -e POLL_ALLOWLIST -e MATH_WORKER_POOL_SIZE=1 -e MATH_CONV_CACHE_CAP=50 \\
  -e MATH_POLLER_DUMP_DIR=/data/errorconv -v /var/lib/polis-shadow/errorconv:/data/errorconv \\
  -v /opt/polis-shadow/launch.py:/opt/polis-shadow/launch.py:ro \\
  --entrypoint python "$IMAGE" /opt/polis-shadow/launch.py
`;
  const unit = `[Unit]
Description=Polis Python math poller, light shadow (MATH_ENV=python-shadow)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=5

[Service]
Type=simple
Environment=HOME=/root DOCKER_CONFIG=/root/.docker
ExecCondition=/usr/local/bin/${SERVICE_NAME}-enabled
ExecStart=/usr/local/bin/${SERVICE_NAME}-start
ExecStop=/usr/bin/docker stop --time 60 ${SERVICE_NAME}
Restart=on-failure
RestartSec=60
TimeoutStartSec=900
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
`;
  const dockerConfig = JSON.stringify({ credHelpers: { [registry]: 'ecr-login' } }) + '\n';
  const agent = JSON.stringify({
    agent: { metrics_collection_interval: 60 },
    metrics: {
      namespace: METRIC_NAMESPACE,
      append_dimensions: { InstanceId: '${aws:InstanceId}' },
      metrics_collected: {
        mem: { measurement: ['mem_used_percent'] },
        disk: { measurement: ['used_percent'], resources: ['/'] },
      },
    },
  }, null, 2) + '\n';
  const launcher = fs.readFileSync(path.join(__dirname, 'lightShadow', 'launch.py'), 'utf8');
  return {
    '/etc/polis-shadow/shadow.env': env,
    '/opt/polis-shadow/launch.py': launcher,
    [`/usr/local/bin/${SERVICE_NAME}-enabled`]: enabled,
    [`/usr/local/bin/${SERVICE_NAME}-start`]: start,
    [`/etc/systemd/system/${SERVICE_NAME}.service`]: unit,
    '/root/.docker/config.json': dockerConfig,
    '/opt/aws/amazon-cloudwatch-agent/etc/light-shadow.json': agent,
  };
}

export function renderUserData(a: LightShadowConfig): string {
  const files = renderHostFiles(a);
  const lines = ['#!/bin/bash', 'set -euo pipefail',
    'dnf install -y docker amazon-ecr-credential-helper amazon-cloudwatch-agent',
    'systemctl enable --now docker',
    'install -d -m 0755 /etc/polis-shadow /opt/polis-shadow /root/.docker',
    'install -d -m 0700 /var/lib/polis-shadow/errorconv'];
  for (const [file, body] of Object.entries(files)) {
    if (body.includes('POLIS_SHADOW_FILE_END')) throw new Error(`heredoc marker inside ${file}`);
    lines.push(`cat > ${file} <<'POLIS_SHADOW_FILE_END'`, body.replace(/\n$/, ''), 'POLIS_SHADOW_FILE_END');
  }
  lines.push(`chmod 0755 /usr/local/bin/${SERVICE_NAME}-enabled /usr/local/bin/${SERVICE_NAME}-start`,
    'chmod 0644 /opt/polis-shadow/launch.py /etc/polis-shadow/shadow.env',
    '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/light-shadow.json',
    'systemctl daemon-reload',
    `systemctl enable ${SERVICE_NAME}.service`,
    `systemctl start ${SERVICE_NAME}.service || true`, '');
  return lines.join('\n');
}

export class LightShadowHost extends Construct {
  constructor(scope: Construct, id: string, config: LightShadowConfig) {
    super(scope, id);
    const a = validateLightShadowConfig(config), stack = cdk.Stack.of(this);
    if (stack.account !== a.account || stack.region !== a.region) throw new Error('Light shadow account/region mismatch');

    const count = new cdk.CfnParameter(this, 'InstanceCount', {
      type: 'Number', default: 0, allowedValues: ['0', '1'],
      description: '0 keeps the host absent; 1 runs one host. The poller still waits for the run switch.',
    });
    count.overrideLogicalId('LightShadowInstanceCount');

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: REPOSITORY_NAME, imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: LOG_GROUP_NAME, retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const runSwitch = new ssm.StringParameter(this, 'RunSwitch', {
      parameterName: RUN_PARAMETER_NAME, stringValue: 'off',
      description: 'Light shadow run switch. The poller starts only when this reads "on".',
    });

    const sg = new ec2.CfnSecurityGroup(this, 'Sg', {
      vpcId: a.vpcId, groupDescription: 'Light shadow math host: no ingress; database and HTTPS egress only',
      securityGroupEgress: [
        { ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, destinationSecurityGroupId: a.databaseSecurityGroupId,
          description: 'PostgreSQL (TLS required) to the production database' },
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0',
          description: 'SSM, Secrets Manager, ECR, CloudWatch and package mirrors over HTTPS' },
      ],
    });
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngress', {
      groupId: a.databaseSecurityGroupId, sourceSecurityGroupId: sg.attrGroupId,
      ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, description: 'Light shadow math host',
    });

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [a.databaseSecretArn] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [runSwitch.parameterArn] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
      resources: [repository.repositoryArn] }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } } }));
    const profile = new iam.CfnInstanceProfile(this, 'Profile', { roles: [role.roleName] });

    const template = new ec2.CfnLaunchTemplate(this, 'Template', { launchTemplateData: {
      imageId: a.ami, instanceType: INSTANCE_TYPE,
      creditSpecification: { cpuCredits: 'unlimited' },
      iamInstanceProfile: { arn: profile.attrArn },
      metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1, httpEndpoint: 'enabled' },
      networkInterfaces: [{ deviceIndex: 0, groups: [sg.attrGroupId], associatePublicIpAddress: false, deleteOnTermination: true }],
      blockDeviceMappings: [{ deviceName: '/dev/xvda',
        ebs: { volumeSize: 30, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
      userData: cdk.Fn.base64(renderUserData(a)),
      tagSpecifications: [{ resourceType: 'volume', tags: [{ key: 'polis:role', value: 'light-shadow' }] }],
    } });

    const group = new autoscaling.CfnAutoScalingGroup(this, 'Group', {
      minSize: '0', maxSize: '1', desiredCapacity: count.valueAsString,
      vpcZoneIdentifier: a.subnetIds,
      launchTemplate: { launchTemplateId: template.ref, version: template.attrLatestVersionNumber },
      healthCheckType: 'EC2', healthCheckGracePeriod: 300,
      tags: [
        { key: 'Name', value: 'polis-light-shadow', propagateAtLaunch: true },
        { key: 'polis:role', value: 'light-shadow', propagateAtLaunch: true },
        { key: 'polis:math-env', value: SHADOW_MATH_ENV, propagateAtLaunch: true },
        { key: 'polis:engine-commit', value: a.engineCommit, propagateAtLaunch: true },
      ],
    });
    group.addDependency(logGroup.node.defaultChild as cdk.CfnResource);

    new cdk.CfnOutput(this, 'AutoScalingGroupName', { value: group.ref });
    new cdk.CfnOutput(this, 'ImageRepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'RunSwitchParameter', { value: RUN_PARAMETER_NAME });
    new cdk.CfnOutput(this, 'LogGroupName', { value: LOG_GROUP_NAME });
  }
}

/** Called from bin/cdk.ts. Adds nothing unless the context flag is set. */
export function addLightShadowStack(app: cdk.App, readConfig: () => LightShadowConfig): cdk.Stack | undefined {
  if (![true, 'true'].includes(app.node.tryGetContext('enableLightShadow'))) return undefined;
  const config = validateLightShadowConfig(readConfig());
  const stack = new cdk.Stack(app, 'LightShadowStack', { env: { account: config.account, region: config.region } });
  new LightShadowHost(stack, 'Host', config);
  return stack;
}
