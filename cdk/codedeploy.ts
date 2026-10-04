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
  // P-073: the delphi-large box's own role fetches revisions too.
  delphiLargeRole?: cdk.aws_iam.IRole
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
  if (delphiLargeRole) {
    deploymentBucket.grantRead(delphiLargeRole);
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