#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';
import * as path from 'path'; // Use * as path
import * as fs from 'fs';
import { ProbeBox, ProbeConfig } from '../probeBox';

interface ExtendedStackProps extends cdk.StackProps {
  domainName?: string; // Make optional since we're not using it initially
  enableSSHAccess: boolean;
  enableOllama: boolean; // Gate the (temporarily retired) Ollama GPU stack
  envFile: string;
  branch: string; // Make required
  sshAllowedIpRange?: string; // Optional, but required if enableSSHAccess is true
  webKeyPairName?: string;   // Optional, but required if enableSSHAccess is true
  mathWorkerKeyPairName?: string; // Optional, but required if enableSSHAccess is true
}

const app = new cdk.App();

const envFilePath = process.env.ENV_FILE || '../../.env'; // Allow configurable .env file path
const resolvedEnvFilePath = path.resolve(__dirname, envFilePath);

// Helper function for boolean conversion
function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true' || value === '1' || value?.toLowerCase() === 'yes';
}

const props: ExtendedStackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  domainName: process.env.CDK_DOMAIN_NAME,
  enableSSHAccess: parseBoolean(process.env.CDK_SSH_ACCESS),
  // The Ollama GPU stack (ASG/GPU launch template/EFS/NLB/secret) is off by
  // default. Set CDK_ENABLE_OLLAMA=true to recreate it (pair with
  // LLM_PROVIDER=ollama in the app env for a self-hosted LLM).
  enableOllama: parseBoolean(process.env.CDK_ENABLE_OLLAMA),
  envFile: resolvedEnvFilePath,
  branch: process.env.CDK_BRANCH || 'edge', // Provide a default branch
  sshAllowedIpRange: process.env.CDK_SSH_ALLOWED_IP_RANGE,
  webKeyPairName: process.env.CDK_WEB_KEY_PAIR_NAME,
  mathWorkerKeyPairName: process.env.CDK_MATH_WORKER_KEY_PAIR_NAME,
};

// Check for required parameters based on enableSSHAccess
if (props.enableSSHAccess) {
  if (!props.sshAllowedIpRange) {
    throw new Error("sshAllowedIpRange is required when enableSSHAccess is true.");
  }
  if (!props.webKeyPairName) {
    throw new Error("webKeyPairName is required when enableSSHAccess is true");
  }
  if (!props.mathWorkerKeyPairName) {
        throw new Error("mathWorkerKeyPairName is required when enableSSHAccess is true");
  }
}


new CdkStack(app, 'CdkStack', props);
// Default-off: existing CdkStack resources and assets are unchanged.
if ([true, 'true'].includes(app.node.tryGetContext('enableProbeBox'))) {
  const filename = process.env.PROBE_BOX_CONFIG;
  if (!filename) throw new Error('PROBE_BOX_CONFIG is required');
  const config: ProbeConfig = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const probeStack = new cdk.Stack(app, 'ProbeStack', {
    env: { account: config.account, region: config.region },
  });
  new ProbeBox(probeStack, 'Box', config);
}
