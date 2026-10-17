import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkStack } from '../lib/cdk-stack';
import { BUILD_BOX_INSTANCE_TYPES, BUILD_BOX_TAG_KEY, BUILD_BOX_TAG_VALUE } from '../buildBox';

// The production stack as deployed (`-c enableCiEc2=true`), with or without
// `-c enableBuildBox=true`. Bundling is skipped as in workerClasses.test.ts.
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

const only = (resources: Record<string, any>, type: string, prefix: string) => {
  const found = Object.entries(resources).filter(([id, r]) => r.Type === type && id.startsWith(prefix));
  expect(found).toHaveLength(1);
  return found[0][1].Properties;
};

const statements = (policy: any) =>
  (policy.PolicyDocument.Statement as any[]).map((s) => ({
    ...s,
    Action: ([] as string[]).concat(s.Action),
  }));

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy-alpha-aws.yml'), 'utf8');
const workflowEnv = (name: string) => {
  const match = workflow.match(new RegExp(`^  ${name}: (.+)$`, 'm'));
  expect(match).not.toBeNull();
  return match![1].trim();
};

describe('enableBuildBox off', () => {
  test('adds nothing', () => {
    expect(Object.keys(synth()).filter((id) => id.startsWith('BuildBox'))).toEqual([]);
  });
});

describe('enableBuildBox on', () => {
  const resources = synth({ enableBuildBox: true });
  const deployRole = only(resources, 'AWS::IAM::Role', 'BuildBoxGithubDeployRole');
  const deployPolicy = statements(only(resources, 'AWS::IAM::Policy', 'BuildBoxGithubDeployRole'));
  const boxPolicy = statements(only(resources, 'AWS::IAM::Policy', 'BuildBoxBoxRole'));
  const template = only(resources, 'AWS::EC2::LaunchTemplate', 'BuildBoxLaunchTemplate');

  test('only the deploy workflow on stable, in the production environment, can assume the deploy role', () => {
    const trust = deployRole.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(trust[0].Condition.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:compdemocracy/polis:environment:production',
      'token.actions.githubusercontent.com:ref': ['refs/heads/stable'],
      'token.actions.githubusercontent.com:repository': 'compdemocracy/polis',
    });
  });

  test('the deploy role terminates and commands only build boxes, and tags only at launch', () => {
    const tagged = { [`ec2:ResourceTag/${BUILD_BOX_TAG_KEY}`]: BUILD_BOX_TAG_VALUE };
    const terminate = deployPolicy.filter((s) => s.Action.includes('ec2:TerminateInstances'));
    expect(terminate).toHaveLength(1);
    expect(terminate[0].Condition).toEqual({ StringEquals: tagged });
    const command = deployPolicy.filter((s) => s.Action.includes('ssm:SendCommand') &&
      JSON.stringify(s.Resource).includes(':instance/'));
    expect(command).toHaveLength(1);
    expect(command[0].Condition).toEqual({
      StringEquals: { [`ssm:resourceTag/${BUILD_BOX_TAG_KEY}`]: BUILD_BOX_TAG_VALUE },
    });
    const tags = deployPolicy.filter((s) => s.Action.includes('ec2:CreateTags'));
    expect(tags).toHaveLength(1);
    expect(tags[0].Condition.StringEquals['ec2:CreateAction']).toBe('RunInstances');
    expect(tags[0].Condition.StringEquals[`aws:RequestTag/${BUILD_BOX_TAG_KEY}`]).toBe(BUILD_BOX_TAG_VALUE);
    const launch = deployPolicy.filter((s) => s.Action.includes('ec2:RunInstances') &&
      JSON.stringify(s.Resource).includes(':instance/'));
    expect(launch).toHaveLength(1);
    expect(Object.keys(launch[0].Condition.ArnEquals).sort()).toEqual(['ec2:InstanceProfile', 'ec2:LaunchTemplate']);
  });

  test('the build box reads no secrets and accepts no connections', () => {
    expect(boxPolicy.flatMap((s) => s.Action).filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
    const group = only(resources, 'AWS::EC2::SecurityGroup', 'BuildBoxBoxSg');
    expect(group.SecurityGroupIngress).toBeUndefined();
    expect(template.LaunchTemplateData.MetadataOptions.HttpTokens).toBe('required');
    expect(template.LaunchTemplateData.InstanceInitiatedShutdownBehavior).toBe('terminate');
  });

  test('the names the deploy workflow hard-codes are the ones the stack creates', () => {
    expect(workflowEnv('DEPLOY_ROLE_ARN')).toBe(`arn:aws:iam::050917022930:role/${deployRole.RoleName}`);
    expect(workflowEnv('BUILD_BOX_TEMPLATE')).toBe(template.LaunchTemplateName);
    expect(workflowEnv('BUILD_BOX_TYPES').split(/\s+/)).toEqual(BUILD_BOX_INSTANCE_TYPES);
  });
});
