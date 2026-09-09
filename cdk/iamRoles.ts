import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';

export default (self: Construct) => {
  const instanceRole = new iam.Role(self, 'InstanceRole', {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforAWSCodeDeploy'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    ],
  });
  instanceRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:AbortMultipartUpload', 's3:ListBucket', 's3:GetObject', 's3:DeleteObject'],
    resources: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
  }));

  const dbBackupLambdaRole = new iam.Role(self, 'DBBackupLambdaRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    ],
  });
  
  // IAM Role for CodeDeploy
  const codeDeployRole = new iam.Role(self, 'CodeDeployRole', {
    assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSCodeDeployRole'),
    ],
  });
  const delphiJobQueueTableArn = cdk.Arn.format({
    service: 'dynamodb',
    region: 'us-east-1',
    account: cdk.Stack.of(self).account,
    resource: 'table',
    resourceName: 'Delphi_*',
  }, cdk.Stack.of(self));

  const delphiJobQueueTableIndexesArn = `${delphiJobQueueTableArn}/index/*`;

  instanceRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan"
    ],
    resources: [
      delphiJobQueueTableArn,
      delphiJobQueueTableIndexesArn
    ],
  }));

  return { instanceRole, codeDeployRole, dbBackupLambdaRole }
}

/**
 * Dedicated role for the Delphi queue demand observer (P-003 slice S1).
 *
 * Deliberately narrow, and deliberately NOT the shared `instanceRole`:
 * P-003 requires that scaling permissions are never attached to the role the
 * web/math/Delphi hosts share.
 *
 * Contains exactly three statements:
 *   - `dynamodb:Scan` on the one queue table (no indexes: the observer reads
 *     the base table so it can see rows absent from every GSI, and it has no
 *     `Query` permission at all in S1).
 *   - `cloudwatch:PutMetricData`. PutMetricData supports no resource-level
 *     permissions, so `Resource: '*'` is unavoidable and is constrained by the
 *     `cloudwatch:namespace` condition key instead. Written as a resource ARN
 *     the policy would simply not work; written as a bare `*` it would grant
 *     the whole account's metric namespace.
 *   - Writes to its own log group only.
 *
 * There is no `autoscaling:*` permission of any kind. S1 is observe-only; the
 * ASG-scoped `SetDesiredCapacity` grant belongs to slice S7.
 */
export const createDelphiObserverRole = (
  self: Construct,
  opts: { queueTableArn: string; logGroupArn: string; metricNamespace: string },
) => {
  const role = new iam.Role(self, 'DelphiDemandObserverRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'Read-only Delphi queue observer (P-003 S1). No scaling permissions.',
  });

  role.addToPolicy(new iam.PolicyStatement({
    sid: 'ScanDelphiJobQueue',
    effect: iam.Effect.ALLOW,
    actions: ['dynamodb:Scan'],
    resources: [opts.queueTableArn],
  }));

  role.addToPolicy(new iam.PolicyStatement({
    sid: 'PublishDelphiQueueMetrics',
    effect: iam.Effect.ALLOW,
    actions: ['cloudwatch:PutMetricData'],
    resources: ['*'],
    conditions: {
      StringEquals: { 'cloudwatch:namespace': opts.metricNamespace },
    },
  }));

  role.addToPolicy(new iam.PolicyStatement({
    sid: 'WriteOwnLogs',
    effect: iam.Effect.ALLOW,
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [opts.logGroupArn, `${opts.logGroupArn}:*`],
  }));

  return role;
}