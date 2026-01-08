import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';

// custom constructs for code organization
import createPolisVPC from '../vpc';
import { createDBBackupLambda } from '../lambda/lambda';
import {
  instanceTypeWeb,
  machineImageWeb,
  instanceTypeMathWorker,
  machineImageMathWorker,
  instanceTypeDelphiSmall,
  machineImageDelphiSmall,
  instanceTypeDelphiLarge,
  machineImageDelphiLarge,
  instanceTypeOllama,
  machineImageOllama
} from '../ec2';
import createSecurityGroups from '../securityGroups';
import createRoles from '../iamRoles';
import createECRRepos from '../ecr';
import createDBResources from '../db';
import configureLaunchTemplates from '../launchTemplates';
import createAutoScalingAndAlarms from '../autoscaling';
import createCodedeployConfig from '../codedeploy';
import createALBAndDNS from '../dns';
import createSecretsAndDependencies from '../secrets';
import { ImportWorkerService } from './import-worker-service';

interface PolisStackProps extends cdk.StackProps {
  enableSSHAccess?: boolean; // Make optional, default to false
  envFile: string;
  branch?: string;
  sshAllowedIpRange?: string; // Add a property for SSH access control
  webKeyPairName?: string;    // Key pair for web instances
  mathWorkerKeyPairName?: string; // Key pair for math worker
  delphiSmallKeyPairName?: string; // Key pair for small Delphi instances
  delphiLargeKeyPairName?: string; // Key pair for large Delphi instance
  ollamaKeyPairName?: string; // Key pair for Ollama instance - NEW
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PolisStackProps) {
    super(scope, id, props);

    const defaultSSHRange = '0.0.0.0/0';
    const ollamaPort = 11434;
    const ollamaModelDirectory = '/efs/ollama-models';
    const ollamaNamespace = 'OllamaMetrics'; // Custom namespace for GPU metrics

    // Create VPC
    const vpc = createPolisVPC(this);

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Polis Application Alarms',
    });
    alarmTopic.addSubscription(new subscriptions.EmailSubscription('tim@compdemocracy.org'));
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create security group
    const {
      webSecurityGroup,
      mathWorkerSecurityGroup,
      delphiSecurityGroup,
      ollamaSecurityGroup,
      efsSecurityGroup,
    } = createSecurityGroups(vpc, this);

    // Allow Delphi -> Ollama
    ollamaSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock), // Allows traffic from any private IP within the VPC
      ec2.Port.tcp(ollamaPort),
      `Allow NLB traffic on ${ollamaPort} from VPC`
    );
    // Allow Ollama -> EFS
    efsSecurityGroup.addIngressRule(
      ollamaSecurityGroup,
      ec2.Port.tcp(2049), // NFS port
      'Allow NFS from Ollama instances'
    );

    // Conditional SSH Access
    if (props.enableSSHAccess) {
      const sshPeer = ec2.Peer.ipv4(props.sshAllowedIpRange || defaultSSHRange);
      webSecurityGroup.addIngressRule(sshPeer, ec2.Port.tcp(22), 'Allow SSH access');
      mathWorkerSecurityGroup.addIngressRule(sshPeer, ec2.Port.tcp(22), 'Allow SSH access');
      delphiSecurityGroup.addIngressRule(sshPeer, ec2.Port.tcp(22), 'Allow SSH access');
      ollamaSecurityGroup.addIngressRule(sshPeer, ec2.Port.tcp(22), 'Allow SSH access');
    }

    webSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.sshAllowedIpRange || defaultSSHRange), ec2.Port.tcp(22), 'Allow SSH'); // Control SSH separately
    webSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    webSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');


    // --- Key Pairs
    const getKeyPair = (name: string, requestedName?: string): ec2.IKeyPair | undefined => {
      if (!props.enableSSHAccess) return undefined;
      return requestedName
        ? ec2.KeyPair.fromKeyPairName(this, name, requestedName)
        : new ec2.KeyPair(this, name);
    };
    const webKeyPair = getKeyPair('WebKeyPair', props.webKeyPairName);
    const mathWorkerKeyPair = getKeyPair('MathWorkerKeyPair', props.mathWorkerKeyPairName);
    const delphiSmallKeyPair = getKeyPair('DelphiSmallKeyPair', props.delphiSmallKeyPairName);
    const delphiLargeKeyPair = getKeyPair('DelphiLargeKeyPair', props.delphiLargeKeyPairName);
    const ollamaKeyPair = getKeyPair('OllamaKeyPair', props.ollamaKeyPairName);

    const { instanceRole, codeDeployRole, dbBackupLambdaRole } = createRoles(this);

    // ALB Security Group
    const lbSecurityGroup = new ec2.SecurityGroup(this, 'LBSecurityGroup', {
      vpc,
      description: 'Security group for the load balancer',
      allowAllOutbound: true,
    });
    lbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    lbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');

    // Create ECR repos
    const { ecrWebRepository, ecrDelphiRepository, ecrMathRepository, imageTagParameter } = createECRRepos(this, instanceRole);

    // Create DB and related resources
    const { dbSubnetGroup, db, dbSecretArnParam, dbHostParam, dbPortParam } = createDBResources(this, vpc);

    // --- EFS for Ollama Models
    const fileSystemPolicyDocument = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "elasticfilesystem:ClientMount",
            "elasticfilesystem:ClientWrite",
            "elasticfilesystem:ClientRootAccess",
          ],
          principals: [new iam.AnyPrincipal()],
          resources: ["*"], // Applies to the filesystem this policy is attached to
          conditions: {
            Bool: { "elasticfilesystem:AccessedViaMountTarget": "true" }
          }
        })
      ]
    });
    const fileSystem = new efs.FileSystem(this, 'OllamaModelFileSystem', {
      vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      securityGroup: efsSecurityGroup,
      vpcSubnets: { subnetGroupName: 'PrivateWithEgress' },
      fileSystemPolicy: fileSystemPolicyDocument,
    });

    // launch templates
    const {
      webLaunchTemplate,
      mathWorkerLaunchTemplate,
      delphiSmallLaunchTemplate,
      delphiLargeLaunchTemplate,
      ollamaLaunchTemplate
    } = configureLaunchTemplates(this,
      logGroup,
      ollamaNamespace,
      ollamaModelDirectory,
      fileSystem,
      machineImageWeb,
      instanceTypeWeb,
      webSecurityGroup,
      webKeyPair,
      instanceRole,
      machineImageMathWorker,
      instanceTypeMathWorker,
      mathWorkerSecurityGroup,
      mathWorkerKeyPair,
      machineImageDelphiSmall,
      instanceTypeDelphiSmall,
      delphiSmallKeyPair,
      machineImageDelphiLarge,
      instanceTypeDelphiLarge,
      delphiSecurityGroup,
      delphiLargeKeyPair,
      machineImageOllama,
      instanceTypeOllama,
      ollamaKeyPair,
      ollamaSecurityGroup
    );

    // Auto Scaling Groups and alarms
    const {
      asgOllama,
      asgWeb,
      asgMathWorker,
      asgDelphiSmall,
      asgDelphiLarge,
      commonAsgProps
    } = createAutoScalingAndAlarms(
      this,
      vpc,
      instanceRole,
      ollamaLaunchTemplate,
      logGroup,
      fileSystem,
      webLaunchTemplate,
      mathWorkerLaunchTemplate,
      delphiSmallLaunchTemplate,
      delphiLargeLaunchTemplate,
      ollamaNamespace,
      alarmTopic
    );

    // --- DEPLOY STUFF
    const {
      application,
      deploymentBucket,
      deploymentGroup
    } = createCodedeployConfig(
      this,
      instanceRole,
      asgWeb,
      asgMathWorker,
      asgDelphiSmall,
      asgDelphiLarge,
      codeDeployRole
    );

    // --- Ollama Network Load Balancer (Internal, in Private+Egress)
    const ollamaNlb = new elbv2.NetworkLoadBalancer(this, 'OllamaNlb', {
      vpc,
      internetFacing: false, // Internal only
      crossZoneEnabled: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    const ollamaListener = ollamaNlb.addListener('OllamaListener', {
      port: ollamaPort,
      protocol: elbv2.Protocol.TCP,
    });
    const ollamaTargetGroup = new elbv2.NetworkTargetGroup(this, 'OllamaTargetGroup', {
      vpc,
      port: ollamaPort,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      targets: [asgOllama],
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(60),
    });
    ollamaListener.addTargetGroups('OllamaTg', ollamaTargetGroup);

    // Secret for Ollama NLB endpoint
    const ollamaServiceSecret = new secretsmanager.Secret(this, 'OllamaServiceSecret', {
      secretName: '/polis/ollama-service-url',
      description: 'URL for the internal Ollama service endpoint (NLB)',
      // Store the NLB DNS name and port
      secretStringValue: cdk.SecretValue.unsafePlainText(`http://${ollamaNlb.loadBalancerDnsName}:${ollamaPort}`),
    });
    ollamaServiceSecret.grantRead(instanceRole);

    // --- DB Access Rules
    db.connections.allowFrom(asgWeb, ec2.Port.tcp(5432), 'Allow database access from web ASG');
    db.connections.allowFrom(asgMathWorker, ec2.Port.tcp(5432), 'Allow database access from math ASG');
    db.connections.allowFrom(asgDelphiSmall, ec2.Port.tcp(5432), 'Allow database access from Delphi small ASG');
    db.connections.allowFrom(asgDelphiLarge, ec2.Port.tcp(5432), 'Allow database access from Delphi large ASG');

    // S3 for DB backups
    const dbBackupBucket = new s3.Bucket(this, 'DBBackupBucket', {
      bucketName: 'polis-db-backups',
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    db.secret!.grantRead(dbBackupLambdaRole);
    dbBackupBucket.grantWrite(dbBackupLambdaRole);

    dbBackupLambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/polis/db-secret-arn`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/polis/db-host`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/polis/db-port`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/polis/db-backup-bucket-name`,
        ],
    }));

    dbBackupLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: ['*'],
    }));

    const bucketNameParameter = new ssm.StringParameter(this, 'DBBackupBucketNameParameter', {
      parameterName: '/polis/db-backup-bucket-name',
      stringValue: dbBackupBucket.bucketName,
      description: 'The name of the S3 bucket for database backups',
    });

    dbBackupBucket.grantWrite(dbBackupLambdaRole);

    const lambda = createDBBackupLambda(this, db, vpc, dbBackupBucket, dbBackupLambdaRole);

    new events.Rule(this, 'DBBackupScheduleRule', {
      schedule: events.Schedule.cron({
        minute: '23',
        hour: '0',
        weekDay: 'TUE',
      }),
      targets: [new targets.LambdaFunction(lambda)],
    });

    db.connections.allowFrom(lambda, ec2.Port.tcp(5432), 'Allow connection from backup Lambda');

    // ALB & DNS
    const {
      lb,
      webTargetGroup,
      httpListener,
      httpsListener,
      webScalingPolicy
    } = createALBAndDNS(
      this,
      vpc,
      lbSecurityGroup,
      asgWeb
    );

    // --- Secrets & Dependencies - creates secrets managed in SSM, grants services permission to interact with each other, etc.
    createSecretsAndDependencies(
      this,
      instanceRole,
      db,
      logGroup,
      asgWeb,
      asgMathWorker,
      asgDelphiSmall,
      asgDelphiLarge,
      asgOllama,
      fileSystem
    );

    // add ECS Fargate service for BYOPD import worker
    new ImportWorkerService(this, 'ImportWorker', {
      vpc: vpc,
      database: db, 
      logGroup: logGroup,
    });

    // --- Outputs
    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: lb.loadBalancerDnsName, description: 'Public DNS name of the Application Load Balancer' });
    new cdk.CfnOutput(this, 'OllamaNlbDnsName', { value: ollamaNlb.loadBalancerDnsName, description: 'Internal DNS Name for the Ollama Network Load Balancer'});
    new cdk.CfnOutput(this, 'OllamaServiceSecretArn', { value: ollamaServiceSecret.secretArn, description: 'ARN of the Secret containing the Ollama service URL' });
    new cdk.CfnOutput(this, 'EfsFileSystemId', { value: fileSystem.fileSystemId, description: 'ID of the EFS File System for Ollama models' });
  }
}