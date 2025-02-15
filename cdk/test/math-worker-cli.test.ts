import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Mock AWS SDK
jest.mock('@aws-sdk/client-ec2', () => {
  const mockDescribeInstances = jest.fn();
  return {
    EC2: jest.fn(() => ({
      describeInstances: mockDescribeInstances
    })),
    DescribeInstancesCommandOutput: jest.fn()
  };
});

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn
}));

jest.mock('fs');

// Mock CDK app
jest.mock('aws-cdk-lib', () => ({
  App: jest.fn().mockImplementation(() => ({
    synth: jest.fn()
  })),
  Stack: jest.fn(),
  Tags: {
    of: jest.fn().mockReturnValue({
      add: jest.fn()
    })
  }
}));

// Mock MathWorkerStack
jest.mock('../lib/math-worker-stack', () => ({
  MathWorkerStack: jest.fn()
}));

describe('Math Worker CLI', () => {
  let mockEC2Instance: { describeInstances: jest.Mock };
  let exitSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  let originalArgv: string[];
  let originalCwd: string;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_REGION = 'us-west-2';
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    // Store original process.argv and cwd
    originalArgv = process.argv;
    originalCwd = process.cwd();

    // Mock process.cwd to return a fixed path
    process.cwd = jest.fn().mockReturnValue('/test/cdk');

    // Setup EC2 mock
    mockEC2Instance = {
      describeInstances: jest.fn()
    };
    const { EC2 } = require('@aws-sdk/client-ec2');
    (EC2 as jest.Mock).mockImplementation(() => mockEC2Instance);

    // Setup spawn mock
    mockSpawn.mockReturnValue({
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
        return mockSpawn.mock.results[0].value;
      }),
      stdio: 'inherit'
    });

    // Mock process.exit and console.error
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original process.argv and cwd
    process.argv = originalArgv;
    process.cwd = jest.fn().mockReturnValue(originalCwd);

    // Restore process.exit and console.error
    exitSpy.mockRestore();
    consoleSpy.mockRestore();

    jest.resetModules();
  });

  describe('create command', () => {
    test('fails when env file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      process.argv = [
        'node',
        'math-worker.js',
        'create',
        '--env-file',
        '.env',
        '--ts-auth-key',
        'tskey123'
      ];

      await import('../bin/math-worker');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Environment file .env does not exist')
      );
    });
  });

  describe('shell command', () => {
    const mockInstance = {
      $metadata: {},
      Reservations: [{
        Instances: [{
          InstanceId: 'i-1234567890abcdef0',
          PublicIpAddress: '1.2.3.4'
        }]
      }]
    };

    beforeEach(() => {
      mockEC2Instance.describeInstances.mockResolvedValue(mockInstance);
    });

    test('successfully connects via SSM by default', async () => {
      process.argv = [
        'node',
        'math-worker.js',
        'shell',
        '--instance-id',
        'i-1234567890abcdef0'
      ];

      await import('../bin/math-worker');

      expect(mockEC2Instance.describeInstances).toHaveBeenCalledWith({
        InstanceIds: ['i-1234567890abcdef0']
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'aws',
        [
          'ssm', 'start-session',
          '--target', 'i-1234567890abcdef0',
          '--region', 'us-west-2'
        ],
        expect.any(Object)
      );
    });

    test('successfully connects via SSH when --ssh flag is used', async () => {
      process.argv = [
        'node',
        'math-worker.js',
        'shell',
        '--instance-id',
        'i-1234567890abcdef0',
        '--ssh'
      ];

      await import('../bin/math-worker');

      expect(mockEC2Instance.describeInstances).toHaveBeenCalledWith({
        InstanceIds: ['i-1234567890abcdef0']
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'ssh',
        [
          '-o',
          'StrictHostKeyChecking=no',
          'ec2-user@1.2.3.4'
        ],
        expect.any(Object)
      );
    });

    test('fails when instance not found', async () => {
      const emptyResponse = {
        $metadata: {},
        Reservations: []
      };
      mockEC2Instance.describeInstances.mockResolvedValue(emptyResponse);

      process.argv = [
        'node',
        'math-worker.js',
        'shell',
        '--instance-id',
        'i-nonexistent'
      ];

      await import('../bin/math-worker');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Instance not found'
      );
    });

    test('suggests removing --ssh flag when SSH not available', async () => {
      const instanceWithoutIP = {
        $metadata: {},
        Reservations: [{
          Instances: [{
            InstanceId: 'i-1234567890abcdef0'
          }]
        }]
      };
      mockEC2Instance.describeInstances.mockResolvedValue(instanceWithoutIP);

      process.argv = [
        'node',
        'math-worker.js',
        'shell',
        '--instance-id',
        'i-1234567890abcdef0',
        '--ssh'
      ];

      await import('../bin/math-worker');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        'No public IP available. The instance might not have SSH access enabled.'
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        'Try removing --ssh flag to connect via SSM Session Manager instead.'
      );
    });

    test('handles EC2 API errors', async () => {
      mockEC2Instance.describeInstances.mockRejectedValue(
        new Error('API Error')
      );

      process.argv = [
        'node',
        'math-worker.js',
        'shell',
        '--instance-id',
        'i-1234567890abcdef0'
      ];

      await import('../bin/math-worker');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error connecting to instance:',
        expect.any(Error)
      );
    });
  });
}); 