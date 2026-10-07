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
 * Worker classes on the Postgres job queue (P-073 r2, P-086; the placement
 * principle: the queue is the unit of placement).
 *
 * Workers of any class on any number of boxes claim from the same Postgres
 * queue; leases, epochs and exit proof make that safe. This file turns a
 * TABLE of classes (`workerClassTable`) into one Auto Scaling group per
 * class, each with its own launch template and instance role, scaled by its
 * own queue-depth metrics. The real-time math host is the existing Delphi
 * small group and is not touched here.
 *
 * Today's rows:
 *
 *   math-large  r7i.2xlarge, 0..1, cgroup 52g, POLIS_JOBS_WORKER_CLASS=large.
 *               Rebuilds of conversations the small poller cannot fit. It
 *               reuses the stack's AsgDelphiLarge / DelphiLargeLaunchTemplate
 *               / DelphiLargeInstanceRole ids (the group has been at 0 since
 *               2026-07-31), so turning the flag on updates that group in
 *               place. Service type `delphi-large`, the branch
 *               scripts/after_install.sh already has.
 *   delphi      r7i.2xlarge, 0..3, cgroup 52g, POLIS_JOBS_WORKER_CLASS=delphi.
 *               The Delphi stages (P-077). Nothing enqueues delphi jobs yet
 *               and nothing reports their depth, so the group stays at 0.
 *               Service type `delphi-worker`. Not in the CodeDeploy group
 *               until scripts/after_install.sh has a branch for that type (an
 *               unknown type starts every service), so a box of this class
 *               gets no deploy, its daemon unit waits for the env document,
 *               and MissingWorker says so.
 *
 * Demand comes from the queue, never from a manifest. The small math poller
 * logs one bare JSON capacity line per readiness interval
 * (delphi/polismath/poller/capacity.py, schema `math_poller.capacity/1`,
 * class `small`, role `primary`) whose large_* counts are the queue's
 * `pq_class_depth` for worker class `large`: `large_demand` (queued),
 * `large_leased` (running), `large_parked`, `large_dead`, `large_poisoned`
 * (routed records whose last job died under this source commit),
 * `oldest_queued_age_ms`, and the queue-wide `queue_full`,
 * `queue_unreachable`, `queue_bytes`, `sweep_age_ms`. Each row of the table
 * names the keys its metric filters read; the delphi row's keys are the same
 * shape with a `delphi_` prefix and are not emitted by anything today.
 *
 * Per class (all CloudWatch metric filters and alarms; no Lambda):
 *
 *   ScaleOut      demand >= 1 for `largeClassOutPeriods` (2) periods -> a step
 *                 policy with EXACT_CAPACITY: one worker per `jobsPerWorker`
 *                 queued jobs, up to the row's maximum.
 *   ScaleIn       demand + leased + parked = 0, every term reported, for
 *                 `largeClassInPeriods` (6) periods -> exact capacity 0. A
 *                 missing term never reads as 0. Parked is in the sum (P-086): a
 *                 terminated box loses its journal, so a job parked on it could
 *                 never prove its exit. The demand term keeps ScaleOut and
 *                 ScaleIn mutually exclusive, so the group never flaps.
 *   DemandUnmet   (rows with a promotion step) pending_promotion >= 1 or
 *                 oldest_unresolved_age_ms >= `largeClassUnmetAgeMs` (3 h) for
 *                 `largeClassUnmetPeriods` (6) periods.
 *   LongRunning   an instance in service for `largeClassLongRunningPeriods`
 *                 (72) periods (6 h): the cost guard.
 *   Parked        parked >= 1 for 3 periods: run the recovery in P-086.
 *   Dead          dead + poisoned >= 1: a ruling is owed.
 *   OldestQueued  oldest_queued_age_ms >= `queueOldestQueuedMs` (2 h).
 *   MissingWorker in-service instances >= 1 and no daemon heartbeat for 3
 *                 periods: box up, daemon not running. The heartbeat is the
 *                 literal `polis_jobs readiness/1 role=worker` the daemon logs
 *                 (queue-rs/src/jobs/readiness.rs); that line carries no class,
 *                 so the count is shared by every worker class.
 *   WorkerDisk    the CloudWatch agent's disk_free for the group <=
 *                 `workerDiskMinBytes` (5 GiB). The daemon's readiness line
 *                 has a text prefix, so a JSON metric filter cannot read a
 *                 disk key from it; the worker boxes run the agent with
 *                 config/amazon-cloudwatch-agent-worker.json, which adds
 *                 `free` and an AutoScalingGroupName roll-up.
 *
 * Once, on the queue itself: Unreachable (routing is refusing), Bytes
 * (`queueBytesLimit`, 1.5 GiB), SweepLag (`queueSweepLagMs`, 2 days), Full.
 *
 * Periods are 5 minutes. No filter sets a defaultValue: an interval without
 * a capacity line is missing data, never a manufactured 0. A standby logs
 * null counts, which a numeric metric filter does not turn into a value.
 *
 * A worker's user data (launchTemplates.ts) records the daemon's class, its
 * memory limit, its image, the NAME of the restricted queue login's secret,
 * the TLS CA file and host allowlist, and the row's child settings (the
 * large child's staged label) in the env document under /etc/app-info, and
 * starts the daemon with that class (systemd unit polis-jobs.service); the
 * class role may read that secret by name. The login itself is provisioned by
 * the owner; nothing here creates it.
 *
 * Off unless synthesized with `-c enableLargeClass=true`: with the flag off
 * the template is byte-identical (test/workerClasses.test.ts).
 */

