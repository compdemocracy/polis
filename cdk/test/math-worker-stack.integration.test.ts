import * as cdk from 'aws-cdk-lib';
import { EC2, waitUntilInstanceRunning, waitUntilInstanceStatusOk } from '@aws-sdk/client-ec2';
import { SSM } from '@aws-sdk/client-ssm';
import { CloudFormation } from '@aws-sdk/client-cloudformation';
import * as fs from 'fs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MathWorkerStack } from '../lib/math-worker-stack';
import { execSync } from 'child_process';

// Skip integration tests if SKIP_INTEGRATION_TESTS is set
const skipIntegrationTests = process.env.SKIP_INTEGRATION_TESTS === 'true';
const testTimeout = 15 * 60 * 1000; // 15 minutes

describe('MathWorkerStack Integration', () => {
  let app: cdk.App;
  let stack: MathWorkerStack;
  let tempDir: string;
  let envFile: string;
  let ec2Client: EC2;
  let ssmClient: SSM;

  const region = process.env.AWS_REGION || 'us-west-2';
  const stackName = 'MathWorkerTestStack';
  const mockEnvContent = `DATABASE_URL=postgres://user:pass@host:5432/db
MATH_ENV=dev`;

  beforeAll(() => {
    if (skipIntegrationTests) return;

    // Create AWS clients
    ec2Client = new EC2({ region });
    ssmClient = new SSM({ region });

    // Create a temporary directory for CDK output and env file
    tempDir = mkdtempSync(join(tmpdir(), 'cdk-integration-test-'));
    envFile = join(tempDir, '.env');

    // Create temporary env file
    writeFileSync(envFile, mockEnvContent, 'utf8');

    // Create app with explicit output directory
    app = new cdk.App({
      outdir: tempDir
    });
  });

  afterAll(async () => {
    if (skipIntegrationTests) return;

    // Clean up temporary directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('with Tailscale', () => {
    beforeAll(() => {
      if (skipIntegrationTests) return;

      // Create the stack with Tailscale
      stack = new MathWorkerStack(app, stackName, {
        envFile,
        tsAuthKey: process.env.TAILSCALE_AUTH_KEY,
        enableSSHAccess: true,
        env: { region }
      });

      // Deploy the stack
      execSync('cdk deploy --require-approval never', {
        env: process.env,
        stdio: 'inherit'
      });
    });

    afterAll(async () => {
      if (skipIntegrationTests) return;

      // Destroy the stack
      execSync('cdk destroy --force', {
        env: process.env,
        stdio: 'inherit'
      });
    });

    test('deploys and runs math worker with Tailscale successfully', async () => {
      if (skipIntegrationTests) {
        console.log('Skipping Tailscale integration tests');
        return;
      }

      // Get instance ID from stack outputs
      const outputs = await describeStackOutputs(stackName);
      const instanceId = outputs.find(o => o.OutputKey === 'InstanceId')?.OutputValue;
      expect(instanceId).toBeDefined();

      // Wait for instance to be running and pass status checks
      await waitForInstance(instanceId!);

      // Get instance details
      const instance = await describeInstance(instanceId!);
      if (!instance || !instance.State || !instance.PublicIpAddress) {
        throw new Error('Instance, state, or public IP not found');
      }

      expect(instance.State.Name).toBe('running');

      // Verify Tailscale connection
      const tailscaleStatus = await checkTailscaleStatus(instance.PublicIpAddress);
      expect(tailscaleStatus).toBe(true);

      // Verify Docker container is running via SSH
      const dockerStatus = await checkDockerStatus(instance.PublicIpAddress);
      expect(dockerStatus).toBe(true);
    }, testTimeout);
  });

  describe('without Tailscale', () => {
    beforeAll(() => {
      if (skipIntegrationTests) return;

      // Create the stack without Tailscale
      stack = new MathWorkerStack(app, stackName, {
        envFile,
        env: { region }
      });

      // Deploy the stack
      execSync('cdk deploy --require-approval never', {
        env: process.env,
        stdio: 'inherit'
      });
    });

    afterAll(async () => {
      if (skipIntegrationTests) return;

      // Destroy the stack
      execSync('cdk destroy --force', {
        env: process.env,
        stdio: 'inherit'
      });
    });

    test('deploys and runs math worker without Tailscale successfully', async () => {
      if (skipIntegrationTests) {
        console.log('Skipping non-Tailscale integration tests');
        return;
      }

      // Get instance ID from stack outputs
      const outputs = await describeStackOutputs(stackName);
      const instanceId = outputs.find(o => o.OutputKey === 'InstanceId')?.OutputValue;
      expect(instanceId).toBeDefined();

      // Wait for instance to be running and pass status checks
      await waitForInstance(instanceId!);

      // Get instance details
      const instance = await describeInstance(instanceId!);
      if (!instance || !instance.State) {
        throw new Error('Instance or state not found');
      }

      expect(instance.State.Name).toBe('running');

      // Verify Docker container is running via SSM
      const dockerStatus = await checkDockerStatusViaSSM(instanceId!);
      expect(dockerStatus).toBe(true);
    }, testTimeout);
  });
});

async function describeStackOutputs(stackName: string): Promise<CloudFormation.Output[]> {
  const cfn = new CloudFormation({ region: process.env.AWS_REGION || 'us-west-2' });
  
  const response = await cfn.describeStacks({
    StackName: stackName
  });
  
  return response.Stacks?.[0]?.Outputs || [];
}

async function describeInstance(instanceId: string) {
  const ec2 = new EC2({ region: process.env.AWS_REGION || 'us-west-2' });
  
  const response = await ec2.describeInstances({
    InstanceIds: [instanceId]
  });
  
  return response.Reservations?.[0]?.Instances?.[0];
}

async function waitForInstance(instanceId: string): Promise<void> {
  const ec2 = new EC2({ region: process.env.AWS_REGION || 'us-west-2' });
  
  // Wait for instance to be running
  await waitUntilInstanceRunning(
    { client: ec2, maxWaitTime: 300 },
    { InstanceIds: [instanceId] }
  );

  // Wait for status checks to pass
  await waitUntilInstanceStatusOk(
    { client: ec2, maxWaitTime: 300 },
    { InstanceIds: [instanceId] }
  );
}

async function checkTailscaleStatus(publicIp: string): Promise<boolean> {
  try {
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no ec2-user@${publicIp} "sudo tailscale status"`,
      { stdio: 'pipe' }
    ).toString();
    
    return result.includes('tailscaled is running');
  } catch (error) {
    return false;
  }
}

async function checkDockerStatus(publicIp: string): Promise<boolean> {
  try {
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no ec2-user@${publicIp} "docker ps"`,
      { stdio: 'pipe' }
    ).toString();
    
    return result.includes('polis-math');
  } catch (error) {
    return false;
  }
}

async function checkDockerStatusViaSSM(instanceId: string): Promise<boolean> {
  const ssm = new SSM({ region: process.env.AWS_REGION || 'us-west-2' });
  
  try {
    const response = await ssm.sendCommand({
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands: ['docker ps']
      },
      InstanceIds: [instanceId]
    });

    const commandId = response.Command?.CommandId;
    if (!commandId) return false;

    // Wait for command completion
    await new Promise(resolve => setTimeout(resolve, 5000));

    const output = await ssm.getCommandInvocation({
      CommandId: commandId,
      InstanceId: instanceId
    });

    return output.StandardOutputContent?.includes('polis-math') || false;
  } catch (error) {
    console.error('Error checking Docker status via SSM:', error);
    return false;
  }
} 