import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { CertificationCiEc2, CI_BOOTSTRAP_PINS } from '../ciEc2';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

function template(shutdownMinutes = 300): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'BootstrapTest', { env: { account: '000000000000', region: 'us-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', {
    vpcId: 'vpc-test', availabilityZones: ['us-east-1a'], privateSubnetIds: ['subnet-test'],
  });
  new CertificationCiEc2(stack, 'Ci', {
    vpc, githubRepo: 'example/repository', githubEnvironment: 'certification-public',
    githubRefs: ['refs/heads/edge'], instanceType: new ec2.InstanceType('r8g.4xlarge'),
    cpuType: ec2.AmazonLinuxCpuType.ARM_64, allowedInstanceTypes: ['r8g.4xlarge'],
    volumeSizeGiB: 100, shutdownMinutes,
  });
  return Template.fromStack(stack);
}

function script(shutdownMinutes = 300): string {
  const lt = Object.values(template(shutdownMinutes).findResources('AWS::EC2::LaunchTemplate'))[0];
  return lt.Properties.LaunchTemplateData.UserData['Fn::Base64'];
}

test('ARM bootstrap installs the noninteractive JVM without unavailable rlwrap', () => {
  const source = script();
  expect(source).toContain('dnf install -y java-21-amazon-corretto-headless ||');
  expect(source).not.toMatch(/dnf install[^\n]*rlwrap/);
  expect(source).toContain('docker-compose-linux-$(uname -m)');
  expect(source).toContain('clojure --version');
});

test('CI has no Lambda, scheduled rule, sweeper role, logs, or custom resources', () => {
  const resources = template().toJSON().Resources;
  for (const [id, resource] of Object.entries(resources) as [string, any][]) {
    expect(id).not.toMatch(/Sweeper/);
    expect(resource.Type).not.toMatch(/AWS::Lambda|AWS::Events|AWS::Logs|Custom::/);
  }
  const lt = Object.values(template().findResources('AWS::EC2::LaunchTemplate'))[0];
  expect(lt.Properties.LaunchTemplateData.InstanceInitiatedShutdownBehavior).toBe('terminate');
  expect(lt.Properties.LaunchTemplateData.BlockDeviceMappings[0].Ebs.DeleteOnTermination).toBe(true);
});

test.each([0, -1, 1.5, NaN, Infinity, 481])('rejects invalid campaign ceiling %s', value => {
  expect(() => template(value)).toThrow('ciEc2ShutdownMinutes must be an integer from 1 to 480');
});

test.each([1, 300, 480])('arms both timers from the campaign ceiling %s before downloads', value => {
  const source = script(value);
  const arm = source.indexOf(`shutdown -h +${value} `);
  expect(arm).toBeGreaterThan(0);
  expect(arm).toBeLessThan(source.indexOf('mktemp -d'));
  expect(arm).toBeLessThan(source.indexOf('dnf '));
  expect(arm).toBeLessThan(source.indexOf('curl '));
  expect(source).toContain(`setsid bash -c 'sleep ${value * 60}; poweroff -f'`);
});

