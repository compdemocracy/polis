# Delphi Autoscaling Setup

This document describes the autoscaling setup for the Delphi service on AWS. The setup uses AWS EC2 Auto Scaling Groups to automatically scale the Delphi service based on CPU usage.

## Architecture Overview

The Delphi autoscaling setup consists of:

1. **Two Types of EC2 Instances**:
   - Small Instances (t3.large): For regular workloads
   - Large Instances (c6g.4xlarge): For demanding jobs (ARM-based)

2. **Auto Scaling Groups**:
   - Small Instance ASG: Starts with 2 instances, scales up to 5 based on demand
   - Large Instance ASG: Starts with 1 instance, scales up to 3 based on demand

3. **CloudWatch Monitoring**:
   - CPU-based scaling: Scale down when CPU is below 60%
   - Alarms for high CPU usage (above 80%)

4. **Instance Identification**:
   - Environment variables to identify instance types
   - Dynamic configuration based on instance size

## CDK Stack Implementation

The CDK stack includes the following components:

### Instance Definitions

```typescript
// Delphi small instance (cost efficient)
const instanceTypeDelphiSmall = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE);
const machineImageDelphiSmall = new ec2.AmazonLinuxImage({ 
  generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023 
});

// Delphi large instance (performance optimized)
const instanceTypeDelphiLarge = ec2.InstanceType.of(ec2.InstanceClass.C6G, ec2.InstanceSize.XLARGE4);
const machineImageDelphiLarge = new ec2.AmazonLinuxImage({
  generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
  cpuType: ec2.AmazonLinuxCpuType.ARM_64
});
```

### Security Group

```typescript
const delphiSecurityGroup = new ec2.SecurityGroup(this, 'DelphiSecurityGroup', {
  vpc,
  description: 'Security group for Delphi worker instances',
  allowAllOutbound: true,
});

if (props.enableSSHAccess) {
  delphiSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.sshAllowedIpRange || defaultSSHRange), ec2.Port.tcp(22), 'Allow SSH access');
}
```

### Key Pairs

```typescript
let delphiSmallKeyPair: ec2.IKeyPair | undefined;
if (props.enableSSHAccess) {
  delphiSmallKeyPair = props.delphiSmallKeyPairName
  ? ec2.KeyPair.fromKeyPairName(this, 'DelphiSmallKeyPair', props.delphiSmallKeyPairName)
  : new ec2.KeyPair(this, 'DelphiSmallKeyPair');
}

let delphiLargeKeyPair: ec2.IKeyPair | undefined;
if (props.enableSSHAccess) {
  delphiLargeKeyPair = props.delphiLargeKeyPairName
  ? ec2.KeyPair.fromKeyPairName(this, 'DelphiLargeKeyPair', props.delphiLargeKeyPairName)
  : new ec2.KeyPair(this, 'DelphiLargeKeyPair');
}
```

### UserData

```typescript
const usrdata = (CLOUDWATCH_LOG_GROUP_NAME: string, service: string, instanceSize?: string) => {
  let ld;
  ld = ec2.UserData.forLinux();
  ld.addCommands(
    '#\!/bin/bash',
    'set -e',
    'set -x',
    `echo "Writing service type '${service}' to /tmp/service_type.txt"`,
    `echo "${service}" > /tmp/service_type.txt`,
    // If instanceSize is provided, write it to a file
    instanceSize ? `echo "Writing instance size '${instanceSize}' to /tmp/instance_size.txt"` : '',
    instanceSize ? `echo "${instanceSize}" > /tmp/instance_size.txt` : '',
    // ... additional setup commands ...
  );
  return ld;
};
```

### Launch Templates

```typescript
const delphiSmallLaunchTemplate = new ec2.LaunchTemplate(this, 'DelphiSmallLaunchTemplate', {
  machineImage: machineImageDelphiSmall,
  userData: usrdata(logGroup.logGroupName, "delphi", "small"),
  instanceType: instanceTypeDelphiSmall,
  securityGroup: delphiSecurityGroup,
  keyPair: props.enableSSHAccess ? delphiSmallKeyPair : undefined,
  role: instanceRole,
});

const delphiLargeLaunchTemplate = new ec2.LaunchTemplate(this, 'DelphiLargeLaunchTemplate', {
  machineImage: machineImageDelphiLarge,
  userData: usrdata(logGroup.logGroupName, "delphi", "large"),
  instanceType: instanceTypeDelphiLarge,
  securityGroup: delphiSecurityGroup,
  keyPair: props.enableSSHAccess ? delphiLargeKeyPair : undefined,
  role: instanceRole,
});
```

### Auto Scaling Groups

```typescript
// Delphi Small Instance Auto Scaling Group
const asgDelphiSmall = new autoscaling.AutoScalingGroup(this, 'AsgDelphiSmall', {
  vpc,
  launchTemplate: delphiSmallLaunchTemplate,
  minCapacity: 1,
  desiredCapacity: 2,
  maxCapacity: 5,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PUBLIC,
  },
  healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(2) }),
});

// Delphi Large Instance Auto Scaling Group
const asgDelphiLarge = new autoscaling.AutoScalingGroup(this, 'AsgDelphiLarge', {
  vpc,
  launchTemplate: delphiLargeLaunchTemplate,
  minCapacity: 0,
  desiredCapacity: 1,
  maxCapacity: 3,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PUBLIC,
  },
  healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(2) }),
});
```

### CloudWatch Metrics and Scaling

