/** P-053: one admission per disposable private stack. No production references. */
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
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'path';
import * as crypto from 'crypto';

export interface PrivateAdmission {
  schema: 'polis-private-admission/1';
  signerPublicKey: string; signature: string;
  id: string; account: string; region: string; ami: string;
  // Opaque per-run names only. This JSON is private, never a public CI artifact.
  fixtureKey: string; fixtureVersion: string; fixtureSha256: string;
  fixtureBytes: number; expandedBytes: number; maxMembers: number;
  candidateSha: string; oracleSha: string; supervisorSha256: string;
  runtimeSha256: string; runnerImage: string; verifierImage: string;
  policySha256: string; scheduleSha256: string; inventorySha256: string;
  // Hashes bind the complete census/coverage; these counts cannot replace it.
  expectedChecks: number; stagingExpiresAt: string; expiresAt: string;
  operatorRoleArn: string; curatorRoleArn: string; reviewerRoleArn: string;
  notificationTopicArn: string; s3PrefixListId: string;
  evidenceRetentionDays: 30 | 90;
}

export function validateAdmission(a: PrivateAdmission): PrivateAdmission {
  const fail = (field: string): never => { throw new Error(`Invalid private admission: ${field}`); };
  if (a.schema !== 'polis-private-admission/1') fail('schema');
  if (!/^[a-f0-9]{64}$/.test(a.signerPublicKey ?? '') || !/^[a-f0-9]{128}$/.test(a.signature ?? '')) fail('signature');
  const { signature, ...signed } = a;
  const publicKey = crypto.createPublicKey({ key: Buffer.from('302a300506032b6570032100' + a.signerPublicKey, 'hex'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(canonical(signed)), publicKey, Buffer.from(signature, 'hex'))) fail('signature');
  for (const key of ['fixtureSha256', 'supervisorSha256', 'runtimeSha256', 'policySha256',
    'scheduleSha256', 'inventorySha256'] as const) if (!/^[a-f0-9]{64}$/.test(a[key] ?? '')) fail(key);
  for (const key of ['candidateSha', 'oracleSha'] as const) if (!/^[a-f0-9]{40}$/.test(a[key] ?? '')) fail(key);
  if (!/^[a-f0-9]{32}$/.test(a.id ?? '')) fail('id');
  if (!/^\d{12}$/.test(a.account ?? '')) fail('account');
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(a.region ?? '')) fail('region');
  if (!/^ami-[a-f0-9]{17}$/.test(a.ami ?? '')) fail('ami');
  if (!/^pl-[a-f0-9]+$/.test(a.s3PrefixListId ?? '')) fail('s3PrefixListId');
  if (a.fixtureKey !== `staging/${a.id}/bundle.tar`) fail('fixtureKey');
  if (!/^[A-Za-z0-9._~+\/-]{1,1024}$/.test(a.fixtureVersion ?? '') || a.fixtureVersion === 'null') fail('fixtureVersion');
  for (const key of ['runnerImage', 'verifierImage'] as const)
    if (!/^localhost\/polis-[a-z-]+@sha256:[a-f0-9]{64}$/.test(a[key] ?? '')) fail(key);
  for (const key of ['fixtureBytes', 'expandedBytes', 'maxMembers', 'expectedChecks'] as const)
    if (!Number.isSafeInteger(a[key]) || a[key] <= 0) fail(key);
  if (a.fixtureBytes > 4 * 1024 ** 3 || a.expandedBytes > 180 * 1024 ** 3 || a.maxMembers > 1000000) fail('storage bounds');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(a.expiresAt ?? '') || !Number.isFinite(Date.parse(a.expiresAt))) fail('expiresAt');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(a.stagingExpiresAt ?? '') || !Number.isFinite(Date.parse(a.stagingExpiresAt)) || Date.parse(a.stagingExpiresAt) >= Date.parse(a.expiresAt)) fail('stagingExpiresAt');
  for (const key of ['operatorRoleArn', 'curatorRoleArn', 'reviewerRoleArn'] as const)
    if (!new RegExp(`^arn:aws:iam::${a.account}:role/[A-Za-z0-9_+=,.@/-]+$`).test(a[key] ?? '')) fail(key);
  if (new Set([a.operatorRoleArn, a.curatorRoleArn, a.reviewerRoleArn]).size !== 3) fail('separate principals');
  if (!new RegExp(`^arn:aws:sns:${a.region}:${a.account}:[A-Za-z0-9_-]+$`).test(a.notificationTopicArn ?? '')) fail('notificationTopicArn');
  if (![30, 90].includes(a.evidenceRetentionDays)) fail('evidenceRetentionDays');
  if (Buffer.byteLength(canonical(a)) > 2800) fail('admission exceeds control environment budget');
  for (const key of ['stagingExpiresAt', 'expiresAt'] as const)
    if (new Date(a[key]).toISOString().replace('.000Z', 'Z') !== a[key]) fail(key);
  return a;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(
    k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}

