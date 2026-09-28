import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/** Deployment presence only. The image contains an idle observer, no writer CLI. */
export class CoordinatorInactiveService extends Construct {
  constructor(scope: Construct, id: string, props: { vpc: ec2.IVpc; database: rds.IDatabaseInstance }) {
    super(scope, id);
    const imageDigest = new cdk.CfnParameter(this, 'ImageDigest', {
      type: 'String', allowedPattern: '^sha256:[a-f0-9]{64}$',
      description: 'Reviewed ARM64 coordinator idle image digest in polis/coordinator; never a mutable tag.',
    });
    const secretArn = new cdk.CfnParameter(this, 'LoginSecretArn', {
      type: 'String', allowedPattern: '^arn:[a-z-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+$',
      description: 'Existing observer-login secret ARN (username/password); never the RDS administrator secret.',
    });
    const count = new cdk.CfnParameter(this, 'DesiredCount', {
      type: 'Number', default: 0, allowedValues: ['0', '1'],
      description: '0 keeps deployment dormant; 1 starts only the read-only idle observer after a separate go.',
    });
    imageDigest.overrideLogicalId('CoordinatorInactiveImageDigest');
    secretArn.overrideLogicalId('CoordinatorInactiveLoginSecretArn');
    count.overrideLogicalId('CoordinatorInactiveDesiredCount');
    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'polis/coordinator', imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const secret = secretsmanager.Secret.fromSecretCompleteArn(this, 'LoginSecret', secretArn.valueAsString);
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });
    const group = new ec2.SecurityGroup(this, 'SecurityGroup', { vpc: props.vpc, allowAllOutbound: false });
    group.addEgressRule(props.database.connections.securityGroups[0], ec2.Port.tcp(5432), 'Verified TLS to the primary');
    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'ECR, task logs and Secrets Manager over HTTPS');
    props.database.connections.allowFrom(group, ec2.Port.tcp(5432), 'Inactive coordinator observer');
    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 256, memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    task.addVolume({ name: 'password' });
    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.RETAIN });
    const container = task.addContainer('Idle', {
      image: ecs.ContainerImage.fromRegistry(repository.repositoryUriForDigest(imageDigest.valueAsString)),
      readonlyRootFilesystem: true, user: '10001:10001', essential: true,
      environment: {
        DATABASE_URL: `postgresql://polis_coordinator_observer_login@${props.database.dbInstanceEndpointAddress}:${props.database.dbInstanceEndpointPort}/polisdb?sslmode=verify-full`,
        COORDINATOR_DB_HOST_ALLOWLIST: props.database.dbInstanceEndpointAddress,
        COORDINATOR_DB_CA_BUNDLE: '/etc/polis/rds-ca.pem',
        COORDINATOR_DB_PASSWORD_FILE: '/run/coordinator/password',
        COORDINATOR_MODE: 'inactive', COORDINATOR_WRITER_ENABLED: 'false', P026_RESERVATION_BYTES: '0',
      },
      secrets: {
        COORDINATOR_BOOTSTRAP_USERNAME: ecs.Secret.fromSecretsManager(secret, 'username'),
        COORDINATOR_BOOTSTRAP_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'idle' }),
    });
    container.addMountPoints({ sourceVolume: 'password', containerPath: '/run/coordinator', readOnly: false });
    repository.grantPull(task.obtainExecutionRole());
    new ecs.FargateService(this, 'Service', {
      cluster, taskDefinition: task, desiredCount: count.valueAsNumber,
      assignPublicIp: false, securityGroups: [group],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: false, circuitBreaker: { rollback: true },
    });
    new cdk.CfnOutput(this, 'ImageRepository', { value: repository.repositoryUri });
  }
}
