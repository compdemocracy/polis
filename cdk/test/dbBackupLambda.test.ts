import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDBBackupLambda, packageHandler } from '../lambda/lambda';

// The database-backup function alone, with asset bundling skipped: these
// tests pin the function's shape in the template, not its package.
const template = () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'Fixture', { env: { account: '000000000000', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const db = new rds.DatabaseInstance(stack, 'Database', {
    vpc, engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
  });
  const bucket = new s3.Bucket(stack, 'Bucket');
  const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  createDBBackupLambda(stack, db, vpc, bucket, role);
  return Template.fromStack(stack);
};

test('the function keeps the shape the Docker-bundled construct produced', () => {
  const t = template();
  t.resourceCountIs('AWS::Lambda::Function', 1);
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'python3.12',
    Handler: 'dbBackuplambda.lambda_handler',
    MemorySize: 512,
    Timeout: 600,
    EphemeralStorage: { Size: 4096 },
    Role: { 'Fn::GetAtt': ['Role1ABCC5F0', 'Arn'] },
    VpcConfig: {
      SecurityGroupIds: [{ 'Fn::GetAtt': ['DatabaseSecurityGroup5C91FDCB', 'GroupId'] }],
      SubnetIds: [{ Ref: 'VpcPrivateSubnet1Subnet536B997A' }, { Ref: 'VpcPrivateSubnet2Subnet3788AAA1' }],
    },
  });
  const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0] as any;
  // Left at Lambda's defaults, as before: no Architectures, Layers or Environment.
  expect(fn.Properties.Architectures).toBeUndefined();
  expect(fn.Properties.Layers).toBeUndefined();
  expect(fn.Properties.Environment).toBeUndefined();
  // A file asset, hashed from the handler directory and the bundling options
  // (the construct's default), so a pin change in requirements.txt is a new key.
  expect(Object.keys(fn.Properties.Code).sort()).toEqual(['S3Bucket', 'S3Key']);
  expect(fn.Properties.Code.S3Key).toMatch(/^[0-9a-f]{64}\.zip$/);
  t.resourceCountIs('AWS::Lambda::LayerVersion', 0);
});

test('nothing in the cdk package depends on the Docker-bundling construct', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('@aws-cdk/aws-lambda-python-alpha');
});

test('the pinned requirement carries a hash for the Lambda platform wheel', () => {
  const requirements = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'handler', 'requirements.txt'), 'utf8');
  const pins = requirements.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
  expect(pins).toMatch(/^psycopg2-binary==\d+\.\d+\.\d+ \\\n\s+--hash=sha256:[0-9a-f]{64}$/);
});

// Runs pip for real (no Docker): the package must hold exactly the handler,
// its requirements file and the psycopg2 wheel's contents, and nothing else.
// Needs python3 with pip and the wheel (network, or a warm pip cache).
test('packageHandler builds the Lambda package with pip, without Docker', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-package-'));
  try {
    expect(packageHandler(out)).toBe(true);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(out, p));
      }
    };
    walk(out);
    expect(files).toContain('dbBackuplambda.py');
    expect(files).toContain('requirements.txt');
    expect(files).toContain('psycopg2/__init__.py');
    expect(files).toContain('psycopg2/_psycopg.cpython-312-x86_64-linux-gnu.so');
    expect(files.filter((f) => f.startsWith('psycopg2_binary.libs/libpq-'))).toHaveLength(1);
    expect(files.filter((f) => /^psycopg2_binary-\d+\.\d+\.\d+\.dist-info\/RECORD$/.test(f))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.pyc'))).toHaveLength(0);
    expect(files.filter((f) => f.startsWith('bin/'))).toHaveLength(0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
