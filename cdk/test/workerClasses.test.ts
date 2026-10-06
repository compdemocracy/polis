import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkStack } from '../lib/cdk-stack';
import {
  AGENT_NAMESPACE, CAPACITY_NAMESPACE, DELPHI_CLASS, DELPHI_WORKER_SERVICE_TYPE, DEMAND_UNMET_ALARM_NAME,
  LARGE_BUSY_METRIC, LARGE_CLASS_CONTEXT, LARGE_DEMAND_METRIC, LARGE_SERVICE_TYPE, LONG_RUNNING_ALARM_NAME,
  MATH_LARGE_CLASS, OLDEST_UNRESOLVED_METRIC, PENDING_PROMOTION_METRIC, QUEUE_BYTES_ALARM_NAME,
  QUEUE_FULL_ALARM_NAME, QUEUE_SWEEP_LAG_ALARM_NAME, QUEUE_UNREACHABLE_ALARM_NAME, SCALE_IN_ALARM_NAME,
  SCALE_OUT_ALARM_NAME, WORKER_DISK_METRIC, WORKER_HEARTBEAT_METRIC, WORKER_HEARTBEAT_PHRASE, capacityFilter,
  largeClassEnabled, workerClassTable,
} from '../workerClasses';
import { HEARTBEAT_PHRASE, STALE_PHRASES } from '../mathPollerAlarms';

// The whole production stack, synthesized the way it is deployed
// (`-c enableCiEc2=true`). Asset bundling is skipped so the backup
// function's package is not built (no pip run) and the tests stay hermetic.
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

type Resources = Record<string, any>;
// A logical id is the construct path with an 8-hex-digit hash; the hash is
// dropped so the diff lists read as construct ids.
const stem = (id: string) => id.replace(/[0-9A-F]{8}$/, '');

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

describe('the class table', () => {
  const table = workerClassTable(new cdk.Stack(new cdk.App(), 'S'));
  test('has the math-large and delphi rows with their daemon classes and sizes', () => {
    expect(table.map((c) => [c.name, c.workerClass, c.serviceType, c.minCapacity, c.maxCapacity, c.containerMemory]))
      .toEqual([
        [MATH_LARGE_CLASS, 'large', LARGE_SERVICE_TYPE, 0, 1, '52g'],
        [DELPHI_CLASS, 'delphi', DELPHI_WORKER_SERVICE_TYPE, 0, 3, '52g'],
      ]);
    expect(table.map((c) => c.instanceType.toString())).toEqual(['r7i.2xlarge', 'r7i.2xlarge']);
  });
  test('names the capacity-line keys each class reads', () => {
    expect(table.find((c) => c.name === MATH_LARGE_CLASS)!.keys).toEqual({
      demand: 'large_demand', leased: 'large_leased', parked: 'large_parked', dead: 'large_dead',
      poisoned: 'large_poisoned', oldestQueuedAgeMs: 'oldest_queued_age_ms',
    });
    expect(table.find((c) => c.name === DELPHI_CLASS)!.keys).toEqual({
      demand: 'delphi_demand', leased: 'delphi_leased', parked: 'delphi_parked', dead: 'delphi_dead',
      oldestQueuedAgeMs: 'delphi_oldest_queued_age_ms',
    });
  });
});