export const LARGE_CLASS_CONTEXT = 'enableLargeClass';
export const CAPACITY_NAMESPACE = 'Polis/MathCapacity';
export const CAPACITY_SCHEMA = 'math_poller.capacity/1';
export const AGENT_NAMESPACE = 'CWAgent';
export const WORKER_DISK_METRIC = 'disk_free';
/** The literal prefix of the jobs daemon's readiness line (readiness.rs). */
export const WORKER_HEARTBEAT_PHRASE = 'polis_jobs readiness/1 role=worker';
export const WORKER_HEARTBEAT_METRIC = 'WorkerHeartbeat';
export const WORKER_AGENT_CONFIG = 'config/amazon-cloudwatch-agent-worker.json';

export const MATH_LARGE_CLASS = 'math-large';
export const DELPHI_CLASS = 'delphi';

/** The service type each class writes to /etc/app-info/service_type.txt. */
export const LARGE_SERVICE_TYPE = 'delphi-large';
export const DELPHI_WORKER_SERVICE_TYPE = 'delphi-worker';

/**
 * The label the large class stages under: the large child's MATH_ENV. It must
 * equal the small poller's MATH_CAPACITY_STAGED_LABEL, whose default is this
 * string (delphi/polismath/poller/capacity.py DEFAULT_STAGED_LABEL; a test
 * reads both). The child refuses a frame staged for any other label.
 */
export const STAGED_LABEL = 'python-large';

/** Metric names on the math-large row (the P-073 names, kept). */
export const LARGE_DEMAND_METRIC = 'LargeDemand';
export const LARGE_BUSY_METRIC = 'LargeBusy';
export const PENDING_PROMOTION_METRIC = 'PendingPromotion';
export const OLDEST_UNRESOLVED_METRIC = 'OldestUnresolvedAgeMs';

/** The math-large row's alarm names (the P-073 names, kept). */
export const SCALE_OUT_ALARM_NAME = 'Polis-LargeClass-ScaleOut';
export const SCALE_IN_ALARM_NAME = 'Polis-LargeClass-ScaleIn';
export const DEMAND_UNMET_ALARM_NAME = 'Polis-LargeClass-DemandUnmet';
export const LONG_RUNNING_ALARM_NAME = 'Polis-LargeClass-LongRunning';

