import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';

import createOperationalAlarms, {
  ALARM_EMAIL_CONTEXT,
  ALARMS_ENABLED_CONTEXT,
  ALERT_DELIVERY_ALARM_NAME,
  ALERT_TOPIC_NAME,
  CODEDEPLOY_FAILURE_RULE_NAME,
  DB_CREDIT_BALANCE_ALARM_NAME,
  HEALTH_PAIRS,
  MATH_WORKER_LIVENESS_ALARM_NAME,
  WEB_HEALTHY_HOSTS_ALARM_NAME,
  alarmsEnabled,
  enforceHealthPairs,
  requireAlarmEmail,
  EnabledAlarmRecord,
} from '../alarms';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const MATH_ASG = 'CdkStack-AsgMathWorker-EXAMPLE';
const LB_FULL_NAME = 'app/example-lb/1111111111111111';
const TG_FULL_NAME = 'targetgroup/example-tg/2222222222222222';

/**
 * Builds a stack holding a real RDS instance (so A04 is asserted against the
 * same `db.metric(...)` call the production stack makes) plus stand-ins for the
 * two db.ts alarms that get retargeted.
 */
const buildStack = () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: ACCOUNT, region: REGION } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const database = new rds.DatabaseInstance(stack, 'Database', {
    engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
    vpc,
  });
  const existingTopic = new sns.Topic(stack, 'DatabaseAlarmsTopic');

  const highCpuAlarm = new cloudwatch.Alarm(stack, 'HighCpuAlarm', {
    alarmName: 'Polis-DB-HighCPUUtilization',
    metric: database.metric('CPUUtilization', {
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
    }),
    threshold: 80,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  highCpuAlarm.addAlarmAction(new cw_actions.SnsAction(existingTopic));

  const lowStorageAlarm = new cloudwatch.Alarm(stack, 'LowStorageAlarm', {
    alarmName: 'Polis-DB-LowFreeStorageSpace',
    metric: database.metric('FreeStorageSpace', {
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
    }),
    threshold: 4 * 1024 * 1024 * 1024,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.IGNORE,
  });
  lowStorageAlarm.addAlarmAction(new cw_actions.SnsAction(existingTopic));

  return { stack, database, highCpuAlarm, lowStorageAlarm };
};

const synth = (overrides: { retarget?: boolean } = {}) => {
  const { stack, database, highCpuAlarm, lowStorageAlarm } = buildStack();
  createOperationalAlarms(stack, {
    email: 'ops@example.org',
    mathWorkerAsgName: MATH_ASG,
    database,
    loadBalancerFullName: LB_FULL_NAME,
    webTargetGroupFullName: TG_FULL_NAME,
    codeDeployApplicationName: 'PolisApplication',
    codeDeployDeploymentGroupName: 'PolisDeploymentGroup',
    retargetAlarms:
      overrides.retarget === false
        ? []
        : [
            {
              id: 'A06',
              alarm: highCpuAlarm,
              treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            },
            {
              id: 'A07',
              alarm: lowStorageAlarm,
              treatMissingData: cloudwatch.TreatMissingData.IGNORE,
            },
          ],
  });
  return { template: Template.fromStack(stack), highCpuAlarm, lowStorageAlarm };
};

const alarmByName = (template: Template, name: string) => {
  const found = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
    (r: any) => r.Properties.AlarmName === name,
  );
  expect(found).toHaveLength(1);
  return (found[0] as any).Properties;
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe(`${ALARMS_ENABLED_CONTEXT} context flag`, () => {
  const enabledWith = (value: unknown) => {
    const app = new cdk.App(
      value === undefined ? {} : { context: { [ALARMS_ENABLED_CONTEXT]: value } },
    );
    return alarmsEnabled(new cdk.Stack(app, 'S'));
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
    for (const value of ['false', '1', 'yes', null, 0]) {
      expect(enabledWith(value)).toBe(false);
    }
  });
});

