import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LightShadowConfig, LightShadowHost, addLightShadowStack, renderHostFiles, renderUserData,
  validateLightShadowConfig,
} from '../lightShadow';

const config: LightShadowConfig = {
  schema: 'polis-light-shadow/1', account: '111111111111', region: 'us-east-1',
  vpcId: 'vpc-12345678', subnetIds: ['subnet-11111111', 'subnet-22222222'], ami: 'ami-' + '1'.repeat(17),
  databaseSecurityGroupId: 'sg-87654321',
  databaseHost: 'public-fixture-primary.abc.us-east-1.rds.amazonaws.com',
  databaseSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:public-fixture-db-AbCdEf',
  mathEnv: 'python-shadow', engineCommit: '057bd9dc11f7385262d37821bdb81a8f21fdfdd4',
  imageDigest: 'sha256:' + 'a'.repeat(64),
};

function build(input: LightShadowConfig = config) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Shadow', { env: { account: config.account, region: config.region } });
  new LightShadowHost(stack, 'Host', input);
  return Template.fromStack(stack);
}
const resources = (j: any, type: string): any[] => Object.values(j.Resources).filter((r: any) => r.Type === type);

describe('configuration', () => {
  test('refuses MATH_ENV=prod and anything other than python-shadow', () => {
    expect(() => validateLightShadowConfig({ ...config, mathEnv: 'prod' })).toThrow('refuses MATH_ENV=prod');
    for (const env of ['', 'python', 'preprod', 'Python-Shadow', 'python-shadow '])
      expect(() => validateLightShadowConfig({ ...config, mathEnv: env })).toThrow('requires MATH_ENV=python-shadow');
    expect(() => build({ ...config, mathEnv: 'prod' })).toThrow();
  });
  test('refuses credential-bearing or unknown keys, mutable images and loose identifiers', () => {
    for (const extra of [{ databaseUrl: 'postgresql://x' }, { password: 'x' }, { instanceType: 'r8g.large' }])
      expect(() => validateLightShadowConfig({ ...config, ...extra } as any)).toThrow();
    for (const bad of [
      { imageDigest: 'latest' }, { imageDigest: 'sha256:abc' }, { engineCommit: '057bd9dc1' },
      { databaseSecretArn: 'arn:aws:secretsmanager:us-east-1:222222222222:secret:other-AbCdEf' },
      { subnetIds: [] }, { ami: 'ami-123' }, { databaseHost: 'db.example.com' },
      { pollAllowlist: [0] }, { pollAllowlist: [1.5] },
    ]) expect(() => validateLightShadowConfig({ ...config, ...bad } as any)).toThrow();
    expect(validateLightShadowConfig({ ...config, pollAllowlist: [12, 34] }).pollAllowlist).toEqual([12, 34]);
  });
});