/** The queue-wide alarm names (P-086). */
export const QUEUE_UNREACHABLE_ALARM_NAME = 'Polis-Queue-Unreachable';
export const QUEUE_BYTES_ALARM_NAME = 'Polis-Queue-Bytes';
export const QUEUE_SWEEP_LAG_ALARM_NAME = 'Polis-Queue-SweepLag';
export const QUEUE_FULL_ALARM_NAME = 'Polis-Queue-Full';

/** The JSON filter for the small poller's primary capacity line. */
export const capacityFilter = (klass: 'small' | 'large' = 'small') =>
  `{ $.schema = "${CAPACITY_SCHEMA}" && $.class = "${klass}" && $.role = "primary" }`;

/** Reads the flag; absent or anything but a literal true means off. */
export const largeClassEnabled = (scope: Construct): boolean => {
  const raw = scope.node.tryGetContext(LARGE_CLASS_CONTEXT);
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.toLowerCase() === 'true';
};

/** The capacity-line keys one class's filters read. */
export interface WorkerClassKeys {
  demand: string;
  leased: string;
  parked: string;
  dead: string;
  /** Routed records the queue refused as poisoned; counted with `dead`. */
  poisoned?: string;
  oldestQueuedAgeMs: string;
}

/** One row of the class table. */
export interface WorkerClassSpec {
  /** The class as the docket names it. */
  name: string;
  /** Construct id stem: `<id>InstanceRole`, `<id>LaunchTemplate`, `Asg<id>`. */
  id: string;
  /** Written to /etc/app-info/service_type.txt; scripts/after_install.sh branches on it. */
  serviceType: string;
  /** POLIS_JOBS_WORKER_CLASS for the daemon on this box. */
  workerClass: string;
  instanceType: ec2.InstanceType;
  minCapacity: number;
  maxCapacity: number;
  /** Scale-out: one worker per this many queued jobs, up to maxCapacity. */
  jobsPerWorker: number;
  /** The cgroup memory limit for the daemon's child (a docker --memory value). */
  containerMemory: string;
  rootVolumeGb: number;
  /** Alarm names are `<alarmPrefix>-<Name>`; filter names `<alarmPrefix>-<Metric>`. */
  alarmPrefix: string;
  /** Per-class metric names are `<metricPrefix><Name>`. */
  metricPrefix: string;
  keys: WorkerClassKeys;
  /** Rows whose output the small poller promotes (DemandUnmet). */
  promotion?: { pendingKey: string; oldestUnresolvedKey: string };
  /**
   * The child's own settings, written into the box's env document after the
   * shared app .env (so they win over it): the large child's staged label,
   * and the small poller's routing/promotion settings turned off (the child
   * refuses to run with them on). Absent: the child sees the shared .env only.
   */
  childEnv?: Record<string, string>;
  /**
   * The child checks the frame's source commit against
   * MATH_POLLER_SOURCE_COMMIT (the deploy hook appends it to .env): the unit
   * refuses to start the daemon without one, so no job is claimed only for
   * its child to refuse it.
   */
  requiresSourceCommit?: boolean;
}

export interface WorkerClassesSettings {
  classes: WorkerClassSpec[];
  /** The Secrets Manager NAME of the restricted queue login (provisioned by the owner). */
  queueLoginSecretName: string;
  /** The image the worker daemon runs from (the Delphi image the deploy builds on the box). */
  workerImage: string;
  /**
   * POLIS_JOBS_HOST_ALLOWLIST: the hosts the daemon's TLS connection may
   * name. Context `queueHostAllowlist`; absent, the stack's RDS instance
   * endpoint (the queue lives in the application database).
   */
  queueHostAllowlist?: string;
  outPeriods: number;
  inPeriods: number;
  unmetPeriods: number;
  unmetAgeMs: number;
  longRunningPeriods: number;
  oldestQueuedMs: number;
  queueBytesLimit: number;
  sweepLagMs: number;
  workerDiskMinBytes: number;
}

const positiveInt = (scope: Construct, key: string, fallback: number): number => {
  const raw = scope.node.tryGetContext(key);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`context ${key} must be a positive integer, got ${raw}`);
  return n;
};

