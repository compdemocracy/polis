import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkStack } from '../lib/cdk-stack';
import {
  CAPACITY_NAMESPACE, DEMAND_UNMET_ALARM_NAME, LARGE_BUSY_METRIC, LARGE_CLASS_CONTEXT, LARGE_DEMAND_METRIC,
  LARGE_SERVICE_TYPE, LONG_RUNNING_ALARM_NAME, OLDEST_UNRESOLVED_METRIC, PENDING_PROMOTION_METRIC,
  SCALE_IN_ALARM_NAME, SCALE_OUT_ALARM_NAME, capacityFilter, largeClassEnabled,
} from '../largeClass';
import { HEARTBEAT_PHRASE, STALE_PHRASES } from '../mathPollerAlarms';

// The whole production stack, synthesized the way it is deployed
// (`-c enableCiEc2=true`). Asset bundling is skipped so no Docker is needed.
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
  return Template.fromStack(stack);
};

describe('enableLargeClass off', () => {
  // The snapshot was recorded on the base commit, before the large class
  // existed: a flag-off synth must stay byte-identical to it.
  test('the stack template is unchanged', () => {
    expect(synth().toJSON()).toMatchSnapshot();
  });
});

describe(`${LARGE_CLASS_CONTEXT} flag`, () => {
  const scope = (value?: unknown) => {
    const app = new cdk.App(value === undefined ? {} : { context: { [LARGE_CLASS_CONTEXT]: value } });
    return new cdk.Stack(app, 'S');
  };
  test('defaults to off; only true and "true" turn it on', () => {
    expect(largeClassEnabled(scope())).toBe(false);
    expect(largeClassEnabled(scope(true))).toBe(true);
    expect(largeClassEnabled(scope('true'))).toBe(true);
    for (const v of ['yes', '1', 'false', false]) expect(largeClassEnabled(scope(v))).toBe(false);
  });
  test('an explicit false synthesizes the same template as no flag', () => {
    expect(synth({ [LARGE_CLASS_CONTEXT]: 'false' }).toJSON()).toEqual(synth().toJSON());
  });
});

