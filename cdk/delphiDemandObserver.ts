import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { createDelphiObserverRole } from './iamRoles';

/**
 * Delphi queue demand observer — P-003 slice S1, observe-only.
 *
 * A one-minute scheduled Lambda that scans `Delphi_JobQueue`, classifies every
 * row against the P-003 wake table, and publishes gauges to the CloudWatch
 * namespace `Polis/DelphiQueue`.
 *
 * It takes NO scaling action and it does not read, reference or depend on the
 * Delphi ASG. Adding `SetDesiredCapacity` is slice S7; per review item G2 the
 * `DesiredCapacity` property on `AsgDelphiSmall` must not be touched here,
 * because removing it on a stack update defaults desired capacity to MinSize.
 *
 * Everything is gated behind the `enableDelphiDemandObserver` CDK context
 * flag, which defaults to false, so the synthesized template is byte-identical
 * to the current one unless the flag is passed.
 */

export const DELPHI_QUEUE_METRIC_NAMESPACE = 'Polis/DelphiQueue';
export const DELPHI_QUEUE_TABLE_NAME = 'Delphi_JobQueue';
const FUNCTION_NAME = 'polis-delphi-demand-observer';

export interface DelphiDemandObserverProps {
  /** DynamoDB table the observer scans. Defaults to `Delphi_JobQueue`. */
  queueTableName?: string;
  /** Value of the fixed `Environment` metric dimension. */
  environmentName?: string;
}

/**
 * Reads the `enableDelphiDemandObserver` context flag. Absent, or anything
 * other than a literal `true`, means off — an enable flag must default to off
 * when it is not present (P-003 F17).
 */
export const delphiDemandObserverEnabled = (scope: Construct): boolean => {
  const raw = scope.node.tryGetContext('enableDelphiDemandObserver');
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.toLowerCase() === 'true';
};

const createDelphiDemandObserver = (
  self: Construct,
  props: DelphiDemandObserverProps = {},
) => {
  const stack = cdk.Stack.of(self);
  const queueTableName = props.queueTableName ?? DELPHI_QUEUE_TABLE_NAME;

  // Exactly one table, by name. Not the `Delphi_*` wildcard the shared
  // instanceRole uses, and no `/index/*` suffix: the observer reads the base
  // table only. Region is pinned the same way iamRoles.ts pins the shared
  // Delphi grant, so both name the same physical table.
  const queueTableArn = cdk.Arn.format({
    service: 'dynamodb',
    region: 'us-east-1',
    resource: 'table',
    resourceName: queueTableName,
  }, stack);

  // The log group is created explicitly (rather than implicitly by Lambda) so
  // the role's logs statement can name it, and so retention is bounded.
  const logGroup = new logs.LogGroup(self, 'DelphiDemandObserverLogGroup', {
    logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const role = createDelphiObserverRole(self, {
    queueTableArn,
    logGroupArn: logGroup.logGroupArn,
    metricNamespace: DELPHI_QUEUE_METRIC_NAMESPACE,
  });

  const observer = new lambda.Function(self, 'DelphiDemandObserver', {
    functionName: FUNCTION_NAME,
    description:
      'P-003 S1: observes Delphi_JobQueue demand and publishes Polis/DelphiQueue metrics. Takes no scaling action.',
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: 'index.lambda_handler',
    // Plain asset, no bundling: the handler needs only boto3, which the Lambda
    // Python runtime already provides. Keeps `cdk synth` free of Docker.
    code: lambda.Code.fromAsset('lambda/delphi-demand-observer'),
    role,
    // Outside the VPC. The queue is DynamoDB-backed in /1, so the observer
    // needs no private connectivity and adds no NAT cost. A future Postgres
    // adapter (P-024) would have to re-enter the VPC.
    timeout: cdk.Duration.seconds(50),
    memorySize: 256,
    // No overlapping invocations. A duplicate scheduled delivery throttling
    // against this limit is benign and informational, not an error: a late
    // retry simply reads current state.
    reservedConcurrentExecutions: 1,
    environment: {
      DELPHI_QUEUE_TABLE: queueTableName,
      POLIS_ENVIRONMENT: props.environmentName ?? 'prod',
      DELPHI_WORKER_CLASS: 'delphi-small',
      // Pre-projection byte budget, not a row count: DynamoDB bills a Scan on
      // item size before the projection is applied. ~1.11 MB measured, so this
      // is ~15x headroom. A budget hit with pages remaining is an incomplete
      // observation, which publishes ObserverHealthy=0 and no demand sample.
      MAX_SCAN_BYTES: String(16 * 1024 * 1024),
      MAX_SCAN_PAGES: '100',
      SCAN_DEADLINE_SECONDS: '30',
    },
    logGroup,
  });

  new events.Rule(self, 'DelphiDemandObserverScheduleRule', {
    description: 'Runs the Delphi queue demand observer every minute (P-003 S1).',
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new targets.LambdaFunction(observer)],
  });

  return { observer, role, logGroup };
};

export default createDelphiDemandObserver;