const GIB = 1024 * 1024 * 1024;

/** The class table. Instance types and the delphi maximum come from context. */
export const workerClassTable = (scope: Construct): WorkerClassSpec[] => {
  const ctx = (key: string, fallback: string) =>
    (scope.node.tryGetContext(key) as string | undefined) ?? fallback;
  return [
    {
      name: MATH_LARGE_CLASS,
      id: 'DelphiLarge',
      serviceType: LARGE_SERVICE_TYPE,
      workerClass: 'large',
      // r7i.2xlarge: 8 vCPU / 64 GiB x86, the small box's family; room for a 52g cgroup.
      instanceType: new ec2.InstanceType(ctx('largeClassInstanceType', 'r7i.2xlarge')),
      minCapacity: 0,
      maxCapacity: 1,
      jobsPerWorker: 1,
      containerMemory: '52g',
      rootVolumeGb: 100,
      alarmPrefix: 'Polis-LargeClass',
      metricPrefix: 'Large',
      keys: {
        demand: 'large_demand',
        leased: 'large_leased',
        parked: 'large_parked',
        dead: 'large_dead',
        poisoned: 'large_poisoned',
        oldestQueuedAgeMs: 'oldest_queued_age_ms',
      },
      promotion: { pendingKey: 'pending_promotion', oldestUnresolvedKey: 'oldest_unresolved_age_ms' },
      childEnv: {
        MATH_ENV: STAGED_LABEL,
        MATH_CAPACITY_ROUTING: '0',
        MATH_CAPACITY_PROMOTE: '0',
        MATH_CAPACITY_RESTAGE: '',
      },
      requiresSourceCommit: true,
    },
    {
      name: DELPHI_CLASS,
      id: 'WorkerDelphi',
      serviceType: DELPHI_WORKER_SERVICE_TYPE,
      workerClass: 'delphi',
      // Same family as every Delphi box (no new numerics question); 64 GiB holds a
      // large conversation's embedding and topic stages. Override with context.
      instanceType: new ec2.InstanceType(ctx('delphiClassInstanceType', 'r7i.2xlarge')),
      minCapacity: 0,
      maxCapacity: positiveInt(scope, 'delphiClassMaxCapacity', 3),
      jobsPerWorker: 2,
      containerMemory: '52g',
      rootVolumeGb: 100,
      alarmPrefix: 'Polis-DelphiClass',
      metricPrefix: 'Delphi',
      keys: {
        demand: 'delphi_demand',
        leased: 'delphi_leased',
        parked: 'delphi_parked',
        dead: 'delphi_dead',
        oldestQueuedAgeMs: 'delphi_oldest_queued_age_ms',
      },
    },
  ];
};

export const workerClassesSettings = (scope: Construct): WorkerClassesSettings => {
  const ctx = (key: string, fallback: string) =>
    (scope.node.tryGetContext(key) as string | undefined) ?? fallback;
  return {
    classes: workerClassTable(scope),
    queueLoginSecretName: ctx('queueLoginSecretName', 'polis-queue-login'),
    workerImage: ctx('workerImage',
      `${cdk.Stack.of(scope).account}.dkr.ecr.${cdk.Stack.of(scope).region}.amazonaws.com/polis/delphi:latest`),
    queueHostAllowlist: scope.node.tryGetContext('queueHostAllowlist') as string | undefined,
    outPeriods: positiveInt(scope, 'largeClassOutPeriods', 2),
    inPeriods: positiveInt(scope, 'largeClassInPeriods', 6),
    unmetPeriods: positiveInt(scope, 'largeClassUnmetPeriods', 6),
    unmetAgeMs: positiveInt(scope, 'largeClassUnmetAgeMs', 3 * 60 * 60 * 1000),
    longRunningPeriods: positiveInt(scope, 'largeClassLongRunningPeriods', 72),
    oldestQueuedMs: positiveInt(scope, 'queueOldestQueuedMs', 2 * 60 * 60 * 1000),
    queueBytesLimit: positiveInt(scope, 'queueBytesLimit', 1.5 * GIB),
    sweepLagMs: positiveInt(scope, 'queueSweepLagMs', 2 * 24 * 60 * 60 * 1000),
    workerDiskMinBytes: positiveInt(scope, 'workerDiskMinBytes', 5 * GIB),
  };
};

