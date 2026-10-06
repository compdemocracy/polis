import { Construct } from "constructs";
import * as cdk from 'aws-cdk-lib';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as s3 from 'aws-cdk-lib/aws-s3';

export default (
  self: Construct,
  instanceRole: cdk.aws_iam.Role,
  asgWeb: cdk.aws_autoscaling.AutoScalingGroup,
  asgMathWorker: cdk.aws_autoscaling.AutoScalingGroup,
  asgDelphiSmall: cdk.aws_autoscaling.AutoScalingGroup,
  asgDelphiLarge: cdk.aws_autoscaling.AutoScalingGroup,
  codeDeployRole: cdk.aws_iam.Role,
  // Queue worker classes (cdk/workerClasses.ts): each class role fetches revisions too. Only
  // asgDelphiLarge (service type delphi-large, which scripts/after_install.sh handles) is in
  // the deployment group. The other worker groups stay out until the deploy hooks have a
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

  // Deployment Group
  const deploymentGroup = new codedeploy.ServerDeploymentGroup(self, 'DeploymentGroup', {
    application,
    deploymentGroupName: 'PolisDeploymentGroup',
    autoScalingGroups: [asgWeb, asgMathWorker, asgDelphiSmall, asgDelphiLarge],
    deploymentConfig: codedeploy.ServerDeploymentConfig.ONE_AT_A_TIME,
    role: codeDeployRole,
    installAgent: true,
  });

  return {
    application,
    deploymentBucket,
    deploymentGroup
  }
}