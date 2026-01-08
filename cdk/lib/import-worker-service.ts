import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

interface ImportWorkerProps {
  vpc: ec2.IVpc;
  logGroup: cdk.aws_logs.ILogGroup;
  database: cdk.aws_rds.DatabaseInstance;
}

export class ImportWorkerService extends Construct {
  public readonly importQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: ImportWorkerProps) {
    super(scope, id);

    this.importQueue = new sqs.Queue(this, 'ImportJobsQueue', {
      queueName: 'import-jobs-queue',
      visibilityTimeout: cdk.Duration.minutes(15), 
      retentionPeriod: cdk.Duration.days(14),
    });
    const repository = ecr.Repository.fromRepositoryName(
      this,
      'ServerRepo',
      'polis/server'
    );
    const cluster = new ecs.Cluster(this, 'PolisCluster', {
      vpc: props.vpc,
      clusterName: 'polis-cluster',
      containerInsights: true,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ImportWorkerTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64, 
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:DeleteObject', 's3:ListBucket', 's3:PutObject'],
      resources: ['arn:aws:s3:::polis-delphi', 'arn:aws:s3:::polis-delphi/*'],
    }));

    this.importQueue.grantConsumeMessages(taskDefinition.taskRole);

    const wrapperCommand = [
      '/bin/sh',
      '-c',
      `
        export DATABASE_URL=$(node -p '
          const s = JSON.parse(process.env.DB_SECRET_JSON);
          const user = encodeURIComponent(s.username);
          const pass = encodeURIComponent(s.password);
          const host = s.host;
          const port = s.port;
          const db = s.dbname;
          \`postgres://\${user}:\${pass}@\${host}:\${port}/\${db}\`
        ') &&
        exec node dist/src/workers/start-import-worker.js
      `.replace(/\s+/g, ' ')
    ];
    const container = taskDefinition.addContainer('WorkerContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repository),
      command: wrapperCommand,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'import-worker',
        logGroup: props.logGroup,
      }),
      secrets: {
        DB_SECRET_JSON: ecs.Secret.fromSecretsManager(props.database.secret!),
      },
      environment: {
        NODE_ENV: 'production',
        SQS_QUEUE_URL: this.importQueue.queueUrl,
        AWS_REGION: cdk.Stack.of(this).region,
        AWS_S3_BUCKET_NAME: 'polis-delphi',
        POSTGRES_HOST: props.database.dbInstanceEndpointAddress,
        POSTGRES_PORT: props.database.dbInstanceEndpointPort,
        POSTGRES_DB: 'polisdb',
      },
    });
    const service = new ecs.FargateService(this, 'ImportWorkerService', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: false,
      securityGroups: [], 
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    service.connections.securityGroups[0].addEgressRule(
      props.database.connections.securityGroups[0],
      ec2.Port.tcp(5432),
      'Allow Import Worker to access RDS'
    );
    props.database.connections.securityGroups[0].addIngressRule(
      service.connections.securityGroups[0],
      ec2.Port.tcp(5432),
      'Allow connection from Import Worker'
    );

    const scaling = service.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 5,
    });

    const visibleMetric = this.importQueue.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(1),
    });
    const notVisibleMetric = this.importQueue.metricApproximateNumberOfMessagesNotVisible({
      period: cdk.Duration.minutes(1),
    });

    const totalBacklogMetric = new cloudwatch.MathExpression({
      expression: 'visible + notVisible',
      usingMetrics: {
        visible: visibleMetric,
        notVisible: notVisibleMetric,
      },
      label: 'Total SQS Messages (Visible + InFlight)',
      period: cdk.Duration.minutes(1),
    });

    scaling.scaleOnMetric('ScaleOnQueueTotal', {
      metric: totalBacklogMetric,
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.minutes(2),
      scalingSteps: [
        { upper: 0, change: -1 }, 
        { lower: 1, change: +1 }, 
        { lower: 100, change: +2 }, 
      ],
    });
  }
}