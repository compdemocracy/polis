import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';

export default (
  self: Construct,
  logGroup: cdk.aws_logs.LogGroup,
  ollamaNamespace: string,
  ollamaModelDirectory: string,
  fileSystem: cdk.aws_efs.FileSystem | undefined,
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
  machineImageOllama: ec2.IMachineImage | undefined,
  instanceTypeOllama: ec2.InstanceType | undefined,
  ollamaKeyPair: ec2.IKeyPair | undefined,
  ollamaSecurityGroup: ec2.ISecurityGroup | undefined,
  enableOllama: boolean = false
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
      // $(uname -m) → x86_64 on the web/delphi tiers, aarch64 on the Graviton math worker. A hardcoded
      // x86_64 binary aborts the boot script on ARM (Exec format error) and the CodeDeploy agent never installs.
      'sudo curl -L https://github.com/docker/compose/releases/download/v2.40.0/docker-compose-linux-$(uname -m) -o /usr/local/bin/docker-compose',
      'sudo chmod +x /usr/local/bin/docker-compose',
      'docker-compose --version',
      'sudo yum install -y jq',
      `export SERVICE=${service}`,
      instanceSize ? `export INSTANCE_SIZE=${instanceSize}` : '',
      CLOUDWATCH_LOG_GROUP_NAME ? `echo "${CLOUDWATCH_LOG_GROUP_NAME}" | sudo tee ${persistentConfigDir}/log_group_name.txt` : '',

      // --- CloudWatch Agent: config + start, on EVERY instance ---
      // The agent is installed above for all tiers, but until now only the
      // ollama user-data configured and started it, so only the GPU box
      // published memory. Memory is the binding resource on the math and delphi
      // tiers (all three idle at 0.5-1.3% CPU), so without this there is no
      // evidence on which to right-size them.
      //
      // Guarded with `|| true` because this function runs under `set -e`: a
      // metrics agent must never be able to abort an instance boot. The
      // nvidia_gpu section of the config collects nothing where there is no
      // GPU, so this is a no-op difference for ollama.
      'echo "Configuring CloudWatch Agent..."',
      `aws s3 cp ${cwAgentConfigAsset.s3ObjectUrl} ${cwAgentTempPath} || echo "CW agent config download failed; continuing"`,
      `sudo mkdir -p $(dirname ${cwAgentConfigPath}) || true`,
      `sudo mv ${cwAgentTempPath} ${cwAgentConfigPath} || true`,
      `sudo chmod 644 ${cwAgentConfigPath} || true`,
      `sudo chown root:root ${cwAgentConfigPath} || true`,
      'sudo systemctl enable amazon-cloudwatch-agent || true',
      'sudo systemctl start amazon-cloudwatch-agent || echo "CW agent failed to start; continuing"',

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
  
// Define path for CloudWatch Agent config
// --- CloudWatch Agent Config Asset ---
// NOTE: this asset is shared by EVERY tier's user data (see usrdata() above),
// not just Ollama, so it is created unconditionally even when the Ollama stack
// is gated off.
const cwAgentConfigAsset = new s3_assets.Asset(self, 'CwAgentConfigAsset', {
  path: 'config/amazon-cloudwatch-agent.json' // Adjust path relative to cdk project root
});

// Grant the instance role read access to the asset bucket
cwAgentConfigAsset.grantRead(instanceRole);
const cwAgentConfigPath = '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json';
const cwAgentTempPath = '/tmp/amazon-cloudwatch-agent.json'; // Temporary download location

// --- Ollama user data (only when the GPU stack is enabled) ---
let ollamaUsrData: ec2.UserData | undefined;
if (enableOllama) {
  if (!fileSystem) {
    throw new Error('enableOllama is true but no EFS fileSystem was provided to configureLaunchTemplates');
  }
  const efsDnsName = `${fileSystem.fileSystemId}.efs.${cdk.Stack.of(self).region}.${cdk.Stack.of(self).urlSuffix}`;
  ollamaUsrData = ec2.UserData.forLinux();
  ollamaUsrData.addCommands(
    // Spread the base user data commands
    ...usrdata(logGroup.logGroupName, "ollama").render().split('\n').filter(line => line.trim() !== ''),

    // Install EFS utilities
    'echo "Installing EFS utilities for Ollama..."',
    'sudo dnf install -y amazon-efs-utils nfs-utils',

    // Start Ollama-specific setup
    'echo "Starting Ollama specific setup..."',

    // --- Mount EFS using standard NFSv4.1 ---
    `echo "Mounting EFS filesystem using NFSv4.1 and DNS Name: ${efsDnsName}"...`,
    `sudo mkdir -p ${ollamaModelDirectory}`,
    `sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport ${efsDnsName}:/ ${ollamaModelDirectory}`,
    `echo "${efsDnsName}:/ ${ollamaModelDirectory} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" | sudo tee -a /etc/fstab`,
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
  );
}

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
  // Ollama Launch Template (only when the GPU stack is enabled)
  let ollamaLaunchTemplate: ec2.LaunchTemplate | undefined;
  if (enableOllama) {
    ollamaLaunchTemplate = new ec2.LaunchTemplate(self, 'OllamaLaunchTemplate', {
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
  }

  return {
    webLaunchTemplate,
    mathWorkerLaunchTemplate,
    delphiSmallLaunchTemplate,
    delphiLargeLaunchTemplate,
    ollamaLaunchTemplate
  }
}