/** Reusable in-VPC probes. The only data export is a closed private receipt. */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'path';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface ProbeConfig {
  schema: 'polis-probe-box/1'; id: string; account: string; region: string; ami: string;
  vpcId: string; subnetCidr: string; availabilityZone: string; resolverAddress: string;
  replicaHost: string; replicaSecurityGroupId: string; database: string;
  // A separate reviewed schema operation creates this secret's login on primary.
  primaryHost: string; primarySecurityGroupId: string; adminSecretArn: string; postgresLayerArn: string;
  s3PrefixListId: string; reviewerRoleArns: string[]; assetPublisherRoleArn: string;
  githubRepo: string; githubEnvironment: string; githubRef: string;
  notificationTopicArn: string;
}
export function validateProbeConfig(a: ProbeConfig): ProbeConfig {
  if (a.schema !== 'polis-probe-box/1' || !/^[a-z][a-z0-9-]{2,20}$/.test(a.id) ||
      !/^\d{12}$/.test(a.account) || !/^[a-z]{2}-[a-z]+-\d$/.test(a.region) ||
      !/^ami-[a-f0-9]{17}$/.test(a.ami) || !/^vpc-[a-f0-9]+$/.test(a.vpcId) ||
      !/^sg-[a-f0-9]+$/.test(a.replicaSecurityGroupId) || !/^pl-[a-f0-9]+$/.test(a.s3PrefixListId) ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(a.database) ||
      !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(a.replicaHost) ||
      !/^\d+\.\d+\.\d+\.\d+\/(2[4-8])$/.test(a.subnetCidr) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(a.resolverAddress) ||
      !a.availabilityZone.startsWith(a.region) || !/^[-\w.]+\/[-\w.]+$/.test(a.githubRepo) ||
      !/^[-\w]+$/.test(a.githubEnvironment) || !/^refs\/heads\/[-\w./]+$/.test(a.githubRef))
    throw new Error('Invalid probe configuration');
  const role = new RegExp(`^arn:aws:iam::${a.account}:role/[A-Za-z0-9_+=,.@/-]+$`);
  if (!a.reviewerRoleArns.length || !a.reviewerRoleArns.every(r => role.test(r)) ||
      !role.test(a.assetPublisherRoleArn) ||
      !a.adminSecretArn.startsWith(`arn:aws:secretsmanager:${a.region}:${a.account}:secret:`) ||
      !/^sg-[a-f0-9]+$/.test(a.primarySecurityGroupId) ||
      !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(a.primaryHost) || a.primaryHost === a.replicaHost ||
      !new RegExp(`^arn:aws:lambda:${a.region}:${a.account}:layer:[A-Za-z0-9_-]+:[1-9][0-9]*$`).test(a.postgresLayerArn) ||
      !a.notificationTopicArn.startsWith(`arn:aws:sns:${a.region}:${a.account}:`))
    throw new Error('Invalid probe principals');
  return a;
}

