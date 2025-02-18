#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MathWorkerStack } from '../lib/math-worker-stack';
import { Command } from 'commander';
import { 
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
  type Tag
} from '@aws-sdk/client-ec2';
import { 
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand
} from '@aws-sdk/client-ssm';
import { 
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
  type Output,
  type DescribeStacksCommandOutput,
  waitUntilStackCreateComplete
} from '@aws-sdk/client-cloudformation';
import { existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

// Create AWS clients
const createEC2Client = (region: string) => new EC2Client({ region });
const createSSMClient = (region: string) => new SSMClient({ region });
const createCloudFormationClient = (region: string) => new CloudFormationClient({ region });

// Interface for overlay options
interface OverlayDefinition {
  name: string;
  optionFlag: string;
  optionDescription: string;
  stackClass: typeof MathWorkerStack;
}

// Load available overlays from the overlays directory
async function loadOverlays(): Promise<OverlayDefinition[]> {
  const overlaysDir = join(__dirname, '..', 'lib', 'overlays');
  const overlays: OverlayDefinition[] = [];

  if (!existsSync(overlaysDir)) {
    return overlays;
  }

  const files = readdirSync(overlaysDir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));

  for (const file of files) {
    try {
      const module = await import(join(overlaysDir, file));
      if (module.overlayDefinition) {
        overlays.push(module.overlayDefinition);
      }
    } catch (error) {
      console.warn(`Warning: Could not load overlay from ${file}:`, error);
    }
  }

  return overlays;
}

// Add debug logging function
function debug(message: string, data?: any) {
  if (process.env.DEBUG || globalOptions.verbose) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [DEBUG] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}

// Add global options interface
interface GlobalOptions {
  verbose?: boolean;
}

const globalOptions: GlobalOptions = {};

// Create command handlers
export const handleCreate = async (options: any) => {
  debug('Create command options:', options);
  
  // Validate env file exists
  if (!existsSync(options.envFile)) {
    console.error(`Error: Environment file ${options.envFile} does not exist`);
    process.exit(1);
  }

  const app = new cdk.App();
  const stackName = options.stackName || 'MathWorkerStack';
  
  debug('Creating CDK app with stack name:', stackName);
  
  const stackProps = {
    env: {
      region: options.region || process.env.AWS_REGION || 'us-west-2'
    },
    envFile: options.envFile,
    branch: options.branch,
    instanceType: options.instanceType,
    databaseUrl: options.databaseUrl,
    enableSSHAccess: options.enableSsh
  };
  
  debug('Stack properties:', stackProps);

  // Load available overlays
  const overlays = await loadOverlays();
  debug('Loaded overlays:', overlays);
  
  // Find the first overlay that has its option flag set
  const activeOverlay = overlays.find(overlay => options[overlay.optionFlag]);
  debug('Active overlay:', activeOverlay);
  
  let stack;
  if (activeOverlay) {
    try {
      debug(`Creating stack with ${activeOverlay.name} overlay`);
      stack = new activeOverlay.stackClass(app, stackName, {
        ...stackProps,
        [activeOverlay.optionFlag]: options[activeOverlay.optionFlag]
      });
    } catch (error) {
      console.error(`Error creating stack with ${activeOverlay.name} overlay:`, error);
      process.exit(1);
    }
  } else {
    debug('Creating base stack without overlays');
    stack = new MathWorkerStack(app, stackName, stackProps);
  }

  const assembly = app.synth();
  const template = assembly.getStackByName(stackName).template;
  debug('Synthesized CloudFormation template');

  // Deploy the stack
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const cfnClient = createCloudFormationClient(region);

  try {
    console.log(`\nCreating instance in region: ${region}`);
    console.log(`Using stack name: ${stackName}`);
    
    debug('Creating CloudFormation stack');
    // Deploy the stack and wait for completion
    const createStackCommand = new CreateStackCommand({
      StackName: stackName,
      TemplateBody: JSON.stringify(template),
      Capabilities: ['CAPABILITY_IAM']
    });
    const deployResult = await cfnClient.send(createStackCommand);
    debug('Stack creation initiated:', deployResult);

    debug('Waiting for stack creation to complete');
    // Wait for stack creation to complete
    await waitUntilStackCreateComplete(
      { client: cfnClient, maxWaitTime: 600 },
      { StackName: stackName }
    );
    debug('Stack creation completed');

    // Get the instance ID from the stack outputs
    debug('Getting stack outputs');
    const describeStacksCommand = new DescribeStacksCommand({
      StackName: stackName
    });
    const outputs: DescribeStacksCommandOutput = await cfnClient.send(describeStacksCommand);
    debug('Stack outputs:', outputs);
    
    const instanceId = outputs.Stacks?.[0]?.Outputs?.find(
      (output: Output) => output.OutputKey === 'InstanceId'
    )?.OutputValue;

    if (!instanceId) {
      throw new Error('Failed to get instance ID from stack outputs');
    }

    console.log(`\nInstance ${instanceId} created successfully in region ${region}`);
    console.log('Waiting for instance to be ready...');

    // Wait for instance to be running
    const ec2Client = createEC2Client(region);
    debug('Waiting for instance to be running');
    await waitForInstanceState(instanceId, 'running', ec2Client);

    console.log(`\nInstance ${instanceId} is ready`);
    console.log(`You can check its status with: math-worker status --instance-id ${instanceId}`);
    console.log(`Or connect to it with: math-worker shell --instance-id ${instanceId}`);

  } catch (error) {
    console.error('Error deploying stack:', error);
    debug('Stack deployment error:', error);
    process.exit(1);
  }
};

