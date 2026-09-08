import * as ec2 from 'aws-cdk-lib/aws-ec2';

export const instanceTypeWeb = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);
export const machineImageWeb = new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023 });
// Right-sized 2026-09: 14 days of CloudWatch showed peak 16.3 GB host memory and ~4 busy cores
// on the previous r8g.4xlarge (128 GB / 16 vCPU). 2xlarge = 8 vCPU / 64 GB. Step to xlarge after
// a month if peaks stay < 12 GB. See math/deps.edn for the matching JVM heap.
export const instanceTypeMathWorker = ec2.InstanceType.of(ec2.InstanceClass.R8G, ec2.InstanceSize.XLARGE2);
export const machineImageMathWorker = new ec2.AmazonLinuxImage({
  generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
  cpuType: ec2.AmazonLinuxCpuType.ARM_64,
});
// Delphi small instance
export const instanceTypeDelphiSmall = ec2.InstanceType.of(ec2.InstanceClass.C7I, ec2.InstanceSize.XLARGE2);
export const machineImageDelphiSmall = new ec2.AmazonLinuxImage({
  generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
  cpuType: ec2.AmazonLinuxCpuType.X86_64
});
// Delphi large instance
export const instanceTypeDelphiLarge = ec2.InstanceType.of(ec2.InstanceClass.C7I, ec2.InstanceSize.XLARGE8);
export const machineImageDelphiLarge = new ec2.AmazonLinuxImage({
  generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
  cpuType: ec2.AmazonLinuxCpuType.X86_64
});
// Ollama Instance
export const instanceTypeOllama = ec2.InstanceType.of(ec2.InstanceClass.G4DN, ec2.InstanceSize.XLARGE); // x86_64 GPU instance
export const machineImageOllama = ec2.MachineImage.genericLinux({
  'us-east-1': 'ami-08e0cf6df13ae3ddb',
});