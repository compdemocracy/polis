import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * The large memory class for the Python math poller (P-073 PR5).
 *
 * The small poller (`math-python` on the Delphi box) routes conversations
 * that do not fit its memory budget to a private capacity manifest in S3.
 * A `delphi-large` box runs only `math-python-large`
 * (scripts/after_install.sh), which computes exactly the manifest and stages
 * the results under its own label; the small poller promotes them. This
 * file adds the box's scaling and alarms. Everything is driven by the bare
 * JSON capacity line each poller logs once per readiness interval
 * (delphi/polismath/poller/capacity.py, schema `math_poller.capacity/1`):
 *
 *   small primary: large_demand, pending_promotion, oldest_unresolved_age_ms
 *   large primary: busy
 *
 * Four log metric filters on the stack's log group, two step-scaling
 * policies with EXACT_CAPACITY on AsgDelphiLarge (0..1), two scaling alarms
 * and two notification alarms on the application alarm topic. Alarm to
 * scaling policy is a native CloudWatch action: no Lambda, and no bucket
 * with autoDeleteObjects. The manifest lives in the existing Delphi bucket,
 * which this stack does not manage.
 *
 *   ScaleOut     large_demand >= 1 for `largeClassOutPeriods` (2) periods
 *                -> exact capacity 1.
 *   ScaleIn      large busy = 0 AND large_demand = 0 for
 *                `largeClassInPeriods` (6) periods -> exact capacity 0. The
 *                demand term keeps the two scaling alarms mutually
 *                exclusive: while demand is unmet but the worker computes
 *                nothing (version skew, a manifest refusal), a busy-only rule
 *                would sit in ALARM next to ScaleOut and an ASG re-invokes a
 *                step policy every minute while its alarm stays in ALARM, so
 *                the group would flap 1/0. Such a box stays up and
 *                LongRunning and DemandUnmet say so.
 *   DemandUnmet  pending_promotion >= 1 or oldest_unresolved_age_ms >=
 *                `largeClassUnmetAgeMs` (3 h) for `largeClassUnmetPeriods` (6)
 *                periods. Not large_demand: demand drops to 0 once a staged
 *                bundle covers the input (it is then pending promotion), so
 *                with MATH_CAPACITY_PROMOTE=0 demand alone never shows the
 *                work as unmet.
 *   LongRunning  the group has had an instance in service for
 *                `largeClassLongRunningPeriods` (72) periods (6 h): the cost
 *                guard.
 *
 * Periods are 5 minutes. No filter sets a defaultValue: an interval
 * without a capacity line is missing data, never a manufactured 0. A
 * standby logs null counts, which a numeric metric filter does not turn
 * into a value.
 *
 * Off unless synthesized with `-c enableLargeClass=true`: with the flag off
 * the template is byte-identical (test/largeClass.test.ts).
 */

export const LARGE_CLASS_CONTEXT = 'enableLargeClass';
export const LARGE_SERVICE_TYPE = 'delphi-large';
export const CAPACITY_NAMESPACE = 'Polis/MathCapacity';
export const CAPACITY_SCHEMA = 'math_poller.capacity/1';

export const LARGE_DEMAND_METRIC = 'LargeDemand';
export const PENDING_PROMOTION_METRIC = 'PendingPromotion';
export const OLDEST_UNRESOLVED_METRIC = 'OldestUnresolvedAgeMs';
export const LARGE_BUSY_METRIC = 'LargeBusy';

export const SCALE_OUT_ALARM_NAME = 'Polis-LargeClass-ScaleOut';
export const SCALE_IN_ALARM_NAME = 'Polis-LargeClass-ScaleIn';
export const DEMAND_UNMET_ALARM_NAME = 'Polis-LargeClass-DemandUnmet';
export const LONG_RUNNING_ALARM_NAME = 'Polis-LargeClass-LongRunning';

/** The JSON filter for one poller class's primary capacity line. */
export const capacityFilter = (klass: 'small' | 'large') =>
  `{ $.schema = "${CAPACITY_SCHEMA}" && $.class = "${klass}" && $.role = "primary" }`;

/** Reads the flag; absent or anything but a literal true means off. */
export const largeClassEnabled = (scope: Construct): boolean => {
  const raw = scope.node.tryGetContext(LARGE_CLASS_CONTEXT);
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.toLowerCase() === 'true';
};

