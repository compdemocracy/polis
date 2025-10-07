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