test.each([0, 1])('timer-arm status %s: failure powers off and prevents work', status => {
  const dir = mkdtempSync(join(tmpdir(), 'p022-timer-'));
  try {
    // Run only the real timer block. All power/timer commands are shell stubs;
    // neither the host nor a child process can execute a real shutdown.
    const source = script();
    const block = source.slice(source.indexOf('if ! shutdown'), source.indexOf('# Redundant timer'));
    const run = spawnSync('bash', ['-c', `
      shutdown() { printf 'armed\\n' >> "$TRACE"; return ${status}; }
      poweroff() { printf 'poweroff\\n' >> "$TRACE"; }
      ${block}
      printf 'work\\n' >> "$TRACE"
    `], { encoding: 'utf8', env: { ...process.env, TRACE: join(dir, 'trace') } });
    expect(run.status).toBe(status === 0 ? 0 : 1);
    expect(readFileSync(join(dir, 'trace'), 'utf8')).toBe(status === 0 ? 'armed\nwork\n' : 'armed\npoweroff\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the four pins are fixed in the rendered script and redirects require HTTPS', () => {
  const source = script();
  for (const pin of [CI_BOOTSTRAP_PINS.uv.sha256, CI_BOOTSTRAP_PINS.clojure.sha256,
    CI_BOOTSTRAP_PINS.compose.aarch64, CI_BOOTSTRAP_PINS.compose.x86_64]) {
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    expect(source).toContain(pin);
  }
  expect(source).toContain('--proto "=https" --proto-redir "=https"');
  expect(source).not.toContain('https://astral.sh/uv/install.sh');
  expect(source).not.toContain('https://download.clojure.org/install/linux-install.sh');
});

describe.each(['uv', 'clojure', 'compose-aarch64', 'compose-x86_64'])('%s verified installation', component => {
  test.each(['valid', 'corrupt', 'truncated', 'download-failed'])('%s bytes', variant => {
    const dir = mkdtempSync(join(tmpdir(), 'p022-download-'));
    try {
      const fixture = '#!/bin/sh\nprintf executed > "$EXECUTED"\n';
      const digest = createHash('sha256').update(fixture).digest('hex');
      writeFileSync(join(dir, 'fixture'), variant === 'corrupt' ? fixture + 'tamper' :
        variant === 'truncated' ? fixture.slice(0, 8) : fixture);
      const source = script();
      const helper = source.slice(source.indexOf('fetch_verified() {'), source.indexOf('# --- docker'));
      let section: string;
      if (component.startsWith('compose')) {
        section = source.slice(source.indexOf('COMPOSE_VERSION='), source.indexOf('# --- which ref'));
        section = section.split(CI_BOOTSTRAP_PINS.compose.aarch64).join(digest)
          .split(CI_BOOTSTRAP_PINS.compose.x86_64).join(digest);
      } else {
        const pin = CI_BOOTSTRAP_PINS[component as 'uv' | 'clojure'];
        const start = source.indexOf(`fetch_verified "${pin.url}"`);
        // The call and the following invocation are the real bootstrap lines.
        section = source.slice(start).split('\n').slice(0, 2).join('\n').split(pin.sha256).join(digest);
      }
      const run = spawnSync('bash', ['-c', `
        set -euo pipefail
        fail() { echo "$*" >&2; exit 1; }
        curl() {
          while [ "$1" != '-o' ]; do shift; done
          cp "$FIXTURE" "$2"
          return ${variant === 'download-failed' ? 22 : 0}
        }
        uname() { echo ${component === 'compose-x86_64' ? 'x86_64' : 'aarch64'}; }
        mkdir() { :; }
        install() { cmp "$3" "$FIXTURE"; printf installed > "$EXECUTED"; }
        ln() { :; }
        docker() { test -f "$EXECUTED"; }
        ${helper}
        ${section}
      `], { encoding: 'utf8', env: { ...process.env, BOOTSTRAP_DOWNLOAD_DIR: dir,
        FIXTURE: join(dir, 'fixture'), EXECUTED: join(dir, 'executed') } });
      expect(run.status).toBe(variant === 'valid' ? 0 : 1);
      expect(existsSync(join(dir, 'executed'))).toBe(variant === 'valid');
      if (['corrupt', 'truncated'].includes(variant)) {
        expect(run.stderr).toContain('download sha256 mismatch');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

test('public results use authenticated instance prefixes and no SSM command reads', () => {
  const j=template().toJSON();
  expect(JSON.stringify(j)).not.toContain('ssm:GetCommandInvocation');
  const policies=Object.values(j.Resources).filter((r:any)=>r.Type==='AWS::IAM::Policy') as any[];
  const statements=policies.flatMap(r=>r.Properties.PolicyDocument.Statement);
  const write=statements.find(s=>s.Sid==='WriteOwnPublicResults');
  expect(JSON.stringify(write.Resource)).toContain('campaigns/${ec2:SourceInstanceARN}/*');
  expect(write.Action).toBe('s3:PutObject');
  expect(write.Condition.StringEquals).toEqual({'s3:if-none-match':'*','s3:x-amz-server-side-encryption':'AES256'});
  const list=statements.find(s=>s.Sid==='ListPublicCampaignResults');
  expect(list.Condition.StringLike['s3:prefix']).toBe('campaigns/*');
  expect(statements.find(s=>s.Sid==='ReadPublicCampaignResults').Action).toBe('s3:GetObject');
  expect(Object.values(j.Resources).filter((r:any)=>r.Type==='AWS::S3::Bucket')).toHaveLength(1);
  const workflow=readFileSync(join(__dirname,'../../.github/workflows/certification-ec2.yml'),'utf8');
  expect(workflow).not.toContain('ssm:GetCommandInvocation');
  expect(workflow).toContain('"campaigns/"+$arn+"/*"');
  expect(workflow).toContain('CERTIFY_RESULTS_BUCKET');
});