describe('the gate adds nothing when it is off', () => {
  // The real proof that the deployed template is byte-identical with the flag
  // off is a `cdk synth` diff of the whole CdkStack against edge, recorded in
  // cost-reduction/04-plans/P-031-slice1-implementation-notes.md. This asserts
  // the mechanism the stack uses to reach that state: the construct is never
  // called, so nothing can be added.
  const baseline = () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Gated', { env: { account: ACCOUNT, region: REGION } });
    new sns.Topic(stack, 'PreExisting');
    return Template.fromStack(stack).toJSON().Resources;
  };

  const gated = (context: Record<string, unknown>) => {
    const app = new cdk.App({ context });
    const stack = new cdk.Stack(app, 'Gated', { env: { account: ACCOUNT, region: REGION } });
    new sns.Topic(stack, 'PreExisting');
    if (alarmsEnabled(stack)) {
      createOperationalAlarms(stack, {
        email: requireAlarmEmail(stack),
        mathWorkerAsgName: MATH_ASG,
        database: rds.DatabaseInstance.fromDatabaseInstanceAttributes(stack, 'Db', {
          instanceIdentifier: 'example',
          instanceEndpointAddress: 'example.invalid',
          port: 5432,
          securityGroups: [],
        }),
        loadBalancerFullName: LB_FULL_NAME,
        webTargetGroupFullName: TG_FULL_NAME,
        codeDeployApplicationName: 'PolisApplication',
        codeDeployDeploymentGroupName: 'PolisDeploymentGroup',
      });
    }
    return { before: baseline(), after: Template.fromStack(stack).toJSON().Resources };
  };

  test('flag absent: the resource set is unchanged', () => {
    const { before, after } = gated({});
    expect(after).toEqual(before);
  });

  test('flag explicitly false: the resource set is unchanged', () => {
    const { before, after } = gated({ [ALARMS_ENABLED_CONTEXT]: 'false' });
    expect(after).toEqual(before);
  });

  test('flag on with no email: synthesis fails rather than deploying silent alarms', () => {
    expect(() => gated({ [ALARMS_ENABLED_CONTEXT]: 'true' })).toThrow(/requires a recipient/);
  });

  test('flag on with an email: resources appear', () => {
    const { before, after } = gated({
      [ALARMS_ENABLED_CONTEXT]: 'true',
      [ALARM_EMAIL_CONTEXT]: 'ops@example.org',
    });
    expect(Object.keys(after).length).toBeGreaterThan(Object.keys(before).length);
  });
});

describe(`${ALARM_EMAIL_CONTEXT} is required when enabled`, () => {
  const emailFrom = (value: unknown) => {
    const app = new cdk.App(
      value === undefined ? {} : { context: { [ALARM_EMAIL_CONTEXT]: value } },
    );
    return () => requireAlarmEmail(new cdk.Stack(app, 'S'));
  };

  test('refuses to synthesize with no recipient', () => {
    expect(emailFrom(undefined)).toThrow(/requires a recipient/);
    expect(emailFrom('')).toThrow(/requires a recipient/);
    expect(emailFrom('   ')).toThrow(/requires a recipient/);
  });

  test('refuses anything that is not one plausible address', () => {
    expect(emailFrom('ops')).toThrow(/must be one email address/);
    expect(emailFrom('ops@localhost')).toThrow(/must be one email address/);
    expect(emailFrom('a@example.org,b@example.org')).toThrow(/must be one email address/);
  });

  test('accepts and trims a single address', () => {
    expect(emailFrom('  ops@example.org ')()).toBe('ops@example.org');
  });
});

// ---------------------------------------------------------------------------
// The alert path
// ---------------------------------------------------------------------------

