import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The database-backup function: `lambda/handler/dbBackuplambda.py` plus the
// dependencies pinned in `lambda/handler/requirements.txt`.
const HANDLER_DIR = path.join(__dirname, 'handler');
const RUNTIME = lambda.Runtime.PYTHON_3_12;

// pip's name for the Lambda platform this function runs on: CPython 3.12 on
// x86_64 (the function's architecture, Lambda's default, left unset below so
// the template keeps its shape), manylinux2014 (glibc 2.17), which Amazon
// Linux 2023 satisfies.
const PIP_PLATFORM_ARGS = [
  '--only-binary=:all:',
  '--platform', 'manylinux2014_x86_64',
  '--implementation', 'cp',
  '--python-version', '3.12',
  '--abi', 'cp312',
];

/**
 * Packages the handler for Lambda on this machine, without Docker: pip
 * installs the pinned, hash-checked wheels for the Lambda platform into the
 * asset directory, then the handler source is copied beside them. The layout
 * is the one the Docker-based PythonFunction construct produced (source files
 * at the root, packages beside them), so the deployed function is unchanged
 * apart from how its package was built. `--no-compile` leaves out bytecode
 * caches, which carry build timestamps, so every machine produces the same
 * package bytes; Python compiles the modules in memory at cold start instead.
 * The asset key is the construct's default: a hash of the handler directory
 * and these bundling options, so moving the pin in requirements.txt is what
 * makes the next deploy upload a new package.
 *
 * Needs `python3` with pip on PATH (any version: the wheel is selected for
 * the Lambda's Python, not the local one) and network access, or a warm pip
 * cache, for the wheel download. Throws on failure rather than returning
 * false, so CDK never falls back to a container build.
 */
export const packageHandler = (outputDir: string): boolean => {
  const python = process.env.CDK_PYTHON ?? 'python3';
  const pip = spawnSync(python, [
    '-m', 'pip', 'install', '--quiet', '--no-compile', '--require-hashes',
    ...PIP_PLATFORM_ARGS,
    '--target', outputDir,
    '-r', path.join(HANDLER_DIR, 'requirements.txt'),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (pip.error) {
    throw new Error(`database-backup function: could not run ${python} -m pip (${pip.error.message}); ` +
      'install Python 3 with pip, or point CDK_PYTHON at one');
  }
  if (pip.status !== 0) {
    throw new Error(`database-backup function: ${python} -m pip install exited with ${pip.status}`);
  }
  for (const name of fs.readdirSync(HANDLER_DIR)) {
    fs.cpSync(path.join(HANDLER_DIR, name), path.join(outputDir, name), { recursive: true });
  }
  return true;
};

const createDBBackupLambda = (self: Construct, db: cdk.aws_rds.DatabaseInstance, vpc: cdk.aws_ec2.IVpc, dbBackupBucket: cdk.aws_s3.Bucket, dbBackupLambdaRole: iam.Role) => {
  return new lambda.Function(self, 'DBBackupLambda', {
    code: lambda.Code.fromAsset(HANDLER_DIR, {
      bundling: {
        // Never used: local packaging either completes or throws.
        image: RUNTIME.bundlingImage,
        local: { tryBundle: packageHandler },
      },
    }),
    runtime: RUNTIME,
    handler: 'dbBackuplambda.lambda_handler',
    vpc: vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [db.connections.securityGroups[0]],
    role: dbBackupLambdaRole,
    timeout: cdk.Duration.minutes(10),
    memorySize: 512,
    ephemeralStorageSize: cdk.Size.gibibytes(4),
    environment: {},
  });
}

export { createDBBackupLambda }