export class PrivateCertBox extends Construct {
  constructor(scope: Construct, id: string, admission: PrivateAdmission) {
    super(scope, id);
    const a = validateAdmission(admission);
    const stack = cdk.Stack.of(this);
    if (stack.account !== a.account || stack.region !== a.region) throw new Error('Explicit admission account/region must match stack');
    const digest = crypto.createHash('sha256').update(canonical(a)).digest('hex');
    const name = `ppc-${a.account}-${a.id}`;
    const run = `runs/${a.id}/`;
    const tag = { key: 'polis:private-cert', value: a.id };
    const instanceArn = `arn:aws:ec2:${a.region}:${a.account}:instance/*`;
    const volumeArn = `arn:aws:ec2:${a.region}:${a.account}:volume/*`;
    // L1 network resources avoid any lookup/default-SG custom resource role.
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.253.0.0/24', enableDnsSupport: true, enableDnsHostnames: false });
    const subnet = new ec2.CfnSubnet(this, 'Subnet', { vpcId: vpc.ref, cidrBlock: '10.253.0.0/26', mapPublicIpOnLaunch: false, availabilityZone: `${a.region}a` });
    const routes = new ec2.CfnRouteTable(this, 'Routes', { vpcId: vpc.ref });
    new ec2.CfnSubnetRouteTableAssociation(this, 'RouteAssociation', { routeTableId: routes.ref, subnetId: subnet.ref });
    const sg = new ec2.CfnSecurityGroup(this, 'WorkerSg', {
      groupDescription: 'Private certification: S3 TLS only; no ingress', vpcId: vpc.ref,
      securityGroupEgress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, destinationPrefixListId: a.s3PrefixListId }],
    });
    const fixtureKey = new kms.Key(this, 'FixtureKey', { enableKeyRotation: true, removalPolicy: cdk.RemovalPolicy.RETAIN });
    const evidenceKey = new kms.Key(this, 'EvidenceKey', { enableKeyRotation: true, removalPolicy: cdk.RemovalPolicy.RETAIN });
    const bucket = (id: string, suffix: string, key: kms.Key, rules: s3.LifecycleRule[]) => new s3.Bucket(this, id, {
      bucketName: `${name}-${suffix}`, encryption: s3.BucketEncryption.KMS, encryptionKey: key,
      bucketKeyEnabled: false, versioned: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, lifecycleRules: rules,
    });
    const fixtures = bucket('Fixtures', 'fixtures', fixtureKey, [{ prefix: `staging/${a.id}/`, expiration: cdk.Duration.days(1), noncurrentVersionExpiration: cdk.Duration.days(1), abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }]);
    const evidence = bucket('Evidence', 'evidence', evidenceKey, [{ prefix: run, expiration: cdk.Duration.days(a.evidenceRetentionDays), noncurrentVersionExpiration: cdk.Duration.days(a.evidenceRetentionDays), abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }]);
    const control = bucket('Control', 'control', evidenceKey, []);
    const endpoint = new ec2.CfnVPCEndpoint(this, 'S3Endpoint', {
      vpcId: vpc.ref, vpcEndpointType: 'Gateway', serviceName: `com.amazonaws.${a.region}.s3`, routeTableIds: [routes.ref],
      policyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'], Resource: [fixtures.arnForObjects('*'), evidence.arnForObjects('*'), control.arnForObjects('*')] }] },
    });
    const worker = new iam.Role(this, 'Worker', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') });
    cdk.Tags.of(worker).add('polis:private-cert', a.id);
    const profile = new iam.CfnInstanceProfile(this, 'Profile', { roles: [worker.roleName] });
    const lifecycle = new iam.Role(this, 'Lifecycle', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const statement = (role: iam.Role, actions: string[], resources: string[], conditions?: Record<string, unknown>) => role.addToPolicy(new iam.PolicyStatement({ actions, resources, conditions }));
    const dataConditions = { StringEquals: { 'aws:SourceVpce': endpoint.ref, 'aws:PrincipalTag/polis:private-cert': a.id } };
    statement(worker, ['s3:GetObjectVersion'], [fixtures.arnForObjects(a.fixtureKey)], {
      StringEquals: { ...dataConditions.StringEquals, 's3:VersionId': a.fixtureVersion }, DateLessThan: { 'aws:CurrentTime': a.expiresAt },
    });
    // Only one immutable boot record. No worker access to cleanup/public records.
    statement(worker, ['s3:GetObject'], [control.arnForObjects(`boot/${a.id}.json`)], dataConditions);
    const ownHeartbeat = control.arnForObjects(`heartbeats/${a.id}/` + '${ec2:SourceInstanceARN}.json');
    statement(worker, ['s3:PutObject'], [ownHeartbeat], { ...dataConditions, DateLessThan: { 'aws:CurrentTime': a.expiresAt } });
    const ownEvidence = evidence.arnForObjects(run + '${ec2:SourceInstanceARN}/*');
    statement(worker, ['s3:PutObject'], [ownEvidence], {
      StringEquals: { ...dataConditions.StringEquals, 's3:if-none-match': '*', 's3:x-amz-server-side-encryption': 'aws:kms', 's3:x-amz-server-side-encryption-aws-kms-key-id': evidenceKey.keyArn },
      DateLessThan: { 'aws:CurrentTime': a.expiresAt },
    });
    const kmsConditions = (resource: string, like = false) => ({
      StringEquals: { 'kms:ViaService': `s3.${a.region}.amazonaws.com` },
      [like ? 'StringLike' : 'StringEquals']: {
        'kms:ViaService': `s3.${a.region}.amazonaws.com`, 'kms:EncryptionContext:aws:s3:arn': resource,
      },
    });
    statement(worker, ['kms:Decrypt'], [fixtureKey.keyArn], kmsConditions(fixtures.arnForObjects(a.fixtureKey)));
    statement(worker, ['kms:Decrypt'], [evidenceKey.keyArn], kmsConditions(control.arnForObjects(`boot/${a.id}.json`)));
    statement(worker, ['kms:GenerateDataKey'], [evidenceKey.keyArn], kmsConditions(ownEvidence, true));
    statement(worker, ['kms:GenerateDataKey'], [evidenceKey.keyArn], kmsConditions(ownHeartbeat));
    // Resource-side denies are independent of grants. Curator has upload only;
    // reviewers see evidence, never fixture staging. No public CI trust exists.
    const deny = (b: s3.Bucket, sid: string, actions: string[], resources: string[], conditions: Record<string, unknown>) => b.addToResourcePolicy(new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()], actions, resources, conditions }));
    deny(fixtures, 'WorkerOnlyReader', ['s3:GetObject*'], [fixtures.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': worker.roleArn } });
    deny(fixtures, 'EndpointOnlyReader', ['s3:GetObject*'], [fixtures.arnForObjects('*')], { StringNotEquals: { 'aws:SourceVpce': endpoint.ref } });
    deny(fixtures, 'OnlyAdmittedVersion', ['s3:GetObject*'], [fixtures.arnForObjects('*')], { StringNotEquals: { 's3:VersionId': a.fixtureVersion } });
    deny(fixtures, 'OnlyCuratorWrites', ['s3:PutObject*'], [fixtures.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': a.curatorRoleArn } });
    deny(fixtures, 'ClosedIngestion', ['s3:PutObject*'], [fixtures.arnForObjects('*')], { DateGreaterThanEquals: { 'aws:CurrentTime': a.stagingExpiresAt } });
    deny(fixtures, 'ExpiredStaging', ['s3:GetObject*'], [fixtures.arnForObjects('*')], { DateGreaterThanEquals: { 'aws:CurrentTime': a.expiresAt } });
    deny(fixtures, 'OnlyCleanerDeletes', ['s3:DeleteObject*', 's3:AbortMultipartUpload'], [fixtures.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': lifecycle.roleArn } });
    deny(evidence, 'PrivateReaders', ['s3:GetObject*', 's3:ListBucket*'], [evidence.bucketArn, evidence.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': a.reviewerRoleArn } });
    deny(evidence, 'WorkerOnlyWrites', ['s3:PutObject*'], [evidence.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': worker.roleArn } });
    deny(evidence, 'CreateOnly', ['s3:PutObject'], [evidence.arnForObjects('*')], { StringNotEquals: { 's3:if-none-match': '*' } });
    deny(evidence, 'WorkerEndpoint', ['s3:PutObject'], [evidence.arnForObjects('*')], { StringNotEquals: { 'aws:SourceVpce': endpoint.ref } });
    deny(control, 'TrustedControlWriters', ['s3:PutObject*', 's3:DeleteObject*'], [control.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': [lifecycle.roleArn, worker.roleArn] } });
    deny(control, 'PrivateControlReaders', ['s3:GetObject*', 's3:ListBucket*'], [control.bucketArn, control.arnForObjects('*')], { ArnNotEquals: { 'aws:PrincipalArn': [worker.roleArn, lifecycle.roleArn, a.operatorRoleArn, a.reviewerRoleArn] } });
    deny(control, 'WorkerCannotWriteRecords', ['s3:PutObject*', 's3:DeleteObject*'], [control.arnForObjects('control/*'), control.arnForObjects('boot/*')], { ArnEquals: { 'aws:PrincipalArn': worker.roleArn } });
    for (const [b, key] of [[fixtures, fixtureKey], [evidence, evidenceKey], [control, evidenceKey]] as const) {
      deny(b, 'RequireKms', ['s3:PutObject'], [b.arnForObjects('*')], { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } });
      deny(b, 'RequireOwnKey', ['s3:PutObject'], [b.arnForObjects('*')], { StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': key.keyArn } });
    }
    const grantExternal = (principal: string, b: s3.Bucket, actions: string[], resource: string, key: kms.Key, keyActions: string[]) => {
      b.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ArnPrincipal(principal)], actions, resources: [resource] }));
      key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ArnPrincipal(principal)], actions: keyActions, resources: ['*'], conditions: kmsConditions(`arn:aws:s3:::${name}-${b === fixtures ? 'fixtures/' + a.fixtureKey : b === evidence ? 'evidence/' + run + '*' : 'control/*'}`, b !== fixtures) }));
    };
    grantExternal(a.curatorRoleArn, fixtures, ['s3:PutObject'], fixtures.arnForObjects(a.fixtureKey), fixtureKey, ['kms:GenerateDataKey']);
    grantExternal(a.reviewerRoleArn, evidence, ['s3:GetObjectVersion'], evidence.arnForObjects(run + '*'), evidenceKey, ['kms:Decrypt']);
    for (const principal of [a.operatorRoleArn, a.reviewerRoleArn])
      grantExternal(principal, control, ['s3:GetObject'], control.arnForObjects('*'), evidenceKey, ['kms:Decrypt']);

    const template = new ec2.CfnLaunchTemplate(this, 'Template', { launchTemplateData: {
      imageId: a.ami, instanceType: 'r8g.4xlarge', iamInstanceProfile: { arn: profile.attrArn },
      // No UserData, KeyName, SSM profile, autoscaling or network overrides.
      metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1, instanceMetadataTags: 'disabled' },
      instanceInitiatedShutdownBehavior: 'terminate', hibernationOptions: { configured: false },
      networkInterfaces: [{ deviceIndex: 0, subnetId: subnet.ref, groups: [sg.attrGroupId], associatePublicIpAddress: false, deleteOnTermination: true }],
      blockDeviceMappings: [{ deviceName: '/dev/xvda', ebs: { volumeSize: 32, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }, { deviceName: '/dev/sdf', ebs: { volumeSize: 256, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
      tagSpecifications: [{ resourceType: 'instance', tags: [tag] }, { resourceType: 'volume', tags: [tag] }],
    } });
    const templateArn = `arn:aws:ec2:${a.region}:${a.account}:launch-template/${template.ref}`;
    statement(lifecycle, ['ec2:RunInstances'], [instanceArn, volumeArn, `arn:aws:ec2:${a.region}:${a.account}:network-interface/*`,
      `arn:aws:ec2:${a.region}::image/${a.ami}`, `arn:aws:ec2:${a.region}:${a.account}:subnet/${subnet.ref}`,
      `arn:aws:ec2:${a.region}:${a.account}:security-group/${sg.attrGroupId}`, templateArn], {
      ArnEquals: { 'ec2:LaunchTemplate': templateArn }, Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
    });
    statement(lifecycle, ['ec2:CreateTags'], [instanceArn, volumeArn], { StringEquals: { 'ec2:CreateAction': 'RunInstances', 'aws:RequestTag/polis:private-cert': a.id }, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['polis:private-cert'] } });
    statement(lifecycle, ['iam:PassRole'], [worker.roleArn], { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } });
    statement(lifecycle, ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeImages'], ['*']);
    statement(lifecycle, ['ec2:TerminateInstances'], [instanceArn], { StringEquals: { 'ec2:ResourceTag/polis:private-cert': a.id } });
    statement(lifecycle, ['ec2:DeleteVolume'], [volumeArn], { StringEquals: { 'ec2:ResourceTag/polis:private-cert': a.id } });
    statement(lifecycle, ['s3:GetObject', 's3:PutObject'], [control.arnForObjects('*')]);
    statement(lifecycle, ['kms:Decrypt', 'kms:GenerateDataKey'], [evidenceKey.keyArn], kmsConditions(control.arnForObjects('*'), true));
    statement(lifecycle, ['s3:ListBucketVersions'], [fixtures.bucketArn], { StringLike: { 's3:prefix': `staging/${a.id}/*` } });
    // ListBucketMultipartUploads has no s3:prefix IAM condition support.
    // Metadata inventory is limited to this one admission's dedicated bucket;
    // API filtering and the abort/delete grants retain the exact staging prefix.
    statement(lifecycle, ['s3:ListBucketMultipartUploads'], [fixtures.bucketArn]);
    statement(lifecycle, ['s3:DeleteObjectVersion', 's3:DeleteObject', 's3:AbortMultipartUpload'], [fixtures.arnForObjects(`staging/${a.id}/*`)]);
    const logGroup = new logs.LogGroup(this, 'ControlLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.RETAIN });
    logGroup.grantWrite(lifecycle);
    const fn = new lambda.Function(this, 'ControlFunction', {
      runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64,
      handler: 'control.handler', code: lambda.Code.fromAsset(path.join(__dirname, '../ci/private_cert'), { exclude: ['__pycache__', 'test_*'] }),
      timeout: cdk.Duration.minutes(5), reservedConcurrentExecutions: 1, role: lifecycle, logGroup,
      environment: { ADMISSION: canonical(a), ADMISSION_SHA256: digest, FIXTURE_BUCKET: fixtures.bucketName,
        EVIDENCE_BUCKET: evidence.bucketName, CONTROL_BUCKET: control.bucketName, CONTROL_KEY: evidenceKey.keyArn,
        TEMPLATE: template.ref, TEMPLATE_VERSION: template.attrLatestVersionNumber, PROFILE: profile.attrArn,
        SUBNET: subnet.ref, SECURITY_GROUP: sg.attrGroupId, ENDPOINT: endpoint.ref },
    });
    // Immutable configuration selected by the function, not caller parameters.
    fn.addPermission('OperatorInvoke', { principal: new iam.ArnPrincipal(a.operatorRoleArn), action: 'lambda:InvokeFunction' });
    new events.Rule(this, 'Sweep', { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), targets: [new targets.LambdaFunction(fn, { event: events.RuleTargetInput.fromObject({ action: 'sweep', admissionId: a.id }) })] });
    const topic = sns.Topic.fromTopicArn(this, 'Maintainer', a.notificationTopicArn);
    for (const [label, metric, threshold, missing] of [
      ['Error', fn.metricErrors({ period: cdk.Duration.minutes(5) }), 1, cw.TreatMissingData.BREACHING],
      ['MissingSweep', fn.metricInvocations({ period: cdk.Duration.minutes(15) }), 1, cw.TreatMissingData.BREACHING],
    ] as const) {
      const alarm = new cw.Alarm(this, label, { metric, threshold, evaluationPeriods: 1, treatMissingData: missing,
        comparisonOperator: label === 'MissingSweep' ? cw.ComparisonOperator.LESS_THAN_THRESHOLD : cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD });
      alarm.addAlarmAction(new actions.SnsAction(topic));
    }
    new cdk.CfnOutput(this, 'ControlFunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'AdmissionDigest', { value: digest });
    new cdk.CfnOutput(this, 'FixtureBucket', { value: fixtures.bucketName });
    new cdk.CfnOutput(this, 'EvidenceBucket', { value: evidence.bucketName });
    new cdk.CfnOutput(this, 'ControlBucket', { value: control.bucketName });
  }
}