/** The row the stack's existing AsgDelphiLarge ids belong to. */
export const mathLargeRow = (s: WorkerClassesSettings): WorkerClassSpec => {
  const row = s.classes.find((c) => c.name === MATH_LARGE_CLASS);
  if (!row) throw new Error(`the class table has no ${MATH_LARGE_CLASS} row`);
  return row;
};

/** Everything a class gets besides its role: filled in by the other modules. */
export type ByClass<T> = Record<string, T>;

/**
 * A worker class's own instance role, scoped to what its boot and deploy
 * path use. Unlike the shared InstanceRole it has no SecretsManagerReadWrite,
 * no CloudWatchLogsFullAccess and no S3 access at all:
 *
 *   - SSM core (session access) and the CloudWatch agent policy (memory and
 *     disk metrics; also logs:PutLogEvents for the docker awslogs driver);
 *   - logs:CreateLogStream / PutLogEvents on the stack log group;
 *   - ssm:GetParameter on /polis/db-secret-arn, /polis/db-host, /polis/db-port
 *     and read on polis-web-app-env-vars and the DB secret (after_install.sh;
 *     granted where those secrets are created);
 *   - secretsmanager:GetSecretValue on the restricted queue login's secret,
 *     by name.
 *
 * The CodeDeploy revision bucket, the agent installer bucket and the CW
 * agent config assets are granted to it by the constructs that own them.
 */