// Helper function to wait for instance state
async function waitForInstanceState(instanceId: string, targetState: string, ec2Client: EC2Client): Promise<void> {
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

export const handleList = async (options: any, ec2Client?: EC2Client) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const command = new DescribeInstancesCommand({
      Filters: [{
        Name: 'tag:Name',
        Values: ['polis-math-worker']
      }]
    });
    const response = await client.send(command);

    console.log('\nInstances:');
    console.log('----------------------------------------');
    response.Reservations?.forEach(r => {
      r.Instances?.forEach((instance: Instance) => {
        const stackName = instance.Tags?.find((tag: Tag) => tag.Key === 'aws:cloudformation:stack-name')?.Value || 'N/A';
        console.log(`ID: ${instance.InstanceId}`);
        console.log(`Stack: ${stackName}`);
        console.log(`State: ${instance.State?.Name}`);
        console.log(`Public IP: ${instance.PublicIpAddress || 'N/A'}`);
        console.log(`Launch Time: ${instance.LaunchTime}`);
        console.log('----------------------------------------');
      });
    });
  } catch (error) {
    console.error('Error listing instances:', error);
    process.exit(1);
  }
};

export const handleStatus = async (options: any, ec2Client?: EC2Client) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const command = new DescribeInstancesCommand({
      InstanceIds: [options.instanceId]
    });
    const response = await client.send(command);

    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      console.error(`Instance ${options.instanceId} not found`);
      process.exit(1);
    }

    console.log(`\nInstance state: ${instance.State?.Name}`);
    console.log(`Public IP: ${instance.PublicIpAddress}`);
    console.log(`Launch time: ${instance.LaunchTime}`);
  } catch (error: any) {
    if (error.name === 'InvalidInstanceID.NotFound') {
      console.error(`Instance ${options.instanceId} not found`);
    } else {
      console.error('Error getting instance status:', error);
    }
    process.exit(1);
  }
};

export const handleStart = async (options: any, ec2Client?: EC2Client) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const command = new StartInstancesCommand({
      InstanceIds: [options.instanceId]
    });
    await client.send(command);
    console.log('Instance start initiated');
  } catch (error) {
    console.error('Error starting instance:', error);
    process.exit(1);
  }
};

export const handleStop = async (options: any, ec2Client?: EC2Client) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const command = new StopInstancesCommand({
      InstanceIds: [options.instanceId]
    });
    await client.send(command);
    console.log('Instance stop initiated');
  } catch (error) {
    console.error('Error stopping instance:', error);
    process.exit(1);
  }
};