export class ProbeBox extends Construct {
  constructor(scope: Construct, id: string, config: ProbeConfig) {
    super(scope, id);
    const a = validateProbeConfig(config), stack = cdk.Stack.of(this);
    if (stack.account !== a.account || stack.region !== a.region) throw new Error('Probe account/region mismatch');
    const name = `polis-probe-${a.account}-${a.id}`;
    const subnet = new ec2.CfnSubnet(this, 'Subnet', {vpcId: a.vpcId, cidrBlock: a.subnetCidr,
      availabilityZone: a.availabilityZone, mapPublicIpOnLaunch: false});
    const routes = new ec2.CfnRouteTable(this, 'Routes', {vpcId: a.vpcId});
    new ec2.CfnSubnetRouteTableAssociation(this, 'RouteAssociation', {routeTableId: routes.ref, subnetId: subnet.ref});
    const endpointSg = new ec2.CfnSecurityGroup(this, 'EndpointSg', {vpcId: a.vpcId,
      groupDescription: 'Probe Secrets Manager endpoint', securityGroupEgress: []});
    const workerSg = new ec2.CfnSecurityGroup(this, 'WorkerSg', {vpcId: a.vpcId,
      groupDescription: 'Probe: no ingress; replica, private assets and receipt only',
      securityGroupEgress: [
        {ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, destinationSecurityGroupId: a.replicaSecurityGroupId},
        {ipProtocol: 'tcp', fromPort: 443, toPort: 443, destinationPrefixListId: a.s3PrefixListId},
        {ipProtocol: 'tcp', fromPort: 443, toPort: 443, destinationSecurityGroupId: endpointSg.attrGroupId}]});
    new ec2.CfnSecurityGroupIngress(this, 'ReplicaIngress', {groupId: a.replicaSecurityGroupId,
      sourceSecurityGroupId: workerSg.attrGroupId, ipProtocol: 'tcp', fromPort: 5432, toPort: 5432});
    new ec2.CfnSecurityGroupIngress(this, 'EndpointIngress', {groupId: endpointSg.attrGroupId,
      sourceSecurityGroupId: workerSg.attrGroupId, ipProtocol: 'tcp', fromPort: 443, toPort: 443});
    const key = new kms.Key(this, 'Key', {enableKeyRotation: true, removalPolicy: cdk.RemovalPolicy.RETAIN});
    const bucket = (id: string, suffix: string) => new s3.Bucket(this, id, {
      bucketName: `${name}-${suffix}`, encryption: s3.BucketEncryption.KMS, encryptionKey: key,
      versioned: true, bucketKeyEnabled: false, enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, removalPolicy: cdk.RemovalPolicy.RETAIN});
    const evidence = bucket('Evidence', 'evidence'), control = bucket('Control', 'control'), assets = bucket('Assets', 'assets');
    evidence.addLifecycleRule({expiration: cdk.Duration.days(90), noncurrentVersionExpiration: cdk.Duration.days(90)});
    const readerSecret = new secrets.Secret(this,'ReaderSecret',{generateSecretString:{secretStringTemplate:JSON.stringify({username:'polis_probe_reader'}),generateStringKey:'password'},removalPolicy:cdk.RemovalPolicy.RETAIN});
    const endpoint = new ec2.CfnVPCEndpoint(this, 'S3Endpoint', {vpcId: a.vpcId, vpcEndpointType: 'Gateway',
      serviceName: `com.amazonaws.${a.region}.s3`, routeTableIds: [routes.ref], policyDocument: {
        Version: '2012-10-17', Statement: [{Effect: 'Allow', Principal: '*', Action: ['s3:GetObject','s3:PutObject'],
          Resource: [assets.arnForObjects('images/*'), control.arnForObjects('*'), evidence.arnForObjects('results/*')]}]}});
    const secretEndpoint = new ec2.CfnVPCEndpoint(this, 'SecretEndpoint', {vpcId: a.vpcId,
      vpcEndpointType: 'Interface', privateDnsEnabled: false, subnetIds: [subnet.ref], securityGroupIds: [endpointSg.attrGroupId],
      serviceName: `com.amazonaws.${a.region}.secretsmanager`, policyDocument: {Version: '2012-10-17',
        Statement: [{Effect:'Allow',Principal:'*',Action:'secretsmanager:GetSecretValue',Resource:[readerSecret.secretArn,a.adminSecretArn]}]}});
    const secretHost = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(0, secretEndpoint.attrDnsEntries)));
    const provisionSg = new ec2.CfnSecurityGroup(this,'ProvisionSg',{vpcId:a.vpcId,groupDescription:'Reader-login provisioning only',
      securityGroupEgress:[{ipProtocol:'tcp',fromPort:5432,toPort:5432,destinationSecurityGroupId:a.primarySecurityGroupId},
        {ipProtocol:'tcp',fromPort:443,toPort:443,destinationSecurityGroupId:endpointSg.attrGroupId}]});
    new ec2.CfnSecurityGroupIngress(this,'PrimaryProvisionIngress',{groupId:a.primarySecurityGroupId,sourceSecurityGroupId:provisionSg.attrGroupId,ipProtocol:'tcp',fromPort:5432,toPort:5432});
    new ec2.CfnSecurityGroupIngress(this,'SecretProvisionIngress',{groupId:endpointSg.attrGroupId,sourceSecurityGroupId:provisionSg.attrGroupId,ipProtocol:'tcp',fromPort:443,toPort:443});
    const vpc=ec2.Vpc.fromVpcAttributes(this,'ExistingVpc',{vpcId:a.vpcId,availabilityZones:[a.availabilityZone]});
    const provision=new lambda.Function(this,'ProvisionLogin',{runtime:lambda.Runtime.PYTHON_3_12,architecture:lambda.Architecture.ARM_64,
      handler:'provision_login.handler',code:lambda.Code.fromAsset(path.join(__dirname,'../ci/probe_box'),{exclude:['test_*','__pycache__','layer','layer/**']}),
      layers:[lambda.LayerVersion.fromLayerVersionArn(this,'PostgresLayer',a.postgresLayerArn)],
      vpc,vpcSubnets:{subnets:[ec2.Subnet.fromSubnetId(this,'ProvisionSubnet',subnet.ref)]},
      securityGroups:[ec2.SecurityGroup.fromSecurityGroupId(this,'ProvisionSecurityGroup',provisionSg.attrGroupId)],
      timeout:cdk.Duration.minutes(2)});
    readerSecret.grantRead(provision);
    provision.addToRolePolicy(new iam.PolicyStatement({actions:['secretsmanager:GetSecretValue'],resources:[a.adminSecretArn]}));
    const provider=new cr.Provider(this,'LoginProvider',{onEventHandler:provision});
    const login=new cdk.CustomResource(this,'ReaderLogin',{serviceToken:provider.serviceToken,properties:{
      ReaderSecretArn:readerSecret.secretArn,AdminSecretArn:a.adminSecretArn,PrimaryHost:a.primaryHost,Database:a.database,SecretsUrl:`https://${secretHost}`}});
    login.node.addDependency(secretEndpoint);
    const worker = new iam.Role(this, 'Worker', {assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')});
    const controller = new iam.Role(this, 'Controller', {assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')});
    const profile = new iam.CfnInstanceProfile(this, 'Profile', {roles: [worker.roleName]});
    const statement = (role: iam.Role, action: string[], resource: string[], conditions?: Record<string, unknown>) =>
      role.addToPolicy(new iam.PolicyStatement({actions: action, resources: resource, conditions}));
    const vpce = {StringEquals: {'aws:SourceVpce': endpoint.ref}};
    const own = '${ec2:SourceInstanceARN}';
    statement(worker,['s3:GetObject'],[control.arnForObjects(`boot/${own}.json`),assets.arnForObjects('images/*')],vpce);
    statement(worker,['s3:PutObject'],[control.arnForObjects(`heartbeats/*/${own}.json`)],vpce);
    statement(worker,['s3:PutObject'],[evidence.arnForObjects(`results/${own}/receipt.json`)],{
      StringEquals: {'aws:SourceVpce': endpoint.ref,'s3:if-none-match':'*'}});
    statement(worker,['secretsmanager:GetSecretValue'],[readerSecret.secretArn],{StringEquals:{'aws:SourceVpce':secretEndpoint.ref}});
    const kmsCondition = {StringEquals:{'kms:ViaService':`s3.${a.region}.amazonaws.com`},
      StringLike:{'kms:EncryptionContext:aws:s3:arn':[control.arnForObjects('*'),assets.arnForObjects('images/*'),evidence.arnForObjects(`results/${own}/receipt.json`)]}};
    statement(worker,['kms:Decrypt','kms:GenerateDataKey'],[key.keyArn],kmsCondition);
    const deny = (b: s3.Bucket, sid: string, actions: string[], resources: string[], conditions: Record<string, unknown>) =>
      b.addToResourcePolicy(new iam.PolicyStatement({sid,effect:iam.Effect.DENY,principals:[new iam.AnyPrincipal()],actions,resources,conditions}));
    deny(evidence,'PrivateReaders',['s3:GetObject*','s3:ListBucket*'],[evidence.bucketArn,evidence.arnForObjects('*')],
      {ArnNotEquals:{'aws:PrincipalArn':[controller.roleArn,...a.reviewerRoleArns]}});
    deny(evidence,'WorkerWrites',['s3:PutObject*'],[evidence.arnForObjects('*')],{ArnNotEquals:{'aws:PrincipalArn':worker.roleArn}});
    deny(evidence,'CreateOnly',['s3:PutObject'],[evidence.arnForObjects('*')],{StringNotEquals:{'s3:if-none-match':'*'}});
    deny(evidence,'PrivateEndpoint',['s3:PutObject'],[evidence.arnForObjects('*')],{StringNotEquals:{'aws:SourceVpce':endpoint.ref}});
    deny(control,'ControlAuthority',['s3:PutObject*','s3:DeleteObject*'],[control.arnForObjects('active.json'),control.arnForObjects('claims/*'),control.arnForObjects('control/*'),control.arnForObjects('boot/*')],
      {ArnNotEquals:{'aws:PrincipalArn':controller.roleArn}});
    deny(assets,'AssetAuthority',['s3:PutObject*','s3:DeleteObject*'],[assets.arnForObjects('*')],{ArnNotEquals:{'aws:PrincipalArn':a.assetPublisherRoleArn}});
    for (const arn of a.reviewerRoleArns) {
      evidence.grantRead(new iam.ArnPrincipal(arn));
    }
    assets.grantWrite(new iam.ArnPrincipal(a.assetPublisherRoleArn));
    statement(controller,['s3:GetObject','s3:PutObject'],[control.arnForObjects('*')]);
    statement(controller,['s3:GetObject'],[evidence.arnForObjects('results/*/receipt.json')]);
    statement(controller,['kms:Decrypt','kms:GenerateDataKey'],[key.keyArn],{
      StringEquals:{'kms:ViaService':`s3.${a.region}.amazonaws.com`},
      StringLike:{'kms:EncryptionContext:aws:s3:arn':[control.arnForObjects('*'),evidence.arnForObjects('results/*/receipt.json')]}});
    const boot = {account:a.account,region:a.region,controlBucket:control.bucketName,
      dnsNames:[a.replicaHost,secretHost,...[control,evidence,assets].map(b=>`${b.bucketName}.s3.${a.region}.amazonaws.com`)],resolver:a.resolverAddress};
    // Only root reads this public boot configuration. No code or credentials in user-data.
    const template = new ec2.CfnLaunchTemplate(this,'Template',{launchTemplateData:{imageId:a.ami,instanceType:'r8g.4xlarge',
      iamInstanceProfile:{arn:profile.attrArn},metadataOptions:{httpTokens:'required',httpPutResponseHopLimit:1},
      instanceInitiatedShutdownBehavior:'terminate',
      userData:cdk.Fn.base64(JSON.stringify(boot)),
      networkInterfaces:[{deviceIndex:0,subnetId:subnet.ref,groups:[workerSg.attrGroupId],associatePublicIpAddress:false,deleteOnTermination:true}],
      blockDeviceMappings:[{deviceName:'/dev/xvda',ebs:{volumeSize:32,volumeType:'gp3',encrypted:true,deleteOnTermination:true}},
        {deviceName:'/dev/sdf',ebs:{volumeSize:256,volumeType:'gp3',encrypted:true,deleteOnTermination:true}}]}});
    const instanceArn=`arn:aws:ec2:${a.region}:${a.account}:instance/*`, volumeArn=`arn:aws:ec2:${a.region}:${a.account}:volume/*`;
    const templateArn=`arn:aws:ec2:${a.region}:${a.account}:launch-template/${template.ref}`;
    statement(controller,['ec2:RunInstances'],[instanceArn,volumeArn,`arn:aws:ec2:${a.region}:${a.account}:network-interface/*`,
      `arn:aws:ec2:${a.region}::image/${a.ami}`,`arn:aws:ec2:${a.region}:${a.account}:subnet/${subnet.ref}`,
      `arn:aws:ec2:${a.region}:${a.account}:security-group/${workerSg.attrGroupId}`,templateArn],
      {ArnEquals:{'ec2:LaunchTemplate':templateArn},Bool:{'ec2:IsLaunchTemplateResource':'true'}});
    statement(controller,['ec2:CreateTags'],[instanceArn,volumeArn],{StringEquals:{'ec2:CreateAction':'RunInstances','aws:RequestTag/polis:probe-box':a.id},
      'ForAllValues:StringEquals':{'aws:TagKeys':['polis:probe-box','polis:probe-run']}});
    statement(controller,['iam:PassRole'],[worker.roleArn],{StringEquals:{'iam:PassedToService':'ec2.amazonaws.com'}});
    statement(controller,['ec2:DescribeInstances','ec2:DescribeImages','ec2:DescribeVolumes'],['*']);
    statement(controller,['ec2:TerminateInstances','ec2:DeleteVolume'],[instanceArn,volumeArn],{StringEquals:{'ec2:ResourceTag/polis:probe-box':a.id}});
    const logGroup=new logs.LogGroup(this,'ControlLogs',{retention:logs.RetentionDays.ONE_MONTH});
    logGroup.grantWrite(controller);
    const fn=new lambda.Function(this,'ControlFunction',{runtime:lambda.Runtime.PYTHON_3_12,architecture:lambda.Architecture.ARM_64,
      handler:'controller.handler',code:lambda.Code.fromAsset(path.join(__dirname,'../ci/probe_box'),{exclude:['test_*','__pycache__','layer','layer/**']}),
      role:controller,logGroup,timeout:cdk.Duration.minutes(5),reservedConcurrentExecutions:1,environment:{
        BOX_ID:a.id,ACCOUNT:a.account,REGION:a.region,AMI:a.ami,CONTROL_BUCKET:control.bucketName,EVIDENCE_BUCKET:evidence.bucketName,
        ASSET_BUCKET:assets.bucketName,CONTROL_KEY:key.keyArn,TEMPLATE:template.ref,TEMPLATE_VERSION:template.attrLatestVersionNumber,
        PROFILE:profile.attrArn,SUBNET:subnet.ref,SECURITY_GROUP:workerSg.attrGroupId,ENDPOINT:endpoint.ref,
        SECRET_ARN:readerSecret.secretArn,REPLICA_HOST:a.replicaHost,DATABASE:a.database,SECRETS_URL:`https://${secretHost}`}});
    fn.node.addDependency(login);
    const github=new iam.Role(this,'Dispatch',{assumedBy:new iam.FederatedPrincipal(
      `arn:aws:iam::${a.account}:oidc-provider/token.actions.githubusercontent.com`,{StringEquals:{
        'token.actions.githubusercontent.com:aud':'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub':`repo:${a.githubRepo}:environment:${a.githubEnvironment}`,
        'token.actions.githubusercontent.com:ref':a.githubRef}},'sts:AssumeRoleWithWebIdentity')});
    fn.grantInvoke(github);
    new events.Rule(this,'Sweep',{schedule:events.Schedule.rate(cdk.Duration.minutes(5)),targets:[new targets.LambdaFunction(fn,{event:events.RuleTargetInput.fromObject({action:'sweep'})})]});
    const topic=sns.Topic.fromTopicArn(this,'Notifications',a.notificationTopicArn);
    for (const [id,metric,op] of [['Errors',fn.metricErrors(),cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD],
      ['MissingSweep',fn.metricInvocations({period:cdk.Duration.minutes(15)}),cw.ComparisonOperator.LESS_THAN_THRESHOLD]] as const) {
      const alarm=new cw.Alarm(this,id,{metric,threshold:1,evaluationPeriods:1,treatMissingData:cw.TreatMissingData.BREACHING,comparisonOperator:op});
      alarm.addAlarmAction(new actions.SnsAction(topic));
    }
    new cdk.CfnOutput(this,'DispatchRoleArn',{value:github.roleArn});
    new cdk.CfnOutput(this,'ControlFunctionName',{value:fn.functionName});
    new cdk.CfnOutput(this,'EvidenceBucket',{value:evidence.bucketName});
    new cdk.CfnOutput(this,'AssetBucket',{value:assets.bucketName});
  }
}
