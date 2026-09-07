
import { Construct } from "constructs";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

export default (
  self: Construct,
  vpc: cdk.aws_ec2.Vpc,
  instanceRole: cdk.aws_iam.Role,
  ollamaLaunchTemplate: cdk.aws_ec2.LaunchTemplate | undefined,
  logGroup: cdk.aws_logs.LogGroup,
  fileSystem: cdk.aws_efs.FileSystem | undefined,
  webLaunchTemplate: cdk.aws_ec2.LaunchTemplate,
  mathWorkerLaunchTemplate: cdk.aws_ec2.LaunchTemplate,
  delphiSmallLaunchTemplate: cdk.aws_ec2.LaunchTemplate,
  delphiLargeLaunchTemplate: cdk.aws_ec2.LaunchTemplate,
  ollamaNamespace: string,
  alarmTopic: cdk.aws_sns.Topic,
  enableOllama: boolean = false
) => {
  const commonAsgProps = { vpc, role: instanceRole };

  // Ollama ASG (only when the GPU stack is enabled)
  let asgOllama: autoscaling.AutoScalingGroup | undefined;
  if (enableOllama) {
    if (!ollamaLaunchTemplate || !fileSystem) {
      throw new Error('enableOllama is true but ollamaLaunchTemplate/fileSystem were not provided to createAutoScalingAndAlarms');
    }
    asgOllama = new autoscaling.AutoScalingGroup(self, 'AsgOllama', {
      vpc,
      launchTemplate: ollamaLaunchTemplate,
      minCapacity: 1,
      maxCapacity: 3,
      desiredCapacity: 1,
      vpcSubnets: { subnetGroupName: 'PrivateWithEgress' },
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(10) }),
    });
    asgOllama.node.addDependency(logGroup);
    asgOllama.node.addDependency(fileSystem); // Ensure EFS is ready before instances start
  }

  // Web ASG
  const asgWeb = new autoscaling.AutoScalingGroup(self, 'Asg', {
    vpc,
    launchTemplate: webLaunchTemplate,
    minCapacity: 2,
    maxCapacity: 10,
    desiredCapacity: 2,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    healthCheck: autoscaling.HealthCheck.elb({grace: cdk.Duration.minutes(5)})
  });

  // Math Worker ASG
  const asgMathWorker = new autoscaling.AutoScalingGroup(self, 'AsgMathWorker', {
    vpc,
    launchTemplate: mathWorkerLaunchTemplate,
    minCapacity: 1,
    desiredCapacity: 1,
    // Keep at 1: every math worker polls every conversation and holds its own actors
    // (math/src/polismath/components/{poller,conv_man}.clj); a second instance duplicates
    // the computation and the writes rather than sharing the load.
    maxCapacity: 1,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(2) }),
  });

  // Delphi Small ASG
  const asgDelphiSmall = new autoscaling.AutoScalingGroup(self, 'AsgDelphiSmall', {
    vpc,
    launchTemplate: delphiSmallLaunchTemplate,
    minCapacity: 2,
    desiredCapacity: 2,
    maxCapacity: 7,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(5) }),
  });

  // Delphi Large ASG
  const asgDelphiLarge = new autoscaling.AutoScalingGroup(self, 'AsgDelphiLarge', {
    vpc,
    launchTemplate: delphiLargeLaunchTemplate,
    // Set to 0 in the console on 2026-07-31 (c7i.8xlarge, ~$1,040/mo, was idle). Match it here so a
    // cdk deploy does not bring it back. Large-conversation jobs route to the small class.
    minCapacity: 0,
    desiredCapacity: 0,
    maxCapacity: 3,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(5) }),
  });


  // --- Scaling Policies & Alarms
  const mathWorkerCpuMetric = new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensionsMap: {
      AutoScalingGroupName: asgMathWorker.autoScalingGroupName
    },
    statistic: 'Average',
    period: cdk.Duration.minutes(10),
  });
  asgMathWorker.scaleToTrackMetric('CpuTracking', {
    metric: mathWorkerCpuMetric,
    targetValue: 50,
  });

  // Add Delphi CPU Scaling Policies & Alarms
  const createDelphiCpuScaling = (asg: autoscaling.AutoScalingGroup, name: string, target: number): cloudwatch.Metric => {
    const cpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });
    asg.scaleToTrackMetric(`${name}CpuTracking`, {
      metric: cpuMetric,
      targetValue: target
    });

    // High CPU Alarm
    const alarm = new cloudwatch.Alarm(self, `${name}HighCpuAlarm`, {
      metric: cpuMetric,
      threshold: 80, // Alert if CPU > 80%
      evaluationPeriods: 2, // for 2 consecutive periods (10 minutes total)
      datapointsToAlarm: 2, // Ensure 2 datapoints are breaching
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `Alert when ${name} instances CPU exceeds 80% for 10 minutes`,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE, // Or BREACHING/NOT_BREACHING as appropriate
    });
    // Add SNS action to the alarm
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
    return cpuMetric;
  };
  const delphiSmallCpuMetric = createDelphiCpuScaling(asgDelphiSmall, 'DelphiSmall', 60); // Target 60% CPU
  const delphiLargeCpuMetric = createDelphiCpuScaling(asgDelphiLarge, 'DelphiLarge', 60); // Target 60% CPU

  // Add Ollama GPU Scaling Policy (only when the GPU stack is enabled)
  if (enableOllama && asgOllama) {
    const ollamaGpuMetric = new cloudwatch.Metric({
      namespace: ollamaNamespace, // Custom namespace from CW Agent config
      metricName: 'utilization_gpu', // GPU utilization metric name from CW Agent config
      dimensionsMap: { AutoScalingGroupName: asgOllama.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    asgOllama.scaleToTrackMetric('OllamaGpuScaling', {
      metric: ollamaGpuMetric,
      targetValue: 75,
      cooldown: cdk.Duration.minutes(5), // Prevent flapping
      disableScaleIn: false, // Allow scaling down
      estimatedInstanceWarmup: cdk.Duration.minutes(5), // Time until instance contributes metrics meaningfully
    });
  }

  return {
    asgOllama,
    asgWeb,
    asgMathWorker,
    asgDelphiSmall,
    asgDelphiLarge,
    commonAsgProps
  }
}