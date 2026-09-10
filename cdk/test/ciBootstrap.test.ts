import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { CertificationCiEc2 } from '../ciEc2';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

function script(): string {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'BootstrapTest', { env: { account: '000000000000', region: 'us-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', {
    vpcId: 'vpc-test', availabilityZones: ['us-east-1a'], privateSubnetIds: ['subnet-test'],
  });
  new CertificationCiEc2(stack, 'Ci', {
    vpc, githubRepo: 'example/repository', githubEnvironment: 'certification-public',
    githubRefs: ['refs/heads/edge'], instanceType: new ec2.InstanceType('r8g.4xlarge'),
    cpuType: ec2.AmazonLinuxCpuType.ARM_64, allowedInstanceTypes: ['r8g.4xlarge'],
    volumeSizeGiB: 100, shutdownMinutes: 300, sweeperMaxAgeMinutes: 360,
  });
  const template = Template.fromStack(stack);
  const lt = Object.values(template.findResources('AWS::EC2::LaunchTemplate'))[0];
  return lt.Properties.LaunchTemplateData.UserData['Fn::Base64'];
}

test('ARM bootstrap installs the noninteractive JVM without unavailable rlwrap', () => {
  const source = script();
  expect(source).toContain('dnf install -y java-21-amazon-corretto-headless ||');
  expect(source).not.toMatch(/dnf install[^\n]*rlwrap/);
  expect(source).toContain('docker-compose-linux-$(uname -m)');
  expect(source).toContain('clojure --version');
});

test('ARM source-build toolchain is installed before the locked Python environment', () => {
  const source = script();
  const toolchain = source.indexOf('dnf install -y gcc gcc-c++ make || fail "python build tools"');
  expect(toolchain).toBeGreaterThan(0);
  expect(toolchain).toBeLessThan(source.indexOf('uv sync --locked --extra dev'));
  expect(source).not.toContain('--no-build-isolation');
  expect(source).not.toContain('--no-install-package');
});

test('test extras are installed and verified before the ready marker', () => {
  const source = script();
  expect(source).toContain('uv sync --locked --extra dev');
  expect(source.indexOf('import pytest, xdist')).toBeGreaterThan(source.indexOf('uv sync --locked --extra dev'));
  expect(source.indexOf('import pytest, xdist')).toBeLessThan(source.indexOf('touch /var/lib/polis-ci-ready'));
});

test('all bootstrap shell is syntactically valid', () => {
  const run = spawnSync('bash', ['-n'], { input: script(), encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
});

test.each(['false', '(exit 7)'])('unexpected failure creates the marker without dumping commands: %s', command => {
  const dir = mkdtempSync(join(tmpdir(), 'p022-bootstrap-'));
  try {
    mkdirSync(join(dir, 'lib'));
    const source = script().split('exec >')[0]
      .split('/var/lib').join(join(dir, 'lib'))
      .split('/var/log/polis-ci-userdata.log').join(join(dir, 'bootstrap.log'));
    // Execute the actual EXIT-trap prologue before logging/timers/packages.
    const run = spawnSync('bash', ['-c', source + '\nBOOTSTRAP_PHASE=python\n' + command], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(existsSync(join(dir, 'lib/polis-ci-failed'))).toBe(true);
    expect(run.stdout + run.stderr).toContain('failed phase=python');
    expect(run.stdout).not.toContain('BASH_COMMAND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
