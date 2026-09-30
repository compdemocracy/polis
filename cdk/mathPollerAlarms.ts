import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * Python math poller readiness/liveness alarms (P-072).
 *
 * The admitted poller (the process holding the label's single-writer lock)
 * logs `math_poller readiness/1 role=primary progress=ok {json}` about once a
 * minute, but only while both poll loops keep completing and no live work is
 * older than the stale bound. A standby, a process whose loops stopped, or
 * one with stuck live work logs a different prefix, which does not count.
 * When the holder's discovery or live work has not moved for ten minutes it
 * also logs `math_poller discovery_stale/1 {json}`.
 *
 * Two log metric filters on the existing log group (every Delphi box's
 * containers log to its `delphi` stream through the awslogs driver) and two
 * alarms on the existing application alarm topic. No Lambda, no new
 * publisher, no instance permission: CloudWatch Logs evaluates the filters.
 *
 *   Polis-MathPoller-HeartbeatMissing   fewer than 1 heartbeat per 5 minutes
 *                                       for 3 consecutive periods; missing
 *                                       data is breaching (a dead poller
 *                                       publishes nothing).
 *   Polis-MathPoller-DiscoveryStale     at least 1 stale (or alert-test) line
 *                                       in a 5-minute period; missing data is
 *                                       not breaching, which is safe only
 *                                       because the heartbeat alarm above is
 *                                       its health pair.
 *
 * Neither filter sets a defaultValue: an interval with other log events but
 * no heartbeat must be absent (breaching), never a manufactured 0 or 1.
 *
 * The alert test (see delphi/polismath/poller/readiness.py and plan P-072):
 * `MATH_POLLER_READINESS_ALERT_TEST=<nonce>` makes the poller log one
 * `math_poller readiness_test/1` line, which the stale filter also counts, so
 * the real filter, metric, alarm and topic fire end to end.
 *
 * Off unless synthesized with `-c enableMathPollerAlarms=true`: while the
 * poller is not deployed the heartbeat alarm would sit in ALARM forever.
 */

export const MATH_POLLER_ALARMS_CONTEXT = 'enableMathPollerAlarms';
export const MATH_POLLER_NAMESPACE = 'Polis/MathPoller';
export const HEARTBEAT_METRIC = 'ReadinessHeartbeat';
export const STALE_METRIC = 'DiscoveryStale';
export const HEARTBEAT_ALARM_NAME = 'Polis-MathPoller-HeartbeatMissing';
export const STALE_ALARM_NAME = 'Polis-MathPoller-DiscoveryStale';

/** The literal phrases the poller logs (pinned by the delphi test suite). */
export const HEARTBEAT_PHRASE = 'math_poller readiness/1 role=primary progress=ok';
export const STALE_PHRASES = ['math_poller discovery_stale/1', 'math_poller readiness_test/1'];

/** Reads the flag; absent or anything but a literal true means off. */
export const mathPollerAlarmsEnabled = (scope: Construct): boolean => {
  const raw = scope.node.tryGetContext(MATH_POLLER_ALARMS_CONTEXT);
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.toLowerCase() === 'true';
};

export interface MathPollerAlarmsProps {
  /** The stack's application log group (the `delphi` stream lives here). */
  logGroup: logs.ILogGroup;
  /** The existing application alarm topic. */
  alarmTopic: sns.ITopic;
}

const quoted = (phrase: string) => `"${phrase}"`;

export const createMathPollerAlarms = (scope: Construct, props: MathPollerAlarmsProps) => {
  const heartbeatFilter = new logs.MetricFilter(scope, 'MathPollerHeartbeatFilter', {
    logGroup: props.logGroup,
    filterName: 'Polis-MathPoller-Heartbeat',
    filterPattern: logs.FilterPattern.literal(quoted(HEARTBEAT_PHRASE)),
    metricNamespace: MATH_POLLER_NAMESPACE,
    metricName: HEARTBEAT_METRIC,
    metricValue: '1',
    unit: cloudwatch.Unit.COUNT,
  });
  const staleFilter = new logs.MetricFilter(scope, 'MathPollerDiscoveryStaleFilter', {
    logGroup: props.logGroup,
    filterName: 'Polis-MathPoller-DiscoveryStale',
    filterPattern: logs.FilterPattern.literal(STALE_PHRASES.map((p) => `?${quoted(p)}`).join(' ')),
    metricNamespace: MATH_POLLER_NAMESPACE,
    metricName: STALE_METRIC,
    metricValue: '1',
    unit: cloudwatch.Unit.COUNT,
  });

  const period = cdk.Duration.minutes(5);
  const heartbeatMissing = new cloudwatch.Alarm(scope, 'MathPollerHeartbeatMissingAlarm', {
    alarmName: HEARTBEAT_ALARM_NAME,
    alarmDescription:
      'P-072: no heartbeat from the admitted Python math poller for 15 minutes. The holder ' +
      'is dead, lost the single-writer lock, or its poll loops or live work stopped ' +
      'progressing. A standby never satisfies it. Runbook: cost-reduction plan P-072.',
    metric: heartbeatFilter.metric({ statistic: 'Sum', period }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  const discoveryStale = new cloudwatch.Alarm(scope, 'MathPollerDiscoveryStaleAlarm', {
    alarmName: STALE_ALARM_NAME,
    alarmDescription:
      'P-072: the admitted Python math poller reports no successful discovery poll, or live ' +
      'work waiting, for more than 10 minutes (or an alert test ran). Silent when the ' +
      'poller is gone: HeartbeatMissing covers that. Runbook: cost-reduction plan P-072.',
    metric: staleFilter.metric({ statistic: 'Sum', period }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  for (const alarm of [heartbeatMissing, discoveryStale]) {
    alarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));
    alarm.addOkAction(new cw_actions.SnsAction(props.alarmTopic));
  }
  return { heartbeatFilter, staleFilter, heartbeatMissing, discoveryStale };
};

export default createMathPollerAlarms;