export interface LargeClassSettings {
  /** r7i.2xlarge: 8 vCPU / 64 GiB x86, the small box's family; room for a 52g cgroup. */
  instanceType: ec2.InstanceType;
  /** The existing Delphi bucket (AWS_S3_BUCKET_NAME); not managed by this stack. */
  manifestBucket: string;
  /** The manifest key MATH_CAPACITY_MANIFEST_URI points at. */
  manifestKey: string;
  outPeriods: number;
  inPeriods: number;
  unmetPeriods: number;
  unmetAgeMs: number;
  longRunningPeriods: number;
}

const positiveInt = (scope: Construct, key: string, fallback: number): number => {
  const raw = scope.node.tryGetContext(key);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`context ${key} must be a positive integer, got ${raw}`);
  return n;
};

export const largeClassSettings = (scope: Construct): LargeClassSettings => {
  const ctx = (key: string, fallback: string) =>
    (scope.node.tryGetContext(key) as string | undefined) ?? fallback;
  return {
    instanceType: new ec2.InstanceType(ctx('largeClassInstanceType', 'r7i.2xlarge')),
    manifestBucket: ctx('largeClassManifestBucket', 'polis-delphi'),
    manifestKey: ctx('largeClassManifestKey', 'math-capacity/python/manifest.json'),
    outPeriods: positiveInt(scope, 'largeClassOutPeriods', 2),
    inPeriods: positiveInt(scope, 'largeClassInPeriods', 6),
    unmetPeriods: positiveInt(scope, 'largeClassUnmetPeriods', 6),
    unmetAgeMs: positiveInt(scope, 'largeClassUnmetAgeMs', 3 * 60 * 60 * 1000),
    longRunningPeriods: positiveInt(scope, 'largeClassLongRunningPeriods', 72),
  };
};

const manifestObjectArn = (s: LargeClassSettings) => `arn:aws:s3:::${s.manifestBucket}/${s.manifestKey}`;

/**
 * The delphi-large box's own instance role, scoped to what its boot and
 * deploy path use. Unlike the shared InstanceRole it has no
 * SecretsManagerReadWrite, no CloudWatchLogsFullAccess and no S3 wildcard:
 *
 *   - SSM core (session access) and the CloudWatch agent policy (memory
 *     metrics; also logs:PutLogEvents for the docker awslogs driver);
 *   - logs:CreateLogStream / PutLogEvents on the stack log group;
 *   - ssm:GetParameter on /polis/db-secret-arn, /polis/db-host, /polis/db-port
 *     and read on polis-web-app-env-vars and the DB secret (after_install.sh;
 *     granted where those secrets are created);
 *   - s3:GetObject on the manifest key, nothing else in that bucket.
 *
 * The CodeDeploy revision bucket, the agent installer bucket and the CW
 * agent config asset are granted to it by the constructs that own them.
 */