export const createWorkerRole = (
  scope: Construct, spec: WorkerClassSpec, s: WorkerClassesSettings, logGroup: logs.ILogGroup,
) => {
  const stack = cdk.Stack.of(scope);
  const role = new iam.Role(scope, `${spec.id}InstanceRole`, {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    description: `Queue worker class ${spec.name} (service type ${spec.serviceType}): the jobs daemon only`,
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
    sid: 'QueueLoginRead',
    actions: ['secretsmanager:GetSecretValue'],
    resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${s.queueLoginSecretName}-*`],
  }));
  return role;
};

export const createWorkerRoles = (scope: Construct, s: WorkerClassesSettings, logGroup: logs.ILogGroup) =>
  Object.fromEntries(s.classes.map((c) => [c.name, createWorkerRole(scope, c, s, logGroup)])) as ByClass<iam.Role>;

export interface WorkerClassesProps {
  groups: ByClass<autoscaling.AutoScalingGroup>;
  logGroup: logs.ILogGroup;
  alarmTopic: sns.ITopic;
  settings: WorkerClassesSettings;
}

export const createWorkerClasses = (scope: Construct, props: WorkerClassesProps) => {
  const { groups, logGroup, alarmTopic, settings: s } = props;
  const period = cdk.Duration.minutes(5);
  const notify = (alarm: cloudwatch.Alarm) => {
    alarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
    alarm.addOkAction(new cw_actions.SnsAction(alarmTopic));
    return alarm;
  };
  const capacityMetric = (id: string, filterName: string, metricName: string, field: string) =>
    new logs.MetricFilter(scope, id, {
      logGroup,
      filterName,
      filterPattern: logs.FilterPattern.literal(capacityFilter('small')),
      metricNamespace: CAPACITY_NAMESPACE,
      metricName,
      metricValue: `$.${field}`,
      unit: cloudwatch.Unit.COUNT,
    }).metric({ statistic: 'Maximum', period });

  // The daemon's heartbeat, counted across every worker class (the line has no class).
  const heartbeat = new logs.MetricFilter(scope, 'WorkerHeartbeatFilter', {
    logGroup,
    filterName: `Polis-Queue-${WORKER_HEARTBEAT_METRIC}`,
    filterPattern: logs.FilterPattern.literal(`"${WORKER_HEARTBEAT_PHRASE}"`),
    metricNamespace: CAPACITY_NAMESPACE,
    metricName: WORKER_HEARTBEAT_METRIC,
    metricValue: '1',
    unit: cloudwatch.Unit.COUNT,
  }).metric({ statistic: 'Sum', period });

  const perClass: ByClass<Record<string, cloudwatch.Alarm>> = {};
  for (const c of s.classes) {
    const asg = groups[c.name];
    if (!asg) throw new Error(`no Auto Scaling group for worker class ${c.name}`);
    const m = (name: string) => `${c.metricPrefix}${name}`;
    const filterOf = (name: string, metricName: string, field: string) =>
      capacityMetric(`${c.id}${name}Filter`, `${c.alarmPrefix}-${metricName}`, metricName, field);
    const alarmName = (name: string) => `${c.alarmPrefix}-${name}`;

    const demand = filterOf('Demand', m('Demand'), c.keys.demand);
    const leased = filterOf('Busy', m('Busy'), c.keys.leased);
    const parked = filterOf('Parked', m('Parked'), c.keys.parked);
    const dead = filterOf('Dead', m('Dead'), c.keys.dead);
    const poisoned = c.keys.poisoned ? filterOf('Poisoned', m('Poisoned'), c.keys.poisoned) : undefined;
    const oldestQueued = filterOf('OldestQueued', m('OldestQueuedAgeMs'), c.keys.oldestQueuedAgeMs);
    const inService = new cloudwatch.Metric({
      namespace: 'AWS/AutoScaling',
      metricName: 'GroupInServiceInstances',
      dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
      statistic: 'Maximum',
      period,
    });

    // Scale out: exact capacity, one worker per jobsPerWorker queued jobs, so a
    // repeated invocation at the same depth is a no-op.
    const scaleOut = new autoscaling.StepScalingAction(scope, `${c.id}ScaleOutPolicy`, {
      autoScalingGroup: asg,
      adjustmentType: autoscaling.AdjustmentType.EXACT_CAPACITY,
    });
    for (let n = 1; n <= c.maxCapacity; n += 1) {
      scaleOut.addAdjustment({
        lowerBound: (n - 1) * c.jobsPerWorker,
        upperBound: n < c.maxCapacity ? n * c.jobsPerWorker : undefined,
        adjustment: n,
      });
    }
    const scaleOutAlarm = new cloudwatch.Alarm(scope, `${c.id}ScaleOutAlarm`, {
      alarmName: alarmName('ScaleOut'),
      alarmDescription:
        `Queue class ${c.name}: jobs of worker class ${c.workerClass} are queued ` +
        `(${c.keys.demand} on the capacity line). Starts workers: one per ${c.jobsPerWorker} ` +
        `queued jobs, at most ${c.maxCapacity}.`,
      metric: demand,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: s.outPeriods,
      datapointsToAlarm: s.outPeriods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    scaleOutAlarm.addAlarmAction(new cw_actions.AutoScalingAction(scaleOut));

    // Scale in: exact capacity 0 once nothing is queued, running or parked,
    // each term REPORTED (P-086). A missing series is not a 0: with the small
    // poller down, or before it emits the parked key, parked is unknown and a
    // terminated box could strand a parked job, so the group stays up and
    // LongRunning is the cost guard.
    const scaleIn = new autoscaling.StepScalingAction(scope, `${c.id}ScaleInPolicy`, {
      autoScalingGroup: asg,
      adjustmentType: autoscaling.AdjustmentType.EXACT_CAPACITY,
    });
    scaleIn.addAdjustment({ upperBound: 0, adjustment: 0 });
    const scaleInAlarm = new cloudwatch.Alarm(scope, `${c.id}ScaleInAlarm`, {
      alarmName: alarmName('ScaleIn'),
      alarmDescription:
        `Queue class ${c.name}: nothing queued, leased or parked for worker class ` +
        `${c.workerClass}. Stops the workers (exact capacity 0). Parked blocks scale-in: a ` +
        'terminated box loses its journal and a job parked on it could never prove its exit.',
      metric: new cloudwatch.MathExpression({
        expression: 'demand + leased + parked',
        usingMetrics: { demand, leased, parked },
        period,
        label: `${c.name} queued + leased + parked`,
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: s.inPeriods,
      datapointsToAlarm: s.inPeriods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    scaleInAlarm.addAlarmAction(new cw_actions.AutoScalingAction(scaleIn));

    const alarms: Record<string, cloudwatch.Alarm> = { scaleOut: scaleOutAlarm, scaleIn: scaleInAlarm };

    if (c.promotion) {
      const pending = filterOf('PendingPromotion', PENDING_PROMOTION_METRIC, c.promotion.pendingKey);
      const oldest = filterOf('OldestUnresolved', OLDEST_UNRESOLVED_METRIC, c.promotion.oldestUnresolvedKey);
      alarms.demandUnmet = notify(new cloudwatch.Alarm(scope, `${c.id}DemandUnmetAlarm`, {
        alarmName: alarmName('DemandUnmet'),
        alarmDescription:
          `Queue class ${c.name}: work is staged but not promoted, or a routed conversation has had ` +
          `input not reflected in the served label for ${s.unmetAgeMs} ms. Expected while ` +
          'MATH_CAPACITY_PROMOTE=0. Otherwise check the worker (skew, capacity) and the small ' +
          'poller\'s promotion loop. Runbook: cost-reduction plan P-073.',
        metric: new cloudwatch.MathExpression({
          expression: `IF(pending >= 1 || FILL(oldest, 0) >= ${s.unmetAgeMs}, 1, 0)`,
          usingMetrics: { pending, oldest },
          period,
          label: `${c.name} demand unmet`,
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: s.unmetPeriods,
        datapointsToAlarm: s.unmetPeriods,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    }

    alarms.longRunning = notify(new cloudwatch.Alarm(scope, `${c.id}LongRunningAlarm`, {
      alarmName: alarmName('LongRunning'),
      alarmDescription:
        `Queue class ${c.name}: a worker has been in service for ` +
        `${(s.longRunningPeriods * 5) / 60} hours. Cost guard: repeated firing is the evidence ` +
        'for a fixed resize instead of the autoscaled class.',
      metric: inService,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: s.longRunningPeriods,
      datapointsToAlarm: s.longRunningPeriods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    alarms.parked = notify(new cloudwatch.Alarm(scope, `${c.id}ParkedAlarm`, {
      alarmName: alarmName('Parked'),
      alarmDescription:
        `Queue class ${c.name}: a job of worker class ${c.workerClass} is parked (exit not ` +
        'proven, or a provider is open). Run the recovery in cost-reduction plan P-086: the ' +
        'daemon rediscovers it from SQL; a terminated instance is confirmed with one operator command.',
      metric: parked,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    alarms.dead = notify(new cloudwatch.Alarm(scope, `${c.id}DeadAlarm`, {
      alarmName: alarmName('Dead'),
      alarmDescription:
        `Queue class ${c.name}: a job of worker class ${c.workerClass} is dead (attempts ` +
        'exhausted and not yet released)' +
        (poisoned ? ', or a routed conversation is poisoned under this source commit' : '') +
        '. A ruling is owed, as for exceeds_largest.',
      metric: poisoned
        ? new cloudwatch.MathExpression({
          expression: 'FILL(dead, 0) + FILL(poisoned, 0)',
          usingMetrics: { dead, poisoned },
          period,
          label: `${c.name} dead + poisoned`,
        })
        : dead,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    alarms.oldestQueued = notify(new cloudwatch.Alarm(scope, `${c.id}OldestQueuedAlarm`, {
      alarmName: alarmName('OldestQueued'),
      alarmDescription:
        `Queue class ${c.name}: the oldest claimable job of worker class ${c.workerClass} has ` +
        `waited ${s.oldestQueuedMs} ms. Demand is not being met: check ScaleOut, the group's ` +
        'capacity and MissingWorker.',
      metric: oldestQueued,
      threshold: s.oldestQueuedMs,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    alarms.missingWorker = notify(new cloudwatch.Alarm(scope, `${c.id}MissingWorkerAlarm`, {
      alarmName: alarmName('MissingWorker'),
      alarmDescription:
        `Queue class ${c.name}: the group has an instance in service and no jobs daemon has ` +
        'logged a readiness line. Box up, daemon not running: check the deploy hook and the ' +
        'daemon\'s refusals in the box\'s log stream.',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(instances >= 1 && FILL(heartbeat, 0) < 1, 1, 0)',
        usingMetrics: { instances: inService, heartbeat },
        period,
        label: `${c.name} instance up, no daemon heartbeat`,
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    alarms.workerDisk = notify(new cloudwatch.Alarm(scope, `${c.id}WorkerDiskAlarm`, {
      alarmName: alarmName('WorkerDisk'),
      alarmDescription:
        `Queue class ${c.name}: a worker's root volume (journal and work directory) has ` +
        `${s.workerDiskMinBytes} bytes free or less (the CloudWatch agent's ${WORKER_DISK_METRIC}).`,
      metric: new cloudwatch.Metric({
        namespace: AGENT_NAMESPACE,
        metricName: WORKER_DISK_METRIC,
        dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
        statistic: 'Minimum',
        period,
      }),
      threshold: s.workerDiskMinBytes,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    perClass[c.name] = alarms;
  }

  // --- Once, on the queue itself.
  const queueMetric = (name: string, metricName: string, field: string) =>
    capacityMetric(`Queue${name}Filter`, `Polis-Queue-${metricName}`, metricName, field);
  const unreachable = queueMetric('Unreachable', 'QueueUnreachable', 'queue_unreachable');
  const bytes = queueMetric('Bytes', 'QueueBytes', 'queue_bytes');
  const sweepAge = queueMetric('SweepAge', 'SweepAgeMs', 'sweep_age_ms');
  const full = queueMetric('Full', 'QueueFull', 'queue_full');

  const queue = {
    unreachable: notify(new cloudwatch.Alarm(scope, 'QueueUnreachableAlarm', {
      alarmName: QUEUE_UNREACHABLE_ALARM_NAME,
      alarmDescription:
        'The small math poller cannot reach the job queue (queue_unreachable on the capacity ' +
        'line): routing is refusing and nothing is enqueued. Check the queue DSN, the login and ' +
        'the database. Runbook: cost-reduction plan P-084.',
      metric: unreachable,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })),
    bytes: notify(new cloudwatch.Alarm(scope, 'QueueBytesAlarm', {
      alarmName: QUEUE_BYTES_ALARM_NAME,
      alarmDescription:
        `The job queue's tables hold ${s.queueBytesLimit} bytes or more (queue_bytes on the ` +
        'capacity line): the retention budget of cost-reduction plan P-083. Check the sweep.',
      metric: bytes,
      threshold: s.queueBytesLimit,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })),
    sweepLag: notify(new cloudwatch.Alarm(scope, 'QueueSweepLagAlarm', {
      alarmName: QUEUE_SWEEP_LAG_ALARM_NAME,
      alarmDescription:
        `The job queue's last sweep is ${s.sweepLagMs} ms old or older (sweep_age_ms on the ` +
        'capacity line). The queue_sweep stage is not running or not finishing.',
      metric: sweepAge,
      threshold: s.sweepLagMs,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })),
    full: notify(new cloudwatch.Alarm(scope, 'QueueFullAlarm', {
      alarmName: QUEUE_FULL_ALARM_NAME,
      alarmDescription:
        'The job queue refused an insert at its admission cap (queue_full on the capacity ' +
        'line). Runbook: cost-reduction plan P-084.',
      metric: full,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })),
  };

  return { perClass, queue };
};

export default createWorkerClasses;