describe('alert path', () => {
  test('one topic with one confirmed-by-hand email subscription', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SNS::Topic', 2); // the shared topic + the db.ts stand-in
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: ALERT_TOPIC_NAME });
    template.resourceCountIs('AWS::SNS::Subscription', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.org',
    });
  });

  test('the topic policy keeps owner access and narrows the two service principals', () => {
    const { template } = synth();
    const policies = Object.values(template.findResources('AWS::SNS::TopicPolicy'));
    expect(policies).toHaveLength(1);
    const statements = (policies[0] as any).Properties.PolicyDocument.Statement;

    const owner = statements.find((s: any) => s.Sid === 'AllowOwnerFullControl');
    expect(owner.Effect).toBe('Allow');
    expect(owner.Condition).toEqual({ StringEquals: { 'AWS:SourceOwner': ACCOUNT } });

    const cw = statements.find((s: any) => s.Sid === 'AllowCloudWatchAlarmsInThisAccount');
    expect(cw.Principal).toEqual({ Service: 'cloudwatch.amazonaws.com' });
    expect(cw.Condition).toEqual({ StringEquals: { 'AWS:SourceAccount': ACCOUNT } });

    // CDK's own events grant is unconditioned, so it is fenced by an explicit
    // Deny rather than left open to any rule in any account.
    const deny = statements.find((s: any) => s.Sid === 'DenyEventBridgeExceptTheCodeDeployRule');
    expect(deny.Effect).toBe('Deny');
    expect(deny.Principal).toEqual({ Service: 'events.amazonaws.com' });
    expect(Object.keys(deny.Condition)).toEqual(['ArnNotEquals']);
    expect(JSON.stringify(deny.Condition)).toContain('CodeDeployFailureRule');
  });

  test('every alarm notifies on both ALARM and OK', () => {
    const { template } = synth();
    for (const name of [
      MATH_WORKER_LIVENESS_ALARM_NAME,
      WEB_HEALTHY_HOSTS_ALARM_NAME,
      DB_CREDIT_BALANCE_ALARM_NAME,
      ALERT_DELIVERY_ALARM_NAME,
    ]) {
      const props = alarmByName(template, name);
      expect(props.AlarmActions).toHaveLength(1);
      expect(props.OKActions).toHaveLength(1);
      expect(props.AlarmActions).toEqual(props.OKActions);
    }
  });

  test('every alarm names its runbook step in the description', () => {
    const { template } = synth();
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const description = (alarm as any).Properties.AlarmDescription;
      if (description === undefined) continue; // the db.ts stand-ins carry none
      expect(description).toMatch(/Runbook: docs\/alarms\.md#/);
    }
  });
});

// ---------------------------------------------------------------------------
// A17 — the math ASG missing-metric alarm
// ---------------------------------------------------------------------------

describe('A17 math worker missing-metric alarm', () => {
  test('watches AWS/EC2 CPUUtilization on the ASG dimension alone', () => {
    const props = alarmByName(synth().template, MATH_WORKER_LIVENESS_ALARM_NAME);
    expect(props.Namespace).toBe('AWS/EC2');
    expect(props.MetricName).toBe('CPUUtilization');
    expect(props.Dimensions).toEqual([{ Name: 'AutoScalingGroupName', Value: MATH_ASG }]);
  });

  test('is a presence alarm: unreachable threshold, breaching on missing data', () => {
    const props = alarmByName(synth().template, MATH_WORKER_LIVENESS_ALARM_NAME);
    // <0% cannot be met by a real CPU reading, so a quiet-but-alive worker
    // never fires it. The missing-data setting is the entire mechanism.
    expect(props.Threshold).toBe(0);
    expect(props.ComparisonOperator).toBe('LessThanThreshold');
    expect(props.TreatMissingData).toBe('breaching');
  });

  test('Minimum over 300s, 2 of 3 periods', () => {
    const props = alarmByName(synth().template, MATH_WORKER_LIVENESS_ALARM_NAME);
    expect(props.Statistic).toBe('Minimum');
    expect(props.Period).toBe(300);
    expect(props.EvaluationPeriods).toBe(3);
    expect(props.DatapointsToAlarm).toBe(2);
  });

  test('a 75-minute gap is 15 consecutive missing periods, so 2 of 3 is satisfied', () => {
    // The 2026-09-08 outage shape, stated as arithmetic. CloudWatch may pull
    // older real datapoints into an extended evaluation range, so this proves
    // the window is short enough, not the exact transition minute.
    const props = alarmByName(synth().template, MATH_WORKER_LIVENESS_ALARM_NAME);
    const missingPeriods = Math.floor((75 * 60) / props.Period);
    expect(missingPeriods).toBe(15);
    expect(missingPeriods).toBeGreaterThanOrEqual(props.DatapointsToAlarm);
    expect(props.EvaluationPeriods * props.Period).toBeLessThan(75 * 60);
  });
});

