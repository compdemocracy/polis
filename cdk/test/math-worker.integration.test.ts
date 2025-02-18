import { 
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  type Instance
} from '@aws-sdk/client-ec2';
import { 
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand
} from '@aws-sdk/client-ssm';
import { 
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand
} from '@aws-sdk/client-cloudformation';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Skip integration tests if SKIP_INTEGRATION_TESTS is set
const skipIntegrationTests = process.env.SKIP_INTEGRATION_TESTS === 'true';
const testTimeout = 15 * 60 * 1000; // 15 minutes

// Create AWS clients
const region = process.env.AWS_REGION || 'us-west-2';
const ec2Client = new EC2Client({ region });
const ssmClient = new SSMClient({ region });
const cfnClient = new CloudFormationClient({ region });

// Generate a unique stack name for this test run
const testStackName = `MathWorkerTestStack-${Date.now()}`;

// Function to clean up resources
async function cleanupResources(instanceId: string | null, stackName: string) {
  console.log('\n=== Cleaning up resources ===');
  
  try {
    // First terminate the instance if it exists
    if (instanceId) {
      console.log(`Terminating instance ${instanceId}...`);
      try {
        const terminateCommand = new TerminateInstancesCommand({
          InstanceIds: [instanceId]
        });
        await ec2Client.send(terminateCommand);
        console.log('Instance termination initiated');
        // Wait for instance termination
        await waitForInstanceState(instanceId, 'terminated');
      } catch (error: any) {
        if (!error.message.includes('does not exist')) {
          console.error('Error terminating instance:', error);
        }
      }
    }

    // Then delete the stack
    console.log(`Deleting stack ${stackName}...`);
    try {
      const deleteStackCommand = new DeleteStackCommand({ 
        StackName: stackName 
      });
      await cfnClient.send(deleteStackCommand);
      console.log('Stack deletion initiated');
      
      // Wait for stack deletion with a timeout
      const startTime = Date.now();
      const timeoutMs = 5 * 60 * 1000; // 5 minutes timeout
      
      while (Date.now() - startTime < timeoutMs) {
        try {
          const describeStacksCommand = new DescribeStacksCommand({
            StackName: stackName
          });
          const response = await cfnClient.send(describeStacksCommand);
          
          const status = response.Stacks?.[0]?.StackStatus;
          if (!status?.includes('DELETE_IN_PROGRESS')) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error: any) {
          if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
            break;
          }
          throw error;
        }
      }
    } catch (error: any) {
      if (!error.message.includes('does not exist')) {
        console.error('Error deleting stack:', error);
      }
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
}

describe('Math Worker CLI Integration', () => {
  let tempDir: string;
  let envFile: string;
  let instanceId: string | null = null;

  const mockEnvContent = `DATABASE_URL=postgres://test:test@localhost:5432/test
MATH_ENV=dev`;

  // Set up signal handlers for cleanup
  const signalHandler = async (signal: string) => {
    console.log(`\nReceived ${signal} signal`);
    if (instanceId) {
      await cleanupResources(instanceId, testStackName);
    }
    process.exit(0);
  };

  beforeAll(async () => {
    if (skipIntegrationTests) return;

    // Register signal handlers
    process.on('SIGINT', () => signalHandler('SIGINT'));
    process.on('SIGTERM', () => signalHandler('SIGTERM'));

    // Create a temporary directory for env file
    tempDir = mkdtempSync(join(tmpdir(), 'math-worker-integration-test-'));
    envFile = join(tempDir, '.env');

    // Create temporary env file
    writeFileSync(envFile, mockEnvContent, 'utf8');
  });

  afterAll(async () => {
    if (skipIntegrationTests) return;

    try {
      // Clean up resources and wait for completion
      await cleanupResources(instanceId, testStackName);

      // Remove signal handlers
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');

      // Clean up temporary directory
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Error in afterAll cleanup:', error);
      throw error;
    }
  }, 300000); // 5 minute timeout for cleanup

  // Test list command independently
  test('list command shows no instances when none exist', async () => {
    if (skipIntegrationTests) {
      console.log('Skipping integration tests');
      return;
    }

    console.log('\n=== Testing list command with no instances ===');
    
    // Call the CLI command
    const listCommand = 'npx ts-node bin/math-worker.ts list';
    console.log('\nRunning command:', listCommand);
    
    const listOutput = execSync(listCommand, { encoding: 'utf8' });
    console.log('\nList command output:');
    console.log('----------------------------------------');
    console.log(listOutput);
    console.log('----------------------------------------');

    // Verify output shows no instances (just headers)
    expect(listOutput).toContain('Instances:');
    const lines = listOutput.trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(3); // Header + separator + empty line
  }, 30000);

  // Test status command with non-existent instance
  test('status command fails gracefully for non-existent instance', async () => {
    if (skipIntegrationTests) {
      console.log('Skipping integration tests');
      return;
    }

    console.log('\n=== Testing status command with non-existent instance ===');
    
    // Try to get status of a non-existent instance
    const nonExistentId = 'i-1234abcd';
    const statusCommand = `npx ts-node bin/math-worker.ts status --instance-id ${nonExistentId}`;
    console.log('\nRunning command:', statusCommand);
    
    try {
      execSync(statusCommand, { encoding: 'utf8' });
      fail('Expected command to fail but it succeeded');
    } catch (error: any) {
      // Check both stdout and stderr for the error message
      const errorOutput = error.stderr?.toString() || error.stdout?.toString();
      expect(errorOutput).toContain(`Instance ${nonExistentId} not found`);
    }
  }, 30000);

  test('complete instance lifecycle', async () => {
    if (skipIntegrationTests) {
      console.log('Skipping integration tests');
      return;
    }

    try {
      console.log('\n=== Creating instance ===');
      console.log(`Using test stack name: ${testStackName}`);
      
      // Use the fixture .env file
      const envFile = join(__dirname, 'fixtures', '.env');
      const createCommand = `npx ts-node bin/math-worker.ts create --env-file ${envFile} --stack-name ${testStackName}`;
      console.log('\nRunning command:', createCommand);
      
      const createOutput = execSync(createCommand, { 
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'pipe']  // Inherit stdin, pipe stdout and stderr
      });
      console.log('\nCreate command output:');
      console.log('----------------------------------------');
      console.log(createOutput);
      console.log('----------------------------------------');

      // Extract instance ID from the output
      const match = createOutput.match(/Instance (i-[a-f0-9]+) created successfully in region/);
      console.log('\nRegex match result:', match);
      expect(match).toBeTruthy();
      instanceId = match![1];
      console.log(`\nInstance created: ${instanceId}`);

      // Wait for instance to be running and ready
      console.log('\n=== Waiting for instance to be ready ===');
      let isReady = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!isReady && attempts < maxAttempts) {
        const command = new DescribeInstancesCommand({
          InstanceIds: [instanceId]
        });
        const response = await ec2Client.send(command);

        const instance = response.Reservations?.[0]?.Instances?.[0];
        console.log(`\nInstance state: ${instance?.State?.Name}`);
        console.log(`Public IP: ${instance?.PublicIpAddress}`);
        console.log(`Launch time: ${instance?.LaunchTime}`);
        
        if (instance?.State?.Name === 'running') {
          isReady = true;
        } else {
          console.log(`Waiting for instance to be ready... (Attempt ${attempts + 1}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }
      }

      expect(isReady).toBe(true);
      console.log('\nInstance is running');

      // Test the status command
      console.log('\n=== Testing status command ===');
      const statusCommand = `npx ts-node bin/math-worker.ts status --instance-id ${instanceId}`;
      console.log('\nRunning command:', statusCommand);
      
      const statusOutput = execSync(statusCommand, { encoding: 'utf8' });
      console.log('\nStatus command output:');
      console.log('----------------------------------------');
      console.log(statusOutput);
      console.log('----------------------------------------');

      // Verify status output contains expected information
      expect(statusOutput).toContain(`Stack: ${testStackName}`);
      expect(statusOutput).toContain('State: running');
      expect(statusOutput).toContain('Public IP:');
      expect(statusOutput).toContain('Launch Time:');

      // Test the list command
      console.log('\n=== Testing list command ===');
      const listCommand = 'npx ts-node bin/math-worker.ts list';
      console.log('\nRunning command:', listCommand);
      
      const listOutput = execSync(listCommand, { encoding: 'utf8' });
      console.log('\nList command output:');
      console.log('----------------------------------------');
      console.log(listOutput);
      console.log('----------------------------------------');

      // Verify list output contains our instance with correct information
      expect(listOutput).toContain(instanceId);
      expect(listOutput).toContain(`Stack: ${testStackName}`);
      expect(listOutput).toContain('State: running');
      expect(listOutput).toContain('Public IP:');
      expect(listOutput).toContain('Launch Time:');

      // Wait for Docker container to be ready
      console.log('\n=== Waiting for Docker container to be ready ===');
      let dockerReady = false;
      attempts = 0;
      while (!dockerReady && attempts < maxAttempts) {
        try {
          const dockerStatus = await runSSMCommand(instanceId, 'docker ps -a --no-trunc');
          if (dockerStatus.includes('polis-math')) {
            dockerReady = true;
          } else {
            console.log(`Waiting for Docker container... (Attempt ${attempts + 1}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds between attempts
            attempts++;
          }
        } catch (error) {
          // SSM might not be ready yet
          console.log(`Waiting for SSM agent... (Attempt ${attempts + 1}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          attempts++;
        }
      }

      expect(dockerReady).toBe(true);
      console.log('\nDocker container is ready');

      // Check Docker container status
      console.log('\n=== Checking Docker container status ===');
      const dockerStatus = await runSSMCommand(instanceId, 'docker ps -a --no-trunc');  // Show all containers with full output
      console.log('\nDocker container status:');
      console.log('----------------------------------------');
      console.log(dockerStatus);
      console.log('----------------------------------------');
      expect(dockerStatus).toContain('polis-math');
      console.log('\nDocker container is running');

      // Check Docker logs
      console.log('\n=== Checking Docker logs ===');
      const dockerLogs = await runSSMCommand(instanceId, 'docker logs polis-math 2>&1');  // Include stderr
      console.log('\nDocker container logs:');
      console.log('----------------------------------------');
      console.log(dockerLogs);
      console.log('----------------------------------------');
      expect(dockerLogs).toBeTruthy();
      console.log('\nDocker logs are available');

      // Also check Docker container details
      console.log('\n=== Checking Docker container details ===');
      const containerDetails = await runSSMCommand(instanceId, 'docker inspect polis-math');
      console.log('\nContainer details:');
      console.log('----------------------------------------');
      console.log(containerDetails);
      console.log('----------------------------------------');

      // Check container resource usage
      console.log('\n=== Checking container resource usage ===');
      const containerStats = await runSSMCommand(instanceId, 'docker stats polis-math --no-stream');
      console.log('\nContainer resource usage:');
      console.log('----------------------------------------');
      console.log(containerStats);
      console.log('----------------------------------------');

      // Stop the instance
      console.log('\n=== Stopping instance ===');
      const stopCommand = new TerminateInstancesCommand({
        InstanceIds: [instanceId]
      });
      await ec2Client.send(stopCommand);
      console.log('\nStop command sent');

      // Wait for instance to stop
      isReady = false;
      attempts = 0;
      while (!isReady && attempts < maxAttempts) {
        const command = new DescribeInstancesCommand({
          InstanceIds: [instanceId]
        });
        const response = await ec2Client.send(command);

        const instance = response.Reservations?.[0]?.Instances?.[0];
        console.log(`\nInstance state: ${instance?.State?.Name}`);
        
        if (instance?.State?.Name === 'stopped') {
          isReady = true;
        } else {
          console.log(`Waiting for instance to stop... (Attempt ${attempts + 1}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }
      }

      expect(isReady).toBe(true);
      console.log('\nInstance is stopped');

      // Terminate the instance
      console.log('\n=== Terminating instance ===');
      const terminateCommand = new TerminateInstancesCommand({
        InstanceIds: [instanceId]
      });
      await ec2Client.send(terminateCommand);
      console.log('\nTerminate command sent');

      // Wait for instance to terminate
      isReady = false;
      attempts = 0;
      while (!isReady && attempts < maxAttempts) {
        const command = new DescribeInstancesCommand({
          InstanceIds: [instanceId]
        });
        const response = await ec2Client.send(command);

        const instance = response.Reservations?.[0]?.Instances?.[0];
        console.log(`\nInstance state: ${instance?.State?.Name}`);
        
        if (instance?.State?.Name === 'terminated') {
          isReady = true;
        } else {
          console.log(`Waiting for instance to terminate... (Attempt ${attempts + 1}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }
      }

      expect(isReady).toBe(true);
      console.log('\nInstance is terminated');

    } catch (error) {
      console.error('\n=== Test failed ===\n');
      console.error('Error details:', error);
      // Attempt cleanup if something went wrong
      if (instanceId) {
        console.log('\nAttempting to clean up instance', instanceId);
        try {
          const terminateCommand = new TerminateInstancesCommand({
            InstanceIds: [instanceId]
          });
          await ec2Client.send(terminateCommand);
          console.log('Cleanup successful');
        } catch (cleanupError) {
          console.error('Cleanup failed:', cleanupError);
        }
      }
      throw error;
    }
  }, 600000); // 10 minute timeout
});

// Helper functions
async function waitForInstanceState(instanceId: string, targetState: string): Promise<void> {
  while (true) {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    const response = await ec2Client.send(command);

    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (instance?.State?.Name === targetState) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Helper function to run SSM commands
const runSSMCommand = async (instanceId: string, command: string): Promise<string> => {
  console.log(`\nExecuting SSM command: ${command}`);
  const response = await ssmClient.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: {
      commands: [command]
    }
  }));

  const commandId = response.Command?.CommandId;
  if (!commandId) throw new Error('No command ID returned');
  console.log(`SSM Command ID: ${commandId}`);

  // Wait for command completion
  let output = '';
  let attempts = 0;
  const maxAttempts = 30;
  while (attempts < maxAttempts) {
    const result = await ssmClient.send(new GetCommandInvocationCommand({
      CommandId: commandId,
      InstanceId: instanceId
    }));

    if (result.Status === 'Success') {
      output = result.StandardOutputContent || '';
      console.log('\nCommand output:');
      console.log('----------------------------------------');
      console.log(output);
      console.log('----------------------------------------');
      break;
    }

    if (result.Status === 'Failed') {
      console.error('\nCommand failed:');
      console.error(result.StandardErrorContent);
      throw new Error(`Command failed: ${result.StandardErrorContent}`);
    }

    console.log(`Waiting for command completion... (Attempt ${attempts + 1}/${maxAttempts})`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    attempts++;
  }

  if (attempts >= maxAttempts) {
    throw new Error('Command timed out');
  }

  return output;
};