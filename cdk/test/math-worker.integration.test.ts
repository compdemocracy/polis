import { 
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
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
import { execSync, spawn } from 'child_process';

const testTimeout = 15 * 60 * 1000; // 15 minutes

// Create AWS clients
const region = process.env.AWS_REGION || 'us-west-2';
const ec2Client = new EC2Client({ region });
const ssmClient = new SSMClient({ region });
const cfnClient = new CloudFormationClient({ region });

// Generate a unique stack name for this test run
const testStackName = `MathWorkerTestStack-${Date.now()}`;

// Helper function to execute command with real-time output
function execCommandWithOutput(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts = command.split(' ');
    const proc = spawn(parts[0], parts.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      output += str;
      process.stdout.write(str); // Display in real-time
    });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      errorOutput += str;
      process.stderr.write(str); // Display in real-time
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with code ${code}\n${errorOutput}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

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

// Helper functions
async function waitForInstanceState(instanceId: string, targetState: string): Promise<void> {
  console.log(`\nWaiting for instance to reach state: ${targetState}`);
  while (true) {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    const response = await ec2Client.send(command);

    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (instance?.State?.Name === targetState) {
      console.log(`Instance is now in state: ${targetState}`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Add new helper function to wait for SSM availability
async function waitForSSMAvailability(instanceId: string, maxAttempts: number = 12): Promise<void> {
  console.log('\nWaiting for SSM to be available...');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runSSMCommand(instanceId, 'echo "Testing SSM availability"');
      console.log('SSM is now available');
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`SSM did not become available after ${maxAttempts} attempts`);
      }
      console.log(`Waiting for SSM to be available... (Attempt ${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay between attempts
    }
  }
}

// Helper function to run SSM commands with improved retry logic
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

  // Wait for command completion with improved error handling
  let output = '';
  let attempts = 0;
  const maxAttempts = 30;
  const delay = 2000; // 2 seconds between attempts
  
  while (attempts < maxAttempts) {
    try {
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

      // Handle other statuses
      if (result.Status === 'Cancelled' || result.Status === 'TimedOut') {
        throw new Error(`Command ${result.Status.toLowerCase()}`);
      }

      console.log(`Waiting for command completion... (Attempt ${attempts + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      attempts++;
    } catch (error: any) {
      if (error.name === 'InvalidInstanceId') {
        console.log(`Instance not ready for SSM commands... (Attempt ${attempts + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
        continue;
      }
      throw error;
    }
  }

  if (attempts >= maxAttempts) {
    throw new Error('Command timed out');
  }

  return output;
};

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
  test('list command shows instances information', async () => {
    console.log('\n=== Testing list command ===');
    
    // Call the CLI command
    const listCommand = 'npx ts-node bin/math-worker.ts list --verbose';
    console.log('\nRunning command:', listCommand);
    
    try {
      const listOutput = await execCommandWithOutput(listCommand);
      console.log('\nList command completed successfully');

      // Verify output format
      expect(listOutput).toContain('Instances:');
      expect(listOutput).toContain('----------------------------------------');
      
      // Each instance should show these fields
      if (listOutput.includes('ID: i-')) {
        expect(listOutput).toContain('Stack:');
        expect(listOutput).toContain('State:');
        expect(listOutput).toContain('Public IP:');
        expect(listOutput).toContain('Launch Time:');
      }
    } catch (error: any) {
      console.error('\nList command failed:', error.message);
      throw error;
    }
  }, 30000);

  // Test status command with non-existent instance
  test('status command fails gracefully for non-existent instance', async () => {
    console.log('\n=== Testing status command with non-existent instance ===');
    
    // Try to get status of a non-existent instance
    const nonExistentId = 'i-1234abcd';
    const statusCommand = `npx ts-node bin/math-worker.ts status --instance-id ${nonExistentId} --verbose`;
    console.log('\nRunning command:', statusCommand);
    
    try {
      await execCommandWithOutput(statusCommand);
      fail('Expected command to fail but it succeeded');
    } catch (error: any) {
      // The error message should contain our expected text
      expect(error.message).toContain(`Instance ${nonExistentId} not found`);
    }
  }, 30000);

  test('complete instance lifecycle', async () => {
    try {
      console.log('\n=== Creating stack and instance ===');
      console.log(`Using test stack name: ${testStackName}`);
      
      // Use the fixture .env file
      const envFile = join(__dirname, 'fixtures', '.env');
      const createCommand = `npx ts-node bin/math-worker.ts create --env-file ${envFile} --stack-name ${testStackName} --verbose`;
      console.log('\nRunning command:', createCommand);
      
      let createOutput;
      try {
        createOutput = await execCommandWithOutput(createCommand);
        console.log('\nCreate command completed successfully');
      } catch (error: any) {
        console.error('\nCreate command failed:', error.message);
        throw error;
      }

      // Extract instance ID from the output
      const match = createOutput.match(/Instance (i-[a-f0-9]+) created successfully in region/);
      console.log('\nRegex match result:', match);
      expect(match).toBeTruthy();
      instanceId = match![1];
      console.log(`\nInstance created: ${instanceId}`);

      // Wait for instance to be running and ready
      console.log('\n=== Waiting for instance to be ready ===');
      await waitForInstanceState(instanceId, 'running');
      console.log('\nInstance is running');

      // Test the status command
      console.log('\n=== Testing status command ===');
      const statusCommand = `npx ts-node bin/math-worker.ts status --instance-id ${instanceId} --verbose`;
      console.log('\nRunning command:', statusCommand);
      
      try {
        const statusOutput = await execCommandWithOutput(statusCommand);
        console.log('\nStatus command completed successfully');

        // Verify status output
        expect(statusOutput).toContain('Instance state: running');
        expect(statusOutput).toContain('Public IP:');
      } catch (error: any) {
        console.error('\nStatus command failed:', error.message);
        throw error;
      }

      // Test Docker container readiness with a timeout
      console.log('\n=== Waiting for Docker container to be ready ===');
      let dockerReady = false;
      let attempts = 0;
      const maxAttempts = 30;
      const dockerTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Docker container readiness check timed out')), 5 * 60 * 1000);
      });
      
      try {
        await Promise.race([
          (async () => {
            while (!dockerReady && attempts < maxAttempts) {
              try {
                const dockerStatus = await runSSMCommand(instanceId, 'docker ps -a --no-trunc');
                if (dockerStatus.includes('polis-math')) {
                  dockerReady = true;
                  break;
                }
                console.log(`Waiting for Docker container... (Attempt ${attempts + 1}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                attempts++;
              } catch (error) {
                console.log(`Waiting for SSM agent... (Attempt ${attempts + 1}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                attempts++;
              }
            }
            if (!dockerReady) {
              throw new Error('Docker container did not become ready after maximum attempts');
            }
          })(),
          dockerTimeout
        ]);
        
        console.log('\nDocker container is ready');
      } catch (error: any) {
        console.error('\nDocker container readiness check failed:', error.message);
        throw error;
      }

      // Test commands with wrong stack name
      console.log('\n=== Testing commands with wrong stack name ===');
      const wrongStackName = 'WrongStackName';

      // Try to stop instance with wrong stack name
      const wrongStopCommand = `npx ts-node bin/math-worker.ts stop --instance-id ${instanceId} --stack-name ${wrongStackName} --verbose`;
      try {
        execSync(wrongStopCommand, { 
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'] // Capture both stdout and stderr
        });
        fail('Expected stop command to fail with wrong stack name');
      } catch (error: any) {
        const errorOutput = error.stderr?.toString() || error.stdout?.toString();
        console.log('\nWrong stop command error output (expected):');
        console.log('----------------------------------------');
        console.log(errorOutput);
        console.log('----------------------------------------');
        expect(errorOutput).toContain(`This instance belongs to stack "${testStackName}"`);
        expect(errorOutput).toContain(`but you're trying to manage stack "${wrongStackName}"`);
      }

      // Test stopping the instance with correct stack name
      console.log('\n=== Testing instance stop ===');
      const stopCommand = `npx ts-node bin/math-worker.ts stop --instance-id ${instanceId} --stack-name ${testStackName} --verbose`;
      try {
        await execCommandWithOutput(stopCommand);
        console.log('\nStop command completed successfully');
      } catch (error: any) {
        console.error('\nStop command failed:', error.message);
        throw error;
      }
      
      // Wait for instance to stop
      await waitForInstanceState(instanceId, 'stopped');
      console.log('\nInstance is stopped');

      // Try to start instance with wrong stack name
      const wrongStartCommand = `npx ts-node bin/math-worker.ts start --instance-id ${instanceId} --stack-name ${wrongStackName} --verbose`;
      try {
        execSync(wrongStartCommand, { 
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'] // Capture both stdout and stderr
        });
        fail('Expected start command to fail with wrong stack name');
      } catch (error: any) {
        const errorOutput = error.stderr?.toString() || error.stdout?.toString();
        console.log('\nWrong start command error output (expected):');
        console.log('----------------------------------------');
        console.log(errorOutput);
        console.log('----------------------------------------');
        expect(errorOutput).toContain(`This instance belongs to stack "${testStackName}"`);
        expect(errorOutput).toContain(`but you're trying to manage stack "${wrongStackName}"`);
      }

      // Test starting the instance with correct stack name
      console.log('\n=== Testing instance start ===');
      const startCommand = `npx ts-node bin/math-worker.ts start --instance-id ${instanceId} --stack-name ${testStackName} --verbose`;
      try {
        await execCommandWithOutput(startCommand);
        console.log('\nStart command completed successfully');
      } catch (error: any) {
        console.error('\nStart command failed:', error.message);
        throw error;
      }
      
      // Wait for instance to start
      await waitForInstanceState(instanceId, 'running');
      console.log('\nInstance is running again');

      // Add wait for SSM to be available after restart
      await waitForSSMAvailability(instanceId);

      // Verify Docker container is still functional
      console.log('\n=== Verifying Docker container after restart ===');
      const dockerStatusAfterRestart = await runSSMCommand(instanceId, 'docker ps -a --no-trunc');
      expect(dockerStatusAfterRestart).toContain('polis-math');
      console.log('\nDocker container verified after restart');

      // Try to terminate instance with wrong stack name
      const wrongTerminateCommand = `npx ts-node bin/math-worker.ts terminate --instance-id ${instanceId} --stack-name ${wrongStackName} --verbose`;
      try {
        await execCommandWithOutput(wrongTerminateCommand);
        fail('Expected terminate command to fail with wrong stack name');
      } catch (error: any) {
        const errorOutput = error.message;
        expect(errorOutput).toContain(`This instance belongs to stack "${testStackName}"`);
        expect(errorOutput).toContain(`but you're trying to manage stack "${wrongStackName}"`);
      }
    } catch (error) {
      console.error('Error in complete instance lifecycle:', error);
      // Ensure cleanup happens even on test failure
      if (instanceId) {
        await cleanupResources(instanceId, testStackName);
      }
      throw error;
    }
  }, testTimeout); // 15 minute timeout for complete instance lifecycle
});