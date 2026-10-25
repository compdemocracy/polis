import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { COORDINATOR_INACTIVE_CONTEXT, CoordinatorInactiveService, coordinatorInactiveEnabled } from '../coordinator';
import { CdkStack } from '../lib/cdk-stack';

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

// The whole production stack, synthesized the way it is deployed
// (`-c enableCiEc2=true -c enableBuildBox=true`), without asset bundling
// so the tests stay hermetic.
describe(`${COORDINATOR_INACTIVE_CONTEXT} flag`, () => {
  const synth = (context: Record<string, unknown> = {}) => {
    const app = new cdk.App({
      context: { 'aws:cdk:bundling-stacks': [], enableCiEc2: true, enableBuildBox: true, ...context },
    });
    const stack = new CdkStack(app, 'CdkStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      envFile: '/dev/null',
      enableSSHAccess: false,
      enableOllama: false,
    });
    return Template.fromStack(stack).toJSON() as Record<string, any>;
  };
  const P = 'CoordinatorInactive';
  const stem = (id: string) => id.replace(/[0-9A-F]{8}$/, '');
  const off = synth();
  const on = synth({ [COORDINATOR_INACTIVE_CONTEXT]: true });

  test('defaults to off; only true or "true" in any letter case turns it on', () => {
    const scope = (value?: unknown) =>
      new cdk.Stack(new cdk.App(value === undefined ? {} : { context: { [COORDINATOR_INACTIVE_CONTEXT]: value } }), 'S');
    expect(coordinatorInactiveEnabled(scope())).toBe(false);
    expect(coordinatorInactiveEnabled(scope(true))).toBe(true);
    for (const v of ['true', 'TRUE', 'True']) expect(coordinatorInactiveEnabled(scope(v))).toBe(true);
    for (const v of ['yes', '1', 'false', false]) expect(coordinatorInactiveEnabled(scope(v))).toBe(false);
  });

  test('flag off: no coordinator resource, parameter, output, DependsOn entry or database ingress', () => {
    expect(JSON.stringify(off)).not.toContain(P);
    expect(JSON.stringify(off)).not.toContain('polis/coordinator');
    expect(Object.keys(off.Parameters).sort()).toEqual([
      'BootstrapVersion',
      'SsmParameterValueawsserviceamiamazonlinuxlatestal2023amikernel61arm64C96584B6F00A464EAD1953AFF4B05118Parameter',
      'SsmParameterValueawsserviceamiamazonlinuxlatestal2023amikernel61x8664C96584B6F00A464EAD1953AFF4B05118Parameter',
    ]);
    for (const parameter of Object.values(off.Parameters)) {
      expect(parameter).toHaveProperty('Default');
    }
  });

  test('an explicit false synthesizes the same template as no flag', () => {
    expect(synth({ [COORDINATOR_INACTIVE_CONTEXT]: 'false' })).toEqual(off);
  });

  test('flag on adds exactly the coordinator and its database ingress rule', () => {
    const added = Object.keys(on.Resources).filter((id) => !(id in off.Resources))
      .map((id) => `${on.Resources[id].Type} ${stem(id)}`).sort();
    expect(Object.keys(off.Resources).filter((id) => !(id in on.Resources))).toEqual([]);
    expect(added).toEqual([
      'AWS::EC2::SecurityGroup CoordinatorInactiveSecurityGroup',
      'AWS::EC2::SecurityGroupEgress CoordinatorInactiveSecurityGrouptoCdkStackDatabaseSecurityGroup606AD3425432',
      'AWS::EC2::SecurityGroupIngress DatabaseSecurityGroupfromCdkStackCoordinatorInactiveSecurityGroup6F94BCBC5432',
      'AWS::ECR::Repository CoordinatorInactiveRepository',
      'AWS::ECS::Cluster CoordinatorInactiveCluster',
      'AWS::ECS::Service CoordinatorInactiveService',
      'AWS::ECS::TaskDefinition CoordinatorInactiveTask',
      'AWS::IAM::Policy CoordinatorInactiveTaskExecutionRoleDefaultPolicy',
      'AWS::IAM::Role CoordinatorInactiveTaskExecutionRole',
      'AWS::IAM::Role CoordinatorInactiveTaskTaskRole',
      'AWS::Logs::LogGroup CoordinatorInactiveLogs',
    ]);
    expect(Object.keys(on.Parameters).filter((k) => !(k in off.Parameters)).sort()).toEqual([
      'CoordinatorInactiveDesiredCount', 'CoordinatorInactiveImageDigest', 'CoordinatorInactiveLoginSecretArn',
    ]);
    expect(Object.keys(on.Outputs ?? {}).filter((k) => !(k in (off.Outputs ?? {}))).map(stem))
      .toEqual(['CoordinatorInactiveImageRepository']);
  });

  test('flag on changes existing resources only by the database ingress DependsOn entry', () => {
    const changed = Object.keys(off.Resources)
      .filter((id) => JSON.stringify(off.Resources[id]) !== JSON.stringify(on.Resources[id]));
    expect(changed.length).toBe(8);
    for (const id of changed) {
      const r = on.Resources[id];
      expect(r.Type).toMatch(/^AWS::AutoScaling::(AutoScalingGroup|ScalingPolicy)$/);
      const extra = r.DependsOn.filter((d: string) => !off.Resources[id].DependsOn.includes(d));
      expect(extra.map(stem)).toEqual(['DatabaseSecurityGroupfromCdkStackCoordinatorInactiveSecurityGroup6F94BCBC5432']);
      expect({ ...r, DependsOn: r.DependsOn.filter((d: string) => !d.includes(P)) }).toEqual(off.Resources[id]);
    }
  });
});
