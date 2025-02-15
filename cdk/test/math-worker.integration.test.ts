import { EC2, waitUntilInstanceRunning, waitUntilInstanceStatusOk } from '@aws-sdk/client-ec2';
import { SSM } from '@aws-sdk/client-ssm';
import { CloudFormation } from '@aws-sdk/client-cloudformation';
import * as fs from 'fs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Skip integration tests if SKIP_INTEGRATION_TESTS is set
const skipIntegrationTests = process.env.SKIP_INTEGRATION_TESTS === 'true';
const testTimeout = 15 * 60 * 1000; // 15 minutes

describe('Math Worker Integration', () => {
  let tempDir: string;
  let envFile: string;
  let ec2Client: EC2;
  let ssmClient: SSM;
  let instanceId: string;

  const region = process.env.AWS_REGION || 'us-west-2';
  const mockEnvContent = `DATABASE_URL=postgres://user:pass@host:5432/db
MATH_ENV=dev`;

  beforeAll(() => {
    if (skipIntegrationTests) return;

    // Create AWS clients
    ec2Client = new EC2({ region });
    ssmClient = new SSM({ region });

    // Create a temporary directory for env file
    tempDir = mkdtempSync(join(tmpdir(), 'math-worker-integration-test-'));
    envFile = join(tempDir, '.env');

    // Create temporary env file
    writeFileSync(envFile, mockEnvContent, 'utf8');
  });

  afterAll(async () => {
    if (skipIntegrationTests) return;

    // Clean up temporary directory
    rmSync(tempDir, { recursive: true, force: true });

    // Clean up instance if it exists
    if (instanceId) {
      try {
        await ec2Client.terminateInstances({ InstanceIds: [instanceId] });
      } catch (error) {
        console.error('Error cleaning up instance:', error);
      }
    }
  });

  describe('Instance Lifecycle', () => {
    test('creates and manages instance successfully', async () => {
      if (skipIntegrationTests) {
        console.log('Skipping integration tests');
        return;
      }

      // 1. Create instance
      const createOutput = execSync(
        `npx ts-node bin/math-worker.ts create --env-file ${envFile}`,
        { stdio: 'pipe', cwd: __dirname + '/..' }
      ).toString();

      // Extract instance ID from output
      const match = createOutput.match(/InstanceId: (i-[a-f0-9]+)/);
      expect(match).toBeTruthy();
      instanceId = match![1];

      // 2. Wait for instance to be running
      await waitForInstance(instanceId);

      // 3. Check instance status
      const statusOutput = execSync(
        `npx ts-node bin/math-worker.ts status --instance-id ${instanceId}`,
        { stdio: 'pipe', cwd: __dirname + '/..' }
      ).toString();
      expect(statusOutput).toContain('running');

      // 4. Connect via SSM and verify Docker container
      const dockerStatus = await checkDockerStatusViaSSM(instanceId);
      expect(dockerStatus).toBe(true);

      // 5. Stop instance
      await execSync(
        `npx ts-node bin/math-worker.ts stop --instance-id ${instanceId}`,
        { stdio: 'pipe', cwd: __dirname + '/..' }
      );

      // Wait for instance to stop
      await waitForInstanceState(instanceId, 'stopped');

      // 6. Start instance
      await execSync(
        `npx ts-node bin/math-worker.ts start --instance-id ${instanceId}`,
        { stdio: 'pipe', cwd: __dirname + '/..' }
      );

      // Wait for instance to start
      await waitForInstance(instanceId);

      // 7. Verify Docker container is still running
      const dockerStatusAfterRestart = await checkDockerStatusViaSSM(instanceId);
      expect(dockerStatusAfterRestart).toBe(true);

    }, testTimeout);
  });
});

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

async function waitForInstanceState(instanceId: string, state: string): Promise<void> {
  const ec2 = new EC2({ region: process.env.AWS_REGION || 'us-west-2' });
  
  while (true) {
    const response = await ec2.describeInstances({ InstanceIds: [instanceId] });
    const instance = response.Reservations?.[0]?.Instances?.[0];
    
    if (instance?.State?.Name === state) {
      break;
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
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