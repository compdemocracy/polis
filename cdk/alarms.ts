import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * Operational alarms — P-031 slice 1, built against plan revision 2.
 *
 * Seven metric alarms plus one EventBridge rule. Every one reads a metric that
 * already exists: no new publisher, no log metric filter, no code in any
 * service. Six of the seven measured zero breaching periods over the four days
 * before the plan was written; the two sparse failure signals (A16, A18) have
 * no historical rule or topic to measure, so "no observed failures" is not a
 * false-positive guarantee for them.
 *
 *   A17  Math ASG missing-metric alarm      (new; the Sep-08 outage detector)
 *   A13  Web healthy host count
 *   A06  RDS CPU > 80%                      (existing db.ts alarm, retargeted)
 *   A07  RDS free storage < 4 GiB           (existing db.ts alarm, retargeted)
 *   A04  RDS CPU credit balance             (new; A07's required health pair)
 *   A16  CodeDeploy FAILURE/STOP            (EventBridge rule)
 *   A18  SNS notification delivery failed   (watches the alert path itself)
 *
 * Everything is gated behind the `enableAlarms` CDK context flag, which
 * defaults to false: with the flag absent the synthesized template is
 * byte-identical to the one without this file. When the flag is on, an
 * `alarmEmail` context value is required and synthesis fails without one —
 * an alarm with no delivery path is worse than no alarm, because it looks
 * like coverage.
 *
 * The remaining catalog alarms (A01–A03, A05, A08–A12, A14, A15) are NOT here.
 * Nine of them have no publisher in the account today; A05 is demoted to a
 * periodic cost review because it fires on the same event as A04 and announces
 * money already spent. See docs/alarms.md for how to add the rest.
 */

export const ALARMS_ENABLED_CONTEXT = 'enableAlarms';
export const ALARM_EMAIL_CONTEXT = 'alarmEmail';

/** Physical name of the shared operations topic. */
export const ALERT_TOPIC_NAME = 'PolisOperationsAlerts';

/** Alarm names, stable across deploys — operators and the runbook use them. */
export const MATH_WORKER_LIVENESS_ALARM_NAME = 'Polis-Math-WorkerMetricMissing';
export const WEB_HEALTHY_HOSTS_ALARM_NAME = 'Polis-Web-NoHealthyHosts';
export const DB_CREDIT_BALANCE_ALARM_NAME = 'Polis-DB-LowCPUCreditBalance';
export const ALERT_DELIVERY_ALARM_NAME = 'Polis-Alerts-NotificationDeliveryFailed';
export const CODEDEPLOY_FAILURE_RULE_NAME = 'Polis-CodeDeploy-DeploymentFailure';

/**
 * The synth-enforced health pairing rule (plan rev2, review K2).
 *
 * Each key is a catalog alarm that is silent when its publisher dies — it uses
 * `notBreaching` or `ignore`, so with no data it holds OK forever. It is safe
 * only while at least one of the listed health alarms is enabled to catch the
 * absence. Enabling one of these without its pair produces an alarm that can
 * never fire and looks green, which is the single worst monitoring outcome.
 *
 * Only A07 is relevant to slice 1, and it is exactly why A04 is in the slice.
 * The rest are recorded here so a later slice inherits the constraint rather
 * than re-deriving it.
 */
export const HEALTH_PAIRS: Readonly<Record<string, readonly string[]>> = {
  A02: ['A03'],
  A07: ['A04', 'A03'],
  A09: ['A08'],
  A10: ['A08'],
  A11: ['A08'],
  A12: ['A13'],
  A14: ['A15'],
};

/** What the pair check needs to know about each enabled alarm. */
export interface EnabledAlarmRecord {
  /** Catalog id, e.g. `A07`. */
  id: string;
  /** Alarm name, for the failure message. */
  alarmName: string;
  treatMissingData: cloudwatch.TreatMissingData;
  /** Number of ALARM-state actions wired. Zero means it notifies nobody. */
  alarmActionCount: number;
}

/**
 * Throws unless every silent-on-publisher-death alarm in `enabled` is covered
 * by an enabled health alarm that both treats missing data as breaching and
 * actually notifies someone. Presence alone is not enough: a health alarm with
 * no action, or one that itself stays OK on missing data, does not satisfy the
 * pair (plan rev2, "Check both alarm presence and effective missing-data/action
 * wiring, so a disabled health action does not satisfy pairing").
 */
export const enforceHealthPairs = (enabled: readonly EnabledAlarmRecord[]): void => {
  const byId = new Map(enabled.map((record) => [record.id, record]));
  for (const record of enabled) {
    const required = HEALTH_PAIRS[record.id];
    if (!required) continue;
    const satisfiedBy = required.filter((healthId) => {
      const health = byId.get(healthId);
      return (
        health !== undefined &&
        health.treatMissingData === cloudwatch.TreatMissingData.BREACHING &&
        health.alarmActionCount > 0
      );
    });
    if (satisfiedBy.length === 0) {
      throw new Error(
        `P-031 health pairing: ${record.id} (${record.alarmName}) treats missing data as ` +
          `"${record.treatMissingData}", so it stays OK forever if its publisher dies. It ` +
          `requires one of [${required.join(', ')}] to be enabled with ` +
          'treatMissingData=breaching and at least one alarm action. Enable one of them, or ' +
          `drop ${record.id} from this slice.`,
      );
    }
  }
};

/**
 * Reads the `enableAlarms` context flag. Absent, or anything other than a
 * literal `true`, means off — an enable flag must default to off when it is
 * not present (the same rule delphiDemandObserver.ts follows).
 */
export const alarmsEnabled = (scope: Construct): boolean => {
  const raw = scope.node.tryGetContext(ALARMS_ENABLED_CONTEXT);
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.toLowerCase() === 'true';
};

// Deliberately loose: this rejects the mistakes that actually happen at the
// command line (empty string, a name with no domain, a stray comma-separated
// list) without pretending to validate deliverability. Confirmation of the
// subscription is manual and is the real proof the address works.
const SINGLE_EMAIL = /^[^\s@,]+@[^\s@,.]+(\.[^\s@,.]+)+$/;

/**
 * Reads and validates `alarmEmail`. Throws at synth time when the alarms are
 * enabled without a usable recipient.
 */
export const requireAlarmEmail = (scope: Construct): string => {
  const raw = scope.node.tryGetContext(ALARM_EMAIL_CONTEXT);
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (!email) {
    throw new Error(
      `${ALARMS_ENABLED_CONTEXT}=true requires a recipient: pass ` +
        `-c ${ALARM_EMAIL_CONTEXT}=ops@example.org. Alarms with no subscriber ` +
        'look like monitoring and are not.',
    );
  }
  if (!SINGLE_EMAIL.test(email)) {
    throw new Error(
      `${ALARM_EMAIL_CONTEXT} must be one email address, got ${JSON.stringify(email)}. ` +
        'Subscribe further recipients to the topic after the first deploy.',
    );
  }
  return email;
};

export interface OperationalAlarmsProps {
  /** Recipient of the email subscription. Confirmation is manual. */
  email: string;
  /** Math worker ASG — the source of the CPUUtilization presence signal. */
  mathWorkerAsgName: string;
  /** RDS instance whose CPU credit balance is watched (A04). */
  database: rds.IDatabaseInstance;
  /** `app/<name>/<id>` — the ALB dimension value. */
  loadBalancerFullName: string;
  /** `targetgroup/<name>/<id>` — the web target group dimension value. */
  webTargetGroupFullName: string;
  /** CodeDeploy application to watch for FAILURE/STOP. */
  codeDeployApplicationName: string;
  /** CodeDeploy deployment group to watch for FAILURE/STOP. */
  codeDeployDeploymentGroupName: string;
  /**
   * Existing db.ts alarms whose notifications move onto the shared topic, with
   * the catalog id each one corresponds to. The topic is ADDED to their
   * actions rather than replacing the current one: the migration must never
   * open a coverage gap, and their logical IDs stay where they are so their
   * history survives.
   */
  retargetAlarms?: RetargetedAlarm[];
}

export interface RetargetedAlarm {
  /** Catalog id, e.g. `A06`. Used by the health-pair check. */
  id: string;
  alarm: cloudwatch.Alarm;
  /** The alarm's deployed missing-data setting, verified by describe-alarms. */
  treatMissingData: cloudwatch.TreatMissingData;
}

const runbook = (anchor: string) => `Runbook: docs/alarms.md#${anchor}`;

const createOperationalAlarms = (self: Construct, props: OperationalAlarmsProps) => {
  const stack = cdk.Stack.of(self);

  // --- 1. The alert path -----------------------------------------------------
  //
  // One topic for every operational alarm. Unencrypted on purpose: this
  // carries alarm metadata only, and a CMK would drag cross-account KMS reach
  // into the path if CI ever publishes here from its own account.
  const topic = new sns.Topic(self, 'OperationalAlertsTopic', {
    topicName: ALERT_TOPIC_NAME,
    displayName: 'Polis Operations Alerts',
  });

  // Email subscriptions are PENDING until the recipient clicks the AWS
  // confirmation link. CloudFormation reports CREATE_COMPLETE either way, so a
  // green deploy is NOT evidence that anything can be delivered. See
  // docs/alarms.md#confirming-the-email-subscription.
  topic.addSubscription(new subscriptions.EmailSubscription(props.email));

  // An explicit topic policy replaces the SNS default, so the account-owner
  // statement is restated here rather than lost. CloudWatch is narrowed to
  // alarms in this account; EventBridge is narrowed by the events target grant
  // that `targets.SnsTopic` adds below.
  topic.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowOwnerFullControl',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        'SNS:GetTopicAttributes',
        'SNS:SetTopicAttributes',
        'SNS:AddPermission',
        'SNS:RemovePermission',
        'SNS:DeleteTopic',
        'SNS:Subscribe',
        'SNS:ListSubscriptionsByTopic',
        'SNS:Publish',
      ],
      resources: [topic.topicArn],
      conditions: { StringEquals: { 'AWS:SourceOwner': stack.account } },
    }),
  );
  topic.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsInThisAccount',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['SNS:Publish'],
      resources: [topic.topicArn],
      conditions: { StringEquals: { 'AWS:SourceAccount': stack.account } },
    }),
  );

  const enabled: EnabledAlarmRecord[] = [];

  const notify = (
    id: string,
    alarm: cloudwatch.Alarm,
    treatMissingData: cloudwatch.TreatMissingData,
    alarmName: string,
  ) => {
    const action = new cw_actions.SnsAction(topic);
    alarm.addAlarmAction(action);
    // OK is sent too: an operator who saw the ALARM email needs to know it
    // cleared without logging in. Email is not a paging system and SNS sends on
    // state transition only — a persisting ALARM does not re-notify.
    alarm.addOkAction(action);
    enabled.push({ id, alarmName, treatMissingData, alarmActionCount: 1 });
    return alarm;
  };

  // --- 2. A17: math ASG missing-metric alarm (review K1) ---------------------
  //
  // The 2026-09-08 math outage presented as a 75-minute HOLE in
  // AWS/EC2 CPUUtilization for the math ASG (old instance terminated, its
  // replacement never reached InService, so nothing published on the ASG
  // dimension) and produced ZERO sub-1% buckets. Every alarm in the original
  // P-031 catalog would have stayed silent.
  //
  // The threshold is < 0%, which no real CPU reading can satisfy. That is the
  // point: this is a presence alarm, and `treatMissingData: BREACHING` is the
  // whole mechanism. Interpreting a low CPU value as failure would be a
  // different, noisier claim — an idle math worker is legitimately quiet.
  //
  // AWS/AutoScaling GroupInServiceInstances would be the tidier metric, but
  // `list-metrics --namespace AWS/AutoScaling` returns [] — ASG group metrics
  // are not enabled on this account, so that would need turning on first.
  //
  // 2/3 does not guarantee a transition at exactly two missing periods:
  // CloudWatch retrieves an extended evaluation range and may use older real
  // datapoints. Validate against an isolated drill, not arithmetic.
  //
  // Measured over the four days to 2026-09-08: 1138 of 1152 five-minute
  // buckets present, Minimum ranging 5.69%–25.44%, and exactly one gap — the
  // outage itself.
  const mathWorkerMetricMissing = notify(
    'A17',
    new cloudwatch.Alarm(self, 'MathWorkerMetricMissingAlarm', {
      alarmName: MATH_WORKER_LIVENESS_ALARM_NAME,
      alarmDescription:
        'A17: the math worker ASG has stopped publishing CPU metrics — the instance is gone, ' +
        'stuck out of service, or never finished booting. Detects ABSENCE only; the <0% ' +
        'threshold is unreachable by a real reading, so a low CPU value never fires it. ' +
        `${runbook('polis-math-workermetricmissing')}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: { AutoScalingGroupName: props.mathWorkerAsgName },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }),
    cloudwatch.TreatMissingData.BREACHING,
    MATH_WORKER_LIVENESS_ALARM_NAME,
  );

  // --- 3. Web healthy hosts (catalog A13) ------------------------------------
  //
  // Dimensions are the target group and the load balancer, with no
  // AvailabilityZone: the per-AZ series exist and would each go to zero during
  // an ordinary AZ rebalance. Verified read-only against `list-metrics`: the
  // account has exactly one target group, published with both the two- and the
  // three-dimension (per-AZ) shapes.
  //
  // Measured over the same four days: 1152 of 1152 buckets present, Minimum
  // 2.0–7.0, zero buckets under 1.
  const webHealthyHosts = notify(
    'A13',
    new cloudwatch.Alarm(self, 'WebHealthyHostsAlarm', {
      alarmName: WEB_HEALTHY_HOSTS_ALARM_NAME,
      alarmDescription:
        'A13: the web target group has no healthy target. Urgent even at zero traffic; does not ' +
        'assume the web ASG minimum stays at two. Missing data is breaching because a target ' +
        `group with no targets stops publishing. ${runbook('polis-web-nohealthyhosts')}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HealthyHostCount',
        dimensionsMap: {
          TargetGroup: props.webTargetGroupFullName,
          LoadBalancer: props.loadBalancerFullName,
        },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }),
    cloudwatch.TreatMissingData.BREACHING,
    WEB_HEALTHY_HOSTS_ALARM_NAME,
  );

  // --- 4. A04: RDS CPU credit balance ---------------------------------------
  //
  // In the slice because A07 uses `ignore`, which retains the last state and so
  // holds OK forever if the database stops publishing. A04 is its health pair:
  // `breaching` on the same instance, so a vanished DB is caught. Without it
  // the pair check below fails synthesis rather than shipping A07's retarget as
  // if it were new missing-RDS coverage.
  //
  // Threshold basis: two vCPUs × (100% − 30% baseline) = 1.4 net credits/min
  // under sustained full load, so 60 credits is roughly 43 minutes of warning.
  // It is an operating margin, not an exhaustion forecast — and on a T3 in
  // unlimited mode, zero credits means surplus charges, not throttling.
  //
  // Re-baselined read-only over the four days to 2026-09-08: 1151 five-minute
  // buckets, Minimum 787.17–864.00 (864 is the db.t3.large ceiling), average
  // 854.58, and zero periods below 60. The same alarm would have been ALARM for
  // ~8 continuous days ending 2026-09-02 (802/960 periods breaching). The cause
  // of the recovery is not established; if it is a side effect of another cost
  // change it can regress silently, which is exactly why this alarm exists.
  const dbCreditBalance = notify(
    'A04',
    new cloudwatch.Alarm(self, 'DatabaseCpuCreditBalanceAlarm', {
      alarmName: DB_CREDIT_BALANCE_ALARM_NAME,
      alarmDescription:
        'A04: the database CPU credit reserve is nearly exhausted. On a T3 in unlimited mode ' +
        'this is cost exposure and lost headroom, NOT proof of throttling. Also the health pair ' +
        'for the free-storage alarm: breaching on missing data, so a database that stops ' +
        `publishing is detected. ${runbook('polis-db-lowcpucreditbalance')}`,
      metric: props.database.metric('CPUCreditBalance', {
        period: cdk.Duration.minutes(5),
        statistic: 'Minimum',
      }),
      threshold: 60,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }),
    cloudwatch.TreatMissingData.BREACHING,
    DB_CREDIT_BALANCE_ALARM_NAME,
  );

  // --- 5. A06 / A07 retarget -------------------------------------------------
  //
  // `Polis-DB-HighCPUUtilization` and `Polis-DB-LowFreeStorageSpace` are live
  // in the account and are already CDK-managed by db.ts, with settings that
  // match the catalog exactly (verified by `describe-alarms`, review K9). So
  // there is nothing to duplicate: the construct only adds this topic to their
  // actions. Their logical IDs, metrics, thresholds and missing-data settings
  // are untouched, which is what preserves their alarm history.
  //
  // `Polis-DB-HighDatabaseConnections` (review K7) is deliberately left alone
  // in this slice. Because the existing DatabaseAlarmsTopic action stays in
  // place on all three, delivery does not split — the shared topic is added,
  // not swapped in. See docs/alarms.md#existing-database-alarms.
  for (const retargeted of props.retargetAlarms ?? []) {
    notify(
      retargeted.id,
      retargeted.alarm,
      retargeted.treatMissingData,
      retargeted.alarm.alarmName,
    );
  }

  // --- 6. A16: CodeDeploy FAILURE/STOP ---------------------------------------
  //
  // STOP is included: an intentional cancellation is still context an operator
  // needs mid-incident. START and SUCCESS are not — this is a failure signal,
  // not a deployment audit, and EventBridge delivery is best effort.
  const codeDeployFailureRule = new events.Rule(self, 'CodeDeployFailureRule', {
    ruleName: CODEDEPLOY_FAILURE_RULE_NAME,
    description:
      'CodeDeploy deployment entered FAILURE or STOP; notifies the operations topic (P-031 A16).',
    eventPattern: {
      account: [stack.account],
      region: [stack.region],
      source: ['aws.codedeploy'],
      detailType: ['CodeDeploy Deployment State-change Notification'],
      detail: {
        application: [props.codeDeployApplicationName],
        deploymentGroup: [props.codeDeployDeploymentGroupName],
        state: ['FAILURE', 'STOP'],
      },
    },
    targets: [
      new targets.SnsTopic(topic, {
        message: events.RuleTargetInput.fromText(
          [
            `CodeDeploy ${events.EventField.fromPath('$.detail.state')}: ` +
              `${events.EventField.fromPath('$.detail.application')} / ` +
              `${events.EventField.fromPath('$.detail.deploymentGroup')}`,
            `deployment ${events.EventField.fromPath('$.detail.deploymentId')}`,
            `at ${events.EventField.fromPath('$.time')}`,
            `https://console.aws.amazon.com/codesuite/codedeploy/deployments/` +
              `${events.EventField.fromPath('$.detail.deploymentId')}?region=${stack.region}`,
            runbook('polis-codedeploy-deploymentfailure'),
          ].join('\n'),
        ),
      }),
    ],
  });

  // `targets.SnsTopic` grants events.amazonaws.com an unconditioned
  // `sns:Publish`, which would let any EventBridge rule in any account publish
  // here. CDK offers no hook to narrow that grant, so it is fenced with an
  // explicit Deny instead: EventBridge may publish only on behalf of this one
  // rule. `ArnNotEquals` also matches when the key is absent, so a request
  // carrying no source ARN is denied too.
  topic.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyEventBridgeExceptTheCodeDeployRule',
      effect: iam.Effect.DENY,
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: { ArnNotEquals: { 'aws:SourceArn': codeDeployFailureRule.ruleArn } },
    }),
  );

  // --- 7. A18: who watches the watcher (review K6) ---------------------------
  //
  // A one-off delivery drill proves the path worked on the day it was run. It
  // does not detect a subscription later disabled by bounces. This alarm does,
  // continuously. `notBreaching` because the metric is emitted only on failure
  // and a healthy topic publishes nothing here.
  //
  // Two limitations to state plainly rather than paper over:
  //   * A DELETED subscription produces no failed delivery attempt at all, so
  //     A18 does not see it. Periodic subscription checks remain necessary.
  //   * Its own action is this same topic, so a failure of the only email path
  //     also prevents its own notification. That case shows only in the
  //     CloudWatch console — which is why alarm state, not just the inbox, is
  //     what gets checked. Two confirmed recipients reduce single-mailbox loss.
  const alertDeliveryFailed = notify(
    'A18',
    new cloudwatch.Alarm(self, 'AlertDeliveryFailedAlarm', {
      alarmName: ALERT_DELIVERY_ALARM_NAME,
      alarmDescription:
        'A18: SNS reported a failed delivery of an operational alert. The alert path itself is ' +
        'degraded: assume any alarm raised in this window was not seen. Does NOT detect a ' +
        'deleted subscription, and cannot notify through the path it is reporting on. ' +
        `${runbook('polis-alerts-notificationdeliveryfailed')}`,
      metric: topic.metricNumberOfNotificationsFailed({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
    cloudwatch.TreatMissingData.NOT_BREACHING,
    ALERT_DELIVERY_ALARM_NAME,
  );

  // --- 8. Synth-enforced health pairing (plan rev2, review K2) ---------------
  //
  // Runs last so it sees the whole enabled set. This throws during `cdk synth`,
  // before anything can be deployed.
  enforceHealthPairs(enabled);

  return {
    topic,
    mathWorkerMetricMissing,
    webHealthyHosts,
    dbCreditBalance,
    codeDeployFailureRule,
    alertDeliveryFailed,
    retargetedAlarms: props.retargetAlarms ?? [],
    enabledAlarms: enabled,
  };
};

export default createOperationalAlarms;
