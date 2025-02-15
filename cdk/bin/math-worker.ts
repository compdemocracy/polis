#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MathWorkerStack } from '../lib/math-worker-stack';
import { Command } from 'commander';
import { EC2 } from '@aws-sdk/client-ec2';
import { SSM } from '@aws-sdk/client-ssm';
import { existsSync } from 'fs';
import { spawn } from 'child_process';

// Create AWS clients
const createEC2Client = (region: string) => new EC2({ region });
const createSSMClient = (region: string) => new SSM({ region });

// Create command handlers
const handleCreate = async (options: any) => {
  // Validate env file exists
  if (!existsSync(options.envFile)) {
    console.error(`Error: Environment file ${options.envFile} does not exist`);
    process.exit(1);
  }

  // If SSH access is not enabled but Tailscale key is provided, warn the user
  if (!options.enableSsh && options.tsAuthKey) {
    console.warn('Warning: Tailscale auth key provided but SSH access is not enabled.');
    console.warn('The instance will not be accessible via SSH. Use --enable-ssh if you need SSH access.');
  }

  const app = new cdk.App();
  
  new MathWorkerStack(app, 'MathWorkerStack', {
    env: {
      region: options.region || process.env.AWS_REGION || 'us-west-2'
    },
    envFile: options.envFile,
    tsAuthKey: options.tsAuthKey,
    branch: options.branch,
    instanceType: options.instanceType,
    databaseUrl: options.databaseUrl,
    enableSSHAccess: options.enableSsh
  });

  app.synth();
};

const handleList = async (options: any, ec2Client?: EC2) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const response = await client.describeInstances({
      Filters: [{
        Name: 'tag:Name',
        Values: ['polis-math-worker']
      }]
    });

    const instances = response.Reservations?.flatMap(r => r.Instances || []) || [];
    
    if (instances.length === 0) {
      console.log('No math worker instances found');
      return;
    }

    console.log('Math Worker Instances:');
    console.log('----------------------------------------');
    instances.forEach(instance => {
      console.log(`ID: ${instance.InstanceId}`);
      console.log(`State: ${instance.State?.Name}`);
      console.log(`Public IP: ${instance.PublicIpAddress}`);
      console.log(`Launch Time: ${instance.LaunchTime}`);
      console.log('----------------------------------------');
    });
  } catch (error) {
    console.error('Error listing instances:', error);
    process.exit(1);
  }
};

const handleStatus = async (options: any, ec2Client?: EC2) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const response = await client.describeInstances({
      InstanceIds: [options.instanceId]
    });

    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      console.error('Instance not found');
      process.exit(1);
    }

    console.log('Instance Status:');
    console.log(`State: ${instance.State?.Name}`);
    console.log(`Public IP: ${instance.PublicIpAddress}`);
    console.log(`Launch Time: ${instance.LaunchTime}`);
  } catch (error) {
    console.error('Error getting instance status:', error);
    process.exit(1);
  }
};

const handleStart = async (options: any, ec2Client?: EC2) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    await client.startInstances({
      InstanceIds: [options.instanceId]
    });
    console.log(`Started instance ${options.instanceId}`);
  } catch (error) {
    console.error('Error starting instance:', error);
    process.exit(1);
  }
};

const handleStop = async (options: any, ec2Client?: EC2) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    await client.stopInstances({
      InstanceIds: [options.instanceId]
    });
    console.log(`Stopped instance ${options.instanceId}`);
  } catch (error) {
    console.error('Error stopping instance:', error);
    process.exit(1);
  }
};

const handleTerminate = async (options: any, ec2Client?: EC2) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    await client.terminateInstances({
      InstanceIds: [options.instanceId]
    });
    console.log(`Terminated instance ${options.instanceId}`);
  } catch (error) {
    console.error('Error terminating instance:', error);
    process.exit(1);
  }
};

const handleShell = async (options: any, ec2Client?: EC2) => {
  const region = options.region || process.env.AWS_REGION || 'us-west-2';
  const client = ec2Client || createEC2Client(region);

  try {
    const response = await client.describeInstances({
      InstanceIds: [options.instanceId]
    });

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

// Configure the CLI
const program = new Command();

program
  .name('math-worker')
  .description('CDK CLI to manage Polis math worker instances')
  .version('1.0.0');

// Create command
program
  .command('create')
  .description('Create a new math worker instance')
  .requiredOption('--env-file <path>', 'Path to environment file')
  .option('--ts-auth-key <key>', 'Tailscale auth key (optional)')
  .option('--branch <branch>', 'Git branch/tag/commit to use', 'edge')
  .option('--instance-type <type>', 'EC2 instance type', 't3.medium')
  .option('--region <region>', 'AWS region')
  .option('--database-url <url>', 'Override the DATABASE_URL from the environment file')
  .option('--enable-ssh', 'Enable SSH access (required for direct SSH access)', false)
  .action(handleCreate);

// List command
program
  .command('list')
  .description('List all math worker instances')
  .option('--region <region>', 'AWS region')
  .action(handleList);

// Status command
program
  .command('status')
  .description('Check instance status')
  .requiredOption('--instance-id <id>', 'Instance ID')
  .option('--region <region>', 'AWS region')
  .action(handleStatus);

// Start command
program
  .command('start')
  .description('Start an instance')
  .requiredOption('--instance-id <id>', 'Instance ID')
  .option('--region <region>', 'AWS region')
  .action(handleStart);

// Stop command
program
  .command('stop')
  .description('Stop an instance')
  .requiredOption('--instance-id <id>', 'Instance ID')
  .option('--region <region>', 'AWS region')
  .action(handleStop);

// Terminate command
program
  .command('terminate')
  .description('Terminate an instance')
  .requiredOption('--instance-id <id>', 'Instance ID')
  .option('--region <region>', 'AWS region')
  .action(handleTerminate);

// Shell command
program
  .command('shell')
  .description('Open a shell session to the instance (uses SSM by default)')
  .requiredOption('--instance-id <id>', 'Instance ID')
  .option('--region <region>', 'AWS region')
  .option('--ssh', 'Use SSH instead of SSM Session Manager', false)
  .action(handleShell);

// Export handlers for testing
export const handlers = {
  handleCreate,
  handleList,
  handleStatus,
  handleStart,
  handleStop,
  handleTerminate,
  handleShell,
};

// Parse command line arguments
program.parse(); 