export const handleTerminate = async (options: any, ec2Client?: EC2Client) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const command = new TerminateInstancesCommand({
      InstanceIds: [options.instanceId]
    });
    await client.send(command);
    console.log('Instance termination initiated');
  } catch (error) {
    console.error('Error terminating instance:', error);
    process.exit(1);
  }
};

export const handleShell = async (options: any, ec2Client?: EC2Client) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const command = new DescribeInstancesCommand({
      InstanceIds: [options.instanceId]
    });
    const response = await client.send(command);

    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      console.error('Instance not found');
      process.exit(1);
    }

    if (!options.ssh) {
      // Use SSM Session Manager (default)
      const ssmProcess = spawn('aws', [
        'ssm', 'start-session',
        '--target', options.instanceId,
        '--region', region
      ], {
        stdio: 'inherit'
      });

      ssmProcess.on('close', (code: number) => {
        process.exit(code || 0);
      });
    } else {
      // Use regular SSH if requested
      if (!instance.PublicIpAddress) {
        console.error('No public IP available. The instance might not have SSH access enabled.');
        console.error('Try removing --ssh flag to connect via SSM Session Manager instead.');
        process.exit(1);
      }

      const sshProcess = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        'ec2-user@' + instance.PublicIpAddress
      ], {
        stdio: 'inherit'
      });

      sshProcess.on('close', (code: number) => {
        process.exit(code || 0);
      });
    }
  } catch (error) {
    console.error('Error connecting to instance:', error);
    process.exit(1);
  }
};

// Main function to run the CLI
const main = () => {
  // Configure the CLI
  const program = new Command();

  program
    .name('math-worker')
    .description('CDK CLI to manage Polis math worker instances')
    .version('1.0.0')
    .option('-v, --verbose', 'Enable verbose output')
    .hook('preAction', (thisCommand) => {
      globalOptions.verbose = thisCommand.opts().verbose;
      debug('CLI options:', thisCommand.opts());
    });

  // Create command with dynamic overlay options
  const createCommand = program
    .command('create')
    .description('Create a new math worker instance')
    .requiredOption('--env-file <path>', 'Path to environment file')
    .option('--branch <branch>', 'Git branch/tag/commit to use', 'edge')
    .option('--instance-type <type>', 'EC2 instance type', 't3.medium')
    .option('--region <region>', 'AWS region')
    .option('--database-url <url>', 'Override the DATABASE_URL from the environment file')
    .option('--enable-ssh', 'Enable SSH access (required for direct SSH access)', false)
    .option('--stack-name <name>', 'CloudFormation stack name (default: MathWorkerStack)')
    .action(async (options) => {
      // Load overlays before handling the create command
      const overlays = await loadOverlays();
      await handleCreate({ ...options, overlays });
    });

  // List command
  program
    .command('list')
    .description('List all math worker instances')
    .option('--region <region>', 'AWS region')
    .action((options) => handleList(options));

  // Status command
  program
    .command('status')
    .description('Check instance status')
    .requiredOption('--instance-id <id>', 'Instance ID')
    .option('--region <region>', 'AWS region')
    .action((options) => handleStatus(options));

  // Start command
  program
    .command('start')
    .description('Start an instance')
    .requiredOption('--instance-id <id>', 'Instance ID')
    .option('--region <region>', 'AWS region')
    .action((options) => handleStart(options));

  // Stop command
  program
    .command('stop')
    .description('Stop an instance')
    .requiredOption('--instance-id <id>', 'Instance ID')
    .option('--region <region>', 'AWS region')
    .action((options) => handleStop(options));

  // Terminate command
  program
    .command('terminate')
    .description('Terminate an instance')
    .requiredOption('--instance-id <id>', 'Instance ID')
    .option('--region <region>', 'AWS region')
    .action((options) => handleTerminate(options));

  // Shell command
  program
    .command('shell')
    .description('Open a shell session to the instance (uses SSM by default)')
    .requiredOption('--instance-id <id>', 'Instance ID')
    .option('--region <region>', 'AWS region')
    .option('--ssh', 'Use SSH instead of SSM Session Manager', false)
    .action((options) => handleShell(options));

  // Parse command line arguments
  program.parse();
};

// Only run the CLI if this file is being executed directly
if (require.main === module) {
  main();
} 