describe('enableLargeClass on', () => {
  const t = synth({ [LARGE_CLASS_CONTEXT]: true });
  const json = t.toJSON();
  const resources = json.Resources as Record<string, any>;
  const byType = (type: string) =>
    Object.entries(resources).filter(([, r]) => r.Type === type) as [string, any][];
  const one = (type: string, prefix: string) => {
    const hits = byType(type).filter(([id]) => id.startsWith(prefix));
    expect(hits).toHaveLength(1);
    return hits[0][1];
  };
  const asgId = Object.keys(resources).find((id) => id.startsWith('AsgDelphiLargeASG'))!;
  const asg = resources[asgId];
  const lt = one('AWS::EC2::LaunchTemplate', 'DelphiLargeLaunchTemplate');
  const userData = JSON.stringify(lt.Properties.LaunchTemplateData.UserData);

  test('no Lambda, no custom resource and no new bucket', () => {
    const off = synth().toJSON().Resources as Record<string, any>;
    const count = (r: Record<string, any>, pred: (type: string) => boolean) =>
      Object.values(r).filter((x: any) => pred(x.Type)).length;
    const lambdaOrCustom = (type: string) =>
      type === 'AWS::Lambda::Function' || type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource';
    expect(count(resources, lambdaOrCustom)).toBe(count(off, lambdaOrCustom));
    expect(count(resources, (type) => type === 'AWS::S3::Bucket')).toBe(count(off, (type) => type === 'AWS::S3::Bucket'));
  });

  test('the large template writes service type delphi-large on an r7i.2xlarge with its own role', () => {
    expect(userData).toContain(`echo \\"${LARGE_SERVICE_TYPE}\\" | sudo tee /etc/app-info/service_type.txt`);
    expect(userData).toContain(`\\"awslogs-stream\\": \\"${LARGE_SERVICE_TYPE}\\"`);
    expect(userData).not.toContain('instance_size.txt');
    expect(lt.Properties.LaunchTemplateData.InstanceType).toBe('r7i.2xlarge');
    const profile = one('AWS::IAM::InstanceProfile', 'DelphiLargeLaunchTemplateProfile');
    expect(profile.Properties.Roles).toEqual([{ Ref: expect.stringMatching(/^DelphiLargeInstanceRole/) }]);
  });

  test('the group is 0..1 with no desired count, collects in-service, and is in the deployment group', () => {
    expect(asg.Properties.MinSize).toBe('0');
    expect(asg.Properties.MaxSize).toBe('1');
    expect(asg.Properties.DesiredCapacity).toBeUndefined();
    expect(asg.Properties.MetricsCollection).toEqual([
      { Granularity: '1Minute', Metrics: ['GroupInServiceInstances'] },
    ]);
    const dg = one('AWS::CodeDeploy::DeploymentGroup', 'DeploymentGroup');
    expect(dg.Properties.AutoScalingGroups).toContainEqual({ Ref: asgId });
  });

  test('exactly two step policies on the group, both exact capacity, and no CPU tracking', () => {
    const policies = byType('AWS::AutoScaling::ScalingPolicy')
      .filter(([, p]) => p.Properties.AutoScalingGroupName.Ref === asgId);
    expect(policies).toHaveLength(2);
    for (const [, p] of policies) {
      expect(p.Properties.PolicyType).toBe('StepScaling');
      expect(p.Properties.AdjustmentType).toBe('ExactCapacity');
    }
    const steps = policies.map(([, p]) => p.Properties.StepAdjustments).sort((a, b) =>
      a[0].ScalingAdjustment - b[0].ScalingAdjustment);
    expect(steps).toEqual([
      [{ MetricIntervalUpperBound: 0, ScalingAdjustment: 0 }],
      [{ MetricIntervalLowerBound: 0, ScalingAdjustment: 1 }],
    ]);
  });

  test('four capacity filters with the bare JSON patterns and no default value', () => {
    const filters = byType('AWS::Logs::MetricFilter')
      .filter(([, f]) => f.Properties.MetricTransformations[0].MetricNamespace === CAPACITY_NAMESPACE);
    const got = Object.fromEntries(filters.map(([, f]) => {
      const m = f.Properties.MetricTransformations[0];
      expect(m.DefaultValue).toBeUndefined();
      expect(f.Properties.LogGroupName).toEqual({ Ref: expect.stringMatching(/^LogGroup/) });
      return [m.MetricName, [f.Properties.FilterPattern, m.MetricValue]];
    }));
    const small = '{ $.schema = "math_poller.capacity/1" && $.class = "small" && $.role = "primary" }';
    const large = '{ $.schema = "math_poller.capacity/1" && $.class = "large" && $.role = "primary" }';
    expect(got).toEqual({
      [LARGE_DEMAND_METRIC]: [small, '$.large_demand'],
      [PENDING_PROMOTION_METRIC]: [small, '$.pending_promotion'],
      [OLDEST_UNRESOLVED_METRIC]: [small, '$.oldest_unresolved_age_ms'],
      [LARGE_BUSY_METRIC]: [large, '$.busy'],
    });
    expect(capacityFilter('small')).toBe(small);
  });

  const alarm = (name: string) => {
    const hits = byType('AWS::CloudWatch::Alarm').filter(([, a]) => a.Properties.AlarmName === name);
    expect(hits).toHaveLength(1);
    return hits[0][1].Properties;
  };
  const policyRef = (adjustment: number) => {
    const [id] = byType('AWS::AutoScaling::ScalingPolicy').find(([, p]) =>
      p.Properties.AutoScalingGroupName.Ref === asgId &&
      p.Properties.StepAdjustments[0].ScalingAdjustment === adjustment)!;
    return { Ref: id };
  };

  test('scale-out reads large_demand only and drives the exact-capacity-1 policy', () => {
    const a = alarm(SCALE_OUT_ALARM_NAME);
    expect(a).toMatchObject({
      MetricName: LARGE_DEMAND_METRIC, Namespace: CAPACITY_NAMESPACE, Statistic: 'Maximum', Period: 300,
      Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 2, DatapointsToAlarm: 2, TreatMissingData: 'notBreaching',
    });
    expect(a.AlarmActions).toEqual([policyRef(1)]);
    expect(a.OKActions).toBeUndefined();
  });

  test('scale-in needs large busy = 0 and no demand, and drives the exact-capacity-0 policy', () => {
    const a = alarm(SCALE_IN_ALARM_NAME);
    expect(a).toMatchObject({
      Threshold: 0, ComparisonOperator: 'LessThanOrEqualToThreshold',
      EvaluationPeriods: 6, DatapointsToAlarm: 6, TreatMissingData: 'notBreaching',
    });
    const expr = a.Metrics.find((m: any) => m.Expression);
    expect(expr.Expression).toBe('FILL(busy, 0) + FILL(demand, 0)');
    const inputs = Object.fromEntries(a.Metrics.filter((m: any) => m.MetricStat)
      .map((m: any) => [m.Id, m.MetricStat.Metric.MetricName]));
    expect(inputs).toEqual({ busy: LARGE_BUSY_METRIC, demand: LARGE_DEMAND_METRIC });
    expect(a.AlarmActions).toEqual([policyRef(0)]);
  });

  test('scale-out and scale-in can never both be in ALARM', () => {
    // ScaleOut needs demand >= 1; ScaleIn needs busy + demand <= 0 with both >= 0.
    const out = alarm(SCALE_OUT_ALARM_NAME);
    const inn = alarm(SCALE_IN_ALARM_NAME);
    expect(out.Threshold).toBeGreaterThan(inn.Threshold);
  });

  test('DemandUnmet reads pending_promotion and the oldest unresolved age, not large_demand', () => {
    const a = alarm(DEMAND_UNMET_ALARM_NAME);
    const expr = a.Metrics.find((m: any) => m.Expression);
    expect(expr.Expression).toBe('IF(pending >= 1 || FILL(oldest, 0) >= 10800000, 1, 0)');
    const inputs = a.Metrics.filter((m: any) => m.MetricStat).map((m: any) => m.MetricStat.Metric.MetricName).sort();
    expect(inputs).toEqual([OLDEST_UNRESOLVED_METRIC, PENDING_PROMOTION_METRIC].sort());
    expect(a).toMatchObject({
      Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 6, DatapointsToAlarm: 6, TreatMissingData: 'notBreaching',
    });
    expect(a.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^AlarmTopic/) }]);
    expect(a.OKActions).toEqual([{ Ref: expect.stringMatching(/^AlarmTopic/) }]);
  });

  test('LongRunning is the in-service cost guard on the alarm topic', () => {
    const a = alarm(LONG_RUNNING_ALARM_NAME);
    expect(a).toMatchObject({
      Namespace: 'AWS/AutoScaling', MetricName: 'GroupInServiceInstances', Statistic: 'Maximum',
      Dimensions: [{ Name: 'AutoScalingGroupName', Value: { Ref: asgId } }],
      Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 72, DatapointsToAlarm: 72, TreatMissingData: 'notBreaching',
    });
    expect(a.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^AlarmTopic/) }]);
  });

  test('periods and the age threshold come from context', () => {
    const r = synth({
      [LARGE_CLASS_CONTEXT]: true, largeClassOutPeriods: 3, largeClassInPeriods: 4,
      largeClassUnmetPeriods: 5, largeClassUnmetAgeMs: 60000, largeClassLongRunningPeriods: 7,
    }).toJSON().Resources as Record<string, any>;
    const props = (name: string) => (Object.values(r).find((x: any) =>
      x.Type === 'AWS::CloudWatch::Alarm' && x.Properties.AlarmName === name) as any).Properties;
    expect(props(SCALE_OUT_ALARM_NAME).EvaluationPeriods).toBe(3);
    expect(props(SCALE_IN_ALARM_NAME).EvaluationPeriods).toBe(4);
    expect(props(DEMAND_UNMET_ALARM_NAME).EvaluationPeriods).toBe(5);
    expect(JSON.stringify(props(DEMAND_UNMET_ALARM_NAME).Metrics)).toContain('>= 60000');
    expect(props(LONG_RUNNING_ALARM_NAME).EvaluationPeriods).toBe(7);
    expect(() => synth({ [LARGE_CLASS_CONTEXT]: true, largeClassInPeriods: 0 })).toThrow(/positive integer/);
  });

  // --- IAM
  const statementsOf = (rolePrefix: string) => byType('AWS::IAM::Policy')
    .filter(([, p]) => p.Properties.Roles.some((r: any) => String(r.Ref).startsWith(rolePrefix)))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  const actions = (s: any) => [].concat(s.Action);
  const manifestArn = 'arn:aws:s3:::polis-delphi/math-capacity/python/manifest.json';

  test('the large role reads only the manifest key in S3 outside the CDK-owned buckets', () => {
    const role = one('AWS::IAM::Role', 'DelphiLargeInstanceRole');
    const managed = JSON.stringify(role.Properties.ManagedPolicyArns);
    expect(managed).toContain('AmazonSSMManagedInstanceCore');
    expect(managed).toContain('CloudWatchAgentServerPolicy');
    for (const broad of ['SecretsManagerReadWrite', 'CloudWatchLogsFullAccess', 'AmazonEC2RoleforAWSCodeDeploy']) {
      expect(managed).not.toContain(broad);
    }
    const st = statementsOf('DelphiLargeInstanceRole');
    const manifest = st.filter((s: any) => s.Sid === 'CapacityManifestRead');
    expect(manifest).toEqual([{ Sid: 'CapacityManifestRead', Effect: 'Allow', Action: 's3:GetObject', Resource: manifestArn }]);
    const s3Writes = st.filter((s: any) => actions(s).some((a: string) => /^s3:(Put|Delete)/.test(a)));
    expect(s3Writes).toEqual([]);
    expect(JSON.stringify(st)).not.toContain('arn:aws:s3:::*');
  });

  test('the large role keeps what after_install.sh and the boot path read', () => {
    const st = JSON.stringify(statementsOf('DelphiLargeInstanceRole'));
    for (const p of ['db-secret-arn', 'db-host', 'db-port']) expect(st).toContain(`:parameter/polis/${p}`);
    expect(st).toContain('WebAppEnvVarsSecret');
    expect(st).toContain('secretsmanager:GetSecretValue');
    expect(st).toMatch(/DatabaseSecret|DBSecret|Secret[A-Za-z0-9]*Attachment|Db[A-Za-z]*Secret/);
    expect(st).toContain('logs:PutLogEvents');
    expect(st).toContain('aws-codedeploy-us-east-1');      // agent installer
    expect(st).toContain('DeploymentPackageBucket');       // the revision
  });

  test('the shared role gets a scoped Get/Put on the manifest key', () => {
    const st = statementsOf('InstanceRole').filter((s: any) => s.Sid === 'CapacityManifestReadWrite');
    expect(st).toEqual([{
      Sid: 'CapacityManifestReadWrite', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: manifestArn,
    }]);
  });

  test('Postgres admits the large group\'s security group', () => {
    // The large template uses the Delphi security group, which already has the
    // Postgres rule (`db.connections.allowFrom(asgDelphiLarge, ...)` dedups
    // into the small group's identical rule).
    const sgs = lt.Properties.LaunchTemplateData.SecurityGroupIds;
    expect(sgs).toHaveLength(1);
    const sg = sgs[0]['Fn::GetAtt'][0];
    expect(sg).toMatch(/^DelphiSecurityGroup/);
    const ingress = byType('AWS::EC2::SecurityGroupIngress').filter(([, i]) =>
      i.Properties.FromPort === 5432 && i.Properties.SourceSecurityGroupId?.['Fn::GetAtt']?.[0] === sg);
    expect(ingress).toHaveLength(1);
  });
});

