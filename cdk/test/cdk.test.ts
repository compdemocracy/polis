import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CoordinatorInactiveService } from '../coordinator';

function template() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Fixture', { env: { account: '000000000000', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const database = new rds.DatabaseInstance(stack, 'Database', {
    vpc, engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
  });
  new CoordinatorInactiveService(stack, 'CoordinatorInactive', { vpc, database });
  return Template.fromStack(stack);
}

test('idle service is present on ARM64 with desired count default zero', () => {
  const t = template();
  t.hasParameter('CoordinatorInactiveDesiredCount', { Default: 0, AllowedValues: ['0', '1'] });
  t.hasResourceProperties('AWS::ECS::Service', { DesiredCount: { Ref: 'CoordinatorInactiveDesiredCount' }, EnableExecuteCommand: false });
  t.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '256', Memory: '512', RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      ReadonlyRootFilesystem: true, User: '10001:10001',
      Environment: Match.arrayWith([
        { Name: 'COORDINATOR_DB_PASSWORD_FILE', Value: '/run/coordinator/password' },
        { Name: 'COORDINATOR_MODE', Value: 'inactive' },
        { Name: 'COORDINATOR_WRITER_ENABLED', Value: 'false' },
        { Name: 'P026_RESERVATION_BYTES', Value: '0' },
      ]),
    })]),
  });
});

test('password is a secret reference and image uses a digest', () => {
  const t = template();
  const task = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0] as any;
  const c = task.Properties.ContainerDefinitions[0];
  expect(c.Secrets.map((s: any) => s.Name).sort()).toEqual(['COORDINATOR_BOOTSTRAP_PASSWORD', 'COORDINATOR_BOOTSTRAP_USERNAME']);
  expect(JSON.stringify(c.Image)).toContain('@');
  expect(JSON.stringify(c.Image)).toContain('CoordinatorInactiveImageDigest');
  const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
  expect(JSON.stringify(env.DATABASE_URL)).toContain('postgresql://polis_coordinator_observer_login@');
  expect(JSON.stringify(env.DATABASE_URL)).not.toContain('password');
  expect(JSON.stringify(env.COORDINATOR_DB_HOST_ALLOWLIST)).toContain('Endpoint.Address');
  expect(env.COORDINATOR_DB_CA_BUNDLE).toBe('/etc/polis/rds-ca.pem');
});

test('no Lambda, administrator-secret access or writer policy is introduced', () => {
  const t = template();
  t.resourceCountIs('AWS::Lambda::Function', 0);
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  expect(policies).toContain('CoordinatorInactiveLoginSecretArn');
  expect(policies).not.toContain('rds-db:connect');
  expect(policies).not.toContain('ssm:');
  expect(policies).not.toContain('DatabaseSecret');
  expect(JSON.stringify(t.toJSON())).not.toContain('polis_coordinator_writer_authority');
});
