import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import createDelphiDemandObserver, {
  DELPHI_QUEUE_METRIC_NAMESPACE,
  delphiDemandObserverEnabled,
} from '../delphiDemandObserver';

const synth = () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  createDelphiDemandObserver(stack);
  return Template.fromStack(stack);
};

describe('enableDelphiDemandObserver context flag', () => {
  const enabledWith = (value: unknown) => {
    const app = new cdk.App(
      value === undefined ? {} : { context: { enableDelphiDemandObserver: value } },
    );
    return delphiDemandObserverEnabled(new cdk.Stack(app, 'S'));
  };

  test('defaults to off when the flag is absent', () => {
    expect(enabledWith(undefined)).toBe(false);
  });

  test('accepts the string the CLI passes for -c flag=true', () => {
    expect(enabledWith('true')).toBe(true);
    expect(enabledWith('TRUE')).toBe(true);
    expect(enabledWith(true)).toBe(true);
  });

  test('anything else is off', () => {
    expect(enabledWith('false')).toBe(false);
    expect(enabledWith('1')).toBe(false);
    expect(enabledWith('yes')).toBe(false);
    expect(enabledWith(null)).toBe(false);
  });
});

describe('observer resources', () => {
  test('runs on a one-minute schedule with no overlapping invocations', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      State: 'ENABLED',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Handler: 'index.lambda_handler',
      ReservedConcurrentExecutions: 1,
    });
  });

  test('runs outside the VPC', () => {
    // DynamoDB-backed in /1, so no private connectivity and no NAT cost.
    const fns = synth().findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      expect((fn as any).Properties.VpcConfig).toBeUndefined();
    }
  });

  test('bounds the scan by pre-projection bytes, not by row count', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DELPHI_QUEUE_TABLE: 'Delphi_JobQueue',
          MAX_SCAN_BYTES: '16777216',
        }),
      },
    });
  });
});

const toArray = (value: any): string[] =>
  Array.isArray(value) ? value : [value];

describe('observer IAM role', () => {
  const statements = () => {
    const policies = synth().findResources('AWS::IAM::Policy');
    return Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement as any[],
    );
  };

  test('PutMetricData is constrained by the cloudwatch:namespace condition', () => {
    // PutMetricData supports no resource-level permissions, so Resource '*'
    // is unavoidable; the namespace condition is the only real constraint.
    const metric = statements().filter((s) =>
      toArray(s.Action).includes('cloudwatch:PutMetricData'),
    );
    expect(metric).toHaveLength(1);
    expect(metric[0].Resource).toEqual('*');
    expect(metric[0].Condition).toEqual({
      StringEquals: { 'cloudwatch:namespace': DELPHI_QUEUE_METRIC_NAMESPACE },
    });
  });

  test('DynamoDB access is Scan on the one table, with no index access', () => {
    const ddb = statements().filter((s) =>
      toArray(s.Action).some((a) => a.startsWith('dynamodb:')),
    );
    expect(ddb).toHaveLength(1);
    expect(ddb[0].Action).toEqual('dynamodb:Scan');
    expect(JSON.stringify(ddb[0].Resource)).toContain('table/Delphi_JobQueue');
    expect(JSON.stringify(ddb[0].Resource)).not.toContain('index');
    expect(JSON.stringify(ddb[0].Resource)).not.toContain('Delphi_*');
  });

  test('grants no autoscaling permission of any kind', () => {
    // S1 is observe-only. SetDesiredCapacity arrives at S7, ASG-scoped.
    const actions = statements().flatMap((s) => toArray(s.Action));
    expect(actions.filter((a) => a.startsWith('autoscaling:'))).toEqual([]);
    expect(actions.filter((a) => a.startsWith('ec2:'))).toEqual([]);
  });

  test('grants no queue writes and no secrets access', () => {
    const actions = statements().flatMap((s) => toArray(s.Action));
    for (const forbidden of [
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'secretsmanager:GetSecretValue',
    ]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  test('log writes are scoped to its own log group', () => {
    const logStatements = statements().filter((s) =>
      toArray(s.Action).some((a) => a.startsWith('logs:')),
    );
    expect(logStatements).toHaveLength(1);
    expect(logStatements[0].Action.sort()).toEqual([
      'logs:CreateLogStream',
      'logs:PutLogEvents',
    ]);
    // Resolves to the observer's own log group, not a wildcard.
    const resource = JSON.stringify(logStatements[0].Resource);
    expect(resource).toContain('DelphiDemandObserverLogGroup');
    expect(resource).not.toContain('log-group:*');
    synth().hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/polis-delphi-demand-observer',
    });
  });

  test('attaches no AWS managed policies', () => {
    const roles = synth().findResources('AWS::IAM::Role');
    for (const role of Object.values(roles)) {
      expect((role as any).Properties.ManagedPolicyArns ?? []).toEqual([]);
    }
  });
});

describe('the observer never touches the ASG', () => {
  test('synthesizes no autoscaling resources at all', () => {
    // Review item G2: removing DesiredCapacity from the template defaults it
    // to MinSize on the update. S1 must not go near the ASG.
    const template = synth();
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 0);
    template.resourceCountIs('AWS::AutoScaling::ScalingPolicy', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });
});
