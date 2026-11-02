import { Construct } from "constructs";
import * as cdk from 'aws-cdk-lib';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';

export default (
  self: Construct,
  instanceRole: cdk.aws_iam.Role,
  asgWeb: cdk.aws_autoscaling.AutoScalingGroup,
  asgMathWorker: cdk.aws_autoscaling.AutoScalingGroup,
  asgDelphiSmall: cdk.aws_autoscaling.AutoScalingGroup,
  asgDelphiLarge: cdk.aws_autoscaling.AutoScalingGroup,
  codeDeployRole: cdk.aws_iam.Role,
  // The web target group (cdk/dns.ts). Named on the web deployment group so CodeDeploy
  // deregisters a web box from the load balancer and lets its in-flight requests drain
  // BEFORE the hooks replace its containers, and registers it again only after
  // ValidateService has passed. Without this the balancer keeps sending requests to a
  // box whose nginx is gone for the whole `docker-compose down`/`up` (HTTP 502s at
  // every deploy): the target group's health check is far too slow to notice a restart.
  webTargetGroup: elbv2.IApplicationTargetGroup,
  // Queue worker classes (cdk/workerClasses.ts): each class role fetches revisions too. Only
  // asgDelphiLarge (service type delphi-large, which scripts/after_install.sh handles) is in
  // a deployment group. The other worker groups stay out until the deploy hooks have a
  // branch for their service type: today an unknown type makes after_install.sh start every
  // service on the box.
  workers?: { roles: cdk.aws_iam.IRole[]; extraGroups: cdk.aws_autoscaling.AutoScalingGroup[] }
) => {
  const application = new codedeploy.ServerApplication(self, 'CodeDeployApplication', {
    applicationName: 'PolisApplication',
  });

  const deploymentBucket = new s3.Bucket(self, 'DeploymentPackageBucket', {
    bucketName: `polis-deployment-packages-${cdk.Stack.of(self).account}-${cdk.Stack.of(self).region}`,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    versioned: true,
    publicReadAccess: false,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  });
  deploymentBucket.grantRead(instanceRole);
  for (const role of workers?.roles ?? []) {
    deploymentBucket.grantRead(role);
  }

  // Two deployment groups, one per tier, because of how CodeDeploy's traffic control
  // works: at the end of an in-place deployment every instance of the group is
  // registered with EVERY target group the group names, whether or not it was
  // registered before. A single group holding the Delphi and worker boxes as well
  // would put those boxes behind the web load balancer. So the web ASG is alone in
  // the group that names the target group, and the worker tiers deploy through a
  // second group with no load balancer. The deploy workflow creates one deployment
  // per group from the same bundle; the migration step serialises on the database
  // lock, so the two may run at the same time.
  //
  // Web boxes: deregister (BlockTraffic), hooks, ValidateService, register
  // (AllowTraffic; CodeDeploy waits for the target to pass a health check, up to an
  // hour). The deployment group name is unchanged so the failure rule (cdk/alarms.ts),
  // the ops dashboards' reads and the deploy workflow keep working.
  const deploymentGroup = new codedeploy.ServerDeploymentGroup(self, 'DeploymentGroup', {
    application,
    deploymentGroupName: 'PolisDeploymentGroup',
    autoScalingGroups: [asgWeb],
    deploymentConfig: codedeploy.ServerDeploymentConfig.ONE_AT_A_TIME,
    role: codeDeployRole,
    installAgent: true,
    loadBalancers: [codedeploy.LoadBalancer.application(webTargetGroup)],
  });

  // Worker tiers: no load balancer, so no traffic control; the hooks restart their
  // services exactly as before.
  const workersDeploymentGroup = new codedeploy.ServerDeploymentGroup(self, 'WorkersDeploymentGroup', {
    application,
    deploymentGroupName: 'PolisWorkersDeploymentGroup',
    autoScalingGroups: [asgMathWorker, asgDelphiSmall, asgDelphiLarge],
    deploymentConfig: codedeploy.ServerDeploymentConfig.ONE_AT_A_TIME,
    role: codeDeployRole,
    installAgent: true,
  });

  return {
    application,
    deploymentBucket,
    deploymentGroup,
    workersDeploymentGroup
  }
}
