import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as crypto from 'crypto';
import { PrivateCertBox, PrivateAdmission, canonical, validateAdmission } from '../privateCertBox';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
function admission(overrides: Partial<PrivateAdmission> = {}): PrivateAdmission {
  const a: PrivateAdmission = {
    schema: 'polis-private-admission/1', signerPublicKey: publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('hex'), signature: '',
    id: 'a'.repeat(32), account: '111111111111', region: 'us-east-1', ami: 'ami-' + '1'.repeat(17),
    fixtureKey: `staging/${'a'.repeat(32)}/bundle.tar`, fixtureVersion: 'synthetic-version-1',
    fixtureSha256: '1'.repeat(64), fixtureBytes: 2048, expandedBytes: 1024, maxMembers: 2,
    candidateSha: '2'.repeat(40), oracleSha: '3'.repeat(40), supervisorSha256: '4'.repeat(64), runtimeSha256: '5'.repeat(64),
    runnerImage: 'localhost/polis-producer@sha256:' + '6'.repeat(64), verifierImage: 'localhost/polis-verifier@sha256:' + '7'.repeat(64),
    policySha256: '8'.repeat(64), scheduleSha256: '9'.repeat(64), inventorySha256: 'a'.repeat(64), expectedChecks: 6,
    stagingExpiresAt: '2099-01-01T09:00:00Z', expiresAt: '2099-01-01T12:00:00Z', operatorRoleArn: 'arn:aws:iam::111111111111:role/synthetic-operator',
    curatorRoleArn: 'arn:aws:iam::111111111111:role/synthetic-curator', reviewerRoleArn: 'arn:aws:iam::111111111111:role/synthetic-reviewer',
    notificationTopicArn: 'arn:aws:sns:us-east-1:111111111111:synthetic-maintainer', s3PrefixListId: 'pl-12345678', evidenceRetentionDays: 30, ...overrides,
  };
  const { signature, ...signed } = a;
  a.signature = crypto.sign(null, Buffer.from(canonical(signed)), privateKey).toString('hex');
  return a;
}
function build(a = admission()) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Private', { env: { account: a.account, region: a.region } });
  new PrivateCertBox(stack, 'Box', a);
  const assembly = app.synth();
  return { t: Template.fromStack(stack), json: assembly.getStackArtifact(stack.artifactId).template };
}
const ofType = (j: any, type: string): any[] => Object.values(j.Resources).filter((r: any) => r.Type === type);
test('isolated sibling network, only S3 endpoint egress and no production or interactive services', () => {
  const {t, json: j} = build();
  t.resourceCountIs('AWS::EC2::VPC', 1); t.resourceCountIs('AWS::EC2::Subnet', 1);
  for (const type of ['AWS::EC2::NatGateway', 'AWS::EC2::InternetGateway', 'AWS::EC2::VPCPeeringConnection', 'AWS::EC2::Route', 'AWS::SSM::Document', 'AWS::IAM::OIDCProvider', 'AWS::EC2::Instance']) t.resourceCountIs(type, 0);
  const sg = ofType(j, 'AWS::EC2::SecurityGroup')[0].Properties;
  expect(sg.SecurityGroupIngress).toBeUndefined();
  expect(sg.SecurityGroupEgress).toEqual([{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, DestinationPrefixListId: 'pl-12345678' }]);
  const endpoint = ofType(j, 'AWS::EC2::VPCEndpoint')[0].Properties;
  expect(endpoint.VpcEndpointType).toBe('Gateway'); expect(endpoint.PolicyDocument.Statement[0].Resource).toHaveLength(3);
});
test('pinned launch with disposable encrypted disks; no userdata, keypair or public IP', () => {
  const d = ofType(build().json, 'AWS::EC2::LaunchTemplate')[0].Properties.LaunchTemplateData;
  expect(d.ImageId).toBe('ami-' + '1'.repeat(17)); expect(d.InstanceType).toBe('r8g.4xlarge');
  expect(d.UserData).toBeUndefined(); expect(d.KeyName).toBeUndefined();
  expect(d.MetadataOptions).toEqual({HttpTokens: 'required', HttpPutResponseHopLimit: 1, InstanceMetadataTags: 'disabled'});
  expect(d.InstanceInitiatedShutdownBehavior).toBe('terminate');
  expect(d.NetworkInterfaces).toHaveLength(1); expect(d.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
  expect(d.BlockDeviceMappings.map((d: any) => d.Ebs)).toEqual([32, 256].map(VolumeSize => ({VolumeSize, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true})));
});
test('worker exact version, endpoint, own create-only writes and narrow KMS; no runtime administration', () => {
  const j = build().json;
  const policy = Object.entries(j.Resources).find(([id, r]: any) => id.startsWith('BoxWorkerDefaultPolicy') && r.Type === 'AWS::IAM::Policy')![1] as any;
  const statements = policy.Properties.PolicyDocument.Statement, all = JSON.stringify(statements);
  for (const forbidden of ['ssm:', 'sts:', 'secretsmanager:', 'ec2:RunInstances', 's3:ListBucket', 's3:Delete', 'logs:']) expect(all).not.toContain(forbidden);
  const get = statements.find((s: any) => s.Action === 's3:GetObjectVersion');
  expect(get.Condition.StringEquals['s3:VersionId']).toBe('synthetic-version-1');
  expect(get.Condition.StringEquals['aws:SourceVpce']).toBeDefined(); expect(get.Condition.DateLessThan).toBeDefined();
  const evidence = statements.find((s: any) => s.Action === 's3:PutObject' && JSON.stringify(s.Resource).includes('/runs/'));
  expect(JSON.stringify(evidence.Resource)).toContain('${ec2:SourceInstanceARN}');
  expect(evidence.Condition.StringEquals['s3:if-none-match']).toBe('*');
  for (const s of statements.filter((s: any) => JSON.stringify(s.Action).includes('kms:'))) {
    expect(JSON.stringify(s.Condition)).not.toContain('SourceVpce');
    expect(s.Condition.StringEquals?.['kms:ViaService'] ?? s.Condition.StringLike?.['kms:ViaService']).toBe('s3.us-east-1.amazonaws.com');
    expect(JSON.stringify(s.Condition)).toContain('kms:EncryptionContext:aws:s3:arn');
  }
});
test('retained versioned private buckets and independent denies', () => {
  const j = build().json;
  for (const r of ofType(j, 'AWS::S3::Bucket')) {
    expect(r.DeletionPolicy).toBe('Retain'); expect(r.UpdateReplacePolicy).toBe('Retain');
    expect(r.Properties.BucketName.length).toBeLessThanOrEqual(63);
    expect(r.Properties.VersioningConfiguration.Status).toBe('Enabled');
    expect(Object.values(r.Properties.PublicAccessBlockConfiguration)).toEqual([true, true, true, true]);
    expect(r.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].BucketKeyEnabled).toBe(false);
  }
  const policies = ofType(j, 'AWS::S3::BucketPolicy').flatMap(r => r.Properties.PolicyDocument.Statement);
  for (const sid of ['WorkerOnlyReader', 'EndpointOnlyReader', 'OnlyAdmittedVersion', 'PrivateReaders', 'CreateOnly', 'WorkerCannotWriteRecords']) expect(policies.find((s: any) => s.Sid === sid)?.Effect).toBe('Deny');
  expect(ofType(j, 'AWS::KMS::Key')).toHaveLength(2);
});
test('serialized operator-only launch with independently scheduled and alarmed sweep', () => {
  const j = build().json, fn = ofType(j, 'AWS::Lambda::Function')[0].Properties;
  expect(fn.ReservedConcurrentExecutions).toBe(1); expect(fn.Environment.Variables.TEMPLATE_VERSION).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(fn.Environment.Variables))).toBeLessThan(4096);
  expect(ofType(j, 'AWS::Events::Rule')[0].Properties.ScheduleExpression).toBe('rate(5 minutes)');
  expect(ofType(j, 'AWS::CloudWatch::Alarm')).toHaveLength(2); expect(JSON.stringify(j)).not.toContain('RunShellScript');
  expect(ofType(j, 'AWS::Lambda::Permission').some(p => p.Properties.Principal === admission().operatorRoleArn)).toBe(true);
});
test.each([
  ['moving image', {runnerImage: 'localhost/polis-producer:latest'}], ['missing version', {fixtureVersion: ''}],
  ['null version', {fixtureVersion: 'null'}], ['wrong key', {fixtureKey: 'another/bundle.tar'}],
  ['wildcard principal', {operatorRoleArn: '*'}], ['same principals', {curatorRoleArn: 'arn:aws:iam::111111111111:role/synthetic-operator'}],
  ['missing expiry', {expiresAt: ''}], ['oversize unpack', {expandedBytes: 200 * 1024 ** 3}],
  ['zero checks', {expectedChecks: 0}], ['retention', {evidenceRetentionDays: 1}],
  ['missing digest', {policySha256: ''}], ['bad region', {region: 'bad'}],
] as [string, any][])('rejects %s before provisioning', (_name, overrides) => {
  expect(() => validateAdmission(admission(overrides))).toThrow('Invalid private admission');
});
test('mutated signed bytes fail', () => {
  const a = admission(); a.fixtureVersion = 'different-version';
  expect(() => validateAdmission(a)).toThrow('signature');
});
test('explicit account mismatch fails', () => {
  const s = new cdk.Stack(new cdk.App(), 'Wrong', {env: {account: '222222222222', region: 'us-east-1'}});
  expect(() => new PrivateCertBox(s, 'Box', admission())).toThrow('must match stack');
});

test('multipart inventory uses the dedicated bucket without unsupported prefix condition', () => {
  const j = build().json;
  const all = ofType(j, 'AWS::IAM::Policy').flatMap(p => p.Properties.PolicyDocument.Statement);
  const statement = all.find((s: any) => s.Action === 's3:ListBucketMultipartUploads');
  expect(statement).toBeDefined(); expect(statement.Condition).toBeUndefined();
  expect(JSON.stringify(statement.Resource)).toContain('Fixtures');
});