describe('readiness lines', () => {
  // The large worker's lines (delphi/polismath/poller/readiness.py
  // class_header) put `class=large` before the line kind. The P-072 filters
  // match their phrases across the whole log group, so no large line may
  // contain one: a large worker must never satisfy the small poller's
  // heartbeat, nor raise its discovery-stale alarm.
  const body = '{"schema":"math_poller.readiness/1","role":"primary","progress":"ok"}';
  const largeLines = [
    `math_poller class=large readiness/1 role=primary progress=ok ${body}`,
    `math_poller class=large readiness/1 role=standby progress=waiting ${body}`,
    `math_poller class=large discovery_stale/1 ${body}`,
    `math_poller class=large readiness_test/1 ${body}`,
    '{"busy":0,"class":"large","label":"python-large","queued":0,"refusal":null,"role":"primary",' +
      '"schema":"math_poller.capacity/1","skew":0,"unfit":0,"allowlisted":0}',
  ];
  const smallLines = [
    `math_poller readiness/1 role=primary progress=ok ${body}`,
    `math_poller discovery_stale/1 ${body}`,
    `math_poller readiness_test/1 ${body}`,
  ];
  // A CloudWatch quoted-term filter matches when the event contains the phrase.
  const matches = (phrase: string, line: string) => line.includes(phrase);

  test('a large line never matches the heartbeat or a stale phrase', () => {
    for (const line of largeLines) {
      expect(matches(HEARTBEAT_PHRASE, line)).toBe(false);
      for (const p of STALE_PHRASES) expect(matches(p, line)).toBe(false);
    }
  });
  test('the small lines still do (the check is not vacuous)', () => {
    expect(matches(HEARTBEAT_PHRASE, smallLines[0])).toBe(true);
    expect(matches(STALE_PHRASES[0], smallLines[1])).toBe(true);
    expect(matches(STALE_PHRASES[1], smallLines[2])).toBe(true);
  });
});
