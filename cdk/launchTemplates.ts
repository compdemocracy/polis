import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';

export default (
  self: Construct,
  logGroup: cdk.aws_logs.LogGroup,
  ollamaNamespace: string,
  ollamaModelDirectory: string,
  fileSystem: cdk.aws_efs.FileSystem,
  machineImageWeb: ec2.IMachineImage,
  instanceTypeWeb: ec2.InstanceType,
  webSecurityGroup: ec2.ISecurityGroup,
  webKeyPair: ec2.IKeyPair | undefined,
  instanceRole: cdk.aws_iam.IRole,
  machineImageMathWorker: ec2.IMachineImage,
  instanceTypeMathWorker: ec2.InstanceType,
  mathWorkerSecurityGroup: ec2.ISecurityGroup,
  mathWorkerKeyPair: ec2.IKeyPair | undefined,
  machineImageDelphiSmall: ec2.IMachineImage,
  instanceTypeDelphiSmall: ec2.InstanceType,
  delphiSmallKeyPair: ec2.IKeyPair | undefined,
  machineImageDelphiLarge: ec2.IMachineImage,
  instanceTypeDelphiLarge: ec2.InstanceType,
  delphiSecurityGroup: ec2.ISecurityGroup,
  delphiLargeKeyPair: ec2.IKeyPair | undefined,
  machineImageOllama: ec2.IMachineImage,
  instanceTypeOllama: ec2.InstanceType,
  ollamaKeyPair: ec2.IKeyPair | undefined,
  ollamaSecurityGroup: ec2.ISecurityGroup
) => {
  const usrdata = (CLOUDWATCH_LOG_GROUP_NAME: string, service: string, instanceSize?: string) => {
    let ld: ec2.UserData;
    ld = ec2.UserData.forLinux();
    const persistentConfigDir = '/etc/app-info';
    ld.addCommands(
      '#!/bin/bash',
      'set -e',
      'set -x',
      `sudo mkdir -p ${persistentConfigDir}`,
      `sudo chown root:root ${persistentConfigDir}`,
      `sudo chmod 755 ${persistentConfigDir}`,
      `echo "Writing service type '${service}' to ${persistentConfigDir}/service_type.txt"`,
      `echo "${service}" | sudo tee ${persistentConfigDir}/service_type.txt`,
      instanceSize ? `echo "Writing instance size '${instanceSize}' to ${persistentConfigDir}/instance_size.txt"` : '',
      instanceSize ? `echo "${instanceSize}" | sudo tee ${persistentConfigDir}/instance_size.txt` : '',
      'sudo yum update -y',
      'sudo yum install -y amazon-cloudwatch-agent -y',
      'sudo dnf install -y wget ruby docker',
      'sudo systemctl start docker',
      'sudo systemctl enable docker',
      'sudo usermod -a -G docker ec2-user',
      'sudo curl -L https://github.com/docker/compose/releases/download/v2.40.0/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose',
      'sudo chmod +x /usr/local/bin/docker-compose',
      'docker-compose --version',
      'sudo yum install -y jq',
      `export SERVICE=${service}`,
      instanceSize ? `export INSTANCE_SIZE=${instanceSize}` : '',
      CLOUDWATCH_LOG_GROUP_NAME ? `echo "${CLOUDWATCH_LOG_GROUP_NAME}" | sudo tee ${persistentConfigDir}/log_group_name.txt` : '',
      'exec 1>>/var/log/user-data.log 2>&1',
      'echo "Finished User Data Execution at $(date)"',
      'sudo mkdir -p /etc/docker',
`cat << EOF | sudo tee /etc/docker/daemon.json
{
  "log-driver": "awslogs",
  "log-opts": {
    "awslogs-group": "${CLOUDWATCH_LOG_GROUP_NAME}",
    "awslogs-region": "${cdk.Stack.of(self).region}",
    "awslogs-stream": "${service}"
  }
}
EOF`,
    `sudo chmod 644 /etc/docker/daemon.json`,
    'sudo systemctl restart docker',
    'sudo systemctl status docker'
    );
    return ld;
  };
  
  const ollamaUsrData = ec2.UserData.forLinux();
// Define path for CloudWatch Agent config
// --- CloudWatch Agent Config Asset ---
const cwAgentConfigAsset = new s3_assets.Asset(self, 'CwAgentConfigAsset', {
  path: 'config/amazon-cloudwatch-agent.json' // Adjust path relative to cdk project root
});

// Grant the instance role read access to the asset bucket
cwAgentConfigAsset.grantRead(instanceRole);
const cwAgentConfigPath = '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json';
const cwAgentTempPath = '/tmp/amazon-cloudwatch-agent.json'; // Temporary download location
const efsDnsName = `${fileSystem.fileSystemId}.efs.${cdk.Stack.of(self).region}.${cdk.Stack.of(self).urlSuffix}`;

// Add commands to the Ollama UserData
ollamaUsrData.addCommands(
  // Spread the base user data commands
  ...usrdata(logGroup.logGroupName, "ollama").render().split('\n').filter(line => line.trim() !== ''),

  // Install EFS utilities
  'echo "Installing EFS utilities for Ollama..."',
  'sudo dnf install -y amazon-efs-utils nfs-utils',

  // Start Ollama-specific setup
  'echo "Starting Ollama specific setup..."',
  'echo "Configuring CloudWatch Agent for GPU metrics..."',

  // --- Download CW Agent config from S3 Asset ---
  `echo "Downloading CW Agent config from S3..."`,
  // Use aws cli to copy from the S3 location provided by the asset object
  // The instance needs NAT access (which it has) and S3 permissions (granted above)
  `aws s3 cp ${cwAgentConfigAsset.s3ObjectUrl} ${cwAgentTempPath}`,
  // Ensure target directory exists and move the file into place
  `sudo mkdir -p $(dirname ${cwAgentConfigPath})`,
  `sudo mv ${cwAgentTempPath} ${cwAgentConfigPath}`,
  `sudo chmod 644 ${cwAgentConfigPath}`,
  `sudo chown root:root ${cwAgentConfigPath}`, // Ensure root ownership
  'echo "CW Agent config downloaded and placed."',

  // --- Enable and Start the CloudWatch Agent Service ---
  'echo "Enabling CloudWatch Agent service..."',
  'sudo systemctl enable amazon-cloudwatch-agent',
  'echo "Starting CloudWatch Agent service..."',
  'sudo systemctl start amazon-cloudwatch-agent',
  'echo "CloudWatch Agent service started."',

  // --- Mount EFS using standard NFSv4.1 ---
  // Use the manually constructed EFS DNS name
  `echo "Mounting EFS filesystem using NFSv4.1 and DNS Name: ${efsDnsName}"...`, // Use variable here
  `sudo mkdir -p ${ollamaModelDirectory}`, // Ensure mount point exists
  // Standard NFS mount command with recommended options for EFS
  `sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport ${efsDnsName}:/ ${ollamaModelDirectory}`, // Use variable here
  // Update fstab to use NFS4 and the DNS name for persistence
  `echo "${efsDnsName}:/ ${ollamaModelDirectory} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" | sudo tee -a /etc/fstab`, // Use variable here
  // Set ownership for the application user
  `sudo chown ec2-user:ec2-user ${ollamaModelDirectory}`,
  'echo "EFS mounted successfully."',

  // --- Start Ollama container ---
  'echo "Starting Ollama container..."',
  'sudo docker run -d --name ollama \\',
  '  --gpus all \\',
  '  -p 0.0.0.0:11434:11434 \\',
  `  -v ${ollamaModelDirectory}:/root/.ollama \\`,
  '  --restart unless-stopped \\',
  '  ollama/ollama serve',

  // --- Pull initial model in background ---
  '(',
  '  echo "Waiting for Ollama service (background task)..."',
  '  sleep 60',
  '  echo "Pulling default Ollama model (llama3.1:8b) in background..."',
  '  sudo docker exec ollama ollama pull llama3.1:8b || echo "Failed to pull default model initially, may need manual pull later."',
  '  echo "Background model pull task finished."',
  ') &',
  'disown',
  'echo "Ollama setup script finished."'
); // End of ollamaUsrData.addCommands
  
  
  // --- Launch Templates
  const webLaunchTemplate = new ec2.LaunchTemplate(self, 'WebLaunchTemplate', {
    machineImage: machineImageWeb,
    userData: usrdata(logGroup.logGroupName, "server"),
    instanceType: instanceTypeWeb,
    securityGroup: webSecurityGroup,
    keyPair: webKeyPair,
    role: instanceRole,
  });
  const mathWorkerLaunchTemplate = new ec2.LaunchTemplate(self, 'MathWorkerLaunchTemplate', {
    machineImage: machineImageMathWorker,
    userData: usrdata(logGroup.logGroupName, "math"),
    instanceType: instanceTypeMathWorker,
    securityGroup: mathWorkerSecurityGroup,
    keyPair: mathWorkerKeyPair,
    role: instanceRole,
    blockDevices: [{
      deviceName: '/dev/xvda',
      volume: ec2.BlockDeviceVolume.ebs(20, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        deleteOnTermination: true,
      }),
    }],
  });
  // Delphi Small Launch Template
  const delphiSmallLaunchTemplate = new ec2.LaunchTemplate(self, 'DelphiSmallLaunchTemplate', {
    machineImage: machineImageDelphiSmall,
    userData: usrdata(logGroup.logGroupName, "delphi", "small"),
    instanceType: instanceTypeDelphiSmall,
    securityGroup: delphiSecurityGroup,
    keyPair: delphiSmallKeyPair,
    role: instanceRole,
    blockDevices: [
      {
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(50, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      },
    ],
  });
  // Delphi Large Launch Template
  const delphiLargeLaunchTemplate = new ec2.LaunchTemplate(self, 'DelphiLargeLaunchTemplate', {
    machineImage: machineImageDelphiLarge,
    userData: usrdata(logGroup.logGroupName, "delphi", "large"),
    instanceType: instanceTypeDelphiLarge,
    securityGroup: delphiSecurityGroup,
    keyPair: delphiLargeKeyPair,
    role: instanceRole,
    blockDevices: [
      {
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      },
    ],
  });
  // Ollama Launch Template
  const ollamaLaunchTemplate = new ec2.LaunchTemplate(self, 'OllamaLaunchTemplate', {
    machineImage: machineImageOllama,
    userData: ollamaUsrData,
    instanceType: instanceTypeOllama,
    securityGroup: ollamaSecurityGroup,
    keyPair: ollamaKeyPair,
    role: instanceRole,
    blockDevices: [
      {
        deviceName: '/dev/xvda', // Adjust if needed for DLAMI
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      },
    ],
  });

  return {
    webLaunchTemplate,
    mathWorkerLaunchTemplate,
    delphiSmallLaunchTemplate,
    delphiLargeLaunchTemplate,
    ollamaLaunchTemplate
  }
}