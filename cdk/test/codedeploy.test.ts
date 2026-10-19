import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkStack } from '../lib/cdk-stack';

// The production stack as deployed (`-c enableCiEc2=true -c enableBuildBox=true`).
// Bundling is skipped as in workerClasses.test.ts.
const synth = () => {
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [], enableCiEc2: true, enableBuildBox: true },
  });
  const stack = new CdkStack(app, 'CdkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    envFile: '/dev/null',
    enableSSHAccess: false,
    enableOllama: false,
  });
  return Template.fromStack(stack).toJSON().Resources as Record<string, any>;
};

const resources = synth();
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
const refs = (list: any[] | undefined) => (list ?? []).map((v) => v.Ref as string);

// A Ref to a CodeDeploy application or deployment group returns its name.
const resolve = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value.Ref === 'AWS::Partition') return 'aws';
  if (value.Ref && resources[value.Ref]) {
    const p = resources[value.Ref].Properties;
    return p.DeploymentGroupName ?? p.ApplicationName;
  }
  if (value['Fn::Join']) return value['Fn::Join'][1].map(resolve).join(value['Fn::Join'][0]);
  throw new Error(`cannot resolve ${JSON.stringify(value)}`);
};

const groups = Object.fromEntries(ofType('AWS::CodeDeploy::DeploymentGroup')
  .map(([, r]) => [r.Properties.DeploymentGroupName as string, r.Properties]));
const web = groups.PolisDeploymentGroup;
const workers = groups.PolisWorkersDeploymentGroup;
const asgIds = ofType('AWS::AutoScaling::AutoScalingGroup').map(([id]) => id);

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy-alpha-aws.yml'), 'utf8');
const workflowArgs = (flag: string) => [...workflow.matchAll(new RegExp(`${flag} (\\S+)`, 'g'))].map((m) => m[1]);

describe('deployment groups', () => {
  test('there are exactly two: the web group and the worker tiers\' group', () => {
    expect(Object.keys(groups).sort()).toEqual(['PolisDeploymentGroup', 'PolisWorkersDeploymentGroup']);
    for (const group of [web, workers]) {
      expect(group.DeploymentConfigName).toBe('CodeDeployDefault.OneAtATime');
      expect(group.ApplicationName).toEqual(web.ApplicationName);
      expect(group.ServiceRoleArn).toEqual(web.ServiceRoleArn);
    }
  });

  test('every Auto Scaling group deploys through exactly one of them', () => {
    const deployed = [...refs(web.AutoScalingGroups), ...refs(workers.AutoScalingGroups)];
    expect([...deployed].sort()).toEqual([...asgIds].sort());
    expect(new Set(deployed).size).toBe(deployed.length);
  });

  test('the web group holds only the web boxes and drains them through the web target group', () => {
    expect(web.DeploymentStyle).toEqual({ DeploymentOption: 'WITH_TRAFFIC_CONTROL' });
    const named = web.LoadBalancerInfo.TargetGroupInfoList;
    expect(named).toHaveLength(1);
    const [targetGroupId, attribute] = named[0].Name['Fn::GetAtt'];
    expect(attribute).toBe('TargetGroupName');
    // CodeDeploy registers every instance of the group with this target group,
    // so the group must hold exactly the boxes the target group serves.
    const served = asgIds.filter((id) => refs(resources[id].Properties.TargetGroupARNs).includes(targetGroupId));
    expect(served).toHaveLength(1);
    expect(refs(web.AutoScalingGroups)).toEqual(served);
    const target = resources[targetGroupId].Properties;
    expect(target.HealthCheckPath).toBe('/api/v3/testConnection');
    expect([target.HealthCheckIntervalSeconds, target.HealthCheckTimeoutSeconds,
      target.HealthyThresholdCount, target.UnhealthyThresholdCount]).toEqual([10, 5, 2, 3]);
    expect(target.TargetGroupAttributes).toContainEqual({ Key: 'deregistration_delay.timeout_seconds', Value: '60' });
  });

  test('the worker group holds the math and Delphi boxes behind no load balancer', () => {
    expect(workers.LoadBalancerInfo).toBeUndefined();
    expect(workers.DeploymentStyle).toBeUndefined();
    const held = refs(workers.AutoScalingGroups);
    expect(held.map((id) => id.replace(/ASG[0-9A-F]{8}$/, '')).sort())
      .toEqual(['AsgDelphiLarge', 'AsgDelphiSmall', 'AsgMathWorker']);
    for (const id of held) expect(resources[id].Properties.TargetGroupARNs).toBeUndefined();
  });
});

describe('the deploy workflow', () => {
  const deployPolicy = ofType('AWS::IAM::Policy').filter(([id]) => id.startsWith('BuildBoxGithubDeployRole'));
  const grants = deployPolicy.flatMap(([, r]) => r.Properties.PolicyDocument.Statement as any[])
    .filter((s) => ([] as string[]).concat(s.Action).includes('codedeploy:CreateDeployment'));
  const groupArn = (name: string) =>
    `arn:aws:codedeploy:us-east-1:123456789012:deploymentgroup:PolisApplication/${name}`;

  test('creates one deployment in each group, in the application the stack creates', () => {
    expect(workflowArgs('aws deploy')).toEqual(['create-deployment', 'create-deployment']);
    expect(workflowArgs('--deployment-group-name')).toEqual(['PolisDeploymentGroup', 'PolisWorkersDeploymentGroup']);
    expect(workflowArgs('--application-name')).toEqual(['PolisApplication', 'PolisApplication']);
    expect(resolve(web.ApplicationName)).toBe('PolisApplication');
  });

  test('its role may create and read a deployment in exactly those two groups, by exact ARN', () => {
    expect(deployPolicy).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(([] as string[]).concat(grants[0].Action).sort())
      .toEqual(['codedeploy:CreateDeployment', 'codedeploy:GetDeployment']);
    const allowed = ([] as any[]).concat(grants[0].Resource).map(resolve);
    expect(allowed.sort()).toEqual(workflowArgs('--deployment-group-name').map(groupArn).sort());
    expect(allowed.join(' ')).not.toContain('*');
  });
});
