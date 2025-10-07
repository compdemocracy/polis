import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const createDBBackupLambda = (self: Construct, db: cdk.aws_rds.DatabaseInstance, vpc: cdk.aws_ec2.IVpc, dbBackupBucket: cdk.aws_s3.Bucket, dbBackupLambdaRole: iam.Role) => {
  return new PythonFunction(self, 'DBBackupLambda', {
    entry: 'lambda/handler',
    runtime: lambda.Runtime.PYTHON_3_12, 
    index: 'dbBackuplambda.py',
    handler: 'lambda_handler',
    vpc: vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [db.connections.securityGroups[0]],
    role: dbBackupLambdaRole,
    timeout: cdk.Duration.minutes(10),
    memorySize: 512,
    ephemeralStorageSize: cdk.Size.gibibytes(4),
    environment: {},
  });
}

export { createDBBackupLambda }
