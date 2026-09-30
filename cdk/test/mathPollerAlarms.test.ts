import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';

import createMathPollerAlarms, {
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_METRIC,
  HEARTBEAT_PHRASE,
  MATH_POLLER_ALARMS_CONTEXT,
  MATH_POLLER_NAMESPACE,
  STALE_ALARM_NAME,
  STALE_METRIC,
  STALE_PHRASES,
  mathPollerAlarmsEnabled,
} from '../mathPollerAlarms';

const build = () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const logGroup = new logs.LogGroup(stack, 'LogGroup');
  const alarmTopic = new sns.Topic(stack, 'AlarmTopic');
  createMathPollerAlarms(stack, { logGroup, alarmTopic });
  return Template.fromStack(stack);
};

describe(`${MATH_POLLER_ALARMS_CONTEXT} flag`, () => {
  const scope = (value?: unknown) => {
    const app = new cdk.App(value === undefined ? {} : { context: { [MATH_POLLER_ALARMS_CONTEXT]: value } });
    return new cdk.Stack(app, 'S');
  };
  test('defaults to off', () => expect(mathPollerAlarmsEnabled(scope())).toBe(false));
  test('on for true and "true"', () => {
    expect(mathPollerAlarmsEnabled(scope(true))).toBe(true);
    expect(mathPollerAlarmsEnabled(scope('true'))).toBe(true);
  });
  test('anything else is off', () => {
    for (const v of ['yes', '1', 'false', false]) expect(mathPollerAlarmsEnabled(scope(v))).toBe(false);
  });
});

describe('metric filters', () => {
  test('two filters on the given log group, no defaultValue', () => {
    const t = build();
    t.resourceCountIs('AWS::Logs::MetricFilter', 2);
    for (const f of Object.values(t.findResources('AWS::Logs::MetricFilter')) as any[]) {
      expect(f.Properties.LogGroupName).toEqual({ Ref: expect.stringMatching(/^LogGroup/) });
      expect(f.Properties.MetricTransformations).toHaveLength(1);
      expect(f.Properties.MetricTransformations[0].DefaultValue).toBeUndefined();
      expect(f.Properties.MetricTransformations[0].MetricNamespace).toBe(MATH_POLLER_NAMESPACE);
    }
  });

  test('the heartbeat counts only primary lines with progress=ok', () => {
    build().hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: `"${HEARTBEAT_PHRASE}"`,
      MetricTransformations: [Match.objectLike({ MetricName: HEARTBEAT_METRIC, MetricValue: '1' })],
    });
    expect(HEARTBEAT_PHRASE).toBe('math_poller readiness/1 role=primary progress=ok');
  });

  test('the stale filter counts stale lines and the alert-test line', () => {
    build().hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: STALE_PHRASES.map((p) => `?"${p}"`).join(' '),
      MetricTransformations: [Match.objectLike({ MetricName: STALE_METRIC, MetricValue: '1' })],
    });
    expect(STALE_PHRASES).toEqual(['math_poller discovery_stale/1', 'math_poller readiness_test/1']);
  });
});

describe('alarms', () => {
  test('heartbeat missing: <1 per 5 minutes for 3 of 3 periods, missing data breaching', () => {
    build().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: HEARTBEAT_ALARM_NAME,
      Namespace: MATH_POLLER_NAMESPACE,
      MetricName: HEARTBEAT_METRIC,
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: 'breaching',
    });
  });

  test('discovery stale: >=1 in one 5-minute period, missing data not breaching', () => {
    build().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: STALE_ALARM_NAME,
      Namespace: MATH_POLLER_NAMESPACE,
      MetricName: STALE_METRIC,
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('both notify the given topic on ALARM and OK, and nothing else is created', () => {
    const t = build();
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    for (const a of Object.values(t.findResources('AWS::CloudWatch::Alarm')) as any[]) {
      expect(a.Properties.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^AlarmTopic/) }]);
      expect(a.Properties.OKActions).toEqual([{ Ref: expect.stringMatching(/^AlarmTopic/) }]);
      expect(a.Properties.ActionsEnabled).not.toBe(false);
    }
    t.resourceCountIs('AWS::Lambda::Function', 0);
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.resourceCountIs('AWS::IAM::Policy', 0);
  });

  test('snapshot of the synthesized filters and alarms', () => {
    const t = build().toJSON();
    const picked = Object.fromEntries(
      Object.entries(t.Resources as Record<string, any>).filter(([, r]) =>
        ['AWS::Logs::MetricFilter', 'AWS::CloudWatch::Alarm'].includes(r.Type)),
    );
    expect(picked).toMatchSnapshot();
  });
});