// ---------------------------------------------------------------------------
// A13 — web healthy hosts
// ---------------------------------------------------------------------------

describe('A13 web healthy host count', () => {
  test('uses the target group and load balancer dimensions, and no AvailabilityZone', () => {
    const props = alarmByName(synth().template, WEB_HEALTHY_HOSTS_ALARM_NAME);
    expect(props.Namespace).toBe('AWS/ApplicationELB');
    expect(props.MetricName).toBe('HealthyHostCount');
    // Per-AZ series exist for this metric and each goes to zero during an
    // ordinary rebalance; including AvailabilityZone would make this noisy.
    expect(props.Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'TargetGroup', Value: TG_FULL_NAME },
        { Name: 'LoadBalancer', Value: LB_FULL_NAME },
      ]),
    );
    expect(props.Dimensions).toHaveLength(2);
    expect(JSON.stringify(props.Dimensions)).not.toContain('AvailabilityZone');
  });

  test('fires below one healthy host and on missing data', () => {
    const props = alarmByName(synth().template, WEB_HEALTHY_HOSTS_ALARM_NAME);
    expect(props.Threshold).toBe(1);
    expect(props.ComparisonOperator).toBe('LessThanThreshold');
    expect(props.Statistic).toBe('Minimum');
    expect(props.Period).toBe(60);
    expect(props.EvaluationPeriods).toBe(3);
    expect(props.DatapointsToAlarm).toBe(2);
    expect(props.TreatMissingData).toBe('breaching');
  });
});

// ---------------------------------------------------------------------------
// A04 — RDS CPU credit balance
// ---------------------------------------------------------------------------

describe('A04 database CPU credit balance', () => {
  test('watches CPUCreditBalance on the database instance dimension', () => {
    const props = alarmByName(synth().template, DB_CREDIT_BALANCE_ALARM_NAME);
    expect(props.Namespace).toBe('AWS/RDS');
    expect(props.MetricName).toBe('CPUCreditBalance');
    expect(props.Dimensions).toHaveLength(1);
    expect(props.Dimensions[0].Name).toBe('DBInstanceIdentifier');
  });

  test('60 credits, Minimum over 3 periods of 300s, breaching on missing data', () => {
    const props = alarmByName(synth().template, DB_CREDIT_BALANCE_ALARM_NAME);
    expect(props.Threshold).toBe(60);
    expect(props.ComparisonOperator).toBe('LessThanThreshold');
    expect(props.Statistic).toBe('Minimum');
    expect(props.Period).toBe(300);
    expect(props.EvaluationPeriods).toBe(3);
    // Breaching is load-bearing: this is the health pair that stops A07's
    // `ignore` from holding OK forever when the database stops publishing.
    expect(props.TreatMissingData).toBe('breaching');
  });
});

// ---------------------------------------------------------------------------
// A06 / A07 — retarget in place
// ---------------------------------------------------------------------------

