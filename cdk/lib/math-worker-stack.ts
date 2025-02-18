import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface MathWorkerStackProps extends cdk.StackProps {
  envFile: string;
  branch?: string;
  instanceType?: string;
  databaseUrl?: string;
  enableSSHAccess?: boolean;
}

export class MathWorkerStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  
  constructor(scope: Construct, id: string, props: MathWorkerStackProps) {
    super(scope, id, props);

    // Default values
    const defaultBranch = 'edge';
    const defaultInstanceType = 't3.medium';

    // Create VPC
    const vpc = new ec2.Vpc(this, 'MathWorkerVPC', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{
        cidrMask: 24,
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
      }],
    });

    // Create security group
    const securityGroup = new ec2.SecurityGroup(this, 'MathWorkerSG', {
      vpc,
      description: 'Security group for Polis math worker',
      allowAllOutbound: true,
    });

    // Only add SSH access if explicitly enabled
    if (props.enableSSHAccess) {
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(22),
        'Allow SSH access'
      );
    }

    // Create IAM role for the instance
    const role = new iam.Role(this, 'MathWorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // Add managed policies
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // Create key pair only if SSH access is enabled
    let keyPair;
    if (props.enableSSHAccess) {
      keyPair = new ec2.CfnKeyPair(this, 'MathWorkerKeyPair', {
        keyName: 'polis-math-worker'
      });
    }

    // Read environment file
    const envContent = readFileSync(props.envFile, 'utf8');
    const modifiedEnvContent = props.databaseUrl 
      ? envContent.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${props.databaseUrl}`)
      : envContent;

    // Create user data script
    const userDataScript = ec2.UserData.forLinux();
    
    // Base installation commands
    const baseCommands = [
      '#!/bin/bash',
      // Install Docker
      'dnf update -y',
      'dnf install -y docker git',
      'systemctl start docker',
      'systemctl enable docker',
    ];

    // Application setup commands
    const appCommands = [
      // Clone Polis repository
      'cd /opt',
      'git clone https://github.com/compdemocracy/polis.git polis',
      'cd polis',
      `git checkout ${props.branch || defaultBranch}`,
      
      // Create env file
      'cat > .env << \'ENVEOF\'',
      modifiedEnvContent,
      'ENVEOF',
      
      // Start math worker
      'cd math',
      'docker build -t polis-math .',
      'docker run -d \\',
      '    --name polis-math \\',
      '    --restart unless-stopped \\',
      '    --memory=$(free -b | awk \'/Mem:/ {printf "%.0f", $2*0.9}\') \\',
      '    --env-file ../.env \\',
      '    polis-math',
    ];

    // Combine all commands
    userDataScript.addCommands(
      ...baseCommands,
      ...appCommands,
    );

    // Create EC2 instance
    this.instance = new ec2.Instance(this, 'MathWorker', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        props.instanceType === 't3.large' ? ec2.InstanceSize.LARGE :
        props.instanceType === 't3.xlarge' ? ec2.InstanceSize.XLARGE :
        ec2.InstanceSize.MEDIUM
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      keyPair: props.enableSSHAccess ? 
        ec2.KeyPair.fromKeyPairName(this, 'ImportedKeyPair', keyPair!.keyName) : 
        undefined,
      role,
      userData: userDataScript,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Add tags
    cdk.Tags.of(this.instance).add('Name', 'polis-math-worker');

    // Output the instance ID
    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'Instance ID of the math worker',
    });

    // Output the instance public IP only if SSH access is enabled
    if (props.enableSSHAccess) {
      new cdk.CfnOutput(this, 'PublicIP', {
        value: this.instance.instancePublicIp,
        description: 'Public IP address of the math worker',
      });
    }
  }
} 