import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkStack } from '../lib/cdk-stack';

// The shared InstanceRole (web, math worker, Delphi small, Delphi large with
// the worker classes off, Ollama) reads exactly the secrets its boxes use,
// read-only, by name: no SecretsManagerReadWrite, no secretsmanager:* on *.
const synth = (context: Record<string, unknown> = {}) => {
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [], enableCiEc2: true, ...context },
  });
  const stack = new CdkStack(app, 'CdkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    envFile: '/dev/null',
    enableSSHAccess: false,
    enableOllama: false,
  });
  return Template.fromStack(stack).toJSON().Resources as Record<string, any>;
};

const roleId = (r: Record<string, any>) =>
  Object.keys(r).find((id) => /^InstanceRole[0-9A-F]{8}$/.test(id) && r[id].Type === 'AWS::IAM::Role')!;

const statementsOf = (r: Record<string, any>, role: string) =>
  Object.values(r)
    .filter((x: any) => x.Type === 'AWS::IAM::Policy'
      && (x.Properties.Roles ?? []).some((ref: any) => ref.Ref === role))
    .flatMap((x: any) => x.Properties.PolicyDocument.Statement);

const actions = (s: any): string[] => [].concat(s.Action);

describe.each([
  ['default', {}],
  ['enableLargeClass', { enableLargeClass: 'true' }],
  ['enableOpsDashboards', { enableOpsDashboards: 'true' }],
])('the shared InstanceRole (%s)', (_name, context) => {
  const r = synth(context);
  const role = roleId(r);

  test('carries no Secrets Manager managed policy', () => {
    const managed = JSON.stringify(r[role].Properties.ManagedPolicyArns);
    expect(managed).not.toContain('SecretsManager');
    expect(managed).toContain('AmazonSSMManagedInstanceCore');      // SSM parameters, unchanged
  });

  test('reads exactly the named secrets, read-only', () => {
    const secretStatements = statementsOf(r, role)
      .filter((s: any) => actions(s).some((a) => a.startsWith('secretsmanager:')));
    for (const s of secretStatements) {
      expect(s.Effect).toBe('Allow');
      expect(actions(s).sort()).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
      expect(JSON.stringify(s.Resource)).not.toContain('"*"');
    }
    const resources = secretStatements.flatMap((s: any) => [].concat(s.Resource))
      .map((x: any) => x.Ref.replace(/[0-9A-F]{8}$/, '')).sort();
    expect(resources).toEqual([
      'ClientAdminEnvVarsSecret',          // polis-client-admin-env-vars (granted before; kept)
      'ClientReportEnvVarsSecret',         // polis-client-report-env-vars (granted before; kept)
      'DatabaseSecretAttachment',          // the DB secret: after_install.sh, by /polis/db-secret-arn
      'WebAppEnvVarsSecret',               // polis-web-app-env-vars: after_install.sh, the app .env
    ]);
  });
});