export const createLargeClassRole = (scope: Construct, s: LargeClassSettings, logGroup: logs.ILogGroup) => {
  const stack = cdk.Stack.of(scope);
  const role = new iam.Role(scope, 'DelphiLargeInstanceRole', {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    description: 'P-073 large memory class box (service type delphi-large): math-python-large only',
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    ],
  });
  logGroup.grantWrite(role);
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: ['db-secret-arn', 'db-host', 'db-port'].map(
      (p) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter/polis/${p}`),
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'CapacityManifestRead',
    actions: ['s3:GetObject'],
    resources: [manifestObjectArn(s)],
  }));
  return role;
};

/** The small poller (shared InstanceRole) reads and writes the manifest key. */
export const grantManifestReadWrite = (role: iam.IRole, s: LargeClassSettings) => {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CapacityManifestReadWrite',
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [manifestObjectArn(s)],
  }));
};

export interface LargeClassProps {
  asg: autoscaling.AutoScalingGroup;
  logGroup: logs.ILogGroup;
  alarmTopic: sns.ITopic;
  settings: LargeClassSettings;
}

export const createLargeClass = (scope: Construct, props: LargeClassProps) => {
  const { asg, logGroup, alarmTopic, settings: s } = props;
  const period = cdk.Duration.minutes(5);

  const filter = (id: string, klass: 'small' | 'large', metricName: string, field: string) =>
    new logs.MetricFilter(scope, id, {
      logGroup,
      filterName: `Polis-LargeClass-${metricName}`,
      filterPattern: logs.FilterPattern.literal(capacityFilter(klass)),
      metricNamespace: CAPACITY_NAMESPACE,
      metricName,
      metricValue: `$.${field}`,
      unit: cloudwatch.Unit.COUNT,
    }).metric({ statistic: 'Maximum', period });

  const demand = filter('LargeClassDemandFilter', 'small', LARGE_DEMAND_METRIC, 'large_demand');
  const pending = filter('LargeClassPendingPromotionFilter', 'small', PENDING_PROMOTION_METRIC, 'pending_promotion');
  const oldest = filter('LargeClassOldestUnresolvedFilter', 'small', OLDEST_UNRESOLVED_METRIC, 'oldest_unresolved_age_ms');
  const busy = filter('LargeClassBusyFilter', 'large', LARGE_BUSY_METRIC, 'busy');

  // Scale out: exact capacity 1, so a repeated invocation is a no-op.
  const scaleOut = new autoscaling.StepScalingAction(scope, 'LargeClassScaleOutPolicy', {
    autoScalingGroup: asg,
    adjustmentType: autoscaling.AdjustmentType.EXACT_CAPACITY,
  });
  scaleOut.addAdjustment({ lowerBound: 0, adjustment: 1 });
  const scaleOutAlarm = new cloudwatch.Alarm(scope, 'LargeClassScaleOutAlarm', {
    alarmName: SCALE_OUT_ALARM_NAME,
    alarmDescription:
      'P-073: the small math poller reports conversations routed to the large memory class ' +
      'whose input is not yet staged. Starts the delphi-large box (exact capacity 1).',
    metric: demand,
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: s.outPeriods,
    datapointsToAlarm: s.outPeriods,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  scaleOutAlarm.addAlarmAction(new cw_actions.AutoScalingAction(scaleOut));

  // Scale in: exact capacity 0 once the large worker is idle and nothing is
  // waiting for it. A missing busy series (no box, or a worker that never
  // logged) counts as idle; a missing demand series (small poller down) too,
  // because nothing can be promoted then and the box only costs money.
  const scaleIn = new autoscaling.StepScalingAction(scope, 'LargeClassScaleInPolicy', {
    autoScalingGroup: asg,
    adjustmentType: autoscaling.AdjustmentType.EXACT_CAPACITY,
  });
  scaleIn.addAdjustment({ upperBound: 0, adjustment: 0 });
  const scaleInAlarm = new cloudwatch.Alarm(scope, 'LargeClassScaleInAlarm', {
    alarmName: SCALE_IN_ALARM_NAME,
    alarmDescription:
      'P-073: the large memory class worker has nothing queued, running or unstaged and the ' +
      'small poller reports no demand. Stops the delphi-large box (exact capacity 0).',
    metric: new cloudwatch.MathExpression({
      expression: 'FILL(busy, 0) + FILL(demand, 0)',
      usingMetrics: { busy, demand },
      period,
      label: 'large busy + large demand',
    }),
    threshold: 0,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: s.inPeriods,
    datapointsToAlarm: s.inPeriods,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  scaleInAlarm.addAlarmAction(new cw_actions.AutoScalingAction(scaleIn));

  const demandUnmet = new cloudwatch.Alarm(scope, 'LargeClassDemandUnmetAlarm', {
    alarmName: DEMAND_UNMET_ALARM_NAME,
    alarmDescription:
      'P-073: large-class work is staged but not promoted, or a routed conversation has had ' +
      `input not reflected in the served label for ${s.unmetAgeMs} ms. Expected while ` +
      'MATH_CAPACITY_PROMOTE=0. Otherwise check the delphi-large box (skew, manifest refusal, ' +
      'capacity) and the small poller\'s promotion loop. Runbook: cost-reduction plan P-073.',
    metric: new cloudwatch.MathExpression({
      expression: `IF(pending >= 1 || FILL(oldest, 0) >= ${s.unmetAgeMs}, 1, 0)`,
      usingMetrics: { pending, oldest },
      period,
      label: 'large-class demand unmet',
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: s.unmetPeriods,
    datapointsToAlarm: s.unmetPeriods,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  const longRunning = new cloudwatch.Alarm(scope, 'LargeClassLongRunningAlarm', {
    alarmName: LONG_RUNNING_ALARM_NAME,
    alarmDescription:
      'P-073: the delphi-large box has been in service for ' +
      `${(s.longRunningPeriods * 5) / 60} hours. Cost guard: repeated firing is the evidence ` +
      'for a fixed resize instead of the autoscaled class.',
    metric: new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupInServiceInstances',
      dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
      statistic: 'Maximum',
      period,
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: s.longRunningPeriods,
    datapointsToAlarm: s.longRunningPeriods,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  for (const alarm of [demandUnmet, longRunning]) {
    alarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
    alarm.addOkAction(new cw_actions.SnsAction(alarmTopic));
  }

  return { scaleOut, scaleIn, scaleOutAlarm, scaleInAlarm, demandUnmet, longRunning };
};

export default createLargeClass;
