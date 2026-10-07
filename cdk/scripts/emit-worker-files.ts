/**
 * Writes a worker box's three files exactly as its launch template installs
 * them (launchTemplates.ts), for a local rehearsal of the real boot path:
 *
 *   <out>/polis-jobs.env       the env document (/etc/app-info/polis-jobs.env)
 *   <out>/polis-jobs-start     the unit's start script (/usr/local/bin/polis-jobs-start)
 *   <out>/polis-jobs.service   the systemd unit (/etc/systemd/system/polis-jobs.service)
 *
 * Usage (from cdk/):
 *   npx ts-node scripts/emit-worker-files.ts --out DIR [--class math-large]
 *     [--queue-hosts HOSTS] [--image IMAGE] [--secret NAME] [--region REGION]
 *
 * The class row, staged label and child settings come from the class table
 * (workerClasses.ts); --queue-hosts stands in for the RDS endpoint the stack
 * would write. Used by delphi/tests/poller/worker_boot_proof.py and
 * delphi/tests/poller/chain_proof.py.
 */
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { workerEnvDocument, workerStartScript, workerUnit } from '../launchTemplates';
import { workerClassesSettings } from '../workerClasses';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  if (fallback === undefined) throw new Error(`--${name} is required`);
  return fallback;
};
const out = opt('out');
const region = opt('region', 'us-east-1');
const stack = new cdk.Stack(new cdk.App(), 'EmitWorkerFiles', { env: { account: '123456789012', region } });
const settings = workerClassesSettings(stack);
const name = opt('class', 'math-large');
const spec = settings.classes.find((c) => c.name === name);
if (!spec) throw new Error(`no worker class ${name}`);
const doc = workerEnvDocument(spec, {
  loginSecretName: opt('secret', settings.queueLoginSecretName),
  image: opt('image', settings.workerImage),
  queueHosts: opt('queue-hosts'),
});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'polis-jobs.env'), doc.map(([k, v]) => `${k}=${v}\n`).join(''));
fs.writeFileSync(path.join(out, 'polis-jobs-start'), `${workerStartScript(region, '/etc/app-info').join('\n')}\n`,
  { mode: 0o755 });
fs.writeFileSync(path.join(out, 'polis-jobs.service'), `${workerUnit().join('\n')}\n`);
console.log(`wrote polis-jobs.env, polis-jobs-start, polis-jobs.service for class ${name} to ${out}`);