describe('enableLargeClass on', () => {
  const off = synth().toJSON().Resources as Resources;
  const t = synth({ [LARGE_CLASS_CONTEXT]: true });
  const json = t.toJSON();
  const resources = json.Resources as Resources;
  const byType = (type: string) =>
    Object.entries(resources).filter(([, r]) => r.Type === type) as [string, any][];
  const one = (type: string, prefix: string) => {
    const hits = byType(type).filter(([id]) => id.startsWith(prefix));
    expect(hits).toHaveLength(1);
    return hits[0][1];
  };
  const asgIdOf = (prefix: string) => Object.keys(resources).find((id) => id.startsWith(prefix))!;
  const largeAsgId = asgIdOf('AsgDelphiLargeASG');
  const delphiAsgId = asgIdOf('AsgWorkerDelphiASG');
  const largeLt = one('AWS::EC2::LaunchTemplate', 'DelphiLargeLaunchTemplate');
  const delphiLt = one('AWS::EC2::LaunchTemplate', 'WorkerDelphiLaunchTemplate');
  const userDataOf = (lt: any) => JSON.stringify(lt.Properties.LaunchTemplateData.UserData);

  test('no Lambda, no custom resource and no new bucket', () => {
    const count = (r: Resources, pred: (type: string) => boolean) =>
      Object.values(r).filter((x: any) => pred(x.Type)).length;
    const lambdaOrCustom = (type: string) =>
      type === 'AWS::Lambda::Function' || type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource';
    expect(count(resources, lambdaOrCustom)).toBe(count(off, lambdaOrCustom));
    expect(count(resources, (type) => type === 'AWS::S3::Bucket')).toBe(count(off, (type) => type === 'AWS::S3::Bucket'));
  });

  test('the flag-on diff lists exactly the expected resources', () => {
    const line = (r: Resources, id: string) => `${r[id].Type} ${stem(id)}`;
    const added = Object.keys(resources).filter((id) => !(id in off)).map((id) => line(resources, id)).sort();
    const removed = Object.keys(off).filter((id) => !(id in resources)).map((id) => line(off, id)).sort();
    const changed = Object.keys(resources)
      .filter((id) => id in off && JSON.stringify(off[id]) !== JSON.stringify(resources[id]))
      .map((id) => line(resources, id)).sort();
    const perClass = (id: string, promotion: boolean) => [
      `AWS::AutoScaling::ScalingPolicy ${id}ScaleInPolicy`,
      `AWS::AutoScaling::ScalingPolicy ${id}ScaleOutPolicy`,
      `AWS::CloudWatch::Alarm ${id}DeadAlarm`,
      ...(promotion ? [`AWS::CloudWatch::Alarm ${id}DemandUnmetAlarm`] : []),
      `AWS::CloudWatch::Alarm ${id}LongRunningAlarm`,
      `AWS::CloudWatch::Alarm ${id}MissingWorkerAlarm`,
      `AWS::CloudWatch::Alarm ${id}OldestQueuedAlarm`,
      `AWS::CloudWatch::Alarm ${id}ParkedAlarm`,
      `AWS::CloudWatch::Alarm ${id}ScaleInAlarm`,
      `AWS::CloudWatch::Alarm ${id}ScaleOutAlarm`,
      `AWS::CloudWatch::Alarm ${id}WorkerDiskAlarm`,
      `AWS::IAM::Policy ${id}InstanceRoleDefaultPolicy`,
      `AWS::IAM::Role ${id}InstanceRole`,
      `AWS::Logs::MetricFilter ${id}BusyFilter`,
      `AWS::Logs::MetricFilter ${id}DeadFilter`,
      `AWS::Logs::MetricFilter ${id}DemandFilter`,
      `AWS::Logs::MetricFilter ${id}OldestQueuedFilter`,
      ...(promotion ? [
        `AWS::Logs::MetricFilter ${id}OldestUnresolvedFilter`,
        `AWS::Logs::MetricFilter ${id}PendingPromotionFilter`,
        `AWS::Logs::MetricFilter ${id}PoisonedFilter`,
      ] : []),
      `AWS::Logs::MetricFilter ${id}ParkedFilter`,
    ];
    expect(added).toEqual([
      ...perClass('DelphiLarge', true),
      ...perClass('WorkerDelphi', false),
      'AWS::AutoScaling::AutoScalingGroup AsgWorkerDelphiASG',
      'AWS::CloudWatch::Alarm QueueBytesAlarm',
      'AWS::CloudWatch::Alarm QueueFullAlarm',
      'AWS::CloudWatch::Alarm QueueSweepLagAlarm',
      'AWS::CloudWatch::Alarm QueueUnreachableAlarm',
      'AWS::EC2::LaunchTemplate WorkerDelphiLaunchTemplate',
      'AWS::IAM::InstanceProfile WorkerDelphiLaunchTemplateProfile',
      'AWS::Logs::MetricFilter QueueBytesFilter',
      'AWS::Logs::MetricFilter QueueFullFilter',
      'AWS::Logs::MetricFilter QueueSweepAgeFilter',
      'AWS::Logs::MetricFilter QueueUnreachableFilter',
      'AWS::Logs::MetricFilter WorkerHeartbeatFilter',
    ].sort());
    // The large group's CPU target tracking goes: it would scale a worker in mid-job.
    expect(removed).toEqual(['AWS::AutoScaling::ScalingPolicy AsgDelphiLargeScalingPolicyDelphiLargeCpuTracking']);
    expect(changed).toEqual([
      'AWS::AutoScaling::AutoScalingGroup AsgDelphiLargeASG',
      'AWS::EC2::LaunchTemplate DelphiLargeLaunchTemplate',
      'AWS::IAM::InstanceProfile DelphiLargeLaunchTemplateProfile',
    ].sort());
  });

  test('every manifest remnant is gone and the shared InstanceRole is untouched', () => {
    const text = JSON.stringify(json);
    for (const remnant of ['CapacityManifest', 'manifest.json', 'math-capacity/', 'largeClassManifest']) {
      expect(text).not.toContain(remnant);
    }
    const instanceRolePolicies = (r: Resources) => Object.entries(r)
      .filter(([, x]) => x.Type === 'AWS::IAM::Policy' && x.Properties.Roles.some((ref: any) => String(ref.Ref).startsWith('InstanceRole')))
      .map(([id, x]) => [id, x]);
    expect(instanceRolePolicies(resources)).toEqual(instanceRolePolicies(off));
    const roleId = Object.keys(resources).find((id) => id.startsWith('InstanceRole') && resources[id].Type === 'AWS::IAM::Role')!;
    expect(resources[roleId]).toEqual(off[roleId]);
  });

  describe.each([
    ['DelphiLarge', 'AsgDelphiLarge'],
    ['WorkerDelphi', 'AsgWorkerDelphi'],
  ])('the %s class', (id, asgPrefix) => {
    test('its resources match the snapshot', () => {
      const own = Object.fromEntries(Object.entries(resources)
        .filter(([rid]) => rid.startsWith(id) || rid.startsWith(asgPrefix))
        .map(([rid, r]) => [stem(rid), r]));
      expect(own).toMatchSnapshot();
    });
  });

  test('each worker template writes its service type, daemon class, memory and the login secret name', () => {
    for (const [lt, service, klass] of [[largeLt, LARGE_SERVICE_TYPE, 'large'], [delphiLt, DELPHI_WORKER_SERVICE_TYPE, 'delphi']] as const) {
      const ud = userDataOf(lt);
      expect(ud).toContain(`echo \\"${service}\\" | sudo tee /etc/app-info/service_type.txt`);
      expect(ud).toContain(`\\"awslogs-stream\\": \\"${service}\\"`);
      expect(ud).not.toContain('instance_size.txt');
      expect(ud).toContain(`echo \\"${klass}\\" | sudo tee /etc/app-info/worker_class.txt`);
      expect(ud).toContain('echo \\"52g\\" | sudo tee /etc/app-info/worker_memory.txt');
      expect(ud).toContain('echo \\"polis-queue-login\\" | sudo tee /etc/app-info/queue_login_secret.txt');
      expect(ud).toContain('POLIS_JOBS_WORKER_CLASS=%s');
      expect(ud).toContain('POLIS_JOBS_CONTAINER_MEMORY=%s');
      expect(ud).toContain('POLIS_JOBS_LOGIN_SECRET_NAME=%s');
      expect(ud).toContain(
        `\\"${klass}\\" \\"52g\\" \\"polis-queue-login\\" \\"123456789012.dkr.ecr.us-east-1.amazonaws.com/polis/delphi:latest\\" | sudo tee /etc/app-info/polis-jobs.env`);
      // The daemon starts with that class as a systemd unit; the login's password is
      // read by the secret's NAME at each start and never appears in the template.
      expect(ud).toContain('sudo tee /etc/systemd/system/polis-jobs.service');
      expect(ud).toContain('ExecStart=/usr/local/bin/polis-jobs-start');
      expect(ud).toContain('Restart=always');
      expect(ud).toContain('sudo systemctl enable --now polis-jobs.service');
      expect(ud).toContain('--secret-id \\"$POLIS_JOBS_LOGIN_SECRET_NAME\\"');
      expect(ud).toContain('-e POLIS_JOBS_PASSWORD_FILE=/run/secrets/queue-login');
      expect(ud).toContain('\\"$POLIS_JOBS_IMAGE\\" polis-jobs');
      expect(ud).not.toMatch(/arn:aws:secretsmanager/);
      expect(lt.Properties.LaunchTemplateData.InstanceType).toBe('r7i.2xlarge');
      expect(lt.Properties.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize).toBe(100);
    }
    expect(one('AWS::IAM::InstanceProfile', 'DelphiLargeLaunchTemplateProfile').Properties.Roles)
      .toEqual([{ Ref: expect.stringMatching(/^DelphiLargeInstanceRole/) }]);
    expect(one('AWS::IAM::InstanceProfile', 'WorkerDelphiLaunchTemplateProfile').Properties.Roles)
      .toEqual([{ Ref: expect.stringMatching(/^WorkerDelphiInstanceRole/) }]);
    // The other tiers keep the shared agent config and write no worker files.
    for (const prefix of ['WebLaunchTemplate', 'DelphiSmallLaunchTemplate', 'MathWorkerLaunchTemplate']) {
      const ud = userDataOf(one('AWS::EC2::LaunchTemplate', prefix));
      expect(ud).not.toContain('worker_class.txt');
      expect(ud).not.toContain('polis-jobs.env');
      expect(ud).not.toContain('polis-jobs.service');
    }
  });

  test('the worker boxes read their own agent config, with disk free rolled up by group', () => {
    const udLarge = userDataOf(largeLt);
    const udSmall = userDataOf(one('AWS::EC2::LaunchTemplate', 'DelphiSmallLaunchTemplate'));
    const assetKey = (ud: string) => /([0-9a-f]{64})\.json/.exec(ud)![1];
    expect(assetKey(udLarge)).not.toBe(assetKey(udSmall));
    expect(assetKey(userDataOf(delphiLt))).toBe(assetKey(udLarge));
    const workerConfig = require('../config/amazon-cloudwatch-agent-worker.json');
    const sharedConfig = require('../config/amazon-cloudwatch-agent.json');
    expect(workerConfig.metrics.metrics_collected.disk.measurement).toEqual(['used_percent', 'free']);
    expect(workerConfig.metrics.aggregation_dimensions).toEqual([['AutoScalingGroupName']]);
    expect(sharedConfig.metrics.aggregation_dimensions).toBeUndefined();
    expect(sharedConfig.metrics.metrics_collected.disk.measurement).toEqual(['used_percent']);
  });

  test('the groups are the table rows with no desired count, collect in-service; only math-large deploys', () => {
    const large = resources[largeAsgId];
    const delphi = resources[delphiAsgId];
    expect([large.Properties.MinSize, large.Properties.MaxSize, large.Properties.DesiredCapacity]).toEqual(['0', '1', undefined]);
    expect([delphi.Properties.MinSize, delphi.Properties.MaxSize, delphi.Properties.DesiredCapacity]).toEqual(['0', '3', undefined]);
    for (const asg of [large, delphi]) {
      expect(asg.Properties.MetricsCollection).toEqual([{ Granularity: '1Minute', Metrics: ['GroupInServiceInstances'] }]);
      expect(JSON.stringify(asg.Properties.VPCZoneIdentifier)).toContain('PrivateWithEgress');
    }
    const dg = one('AWS::CodeDeploy::DeploymentGroup', 'DeploymentGroup');
    expect(dg.Properties.AutoScalingGroups).toContainEqual({ Ref: largeAsgId });
    // after_install.sh has no delphi-worker branch yet; its unknown-type branch starts every service.
    expect(dg.Properties.AutoScalingGroups).not.toContainEqual({ Ref: delphiAsgId });
    expect(dg.Properties.AutoScalingGroups).toHaveLength(4);
    expect(large.Properties.LaunchTemplate.LaunchTemplateId).toEqual({ Ref: expect.stringMatching(/^DelphiLargeLaunchTemplate/) });
    expect(delphi.Properties.LaunchTemplate.LaunchTemplateId).toEqual({ Ref: expect.stringMatching(/^WorkerDelphiLaunchTemplate/) });
  });

  const policiesOf = (asgId: string) => byType('AWS::AutoScaling::ScalingPolicy')
    .filter(([, p]) => p.Properties.AutoScalingGroupName.Ref === asgId);
  const policyRef = (asgId: string, adjustment: number) => {
    const [id] = policiesOf(asgId).find(([, p]) => p.Properties.StepAdjustments[0].ScalingAdjustment === adjustment)!;
    return { Ref: id };
  };

  test('each group has exactly two step policies, both exact capacity, and no CPU tracking', () => {
    for (const asgId of [largeAsgId, delphiAsgId]) {
      const policies = policiesOf(asgId);
      expect(policies).toHaveLength(2);
      for (const [, p] of policies) {
        expect(p.Properties.PolicyType).toBe('StepScaling');
        expect(p.Properties.AdjustmentType).toBe('ExactCapacity');
      }
    }
    const steps = (asgId: string) => policiesOf(asgId).map(([, p]) => p.Properties.StepAdjustments)
      .sort((a, b) => a[0].ScalingAdjustment - b[0].ScalingAdjustment);
    expect(steps(largeAsgId)).toEqual([
      [{ MetricIntervalUpperBound: 0, ScalingAdjustment: 0 }],
      [{ MetricIntervalLowerBound: 0, ScalingAdjustment: 1 }],
    ]);
    // delphi: one worker per two queued jobs, up to three.
    expect(steps(delphiAsgId)).toEqual([
      [{ MetricIntervalUpperBound: 0, ScalingAdjustment: 0 }],
      [
        { MetricIntervalLowerBound: 0, MetricIntervalUpperBound: 2, ScalingAdjustment: 1 },
        { MetricIntervalLowerBound: 2, MetricIntervalUpperBound: 4, ScalingAdjustment: 2 },
        { MetricIntervalLowerBound: 4, ScalingAdjustment: 3 },
      ],
    ]);
  });

  test('the metric filters read the queue counts on the small capacity line, no default value', () => {
    const filters = byType('AWS::Logs::MetricFilter')
      .filter(([, f]) => f.Properties.MetricTransformations[0].MetricNamespace === CAPACITY_NAMESPACE);
    const got = Object.fromEntries(filters.map(([, f]) => {
      const m = f.Properties.MetricTransformations[0];
      expect(m.DefaultValue).toBeUndefined();
      expect(f.Properties.LogGroupName).toEqual({ Ref: expect.stringMatching(/^LogGroup/) });
      return [m.MetricName, [f.Properties.FilterName, f.Properties.FilterPattern, m.MetricValue]];
    }));
    const small = '{ $.schema = "math_poller.capacity/1" && $.class = "small" && $.role = "primary" }';
    expect(got).toEqual({
      [LARGE_DEMAND_METRIC]: ['Polis-LargeClass-LargeDemand', small, '$.large_demand'],
      [LARGE_BUSY_METRIC]: ['Polis-LargeClass-LargeBusy', small, '$.large_leased'],
      LargeParked: ['Polis-LargeClass-LargeParked', small, '$.large_parked'],
      LargeDead: ['Polis-LargeClass-LargeDead', small, '$.large_dead'],
      LargePoisoned: ['Polis-LargeClass-LargePoisoned', small, '$.large_poisoned'],
      LargeOldestQueuedAgeMs: ['Polis-LargeClass-LargeOldestQueuedAgeMs', small, '$.oldest_queued_age_ms'],
      [PENDING_PROMOTION_METRIC]: ['Polis-LargeClass-PendingPromotion', small, '$.pending_promotion'],
      [OLDEST_UNRESOLVED_METRIC]: ['Polis-LargeClass-OldestUnresolvedAgeMs', small, '$.oldest_unresolved_age_ms'],
      DelphiDemand: ['Polis-DelphiClass-DelphiDemand', small, '$.delphi_demand'],
      DelphiBusy: ['Polis-DelphiClass-DelphiBusy', small, '$.delphi_leased'],
      DelphiParked: ['Polis-DelphiClass-DelphiParked', small, '$.delphi_parked'],
      DelphiDead: ['Polis-DelphiClass-DelphiDead', small, '$.delphi_dead'],
      DelphiOldestQueuedAgeMs: ['Polis-DelphiClass-DelphiOldestQueuedAgeMs', small, '$.delphi_oldest_queued_age_ms'],
      QueueUnreachable: ['Polis-Queue-QueueUnreachable', small, '$.queue_unreachable'],
      QueueBytes: ['Polis-Queue-QueueBytes', small, '$.queue_bytes'],
      SweepAgeMs: ['Polis-Queue-SweepAgeMs', small, '$.sweep_age_ms'],
      QueueFull: ['Polis-Queue-QueueFull', small, '$.queue_full'],
      [WORKER_HEARTBEAT_METRIC]: ['Polis-Queue-WorkerHeartbeat', `"${WORKER_HEARTBEAT_PHRASE}"`, '1'],
    });
    expect(capacityFilter('small')).toBe(small);
    // No filter reads the former large worker's own line or a manifest field.
    expect(JSON.stringify(filters)).not.toContain('$.class = \\"large\\"');
    expect(JSON.stringify(filters)).not.toContain('$.busy');
  });

  const alarm = (name: string) => {
    const hits = byType('AWS::CloudWatch::Alarm').filter(([, a]) => a.Properties.AlarmName === name);
    expect(hits).toHaveLength(1);
    return hits[0][1].Properties;
  };
  const exprOf = (a: any) => a.Metrics.find((m: any) => m.Expression).Expression;
  const inputsOf = (a: any) => Object.fromEntries(a.Metrics.filter((m: any) => m.MetricStat)
    .map((m: any) => [m.Id, m.MetricStat.Metric.MetricName]));
  const topic = [{ Ref: expect.stringMatching(/^AlarmTopic/) }];

  test('the alarm table is exactly P-086 per class plus the queue-wide four', () => {
    const names = byType('AWS::CloudWatch::Alarm').map(([, a]) => a.Properties.AlarmName).filter(Boolean).sort();
    const offNames = Object.values(off).filter((x: any) => x.Type === 'AWS::CloudWatch::Alarm')
      .map((x: any) => x.Properties.AlarmName).filter(Boolean);
    const perClass = (prefix: string, promotion: boolean) => [
      'ScaleOut', 'ScaleIn', ...(promotion ? ['DemandUnmet'] : []), 'LongRunning',
      'Parked', 'Dead', 'OldestQueued', 'MissingWorker', 'WorkerDisk',
    ].map((n) => `${prefix}-${n}`);
    expect(names).toEqual([
      ...offNames,
      ...perClass('Polis-LargeClass', true),
      ...perClass('Polis-DelphiClass', false),
      QUEUE_UNREACHABLE_ALARM_NAME, QUEUE_BYTES_ALARM_NAME, QUEUE_SWEEP_LAG_ALARM_NAME, QUEUE_FULL_ALARM_NAME,
    ].sort());
  });

  test('scale-out reads the class demand only and drives its exact-capacity policy', () => {
    const a = alarm(SCALE_OUT_ALARM_NAME);
    expect(a).toMatchObject({
      MetricName: LARGE_DEMAND_METRIC, Namespace: CAPACITY_NAMESPACE, Statistic: 'Maximum', Period: 300,
      Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 2, DatapointsToAlarm: 2, TreatMissingData: 'notBreaching',
    });
    expect(a.AlarmActions).toEqual([policyRef(largeAsgId, 1)]);
    expect(a.OKActions).toBeUndefined();
    const d = alarm('Polis-DelphiClass-ScaleOut');
    expect(d).toMatchObject({ MetricName: 'DelphiDemand', Threshold: 1, EvaluationPeriods: 2 });
    expect(d.AlarmActions).toEqual([policyRef(delphiAsgId, 1)]);
  });

  test('scale-in needs queued, leased and parked all reported and at 0, and drives the exact-capacity-0 policy', () => {
    for (const [name, asgId, prefix] of [[SCALE_IN_ALARM_NAME, largeAsgId, 'Large'], ['Polis-DelphiClass-ScaleIn', delphiAsgId, 'Delphi']] as const) {
      const a = alarm(name);
      expect(a).toMatchObject({
        Threshold: 0, ComparisonOperator: 'LessThanOrEqualToThreshold',
        EvaluationPeriods: 6, DatapointsToAlarm: 6, TreatMissingData: 'notBreaching',
      });
      // No FILL: a missing term (the poller down, or not yet emitting parked) is unknown, not 0.
      expect(exprOf(a)).toBe('demand + leased + parked');
      expect(inputsOf(a)).toEqual({ demand: `${prefix}Demand`, leased: `${prefix}Busy`, parked: `${prefix}Parked` });
      expect(a.AlarmActions).toEqual([policyRef(asgId, 0)]);
    }
  });

  test('scale-out and scale-in can never both be in ALARM', () => {
    // ScaleOut needs demand >= 1; ScaleIn needs demand + leased + parked <= 0 with all >= 0.
    for (const [out, inn] of [[SCALE_OUT_ALARM_NAME, SCALE_IN_ALARM_NAME], ['Polis-DelphiClass-ScaleOut', 'Polis-DelphiClass-ScaleIn']]) {
      expect(alarm(out).Threshold).toBeGreaterThan(alarm(inn).Threshold);
    }
  });

  test('DemandUnmet exists for the promoted class only and reads the promotion keys', () => {
    const a = alarm(DEMAND_UNMET_ALARM_NAME);
    expect(exprOf(a)).toBe('IF(pending >= 1 || FILL(oldest, 0) >= 10800000, 1, 0)');
    expect(Object.values(inputsOf(a)).sort()).toEqual([OLDEST_UNRESOLVED_METRIC, PENDING_PROMOTION_METRIC].sort());
    expect(a).toMatchObject({
      Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 6, DatapointsToAlarm: 6, TreatMissingData: 'notBreaching',
    });
    expect(a.AlarmActions).toEqual(topic);
    expect(a.OKActions).toEqual(topic);
    expect(byType('AWS::CloudWatch::Alarm').filter(([, x]) => x.Properties.AlarmName === 'Polis-DelphiClass-DemandUnmet')).toEqual([]);
  });

  test('LongRunning is the in-service cost guard per group, on the alarm topic', () => {
    for (const [name, asgId] of [[LONG_RUNNING_ALARM_NAME, largeAsgId], ['Polis-DelphiClass-LongRunning', delphiAsgId]]) {
      const a = alarm(name);
      expect(a).toMatchObject({
        Namespace: 'AWS/AutoScaling', MetricName: 'GroupInServiceInstances', Statistic: 'Maximum',
        Dimensions: [{ Name: 'AutoScalingGroupName', Value: { Ref: asgId } }],
        Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 72, DatapointsToAlarm: 72, TreatMissingData: 'notBreaching',
      });
      expect(a.AlarmActions).toEqual(topic);
    }
  });

  test('Parked, Dead and OldestQueued read the class keys with the P-086 thresholds', () => {
    const parked = alarm('Polis-LargeClass-Parked');
    expect(parked).toMatchObject({
      MetricName: 'LargeParked', Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 3, DatapointsToAlarm: 3, TreatMissingData: 'notBreaching',
    });
    const dead = alarm('Polis-LargeClass-Dead');
    expect(exprOf(dead)).toBe('FILL(dead, 0) + FILL(poisoned, 0)');
    expect(inputsOf(dead)).toEqual({ dead: 'LargeDead', poisoned: 'LargePoisoned' });
    expect(dead).toMatchObject({ Threshold: 1, EvaluationPeriods: 1, DatapointsToAlarm: 1 });
    expect(alarm('Polis-DelphiClass-Dead')).toMatchObject({ MetricName: 'DelphiDead', Threshold: 1, EvaluationPeriods: 1 });
    expect(alarm('Polis-LargeClass-OldestQueued')).toMatchObject({
      MetricName: 'LargeOldestQueuedAgeMs', Threshold: 7200000, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1, DatapointsToAlarm: 1,
    });
    expect(alarm('Polis-DelphiClass-OldestQueued')).toMatchObject({ MetricName: 'DelphiOldestQueuedAgeMs', Threshold: 7200000 });
    for (const name of ['Polis-LargeClass-Parked', 'Polis-LargeClass-Dead', 'Polis-LargeClass-OldestQueued']) {
      expect(alarm(name).AlarmActions).toEqual(topic);
      expect(alarm(name).OKActions).toEqual(topic);
    }
  });

  test('MissingWorker is the group in service with no daemon heartbeat', () => {
    for (const [name, asgId] of [['Polis-LargeClass-MissingWorker', largeAsgId], ['Polis-DelphiClass-MissingWorker', delphiAsgId]]) {
      const a = alarm(name);
      expect(exprOf(a)).toBe('IF(instances >= 1 && FILL(heartbeat, 0) < 1, 1, 0)');
      expect(inputsOf(a)).toEqual({ instances: 'GroupInServiceInstances', heartbeat: WORKER_HEARTBEAT_METRIC });
      const instances = a.Metrics.find((m: any) => m.Id === 'instances').MetricStat;
      expect(instances.Metric.Dimensions).toEqual([{ Name: 'AutoScalingGroupName', Value: { Ref: asgId } }]);
      const heartbeat = a.Metrics.find((m: any) => m.Id === 'heartbeat').MetricStat;
      expect(heartbeat.Stat).toBe('Sum');
      expect(a).toMatchObject({ Threshold: 1, EvaluationPeriods: 3, DatapointsToAlarm: 3, TreatMissingData: 'notBreaching' });
      expect(a.AlarmActions).toEqual(topic);
    }
  });

  test("WorkerDisk reads the agent's disk free for the group", () => {
    for (const [name, asgId] of [['Polis-LargeClass-WorkerDisk', largeAsgId], ['Polis-DelphiClass-WorkerDisk', delphiAsgId]]) {
      expect(alarm(name)).toMatchObject({
        Namespace: AGENT_NAMESPACE, MetricName: WORKER_DISK_METRIC, Statistic: 'Minimum',
        Dimensions: [{ Name: 'AutoScalingGroupName', Value: { Ref: asgId } }],
        Threshold: 5 * 1024 * 1024 * 1024, ComparisonOperator: 'LessThanOrEqualToThreshold',
        EvaluationPeriods: 1, DatapointsToAlarm: 1, TreatMissingData: 'notBreaching',
      });
    }
  });

  test('the queue-wide alarms: Unreachable, Bytes, SweepLag, Full', () => {
    expect(alarm(QUEUE_UNREACHABLE_ALARM_NAME)).toMatchObject({
      MetricName: 'QueueUnreachable', Threshold: 1, EvaluationPeriods: 2, DatapointsToAlarm: 2,
    });
    expect(alarm(QUEUE_BYTES_ALARM_NAME)).toMatchObject({
      MetricName: 'QueueBytes', Threshold: 1.5 * 1024 * 1024 * 1024, EvaluationPeriods: 1,
    });
    expect(alarm(QUEUE_SWEEP_LAG_ALARM_NAME)).toMatchObject({
      MetricName: 'SweepAgeMs', Threshold: 2 * 24 * 60 * 60 * 1000, EvaluationPeriods: 1,
    });
    expect(alarm(QUEUE_FULL_ALARM_NAME)).toMatchObject({
      MetricName: 'QueueFull', Threshold: 1, EvaluationPeriods: 2, DatapointsToAlarm: 2,
    });
    for (const name of [QUEUE_UNREACHABLE_ALARM_NAME, QUEUE_BYTES_ALARM_NAME, QUEUE_SWEEP_LAG_ALARM_NAME, QUEUE_FULL_ALARM_NAME]) {
      const a = alarm(name);
      expect(a).toMatchObject({ Namespace: CAPACITY_NAMESPACE, Statistic: 'Maximum', Period: 300, TreatMissingData: 'notBreaching' });
      expect(a.AlarmActions).toEqual(topic);
      expect(a.OKActions).toEqual(topic);
    }
  });

  test('periods, thresholds, sizes and the secret name come from context', () => {
    const r = synth({
      [LARGE_CLASS_CONTEXT]: true, largeClassOutPeriods: 3, largeClassInPeriods: 4,
      largeClassUnmetPeriods: 5, largeClassUnmetAgeMs: 60000, largeClassLongRunningPeriods: 7,
      queueOldestQueuedMs: 1000, queueBytesLimit: 2000, queueSweepLagMs: 3000, workerDiskMinBytes: 4000,
      delphiClassMaxCapacity: 2, delphiClassInstanceType: 'r7i.xlarge', largeClassInstanceType: 'r7i.4xlarge',
      queueLoginSecretName: 'polis-queue-login-test',
    }).toJSON().Resources as Resources;
    const props = (name: string) => (Object.values(r).find((x: any) =>
      x.Type === 'AWS::CloudWatch::Alarm' && x.Properties.AlarmName === name) as any).Properties;
    expect(props(SCALE_OUT_ALARM_NAME).EvaluationPeriods).toBe(3);
    expect(props(SCALE_IN_ALARM_NAME).EvaluationPeriods).toBe(4);
    expect(props(DEMAND_UNMET_ALARM_NAME).EvaluationPeriods).toBe(5);
    expect(JSON.stringify(props(DEMAND_UNMET_ALARM_NAME).Metrics)).toContain('>= 60000');
    expect(props(LONG_RUNNING_ALARM_NAME).EvaluationPeriods).toBe(7);
    expect(props('Polis-LargeClass-OldestQueued').Threshold).toBe(1000);
    expect(props(QUEUE_BYTES_ALARM_NAME).Threshold).toBe(2000);
    expect(props(QUEUE_SWEEP_LAG_ALARM_NAME).Threshold).toBe(3000);
    expect(props('Polis-DelphiClass-WorkerDisk').Threshold).toBe(4000);
    const delphiAsg = Object.values(r).find((x: any) => x.Type === 'AWS::AutoScaling::AutoScalingGroup' && x.Properties.MaxSize === '2') as any;
    expect(delphiAsg).toBeDefined();
    const lts = Object.entries(r).filter(([, x]: any) => x.Type === 'AWS::EC2::LaunchTemplate')
      .map(([id, x]: any) => [stem(id), x.Properties.LaunchTemplateData.InstanceType]);
    expect(lts).toContainEqual(['WorkerDelphiLaunchTemplate', 'r7i.xlarge']);
    expect(lts).toContainEqual(['DelphiLargeLaunchTemplate', 'r7i.4xlarge']);
    expect(JSON.stringify(r)).toContain('secret:polis-queue-login-test-*');
    expect(() => synth({ [LARGE_CLASS_CONTEXT]: true, largeClassInPeriods: 0 })).toThrow(/positive integer/);
    expect(() => synth({ [LARGE_CLASS_CONTEXT]: true, delphiClassMaxCapacity: 0 })).toThrow(/positive integer/);
  });

  // --- IAM
  const statementsOf = (rolePrefix: string) => byType('AWS::IAM::Policy')
    .filter(([, p]) => p.Properties.Roles.some((r: any) => String(r.Ref).startsWith(rolePrefix)))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  const actions = (s: any) => [].concat(s.Action);

  test.each(['DelphiLargeInstanceRole', 'WorkerDelphiInstanceRole'])('%s is scoped: no broad policy, no S3 outside the CDK-owned buckets', (rolePrefix) => {
    const role = one('AWS::IAM::Role', rolePrefix);
    const managed = JSON.stringify(role.Properties.ManagedPolicyArns);
    expect(managed).toContain('AmazonSSMManagedInstanceCore');
    expect(managed).toContain('CloudWatchAgentServerPolicy');
    for (const broad of ['SecretsManagerReadWrite', 'CloudWatchLogsFullAccess', 'AmazonEC2RoleforAWSCodeDeploy']) {
      expect(managed).not.toContain(broad);
    }
    const st = statementsOf(rolePrefix);
    const s3Writes = st.filter((s: any) => actions(s).some((a: string) => /^s3:(Put|Delete)/.test(a)));
    expect(s3Writes).toEqual([]);
    const text = JSON.stringify(st);
    expect(text).not.toContain('arn:aws:s3:::*');
    expect(text).not.toContain('CapacityManifest');
    // What after_install.sh and the boot path read.
    for (const p of ['db-secret-arn', 'db-host', 'db-port']) expect(text).toContain(`:parameter/polis/${p}`);
    expect(text).toContain('WebAppEnvVarsSecret');
    expect(text).toContain('secretsmanager:GetSecretValue');
    expect(text).toMatch(/DatabaseSecret|DBSecret|Secret[A-Za-z0-9]*Attachment|Db[A-Za-z]*Secret/);
    expect(text).toContain('logs:PutLogEvents');
    // The agent installer: only for a group in the deployment group (math-large today).
    if (rolePrefix.startsWith('DelphiLarge')) expect(text).toContain('aws-codedeploy-us-east-1');
    else expect(text).not.toContain('aws-codedeploy-us-east-1');
    expect(text).toContain('DeploymentPackageBucket');       // the revision
    // The restricted queue login, by name only; nothing creates it.
    const login = st.filter((s: any) => s.Sid === 'QueueLoginRead');
    expect(login).toEqual([{
      Sid: 'QueueLoginRead', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue',
      Resource: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:polis-queue-login-*',
    }]);
    expect(byType('AWS::SecretsManager::Secret').filter(([, s]) => String(s.Properties.Name).startsWith('polis-queue-login'))).toEqual([]);
  });

  test('Postgres admits every worker group', () => {
    // Both worker templates use the Delphi security group, which already has
    // the Postgres rule; the extra group's allowFrom dedups into the same rule.
    for (const lt of [largeLt, delphiLt]) {
      const sgs = lt.Properties.LaunchTemplateData.SecurityGroupIds;
      expect(sgs).toHaveLength(1);
      const sg = sgs[0]['Fn::GetAtt'][0];
      expect(sg).toMatch(/^DelphiSecurityGroup/);
      const ingress = byType('AWS::EC2::SecurityGroupIngress').filter(([, i]) =>
        i.Properties.FromPort === 5432 && i.Properties.SourceSecurityGroupId?.['Fn::GetAtt']?.[0] === sg);
      expect(ingress).toHaveLength(1);
    }
  });
});

