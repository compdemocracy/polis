import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Read-only AWS access for the ops dashboards (P-074 PR3).
 *
 * The /ops pages on the web server read CloudWatch metrics and alarm states,
 * the Auto Scaling fleet, recent CodeDeploy deployments and the Cost Explorer
 * monthly total, with credentials from the instance metadata service. This
 * adds the one policy those reads need, and nothing that writes.
 *
 * The web boxes share `InstanceRole` with the math and Delphi tiers, so the
 * policy is attached to that role: these reads are available to every process
 * on those boxes. All of it is metadata, metrics and billing totals.
 *
 *   cloudwatch:GetMetricData, cloudwatch:ListMetrics   *   (no resource-level support)
 *   autoscaling:DescribeAutoScalingGroups              *   (no resource-level support)
 *   ce:GetCostAndUsage                                 *
 *   cloudwatch:DescribeAlarms                          alarm:Polis-*
 *   codedeploy:ListDeployments,
 *   codedeploy:BatchGetDeployments                     the Polis deployment group
 *
 * `alarm:Polis-*`: AWS lists `alarm` as the resource type for DescribeAlarms,
 * but does not document whether a call by `AlarmNamePrefix` is authorized
 * against a name-wildcard ARN. If the alarms panel reads "not permitted",
 * widen this one resource to `alarm:*` (still read-only; the server filters
 * on `Polis-`).
 *
 * The web launch template's IMDS hop limit is set to 2. The server runs in a
 * bridged Docker container, one network hop further from IMDS than the host;
 * with a hop limit of 1 it cannot get an IMDSv2 token and every AWS panel
 * reads `aws_no_credentials`. The template sets no metadata options today, so
 * instances inherit the AMI default (AL2023: IMDSv2 required, hop limit 2);
 * this makes the requirement explicit instead of inherited. It applies to web
 * instances launched after the change.
 *
 * Off unless synthesized with `-c enableOpsDashboards=true`; with the flag
 * off the template is unchanged.
 */

export const OPS_DASHBOARDS_CONTEXT = 'enableOpsDashboards';
export const OPS_ALARM_NAME_PREFIX = 'Polis-';
export const WEB_IMDS_HOP_LIMIT = 2;

/** Reads the flag; absent or anything but a literal true means off. */
export const opsDashboardsEnabled = (scope: Construct): boolean => {
  const raw = scope.node.tryGetContext(OPS_DASHBOARDS_CONTEXT);
  if (typeof raw === 'boolean') return raw;
  return raw === 'true';
};

export interface OpsDashboardsAccessProps {
  instanceRole: iam.IRole;
  webLaunchTemplate: ec2.LaunchTemplate;
  /** The CodeDeploy application and deployment group the web boxes deploy through. */
  codeDeployApplicationName: string;
  codeDeployDeploymentGroupName: string;
}

/** The deployment group ARN, with the account and region as CloudFormation pseudo parameters. */
export const deploymentGroupArn = (applicationName: string, deploymentGroupName: string): string =>
  `arn:${cdk.Aws.PARTITION}:codedeploy:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:deploymentgroup:${applicationName}/${deploymentGroupName}`;

export const opsDashboardsStatements = (deploymentGroupArn: string): iam.PolicyStatement[] => [
  new iam.PolicyStatement({
    sid: 'OpsDashboardsReadMetricsFleetCost',
    effect: iam.Effect.ALLOW,
    actions: [
      'cloudwatch:GetMetricData',
      'cloudwatch:ListMetrics',
      'autoscaling:DescribeAutoScalingGroups',
      'ce:GetCostAndUsage',
    ],
    resources: ['*'],
  }),
  new iam.PolicyStatement({
    sid: 'OpsDashboardsReadAlarms',
    effect: iam.Effect.ALLOW,
    actions: ['cloudwatch:DescribeAlarms'],
    resources: [
      `arn:${cdk.Aws.PARTITION}:cloudwatch:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:alarm:${OPS_ALARM_NAME_PREFIX}*`,
    ],
  }),
  new iam.PolicyStatement({
    sid: 'OpsDashboardsReadDeployments',
    effect: iam.Effect.ALLOW,
    actions: ['codedeploy:ListDeployments', 'codedeploy:BatchGetDeployments'],
    resources: [deploymentGroupArn],
  }),
];

export default (scope: Construct, props: OpsDashboardsAccessProps) => {
  const policy = new iam.Policy(scope, 'OpsDashboardsReadPolicy', {
    statements: opsDashboardsStatements(
      deploymentGroupArn(props.codeDeployApplicationName, props.codeDeployDeploymentGroupName)),
  });
  policy.attachToRole(props.instanceRole);

  const cfnTemplate = props.webLaunchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
  cfnTemplate.addPropertyOverride(
    'LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit',
    WEB_IMDS_HOP_LIMIT,
  );
  return { policy };
};