describe('A06 / A07 retarget', () => {
  test('the existing alarms keep their metric, threshold and missing-data settings', () => {
    const { template } = synth();
    const cpu = alarmByName(template, 'Polis-DB-HighCPUUtilization');
    expect(cpu.MetricName).toBe('CPUUtilization');
    expect(cpu.Statistic).toBe('Average');
    expect(cpu.Period).toBe(300);
    expect(cpu.Threshold).toBe(80);
    expect(cpu.EvaluationPeriods).toBe(2);
    expect(cpu.TreatMissingData).toBe('notBreaching');

    const storage = alarmByName(template, 'Polis-DB-LowFreeStorageSpace');
    expect(storage.MetricName).toBe('FreeStorageSpace');
    expect(storage.Statistic).toBe('Average');
    expect(storage.Period).toBe(300);
    expect(storage.Threshold).toBe(4 * 1024 * 1024 * 1024);
    expect(storage.EvaluationPeriods).toBe(1);
    // `ignore` is preserved deliberately: it is the deployed setting, and A04
    // is what makes it safe.
    expect(storage.TreatMissingData).toBe('ignore');
  });

  test('the shared topic is ADDED to their actions, never swapped in', () => {
    const { template } = synth();
    for (const name of ['Polis-DB-HighCPUUtilization', 'Polis-DB-LowFreeStorageSpace']) {
      const props = alarmByName(template, name);
      // Two ALARM actions: the pre-existing database topic and the new shared
      // one. Replacing would open a coverage gap during migration.
      expect(props.AlarmActions).toHaveLength(2);
      expect(JSON.stringify(props.AlarmActions)).toContain('DatabaseAlarmsTopic');
      expect(JSON.stringify(props.AlarmActions)).toContain('OperationalAlertsTopic');
    }
  });

  test('their logical IDs are untouched', () => {
    const { template } = synth();
    // CDK appends a hash to the construct id; the prefix is the logical id
    // path, which is what must not move.
    const ids = Object.keys(template.findResources('AWS::CloudWatch::Alarm'));
    for (const prefix of ['HighCpuAlarm', 'LowStorageAlarm']) {
      expect(ids.filter((id) => id.startsWith(prefix))).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// A16 — CodeDeploy failure rule
// ---------------------------------------------------------------------------

describe('A16 CodeDeploy failure rule', () => {
  test('matches only FAILURE and STOP for the Polis application, in this account', () => {
    synth().template.hasResourceProperties('AWS::Events::Rule', {
      Name: CODEDEPLOY_FAILURE_RULE_NAME,
      State: 'ENABLED',
      EventPattern: {
        account: [ACCOUNT],
        region: [REGION],
        source: ['aws.codedeploy'],
        'detail-type': ['CodeDeploy Deployment State-change Notification'],
        detail: {
          application: ['PolisApplication'],
          deploymentGroup: ['PolisDeploymentGroup'],
          // START and SUCCESS are excluded: this is a failure signal, not a
          // deployment audit.
          state: ['FAILURE', 'STOP'],
        },
      },
    });
  });

  test('the notification carries state, ids, time and a console link', () => {
    const rules = Object.values(synth().template.findResources('AWS::Events::Rule'));
    expect(rules).toHaveLength(1);
    const target = (rules[0] as any).Properties.Targets[0];
    const paths = target.InputTransformer.InputPathsMap;
    expect(Object.values(paths)).toEqual(
      expect.arrayContaining([
        '$.detail.state',
        '$.detail.application',
        '$.detail.deploymentGroup',
        '$.detail.deploymentId',
        '$.time',
      ]),
    );
    expect(target.InputTransformer.InputTemplate).toContain('console.aws.amazon.com');
    expect(target.InputTransformer.InputTemplate).toContain('docs/alarms.md#');
    expect(target.Arn.Ref).toMatch(/^OperationalAlertsTopic/);
  });
});

// ---------------------------------------------------------------------------
// A18 — the alert path watches itself
// ---------------------------------------------------------------------------

describe('A18 notification delivery failure', () => {
  test('sums AWS/SNS NumberOfNotificationsFailed on the shared topic', () => {
    const props = alarmByName(synth().template, ALERT_DELIVERY_ALARM_NAME);
    expect(props.Namespace).toBe('AWS/SNS');
    expect(props.MetricName).toBe('NumberOfNotificationsFailed');
    expect(props.Statistic).toBe('Sum');
    expect(props.Dimensions).toHaveLength(1);
    expect(props.Dimensions[0].Name).toBe('TopicName');
  });

  test('fires on a single failure and treats silence as healthy', () => {
    const props = alarmByName(synth().template, ALERT_DELIVERY_ALARM_NAME);
    expect(props.Threshold).toBe(1);
    expect(props.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
    expect(props.Period).toBe(300);
    expect(props.EvaluationPeriods).toBe(1);
    // Failure-only metric: a healthy topic publishes nothing here, so
    // breaching would mean permanent ALARM.
    expect(props.TreatMissingData).toBe('notBreaching');
  });
});

// ---------------------------------------------------------------------------
// Health pairing, enforced at synth
// ---------------------------------------------------------------------------

describe('synth-enforced health pairs', () => {
  const record = (
    id: string,
    treatMissingData: cloudwatch.TreatMissingData,
    alarmActionCount = 1,
  ): EnabledAlarmRecord => ({ id, alarmName: id, treatMissingData, alarmActionCount });

  test('the slice as built satisfies every pair', () => {
    expect(() => synth()).not.toThrow();
  });

  test('A07 without A04 is refused', () => {
    expect(() =>
      enforceHealthPairs([record('A07', cloudwatch.TreatMissingData.IGNORE)]),
    ).toThrow(/A07 .*requires one of \[A04, A03\]/s);
  });

  test('A04 present but notifying nobody does not satisfy A07', () => {
    // A health alarm with no action is decoration: it cannot tell anyone the
    // publisher died.
    expect(() =>
      enforceHealthPairs([
        record('A07', cloudwatch.TreatMissingData.IGNORE),
        record('A04', cloudwatch.TreatMissingData.BREACHING, 0),
      ]),
    ).toThrow(/A07/);
  });

  test('A04 present but not breaching on missing data does not satisfy A07', () => {
    expect(() =>
      enforceHealthPairs([
        record('A07', cloudwatch.TreatMissingData.IGNORE),
        record('A04', cloudwatch.TreatMissingData.NOT_BREACHING),
      ]),
    ).toThrow(/A07/);
  });

  test('either listed health alarm satisfies the pair', () => {
    for (const healthId of HEALTH_PAIRS.A07) {
      expect(() =>
        enforceHealthPairs([
          record('A07', cloudwatch.TreatMissingData.IGNORE),
          record(healthId, cloudwatch.TreatMissingData.BREACHING),
        ]),
      ).not.toThrow();
    }
  });

  test('the rule table carries the constraints later slices inherit', () => {
    expect(HEALTH_PAIRS).toEqual({
      A02: ['A03'],
      A07: ['A04', 'A03'],
      A09: ['A08'],
      A10: ['A08'],
      A11: ['A08'],
      A12: ['A13'],
      A14: ['A15'],
    });
  });

  test('alarms with no pairing requirement pass on their own', () => {
    expect(() =>
      enforceHealthPairs([record('A06', cloudwatch.TreatMissingData.NOT_BREACHING)]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

describe('what the construct does NOT add', () => {
  test('exactly five alarms are created here; the other two are pre-existing', () => {
    const { template } = synth();
    // A17, A13, A04, A18 are new; A06/A07 are the db.ts stand-ins this test
    // stack builds, and the construct only adds actions to them.
    template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
  });

  test('no IAM role, no Lambda, no capacity mutation and no new publisher', () => {
    // Two independently built stacks rather than one synthesized twice: CDK
    // forbids mutating a tree after synthesis.
    const before = Template.fromStack(buildStack().stack).toJSON().Resources;
    const after = synth().template.toJSON().Resources;
    const addedTypes = new Set(
      Object.keys(after)
        .filter((k) => !(k in before))
        .map((k) => after[k].Type),
    );
    expect([...addedTypes].sort()).toEqual([
      'AWS::CloudWatch::Alarm',
      'AWS::Events::Rule',
      'AWS::SNS::Subscription',
      'AWS::SNS::Topic',
      'AWS::SNS::TopicPolicy',
    ]);
    for (const forbidden of [
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::Lambda::Function',
      'AWS::AutoScaling::AutoScalingGroup',
      'AWS::AutoScaling::ScalingPolicy',
      'AWS::Logs::MetricFilter',
    ]) {
      expect(addedTypes.has(forbidden)).toBe(false);
    }
  });

  test('no alarm carries an autoscaling or EC2 action', () => {
    const { template } = synth();
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const actions = JSON.stringify((alarm as any).Properties.AlarmActions ?? []);
      expect(actions).not.toContain('autoscaling');
      expect(actions).not.toContain('ec2:');
      expect(actions).not.toContain('automate');
    }
  });
});