describe('readiness lines', () => {
  // The daemon's heartbeat (queue-rs/src/jobs/readiness.rs) and the math
  // poller's (P-072) must never satisfy each other's filters: a worker box
  // must not keep the small poller's heartbeat alive, and the small poller
  // must not count as a worker daemon.
  const body = '{"schema":"math_poller.readiness/1","role":"primary","progress":"ok"}';
  const daemonLines = [
    'polis_jobs readiness/1 role=worker progress=ok {"schema":"polis_jobs.readiness/1","env":"prod","in_flight":[]}',
    'polis_jobs readiness/1 role=worker progress=idle {"schema":"polis_jobs.readiness/1","env":"prod","in_flight":[]}',
    '{"class":"small","label":"python","large_demand":1,"large_leased":0,"large_poisoned":0,"role":"primary",' +
      '"schema":"math_poller.capacity/1"}',
  ];
  const smallLines = [
    `math_poller readiness/1 role=primary progress=ok ${body}`,
    `math_poller discovery_stale/1 ${body}`,
    `math_poller readiness_test/1 ${body}`,
  ];
  // A CloudWatch quoted-term filter matches when the event contains the phrase.
  const matches = (phrase: string, line: string) => line.includes(phrase);

  test('a daemon line never matches the math poller heartbeat or a stale phrase', () => {
    for (const line of daemonLines) {
      expect(matches(HEARTBEAT_PHRASE, line)).toBe(false);
      for (const p of STALE_PHRASES) expect(matches(p, line)).toBe(false);
    }
  });
  test('a math poller line never matches the daemon heartbeat; the daemon lines do', () => {
    for (const line of smallLines) expect(matches(WORKER_HEARTBEAT_PHRASE, line)).toBe(false);
    expect(matches(WORKER_HEARTBEAT_PHRASE, daemonLines[0])).toBe(true);
    expect(matches(WORKER_HEARTBEAT_PHRASE, daemonLines[1])).toBe(true);
    expect(matches(WORKER_HEARTBEAT_PHRASE, daemonLines[2])).toBe(false);
  });
  test('the small lines still match their own filters (the check is not vacuous)', () => {
    expect(matches(HEARTBEAT_PHRASE, smallLines[0])).toBe(true);
    expect(matches(STALE_PHRASES[0], smallLines[1])).toBe(true);
    expect(matches(STALE_PHRASES[1], smallLines[2])).toBe(true);
  });
});
