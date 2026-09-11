/** Reusable in-VPC probes. The only data export is a closed private receipt. */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

export interface ProbeConfig {
  schema: 'polis-probe-box/1'; id: string; account: string; region: string; ami: string;
  vpcId: string; subnetCidr: string; availabilityZone: string; resolverAddress: string;
  // Read target: primary under the live ruling, or a distinct replica.
  replicaHost: string; replicaSecurityGroupId: string; database: string;
  // A separate reviewed schema operation creates this secret's login on primary.
  primaryHost: string; primarySecurityGroupId: string; adminSecretArn: string; provisionOwner: string;
  s3PrefixListId: string; reviewerRoleArns: string[]; assetPublisherRoleArn: string;
  operatorRoleArns: string[];
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
      !a.availabilityZone.startsWith(a.region) || 'postgresLayerArn' in a ||
      !/^polis-probe-login:[A-Za-z0-9:_/.-]{1,200}$/.test(a.provisionOwner))
    throw new Error('Invalid probe configuration');
  const role = new RegExp(`^arn:aws:iam::${a.account}:role/[A-Za-z0-9_+=,.@/-]+$`);
  if (!a.reviewerRoleArns.length || !a.reviewerRoleArns.every(r => role.test(r)) ||
      !role.test(a.assetPublisherRoleArn) ||
      !a.operatorRoleArns.length || !a.operatorRoleArns.every(r => role.test(r)) ||
      !a.adminSecretArn.startsWith(`arn:aws:secretsmanager:${a.region}:${a.account}:secret:`) ||
      !/^sg-[a-f0-9]+$/.test(a.primarySecurityGroupId) ||
      !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(a.primaryHost) ||
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
        {ipProtocol:'tcp',fromPort:443,toPort:443,destinationSecurityGroupId:endpointSg.attrGroupId},
        {ipProtocol:'tcp',fromPort:443,toPort:443,destinationPrefixListId:a.s3PrefixListId}]});
    // Same destination is valid in live mode: provisioner and worker have distinct source SGs.
    new ec2.CfnSecurityGroupIngress(this,'PrimaryProvisionIngress',{groupId:a.primarySecurityGroupId,sourceSecurityGroupId:provisionSg.attrGroupId,ipProtocol:'tcp',fromPort:5432,toPort:5432});
    new ec2.CfnSecurityGroupIngress(this,'SecretProvisionIngress',{groupId:endpointSg.attrGroupId,sourceSecurityGroupId:provisionSg.attrGroupId,ipProtocol:'tcp',fromPort:443,toPort:443});
    const worker = new iam.Role(this, 'Worker', {assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')});
    const operator = new iam.Role(this, 'Operator', {assumedBy: new iam.CompositePrincipal(...a.operatorRoleArns.map(r => new iam.ArnPrincipal(r)))});
    const provisioner = new iam.Role(this, 'Provisioner', {assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')});
    const provisionProfile = new iam.CfnInstanceProfile(this, 'ProvisionProfile', {roles:[provisioner.roleName]});
    const profile = new iam.CfnInstanceProfile(this, 'Profile', {roles: [worker.roleName]});
    const statement = (role: iam.Role, action: string[], resource: string[], conditions?: Record<string, unknown>) =>
      role.addToPolicy(new iam.PolicyStatement({actions: action, resources: resource, conditions}));
    const vpce = {StringEquals: {'aws:SourceVpce': endpoint.ref}};
    const own = '${ec2:SourceInstanceARN}';
    statement(worker,['s3:GetObject'],[control.arnForObjects(`boot/worker/${own}.json`),assets.arnForObjects('images/*')],vpce);
    statement(worker,['s3:PutObject'],[control.arnForObjects(`heartbeats/*/${own}.json`)],vpce);
    statement(worker,['s3:PutObject'],[evidence.arnForObjects(`results/${own}/receipt.json`)],{
      StringEquals: {'aws:SourceVpce': endpoint.ref,'s3:if-none-match':'*'}});
    statement(worker,['secretsmanager:GetSecretValue'],[readerSecret.secretArn],{StringEquals:{'aws:SourceVpce':secretEndpoint.ref}});
    const kmsCondition = {StringEquals:{'kms:ViaService':`s3.${a.region}.amazonaws.com`},
      StringLike:{'kms:EncryptionContext:aws:s3:arn':[control.arnForObjects('*'),assets.arnForObjects('images/*'),evidence.arnForObjects(`results/${own}/receipt.json`)]}};
    statement(worker,['kms:Decrypt','kms:GenerateDataKey'],[key.keyArn],kmsCondition);
    statement(provisioner,['s3:GetObject'],[control.arnForObjects(`boot/provision/${own}.json`)],vpce);
    statement(provisioner,['s3:PutObject'],[control.arnForObjects(`provision-results/${own}.json`)],{
      StringEquals:{'aws:SourceVpce':endpoint.ref,'s3:if-none-match':'*'}});
    statement(provisioner,['secretsmanager:GetSecretValue'],[readerSecret.secretArn,a.adminSecretArn],{
      StringEquals:{'aws:SourceVpce':secretEndpoint.ref}});
    statement(provisioner,['kms:Decrypt','kms:GenerateDataKey'],[key.keyArn],{
      StringEquals:{'kms:ViaService':`s3.${a.region}.amazonaws.com`},
      StringLike:{'kms:EncryptionContext:aws:s3:arn':[control.arnForObjects(`boot/provision/${own}.json`),control.arnForObjects(`provision-results/${own}.json`)]}});
    const deny = (b: s3.Bucket, sid: string, actions: string[], resources: string[], conditions: Record<string, unknown>) =>
      b.addToResourcePolicy(new iam.PolicyStatement({sid,effect:iam.Effect.DENY,principals:[new iam.AnyPrincipal()],actions,resources,conditions}));
    deny(evidence,'PrivateReaders',['s3:GetObject*','s3:ListBucket*'],[evidence.bucketArn,evidence.arnForObjects('*')],
      {ArnNotEquals:{'aws:PrincipalArn':[operator.roleArn,...a.reviewerRoleArns]}});
    deny(evidence,'WorkerWrites',['s3:PutObject*'],[evidence.arnForObjects('*')],{ArnNotEquals:{'aws:PrincipalArn':worker.roleArn}});
    deny(evidence,'CreateOnly',['s3:PutObject'],[evidence.arnForObjects('*')],{StringNotEquals:{'s3:if-none-match':'*'}});
    deny(evidence,'PrivateEndpoint',['s3:PutObject'],[evidence.arnForObjects('*')],{StringNotEquals:{'aws:SourceVpce':endpoint.ref}});
    deny(control,'ControlAuthority',['s3:PutObject*','s3:DeleteObject*'],[control.arnForObjects('active.json'),control.arnForObjects('claims/*'),control.arnForObjects('control/*'),control.arnForObjects('boot/*')],
      {ArnNotEquals:{'aws:PrincipalArn':operator.roleArn}});
    deny(control,'ProvisionResultsAuthority',['s3:PutObject*','s3:DeleteObject*'],[control.arnForObjects('provision-results/*')],
      {ArnNotEquals:{'aws:PrincipalArn':provisioner.roleArn}});
    deny(control,'ProvisionResultsCreateOnly',['s3:PutObject'],[control.arnForObjects('provision-results/*')],
      {StringNotEquals:{'s3:if-none-match':'*'}});
    deny(control,'ProvisionResultsEndpoint',['s3:PutObject'],[control.arnForObjects('provision-results/*')],
      {StringNotEquals:{'aws:SourceVpce':endpoint.ref}});
    deny(assets,'AssetAuthority',['s3:PutObject*','s3:DeleteObject*'],[assets.arnForObjects('*')],{ArnNotEquals:{'aws:PrincipalArn':a.assetPublisherRoleArn}});
    for (const arn of a.reviewerRoleArns) {
      evidence.grantRead(new iam.ArnPrincipal(arn));
    }
    assets.grantWrite(new iam.ArnPrincipal(a.assetPublisherRoleArn));
    statement(operator,['s3:GetObject','s3:PutObject'],[control.arnForObjects('*')]);
    statement(operator,['s3:GetObject'],[evidence.arnForObjects('results/*/receipt.json')]);
    statement(operator,['kms:Decrypt','kms:GenerateDataKey'],[key.keyArn],{
      StringEquals:{'kms:ViaService':`s3.${a.region}.amazonaws.com`},
      StringLike:{'kms:EncryptionContext:aws:s3:arn':[control.arnForObjects('*'),evidence.arnForObjects('results/*/receipt.json')]}});
    const boot = {mode:'worker',account:a.account,region:a.region,controlBucket:control.bucketName,
      dnsNames:[a.replicaHost,secretHost,...[control,evidence,assets].map(b=>`${b.bucketName}.s3.${a.region}.amazonaws.com`)],resolver:a.resolverAddress};
    // Only root reads this public boot configuration. No code or credentials in user-data.
    const template = new ec2.CfnLaunchTemplate(this,'Template',{launchTemplateData:{imageId:a.ami,instanceType:'r8g.4xlarge',
      iamInstanceProfile:{arn:profile.attrArn},metadataOptions:{httpTokens:'required',httpPutResponseHopLimit:1},
      instanceInitiatedShutdownBehavior:'terminate',
      userData:cdk.Fn.base64(JSON.stringify(boot)),
      networkInterfaces:[{deviceIndex:0,subnetId:subnet.ref,groups:[workerSg.attrGroupId],associatePublicIpAddress:false,deleteOnTermination:true}],
      blockDeviceMappings:[{deviceName:'/dev/xvda',ebs:{volumeSize:32,volumeType:'gp3',encrypted:true,deleteOnTermination:true}},
        {deviceName:'/dev/sdf',ebs:{volumeSize:256,volumeType:'gp3',encrypted:true,deleteOnTermination:true}}]}});
    const provisionBoot = {mode:'provision',account:a.account,region:a.region,controlBucket:control.bucketName,
      dnsNames:[a.primaryHost,secretHost,`${control.bucketName}.s3.${a.region}.amazonaws.com`],resolver:a.resolverAddress};
    const provisionTemplate = new ec2.CfnLaunchTemplate(this,'ProvisionTemplate',{launchTemplateData:{imageId:a.ami,instanceType:'t4g.small',
      iamInstanceProfile:{arn:provisionProfile.attrArn},metadataOptions:{httpTokens:'required',httpPutResponseHopLimit:1},
      instanceInitiatedShutdownBehavior:'terminate',userData:cdk.Fn.base64(JSON.stringify(provisionBoot)),
      networkInterfaces:[{deviceIndex:0,subnetId:subnet.ref,groups:[provisionSg.attrGroupId],associatePublicIpAddress:false,deleteOnTermination:true}],
      blockDeviceMappings:[{deviceName:'/dev/xvda',ebs:{volumeSize:32,volumeType:'gp3',encrypted:true,deleteOnTermination:true}},
        {deviceName:'/dev/sdf',ebs:{volumeSize:8,volumeType:'gp3',encrypted:true,deleteOnTermination:true}}]}});
    const instanceArn=`arn:aws:ec2:${a.region}:${a.account}:instance/*`, volumeArn=`arn:aws:ec2:${a.region}:${a.account}:volume/*`;
    for (const [lt,sg,role] of [[template,workerSg,worker],[provisionTemplate,provisionSg,provisioner]] as const) {
      const templateArn=`arn:aws:ec2:${a.region}:${a.account}:launch-template/${lt.ref}`;
      statement(operator,['ec2:RunInstances'],[instanceArn,volumeArn,`arn:aws:ec2:${a.region}:${a.account}:network-interface/*`,
        `arn:aws:ec2:${a.region}::image/${a.ami}`,`arn:aws:ec2:${a.region}:${a.account}:subnet/${subnet.ref}`,
        `arn:aws:ec2:${a.region}:${a.account}:security-group/${sg.attrGroupId}`,templateArn],
        {ArnEquals:{'ec2:LaunchTemplate':templateArn},Bool:{'ec2:IsLaunchTemplateResource':'true'}});
      statement(operator,['iam:PassRole'],[role.roleArn],{StringEquals:{'iam:PassedToService':'ec2.amazonaws.com'}});
    }
    statement(operator,['ec2:CreateTags'],[instanceArn,volumeArn],{StringEquals:{'ec2:CreateAction':'RunInstances','aws:RequestTag/polis:probe-box':a.id},
      'ForAllValues:StringEquals':{'aws:TagKeys':['polis:probe-box','polis:probe-run']}});
    statement(operator,['ec2:DescribeInstances','ec2:DescribeImages','ec2:DescribeVolumes'],['*']);
    statement(operator,['ec2:TerminateInstances','ec2:DeleteVolume'],[instanceArn,volumeArn],{StringEquals:{'ec2:ResourceTag/polis:probe-box':a.id}});
    const topic=sns.Topic.fromTopicArn(this,'Notifications',a.notificationTopicArn);
    // Per-run worker InstanceId dimensions are installed by the active operator.
    // A native alarm still exists while idle; missing data is intentionally quiet
    // until the operator binds the actual admitted instance and deadline.
    for (const name of ['StatusCheckFailed','StatusCheckFailed_System']) {
      const alarm = new cw.Alarm(this,name,{alarmName:`${a.id}-worker-unbound-${name}`,
        metric:new cw.Metric({namespace:'AWS/EC2',metricName:name,dimensionsMap:{InstanceId:'unbound'},period:cdk.Duration.minutes(5),statistic:'Maximum'}),
        threshold:1,evaluationPeriods:1,actionsEnabled:false,
        treatMissingData:cw.TreatMissingData.NOT_BREACHING});
      alarm.addAlarmAction(new actions.SnsAction(topic));
    }
    statement(operator,['cloudwatch:PutMetricAlarm','cloudwatch:DeleteAlarms'],[`arn:aws:cloudwatch:${a.region}:${a.account}:alarm:${a.id}-worker-*`]);
    const common = {BOX_ID:a.id,ACCOUNT:a.account,REGION:a.region,AMI:a.ami,CONTROL_BUCKET:control.bucketName,
      EVIDENCE_BUCKET:evidence.bucketName,ASSET_BUCKET:assets.bucketName,CONTROL_KEY:key.keyArn,SUBNET:subnet.ref,
      ENDPOINT:endpoint.ref,SECRET_ARN:readerSecret.secretArn,DATABASE:a.database,SECRETS_URL:`https://${secretHost}`,
      NOTIFICATION_TOPIC:a.notificationTopicArn};
    new cdk.CfnOutput(this,'OperatorRoleArn',{value:operator.roleArn});
    new cdk.CfnOutput(this,'WorkerConfig',{value:cdk.Fn.toJsonString({...common,MODE:'worker',INSTANCE_TYPE:'r8g.4xlarge',
      TEMPLATE:template.ref,TEMPLATE_VERSION:template.attrLatestVersionNumber,PROFILE:profile.attrArn,
      SECURITY_GROUP:workerSg.attrGroupId,REPLICA_HOST:a.replicaHost})});
    new cdk.CfnOutput(this,'ProvisionConfig',{value:cdk.Fn.toJsonString({...common,MODE:'provision',INSTANCE_TYPE:'t4g.small',
      TEMPLATE:provisionTemplate.ref,TEMPLATE_VERSION:provisionTemplate.attrLatestVersionNumber,PROFILE:provisionProfile.attrArn,
      SECURITY_GROUP:provisionSg.attrGroupId,REPLICA_HOST:a.primaryHost,ADMIN_SECRET_ARN:a.adminSecretArn,PROVISION_OWNER:a.provisionOwner})});
    new cdk.CfnOutput(this,'EvidenceBucket',{value:evidence.bucketName});
    new cdk.CfnOutput(this,'AssetBucket',{value:assets.bucketName});
  }
}