```typescript
// CPU metrics for Delphi small instances
const delphiSmallCpuMetric = new cloudwatch.Metric({
  namespace: 'AWS/EC2',
  metricName: 'CPUUtilization',
  dimensionsMap: {
    AutoScalingGroupName: asgDelphiSmall.autoScalingGroupName,
  },
  statistic: 'Average',
  period: cdk.Duration.minutes(5),
});

// Scale small Delphi instances based on CPU usage
asgDelphiSmall.scaleToTrackMetric('DelphiSmallCpuTracking', {
  metric: delphiSmallCpuMetric,
  targetValue: 60,  // Target 60% CPU utilization
  scaleInCooldown: cdk.Duration.minutes(5),
  scaleOutCooldown: cdk.Duration.minutes(2),
});
```

### CloudWatch Alarms

```typescript
// CloudWatch alarms for Delphi small instances
const delphiSmallHighCpuAlarm = new cloudwatch.Alarm(this, 'DelphiSmallHighCpuAlarm', {
  metric: delphiSmallCpuMetric,
  threshold: 80,
  evaluationPeriods: 2,
  datapointsToAlarm: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  alarmDescription: 'Alert when Delphi small instances CPU exceeds 80% for 10 minutes',
});

delphiSmallHighCpuAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));
```

## Docker Compose Configuration

The docker-compose.yml file is configured to adjust resource usage based on the instance size:

```yaml
delphi:
  image: 050917022930.dkr.ecr.us-east-1.amazonaws.com/polis/delphi:latest
  build:
    context: ./delphi
  environment:
    - INSTANCE_SIZE=${INSTANCE_SIZE:-default}
    - DELPHI_MAX_WORKERS=${DELPHI_MAX_WORKERS:-2}
    - DELPHI_WORKER_MEMORY=${DELPHI_WORKER_MEMORY:-1g}
  deploy:
    resources:
      limits:
        memory: ${DELPHI_CONTAINER_MEMORY:-4g}
        cpus: ${DELPHI_CONTAINER_CPUS:-2}
```

## CodeDeploy Integration

The deployment script (`/scripts/after_install.sh`) is updated to handle the Delphi service type:

```bash
elif [ "$SERVICE_FROM_FILE" == "delphi" ]; then
  echo "Starting docker-compose up for 'delphi' service"
  
  # Check if instance size file exists
  if [ -f "/tmp/instance_size.txt" ]; then
    INSTANCE_SIZE=$(cat /tmp/instance_size.txt)
    echo "Instance size detected: $INSTANCE_SIZE"
    
    # Set environment variables based on instance size
    if [ "$INSTANCE_SIZE" == "small" ]; then
      echo "Configuring delphi for small instance"
      export INSTANCE_SIZE="small"
      export DELPHI_MAX_WORKERS=3
      export DELPHI_WORKER_MEMORY="2g"
      export DELPHI_CONTAINER_MEMORY="8g"
      export DELPHI_CONTAINER_CPUS="2"
    elif [ "$INSTANCE_SIZE" == "large" ]; then
      echo "Configuring delphi for large instance"
      export INSTANCE_SIZE="large"
      export DELPHI_MAX_WORKERS=8
      export DELPHI_WORKER_MEMORY="8g"
      export DELPHI_CONTAINER_MEMORY="32g"
      export DELPHI_CONTAINER_CPUS="8"
    fi
    
    # Add environment variables to .env file
    echo "INSTANCE_SIZE=$INSTANCE_SIZE" >> .env
    echo "DELPHI_MAX_WORKERS=$DELPHI_MAX_WORKERS" >> .env
    echo "DELPHI_WORKER_MEMORY=$DELPHI_WORKER_MEMORY" >> .env
    echo "DELPHI_CONTAINER_MEMORY=$DELPHI_CONTAINER_MEMORY" >> .env
    echo "DELPHI_CONTAINER_CPUS=$DELPHI_CONTAINER_CPUS" >> .env
  fi
  
  # Start delphi service
  /usr/local/bin/docker-compose up -d delphi --build --force-recreate
fi
```

## Required Application Changes

The Delphi application should check the `INSTANCE_SIZE` environment variable and adjust its internal settings accordingly:

```python
import os

# Get instance type from environment
instance_type = os.environ.get('INSTANCE_SIZE', 'default')
max_workers = int(os.environ.get('DELPHI_MAX_WORKERS', 2))
worker_memory = os.environ.get('DELPHI_WORKER_MEMORY', '1g')

# Configure application based on instance type
if instance_type == 'large':
    # Configure for high performance
    use_gpu = True
    batch_size = 64
    model_size = 'large'
elif instance_type == 'small':
    # Configure for balanced performance
    use_gpu = False
    batch_size = 32
    model_size = 'medium'
else:
    # Default configuration
    use_gpu = False
    batch_size = 16
    model_size = 'small'
```

## Deployment Notes

1. When deploying the CDK stack, ensure that:
   - The correct VPC is used
   - Security groups are properly configured
   - Key pairs are available if SSH access is enabled

2. After deployment, verify:
   - The Auto Scaling Groups are created
   - The launch templates are configured correctly
   - The CloudWatch alarms are active

3. To monitor the autoscaling:
   - Check CloudWatch metrics for CPU utilization
   - Monitor Auto Scaling Group activity
   - Review instance logs for any issues

4. To update resources:
   - Modify the `after_install.sh` script to adjust resource allocations
   - Update the CDK stack to change instance types or scaling policies
EOF < /dev/null