describe('default off', () => {
  test('without the context flag nothing is added and the config is never read', () => {
    const app = new cdk.App();
    const read = jest.fn(() => config);
    expect(addLightShadowStack(app, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(app.node.children.length).toBe(0);
  });
  test('with the flag it adds exactly one LightShadowStack', () => {
    const app = new cdk.App({ context: { enableLightShadow: 'true' } });
    const stack = addLightShadowStack(app, () => config)!;
    expect(stack.stackName).toBe('LightShadowStack');
    expect(app.node.children.map(c => c.node.id)).toEqual(['LightShadowStack']);
  });
  test('the flag with a prod config still refuses', () => {
    const app = new cdk.App({ context: { enableLightShadow: true } });
    expect(() => addLightShadowStack(app, () => ({ ...config, mathEnv: 'prod' }))).toThrow();
  });
});

describe('host', () => {
  test('one t4g.large ARM64 host, absent until the instance count is set to 1', () => {
    const t = build(), j = t.toJSON();
    t.hasParameter('LightShadowInstanceCount', { Default: 0, AllowedValues: ['0', '1'] });
    t.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
    const g = resources(j, 'AWS::AutoScaling::AutoScalingGroup')[0].Properties;
    expect([g.MinSize, g.MaxSize]).toEqual(['0', '1']);
    expect(g.DesiredCapacity).toEqual({ Ref: 'LightShadowInstanceCount' });
    expect(g.VPCZoneIdentifier).toEqual(config.subnetIds);
    const d = resources(j, 'AWS::EC2::LaunchTemplate')[0].Properties.LaunchTemplateData;
    expect(d.InstanceType).toBe('t4g.large');
    expect(d.ImageId).toBe(config.ami);
    expect(d.KeyName).toBeUndefined();
    expect(d.MetadataOptions).toEqual({ HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' });
    expect(d.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
    expect(d.BlockDeviceMappings[0].Ebs).toMatchObject({ Encrypted: true, DeleteOnTermination: true });
    expect(g.Tags).toContainEqual({ Key: 'polis:math-env', Value: 'python-shadow', PropagateAtLaunch: true });
  });
  test('no ingress; egress only to the database on 5432 and HTTPS; one database ingress rule', () => {
    const j = build().toJSON();
    const sg = resources(j, 'AWS::EC2::SecurityGroup')[0].Properties;
    expect(sg.SecurityGroupIngress).toBeUndefined();
    expect(sg.SecurityGroupEgress.map((e: any) => [e.FromPort, e.ToPort, e.DestinationSecurityGroupId ?? e.CidrIp]))
      .toEqual([[5432, 5432, config.databaseSecurityGroupId], [443, 443, '0.0.0.0/0']]);
    const ingress = resources(j, 'AWS::EC2::SecurityGroupIngress');
    expect(ingress).toHaveLength(1);
    expect(ingress[0].Properties).toMatchObject({ GroupId: config.databaseSecurityGroupId, FromPort: 5432, ToPort: 5432 });
  });
  test('role reads only the configured database secret and holds no write or admin authority', () => {
    const j = build().toJSON();
    const policy = resources(j, 'AWS::IAM::Policy')[0].Properties.PolicyDocument, raw = JSON.stringify(policy);
    const secret = policy.Statement.filter((s: any) => s.Action === 'secretsmanager:GetSecretValue');
    expect(secret).toHaveLength(1);
    expect(secret[0].Resource).toBe(config.databaseSecretArn);
    for (const no of ['s3:', 'dynamodb:', 'rds-db:', 'kms:', 'ec2:', 'iam:', 'secretsmanager:*', 'ssm:PutParameter', 'ecr:Put'])
      expect(raw).not.toContain(no);
    const role = JSON.stringify(resources(j, 'AWS::IAM::Role')[0].Properties.ManagedPolicyArns);
    expect(role).toContain('AmazonSSMManagedInstanceCore');
    expect(role).not.toContain('SecretsManagerReadWrite');
  });
  test('immutable digest-only repository, one-month logs, run switch defaults off', () => {
    const t = build(), j = t.toJSON();
    t.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'polis/math-python', ImageTagMutability: 'IMMUTABLE' });
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/polis/light-shadow/math', RetentionInDays: 30 });
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/polis/light-shadow/run', Value: 'off', Type: 'String' });
    expect(resources(j, 'AWS::ECR::Repository')[0].DeletionPolicy).toBe('Retain');
  });
  test('no Lambda, custom resource or new database secret', () => {
    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.Type === 'string') {
        expect(node.Type.startsWith('AWS::Lambda::')).toBe(false);
        expect(node.Type.startsWith('Custom::')).toBe(false);
        expect(node.Type).not.toBe('AWS::SecretsManager::Secret');
      }
      expect(node.ServiceToken).toBeUndefined();
      for (const v of Object.values(node)) visit(v);
    };
    visit(build().toJSON());
  });
});

describe('on-box files', () => {
  const files = renderHostFiles(config);
  test('environment is fixed to python-shadow with TLS required and carries no credential', () => {
    const env = files['/etc/polis-shadow/shadow.env'];
    expect(env).toContain('\nMATH_ENV=python-shadow\n');
    expect(env).toContain('\nDATABASE_SSL_MODE=require\n');
    expect(env).toContain(`@${config.imageDigest}`);
    expect(env).not.toMatch(/DATABASE_URL|PASSWORD|password/);
    const user = renderUserData(config);
    expect(user).not.toMatch(/DATABASE_URL=|password=/i);
    expect(user).toContain(`systemctl enable polis-math-shadow.service`);
  });
  test('start script refuses prod, unpinned or non-arm64 images and passes no credential', () => {
    const start = files['/usr/local/bin/polis-math-shadow-start'];
    expect(start).toContain('set -a\n. /etc/polis-shadow/shadow.env\nset +a');
    expect(start).toContain('if [ "$MATH_ENV" != python-shadow ]');
    expect(start).toContain('if [ "$DATABASE_SSL_MODE" != require ]');
    expect(start).toContain('*@sha256:*');
    expect(start).toContain('!= arm64');
    expect(start).toContain('--memory 6g');
    expect(start).toContain('--log-driver awslogs');
    expect(start).not.toMatch(/DATABASE_URL|get-secret-value/);
  });
  test('the unit only starts when the run switch reads on', () => {
    expect(files['/etc/systemd/system/polis-math-shadow.service']).toContain('ExecCondition=/usr/local/bin/polis-math-shadow-enabled');
    expect(files['/usr/local/bin/polis-math-shadow-enabled']).toContain('[ "$value" = on ] && exit 0');
  });
  test('rendered files match the reviewed snapshot', () => {
    expect(files).toMatchSnapshot();
  });
});

const python = spawnSync('python3', ['--version']).status === 0;
(python ? describe : describe.skip)('launcher', () => {
  const launcher = path.join(__dirname, '..', 'lightShadow', 'launch.py');
  const base = { PATH: process.env.PATH ?? '', MATH_ENV: 'python-shadow', DATABASE_SSL_MODE: 'require',
    DB_SECRET_ARN: config.databaseSecretArn, DB_EXPECTED_HOST: config.databaseHost, AWS_REGION: 'us-east-1' };
  const run = (env: Record<string, string>, secret?: object) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-launch-'));
    // A stand-in boto3 that returns a fixed secret and records nothing.
    fs.writeFileSync(path.join(dir, 'boto3.py'), `import json
class _C:
    def get_secret_value(self, SecretId):
        return {"SecretString": json.dumps(${JSON.stringify(secret ?? {})})}
def client(*a, **k):
    return _C()
`);
    fs.writeFileSync(path.join(dir, 'probe.py'), `import os, runpy, sys
sys.path.insert(0, ${JSON.stringify(dir)})
os.execv = lambda exe, argv: (print("EXEC", argv[-1], os.environ["DATABASE_URL"].split("@")[1]), sys.exit(0))
runpy.run_path(${JSON.stringify(launcher)}, run_name="__main__")
`);
    return spawnSync('python3', [path.join(dir, 'probe.py')], { env, encoding: 'utf8' });
  };
  const good = { username: 'dbUser', password: 'Abc123xyz', host: config.databaseHost, port: 5432, dbname: 'polisdb' };
  test('refuses prod, other envs and a missing TLS mode before touching AWS', () => {
    for (const env of [{ ...base, MATH_ENV: 'prod' }, { ...base, MATH_ENV: 'python' }, { ...base, DATABASE_SSL_MODE: 'prefer' },
      { ...base, DATABASE_URL: 'postgresql://x' }]) {
      const r = run(env, good);
      expect(r.status).toBe(64);
      expect(r.stderr).toContain('refused');
    }
  });
  test('refuses a secret for another host or with characters the poller cannot parse, without echoing it', () => {
    let r = run(base, { ...good, host: 'other.abc.us-east-1.rds.amazonaws.com' });
    expect(r.status).toBe(64);
    r = run(base, { ...good, password: 'a@b' });
    expect(r.status).toBe(64);
    expect(r.stderr + r.stdout).not.toContain('a@b');
  });
  test('builds the URL in memory and hands over to the poller', () => {
    const r = run(base, good);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`EXEC /app/scripts/math_poller.py ${config.databaseHost}:5432/polisdb`);
    expect(r.stdout + r.stderr).not.toContain('Abc123xyz');
  });
});
