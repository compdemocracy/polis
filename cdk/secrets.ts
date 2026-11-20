import { Construct } from "constructs";
import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export default (
  self: Construct,
  instanceRole: cdk.aws_iam.Role,
  db: cdk.aws_rds.DatabaseInstance,
  logGroup: cdk.aws_logs.LogGroup,
  asgWeb: cdk.aws_autoscaling.AutoScalingGroup,
  asgMathWorker: cdk.aws_autoscaling.AutoScalingGroup,
  asgDelphiSmall: cdk.aws_autoscaling.AutoScalingGroup,
  asgDelphiLarge: cdk.aws_autoscaling.AutoScalingGroup,
  asgOllama: cdk.aws_autoscaling.AutoScalingGroup | undefined,
  fileSystem: cdk.aws_efs.FileSystem | undefined,
  // Queue worker classes (cdk/workerClasses.ts): each class role reads the env
  // document and the DB secret in after_install.sh (and nothing else here);
  // every worker group besides asgDelphiLarge gets the same dependencies.
  workers?: { roles: cdk.aws_iam.IRole[]; extraGroups: cdk.aws_autoscaling.AutoScalingGroup[] }
) => {
  const webAppEnvVarsSecret = new secretsmanager.Secret(self, 'WebAppEnvVarsSecret', {
    secretName: 'polis-web-app-env-vars',
    description: 'Environment variables for the Polis web application',
  });
  const clientAdminEnvVarsSecret = new secretsmanager.Secret(self, 'ClientAdminEnvVarsSecret', {
    secretName: 'polis-client-admin-env-vars',
    description: 'Environment variables for the Polis client-admin web application',
  });

  const clientReportEnvVarsSecret = new secretsmanager.Secret(self, 'ClientReportEnvVarsSecret', {
    secretName: 'polis-client-report-env-vars',
    description: 'Environment variables for the Polis client-report web application',
  });
  // Read-only, by name, on the shared InstanceRole (iamRoles.ts: no
  // SecretsManagerReadWrite). scripts/after_install.sh reads the app env
  // document by name and the database secret by the ARN in /polis/db-secret-arn.
  webAppEnvVarsSecret.grantRead(instanceRole);
  clientAdminEnvVarsSecret.grantRead(instanceRole);
  clientReportEnvVarsSecret.grantRead(instanceRole);
  db.secret!.grantRead(instanceRole);
  for (const role of workers?.roles ?? []) {
    webAppEnvVarsSecret.grantRead(role);
    db.secret!.grantRead(role);
  }

  // Dependencies (Add ASGs to loops/lists)
  const addDbDependency = (asg: autoscaling.IAutoScalingGroup) => asg.node.addDependency(db);
  const addLogDependency = (asg: autoscaling.IAutoScalingGroup) => asg.node.addDependency(logGroup);
  const addSecretDependency = (asg: autoscaling.IAutoScalingGroup) => asg.node.addDependency(webAppEnvVarsSecret);

  // Apply common dependencies to all ASGs
  [asgWeb, asgMathWorker, asgDelphiSmall, asgDelphiLarge, ...(workers?.extraGroups ?? [])].forEach(asg => {
    addLogDependency(asg);
    addSecretDependency(asg);
    addDbDependency(asg);
  });

  // Ollama dependencies (only when the GPU stack is enabled)
  if (asgOllama) {
    addLogDependency(asgOllama);
    addSecretDependency(asgOllama);
    if (fileSystem) {
      asgOllama.node.addDependency(fileSystem);
    }
  }
}
