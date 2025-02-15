import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fs from 'fs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MathWorkerStack } from '../lib/math-worker-stack';

describe('MathWorkerStack', () => {
  let app: cdk.App;
  let stack: MathWorkerStack;
  let template: Template;
  let tempDir: string;
  let envFile: string;

  const mockEnvContent = `DATABASE_URL=postgres://user:pass@host:5432/db
MATH_ENV=dev`;

  beforeEach(() => {
    // Create a temporary directory for CDK output and env file
    tempDir = mkdtempSync(join(tmpdir(), 'cdk-test-'));
    envFile = join(tempDir, '.env');

    // Create temporary env file
    writeFileSync(envFile, mockEnvContent, 'utf8');

    // Create app with explicit output directory
    app = new cdk.App({
      outdir: tempDir
    });
    
    // Create the stack
    stack = new MathWorkerStack(app, 'TestStack', {
      envFile,
      tsAuthKey: 'tskey-test',
      env: {
        region: 'us-west-2',
        account: '123456789012'
      }
    });
    
    // Get the template from the stack
    template = Template.fromStack(stack);
  });

  afterEach(() => {
    // Clean up temporary directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates VPC with correct configuration', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });

    // Verify subnet configuration
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
      VpcId: Match.anyValue(),
    });
  });

  test('creates security group with SSH access', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Polis math worker',
      SecurityGroupIngress: [
        {
          CidrIp: '0.0.0.0/0',
          FromPort: 22,
          IpProtocol: 'tcp',
          ToPort: 22,
        },
      ],
    });
  });

  test('creates IAM role with correct policies', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              Service: 'ec2.amazonaws.com',
            },
          },
        ],
        Version: '2012-10-17',
      },
      ManagedPolicyArns: [
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':iam::aws:policy/AmazonSSMManagedInstanceCore',
            ],
          ],
        },
      ],
    });
  });

  test('creates EC2 instance with correct configuration', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.medium',
      Tags: [
        {
          Key: 'Name',
          Value: 'polis-math-worker',
        },
      ],
    });
  });

  test('creates key pair', () => {
    template.hasResourceProperties('AWS::EC2::KeyPair', {
      KeyName: 'polis-math-worker',
    });
  });

  describe('custom configurations', () => {
    let customApp: cdk.App;
    let customTempDir: string;

    beforeEach(() => {
      customTempDir = mkdtempSync(join(tmpdir(), 'cdk-custom-test-'));
      customApp = new cdk.App({
        outdir: customTempDir
      });
    });

    afterEach(() => {
      rmSync(customTempDir, { recursive: true, force: true });
    });

    test('creates instance with custom instance type', () => {
      const customStack = new MathWorkerStack(customApp, 'CustomStack', {
        envFile,
        tsAuthKey: 'tskey-test',
        instanceType: 't3.large',
        env: {
          region: 'us-west-2',
          account: '123456789012'
        }
      });
      
      const customTemplate = Template.fromStack(customStack);

      customTemplate.hasResourceProperties('AWS::EC2::Instance', {
        InstanceType: 't3.large',
      });
    });

    test('creates instance with custom database URL', () => {
      const customDbUrl = 'postgres://custom:pass@host:5432/db';
      const customStack = new MathWorkerStack(customApp, 'CustomDbStack', {
        envFile,
        tsAuthKey: 'tskey-test',
        databaseUrl: customDbUrl,
        env: {
          region: 'us-west-2',
          account: '123456789012'
        }
      });
      
      const customTemplate = Template.fromStack(customStack);

      // Verify that user data contains the custom database URL
      customTemplate.hasResourceProperties('AWS::EC2::Instance', {
        UserData: Match.objectLike({
          'Fn::Base64': Match.stringLikeRegexp(customDbUrl)
        })
      });
    });

    test('creates instance with custom branch', () => {
      const customBranch = 'feature/test-branch';
      const customStack = new MathWorkerStack(customApp, 'CustomBranchStack', {
        envFile,
        tsAuthKey: 'tskey-test',
        branch: customBranch,
        env: {
          region: 'us-west-2',
          account: '123456789012'
        }
      });
      
      const customTemplate = Template.fromStack(customStack);

      // Verify that user data contains the custom branch
      customTemplate.hasResourceProperties('AWS::EC2::Instance', {
        UserData: Match.objectLike({
          'Fn::Base64': Match.stringLikeRegexp(`git checkout ${customBranch}`)
        })
      });
    });
  });

  test('creates outputs for instance ID and public IP', () => {
    template.hasOutput('InstanceId', {});
    template.hasOutput('PublicIP', {});
  });
}); 