import { Construct } from "constructs";
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

export default (self: Construct, vpc: cdk.aws_ec2.IVpc) => {
  const dbSubnetGroup = new rds.SubnetGroup(self, 'DatabaseSubnetGroup', {
    vpc,
    subnetGroupName: 'PolisDatabaseSubnetGroup',
    description: 'Subnet group for the postgres database',
    vpcSubnets: { subnetGroupName: 'Private' },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const db = new rds.DatabaseInstance(self, 'Database', {
    engine: rds.DatabaseInstanceEngine.postgres({version: rds.PostgresEngineVersion.VER_17 }),
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
    vpc,
    allocatedStorage: 20,
    maxAllocatedStorage: 100,
    storageType: rds.StorageType.GP2,
    credentials: rds.Credentials.fromGeneratedSecret('dbUser'),
    databaseName: 'polisdb',
    removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    deletionProtection: true,
    publiclyAccessible: false,
    subnetGroup: dbSubnetGroup,
  });

  const dbAlarmsTopic = new sns.Topic(self, 'DatabaseAlarmsTopic', {
    displayName: 'Database Alarms Topic',
  });

  dbAlarmsTopic.addSubscription(new subscriptions.EmailSubscription('tim@compdemocracy.org'));

  const lowStorageAlarm = new cloudwatch.Alarm(self, 'LowStorageAlarm', {
    alarmName: 'Polis-DB-LowFreeStorageSpace',
    alarmDescription: 'Alarm when the database has low free storage space',
    metric: db.metric('FreeStorageSpace', {
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
    }),
    threshold: 4 * 1024 * 1024 * 1024, // 4 Gigabytes in bytes
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.IGNORE,
  });
  lowStorageAlarm.addAlarmAction(new cw_actions.SnsAction(dbAlarmsTopic));

  // Alarm for High CPU Utilization (triggers when > 80% for 10 minutes)
  const highCpuAlarm = new cloudwatch.Alarm(self, 'HighCpuAlarm', {
    alarmName: 'Polis-DB-HighCPUUtilization',
    alarmDescription: 'Alarm when the database CPU utilization is high',
    metric: db.metric('CPUUtilization', {
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
    }),
    threshold: 80, // 80 percent
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  highCpuAlarm.addAlarmAction(new cw_actions.SnsAction(dbAlarmsTopic));

    // Alarm for High Database Connections (triggers when connections > 500)
  const highConnectionsAlarm = new cloudwatch.Alarm(self, 'HighConnectionsAlarm', {
    alarmName: 'Polis-DB-HighDatabaseConnections',
    alarmDescription: 'Alarm when the number of database connections is high',
    metric: db.metric('DatabaseConnections', {
      period: cdk.Duration.minutes(1),
      statistic: 'Average',
    }),
    threshold: 500, // Adjust this based on your instance type's limits and expected load
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 3, // Breached for 3 consecutive periods (3 mins)
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  highConnectionsAlarm.addAlarmAction(new cw_actions.SnsAction(dbAlarmsTopic));


  // SSM Parameters for DB connection
  const dbSecretArnParam = new ssm.StringParameter(self, 'DBSecretArnParameter', {
    parameterName: '/polis/db-secret-arn',
    stringValue: db.secret!.secretArn,
    description: 'SSM Parameter storing the ARN of the Polis Database Secret',
  });
  const dbHostParam = new ssm.StringParameter(self, 'DBHostParameter', {
    parameterName: '/polis/db-host',
    stringValue: db.dbInstanceEndpointAddress,
    description: 'SSM Parameter storing the Polis Database Host',
  });
  const dbPortParam = new ssm.StringParameter(self, 'DBPortParameter', {
    parameterName: '/polis/db-port',
    stringValue: db.dbInstanceEndpointPort,
    description: 'SSM Parameter storing the Polis Database Port',
  });

  return { dbSubnetGroup, db, dbSecretArnParam, dbHostParam, dbPortParam, dbAlarmsTopic }
}
