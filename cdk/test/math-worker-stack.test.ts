import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MathWorkerStack } from '../lib/math-worker-stack';

describe('MathWorkerStack', () => {
  let tempDir: string;
  let envFile: string;

  const mockEnvContent = `DATABASE_URL=postgres://user:pass@host:5432/db
MATH_ENV=dev`;

  beforeEach(() => {
    // Create a temporary directory for env file
    tempDir = mkdtempSync(join(tmpdir(), 'cdk-test-'));
    envFile = join(tempDir, '.env');
    writeFileSync(envFile, mockEnvContent, 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates basic infrastructure', () => {
    const app = new cdk.App();
    const stack = new MathWorkerStack(app, 'TestStack', {
      envFile,
      env: { region: 'us-west-2' }
    });
    const template = Template.fromStack(stack);

    // Verify VPC
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 1);
    
    // Verify security group
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    
    // Verify IAM role with SSM access
    template.hasResourceProperties('AWS::IAM::Role', {
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
    
    // Verify EC2 instance
    template.resourceCountIs('AWS::EC2::Instance', 1);
    
    // Verify instance ID output
    template.hasOutput('InstanceId', {});
  });

  test('enables SSH access when requested', () => {
    const app = new cdk.App();
    const stack = new MathWorkerStack(app, 'SSHStack', {
      envFile,
      enableSSHAccess: true,
      env: { region: 'us-west-2' }
    });
    const template = Template.fromStack(stack);

    // Verify SSH security group rule
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [
        {
          CidrIp: '0.0.0.0/0',
          FromPort: 22,
          IpProtocol: 'tcp',
          ToPort: 22,
        },
      ],
    });

    // Verify public IP output is present
    template.hasOutput('PublicIP', {});
  });
}); 