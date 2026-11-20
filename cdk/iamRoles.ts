import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';

export default (self: Construct) => {
  // The shared role of the web, math-worker, Delphi small, Delphi large
  // (with the worker classes off) and Ollama boxes. Secrets Manager access is
  // NOT a managed policy: SecretsManagerReadWrite let any process on these
  // boxes read, write and delete every secret in the account. Each secret a
  // box reads is granted read-only (GetSecretValue + DescribeSecret) by name
  // where it is created: secrets.ts (the app env document, the client env
  // documents, the database secret) and cdk-stack.ts (the Ollama URL).
  const instanceRole = new iam.Role(self, 'InstanceRole', {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforAWSCodeDeploy'),
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