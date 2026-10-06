import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as path from 'path';

import { CdkStack } from '../lib/cdk-stack';
import {
  OPS_DASHBOARDS_CONTEXT,
  WEB_IMDS_HOP_LIMIT,
  opsDashboardsEnabled,
} from '../opsDashboards';

// The whole CdkStack, synthesized without bundling (the backup Lambda's
// package is built with pip at synth time; skipping it keeps the tests
// hermetic and does not change any resource this flag touches).
const synth = (context: Record<string, unknown> = {}) => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stack = new CdkStack(app, 'CdkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    envFile: path.join(__dirname, 'does-not-exist.env'),
  });
  return Template.fromStack(stack).toJSON() as { Resources: Record<string, any> };
};

const off = synth();
const on = synth({ [OPS_DASHBOARDS_CONTEXT]: 'true' });

const withoutHopLimit = (lt: any) => {
  const copy = JSON.parse(JSON.stringify(lt));
  delete copy.Properties.LaunchTemplateData.MetadataOptions;
  return copy;
};

const webLaunchTemplateId = (resources: Record<string, any>) => {
  const ids = Object.keys(resources).filter(
    (id) => id.startsWith('WebLaunchTemplate') && resources[id].Type === 'AWS::EC2::LaunchTemplate');
  expect(ids).toHaveLength(1);
  return ids[0];
};

describe(`${OPS_DASHBOARDS_CONTEXT} flag`, () => {
  const scope = (value?: unknown) => {
    const app = new cdk.App(value === undefined ? {} : { context: { [OPS_DASHBOARDS_CONTEXT]: value } });
    return new cdk.Stack(app, 'S');
  };
  test('defaults to off', () => expect(opsDashboardsEnabled(scope())).toBe(false));
  test('on for true and "true"', () => {
    expect(opsDashboardsEnabled(scope(true))).toBe(true);
    expect(opsDashboardsEnabled(scope('true'))).toBe(true);
  });
  test('anything else is off', () => {
    for (const v of ['yes', '1', 'false', false]) expect(opsDashboardsEnabled(scope(v))).toBe(false);
  });
});

describe('flag off', () => {
  test('explicit false synthesizes the same template as absent', () => {
    expect(synth({ [OPS_DASHBOARDS_CONTEXT]: 'false' })).toEqual(off);
  });

  test('the web launch template sets no metadata options', () => {
    const lt = off.Resources[webLaunchTemplateId(off.Resources)];
    expect(lt.Properties.LaunchTemplateData.MetadataOptions).toBeUndefined();
  });

  test('snapshot of every IAM policy and the web launch template', () => {
    const picked = Object.fromEntries(
      Object.entries(off.Resources).filter(([id, r]) =>
        r.Type === 'AWS::IAM::Policy' || id === webLaunchTemplateId(off.Resources)),
    );
    expect(picked).toMatchSnapshot();
  });
});

describe('flag on', () => {
  test('adds exactly one resource, the read-only policy, and changes only the web launch template', () => {
    const added = Object.keys(on.Resources).filter((id) => !(id in off.Resources));
    const removed = Object.keys(off.Resources).filter((id) => !(id in on.Resources));
    expect(removed).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^OpsDashboardsReadPolicy/);
    expect(on.Resources[added[0]].Type).toBe('AWS::IAM::Policy');

    const changed = Object.keys(off.Resources).filter(
      (id) => JSON.stringify(off.Resources[id]) !== JSON.stringify(on.Resources[id]));
    expect(changed).toEqual([webLaunchTemplateId(off.Resources)]);
    const id = changed[0];
    expect(withoutHopLimit(on.Resources[id])).toEqual(off.Resources[id]);
    expect(on.Resources[id].Properties.LaunchTemplateData.MetadataOptions).toEqual({
      HttpPutResponseHopLimit: WEB_IMDS_HOP_LIMIT,
    });
    expect(WEB_IMDS_HOP_LIMIT).toBe(2);
  });

  test('the policy is attached to InstanceRole only and grants exactly the read actions', () => {
    const t = Template.fromJSON(on);
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('^OpsDashboardsReadPolicy'),
      Roles: [{ Ref: Match.stringLikeRegexp('^InstanceRole') }],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'OpsDashboardsReadMetricsFleetCost',
            Effect: 'Allow',
            Action: [
              'cloudwatch:GetMetricData',
              'cloudwatch:ListMetrics',
              'autoscaling:DescribeAutoScalingGroups',
              'ce:GetCostAndUsage',
            ],
            Resource: '*',
          },
          {
            Sid: 'OpsDashboardsReadAlarms',
            Effect: 'Allow',
            Action: 'cloudwatch:DescribeAlarms',
            Resource: {
              'Fn::Join': ['', [
                'arn:', { Ref: 'AWS::Partition' }, ':cloudwatch:', { Ref: 'AWS::Region' }, ':',
                { Ref: 'AWS::AccountId' }, ':alarm:Polis-*',
              ]],
            },
          },
          {
            Sid: 'OpsDashboardsReadDeployments',
            Effect: 'Allow',
            Action: ['codedeploy:ListDeployments', 'codedeploy:BatchGetDeployments'],
            Resource: {
              'Fn::Join': ['', [
                'arn:', { Ref: 'AWS::Partition' }, ':codedeploy:', { Ref: 'AWS::Region' }, ':',
                { Ref: 'AWS::AccountId' }, ':deploymentgroup:',
                { Ref: Match.stringLikeRegexp('^CodeDeployApplication') }, '/',
                { Ref: Match.stringLikeRegexp('^DeploymentGroup') },
              ]],
            },
          },
        ],
      },
    });
  });

  test('the CodeDeploy statement is scoped to the Polis deployment group', () => {
    const policy = Object.entries(on.Resources).find(([id]) => id.startsWith('OpsDashboardsReadPolicy'))![1];
    const deploy = policy.Properties.PolicyDocument.Statement.find((s: any) => s.Sid === 'OpsDashboardsReadDeployments');
    const resource = JSON.stringify(deploy.Resource);
    expect(resource).toContain(':codedeploy:');
    expect(resource).toContain(':deploymentgroup:');
    expect(resource).toContain('CodeDeployApplication');
    expect(resource).toContain('AWS::AccountId');
    expect(resource).toContain('DeploymentGroup');
    expect(resource).not.toContain('*');
  });

  test('nothing writes and no Lambda is added', () => {
    const policy = Object.entries(on.Resources).find(([id]) => id.startsWith('OpsDashboardsReadPolicy'))![1];
    const actions = policy.Properties.PolicyDocument.Statement.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action]);
    expect(actions.sort()).toEqual([
      'autoscaling:DescribeAutoScalingGroups',
      'ce:GetCostAndUsage',
      'cloudwatch:DescribeAlarms',
      'cloudwatch:GetMetricData',
      'cloudwatch:ListMetrics',
      'codedeploy:BatchGetDeployments',
      'codedeploy:ListDeployments',
    ]);
    for (const a of actions) expect(a).toMatch(/:(Get|List|Describe|BatchGet)/);
    const lambdas = (r: Record<string, any>) => Object.values(r).filter((x) => x.Type === 'AWS::Lambda::Function').length;
    expect(lambdas(on.Resources)).toBe(lambdas(off.Resources));
  });

  test('the template carries no literal account id', () => {
    const policy = Object.entries(on.Resources).find(([id]) => id.startsWith('OpsDashboardsReadPolicy'))![1];
    expect(JSON.stringify(policy)).not.toContain('123456789012');
  });
});
