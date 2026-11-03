import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import {
  ByClass, WORKER_AGENT_CONFIG, WorkerClassSpec, WorkerClassesSettings, mathLargeRow,
} from './workerClasses';

/** Where a worker box keeps the RDS CA bundle the daemon's TLS trusts (mounted read-only). */
export const WORKER_CA_FILE = '/etc/polis-jobs/rds-ca-bundle.pem';
/** AWS's published bundle of every RDS certificate authority, fetched when the file is missing. */
export const RDS_CA_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
/** The shared app env document the deploy writes; the worker env document comes after it. */
export const APP_ENV_FILE = '/opt/polis/polis/.env';

/**
 * A worker box's env document (/etc/app-info/polis-jobs.env), in order. The
 * unit sources it and passes it to `docker run` AFTER the shared app .env, so
 * every key here wins over the same key there (the large child's MATH_ENV
 * over the served label).
 */
export const workerEnvDocument = (spec: WorkerClassSpec, opts: {
  loginSecretName: string; image: string; queueHosts: string;
}): [string, string][] => [
  ['POLIS_JOBS_WORKER_CLASS', spec.workerClass],
  ['POLIS_JOBS_CONTAINER_MEMORY', spec.containerMemory],
  ['POLIS_JOBS_LOGIN_SECRET_NAME', opts.loginSecretName],
  ['POLIS_JOBS_IMAGE', opts.image],
  ['POLIS_JOBS_CA_FILE', WORKER_CA_FILE],
  ['POLIS_JOBS_HOST_ALLOWLIST', opts.queueHosts],
  ['POLIS_JOBS_REQUIRE_SOURCE_COMMIT', spec.requiresSourceCommit ? '1' : '0'],
  ...Object.entries(spec.childEnv ?? {}),
];

/** The script polis-jobs.service runs (/usr/local/bin/polis-jobs-start). */
export const workerStartScript = (region: string, configDir: string): string[] => [
  '#!/bin/bash',
  '# Starts the queue worker daemon with this box\'s class (written by the launch template).',
  'set -euo pipefail',
  `. ${configDir}/polis-jobs.env`,
  `test -f ${APP_ENV_FILE}  # the env document; the deploy writes it, systemd retries until then`,
  'umask 077',
  'mkdir -p /run/polis-jobs /var/lib/polis-jobs/journal',
  // The child refuses a frame admitted at another source commit, and with no
  // commit at all; without one in .env every job would be claimed only to
  // fail its attempt, so the daemon does not start.
  'if [ "${POLIS_JOBS_REQUIRE_SOURCE_COMMIT:-0}" = 1 ]; then',
  // (`|| true`: no line is the refusal below, not a pipefail exit without a message.)
  `  commit=$({ grep -E '^MATH_POLLER_SOURCE_COMMIT=' ${APP_ENV_FILE} || true; } | tail -n 1 | cut -d= -f2-)`,
  '  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then',
  `    echo "polis-jobs-start: refusing: no MATH_POLLER_SOURCE_COMMIT in ${APP_ENV_FILE} (the deploy hook writes it)" >&2`,
  '    exit 1',
  '  fi',
  'fi',
  // TLS to the queue trusts only this bundle (the daemon disables built-in roots).
  'if [ ! -s "$POLIS_JOBS_CA_FILE" ]; then',
  '  mkdir -p "$(dirname "$POLIS_JOBS_CA_FILE")"',
  `  curl -fsS --retry 3 --max-time 60 ${RDS_CA_BUNDLE_URL} -o "$POLIS_JOBS_CA_FILE.tmp"`,
  '  grep -q -- "-----BEGIN CERTIFICATE-----" "$POLIS_JOBS_CA_FILE.tmp"',
  '  chmod 644 "$POLIS_JOBS_CA_FILE.tmp"',
  '  mv "$POLIS_JOBS_CA_FILE.tmp" "$POLIS_JOBS_CA_FILE"',
  'fi',
  `aws secretsmanager get-secret-value --region ${region} --secret-id "$POLIS_JOBS_LOGIN_SECRET_NAME" ` +
    '--query SecretString --output text | jq -er .password > /run/polis-jobs/password',
  'exec docker run --rm --name polis-jobs --memory "$POLIS_JOBS_CONTAINER_MEMORY" \\',
  `  --env-file ${APP_ENV_FILE} --env-file ${configDir}/polis-jobs.env \\`,
  '  -e POLIS_JOBS_ENABLED=1 -e POLIS_JOBS_PASSWORD_FILE=/run/secrets/queue-login \\',
  '  -e POLIS_JOBS_JOURNAL_DIR=/var/lib/polis-jobs/journal \\',
  '  -v /run/polis-jobs/password:/run/secrets/queue-login:ro -v /var/lib/polis-jobs:/var/lib/polis-jobs \\',
  '  -v "$POLIS_JOBS_CA_FILE:$POLIS_JOBS_CA_FILE:ro" \\',
  '  "$POLIS_JOBS_IMAGE" polis-jobs',
];

/** The systemd unit (/etc/systemd/system/polis-jobs.service). */
export const workerUnit = (): string[] => [
  '[Unit]',
  'Description=Polis queue worker daemon (class in /etc/app-info/polis-jobs.env)',
  'After=docker.service network-online.target',
  'Wants=network-online.target',
  'Requires=docker.service',
  '[Service]',
  'ExecStartPre=-/usr/bin/docker rm -f polis-jobs',
  'ExecStart=/usr/local/bin/polis-jobs-start',
  // Drain: the daemon stops claiming on SIGTERM and lets its child finish.
  'ExecStop=/usr/bin/docker stop -t 900 polis-jobs',
  'TimeoutStopSec=960',
  'Restart=always',
  'RestartSec=60',
  '[Install]',
  'WantedBy=multi-user.target',
];

export default (
  self: Construct,
  logGroup: cdk.aws_logs.LogGroup,
  ollamaNamespace: string,
  ollamaModelDirectory: string,
  fileSystem: cdk.aws_efs.FileSystem | undefined,
  machineImageWeb: ec2.IMachineImage,
  instanceTypeWeb: ec2.InstanceType,
  webSecurityGroup: ec2.ISecurityGroup,
  webKeyPair: ec2.IKeyPair | undefined,
  instanceRole: cdk.aws_iam.IRole,
  machineImageMathWorker: ec2.IMachineImage,
  instanceTypeMathWorker: ec2.InstanceType,
  mathWorkerSecurityGroup: ec2.ISecurityGroup,
  mathWorkerKeyPair: ec2.IKeyPair | undefined,
  machineImageDelphiSmall: ec2.IMachineImage,
  instanceTypeDelphiSmall: ec2.InstanceType,
  delphiSmallKeyPair: ec2.IKeyPair | undefined,
  machineImageDelphiLarge: ec2.IMachineImage,
  instanceTypeDelphiLarge: ec2.InstanceType,
  delphiSecurityGroup: ec2.ISecurityGroup,
  delphiLargeKeyPair: ec2.IKeyPair | undefined,
  machineImageOllama: ec2.IMachineImage | undefined,
  instanceTypeOllama: ec2.InstanceType | undefined,
  ollamaKeyPair: ec2.IKeyPair | undefined,
  ollamaSecurityGroup: ec2.ISecurityGroup | undefined,
  enableOllama: boolean = false,
  // Queue worker classes (-c enableLargeClass=true, cdk/workerClasses.ts): one
  // template per row of the class table, each with its own instance type and
  // role; the math-large row is the Delphi large template. Undefined: the
  // Delphi large template is unchanged and no worker template exists.
  workers?: { settings: WorkerClassesSettings; roles: ByClass<cdk.aws_iam.IRole>; queueHosts: string }
) => {
  // The jobs daemon of a worker box, started with the box's class (see usrdata).
  const workerDaemonCommands = (configDir: string): string[] => {
    const start = workerStartScript(cdk.Stack.of(self).region, configDir);
    const unit = workerUnit();
    return [
      `cat << 'POLIS_JOBS_START' | sudo tee /usr/local/bin/polis-jobs-start\n${start.join('\n')}\nPOLIS_JOBS_START`,
      'sudo chmod 755 /usr/local/bin/polis-jobs-start',
      `cat << 'POLIS_JOBS_UNIT' | sudo tee /etc/systemd/system/polis-jobs.service\n${unit.join('\n')}\nPOLIS_JOBS_UNIT`,
      'sudo systemctl daemon-reload',
      // A worker daemon must never abort the boot (set -e above).
      'sudo systemctl enable --now polis-jobs.service || echo "polis-jobs unit failed to start; it retries"',
    ];
  };
  // A worker box's user data records what its jobs daemon runs with (the
  // worker class, the cgroup memory limit, the image, the NAME of the
  // restricted queue login's secret (the login is provisioned by the owner),
  // the TLS CA file and host allowlist, and the row's child settings) in the
  // env document /etc/app-info/polis-jobs.env (workerEnvDocument), and starts
  // the daemon with that class as the systemd unit polis-jobs.service. The
  // unit reads the login's password from Secrets Manager by name at each
  // start (never baked into the template), fetches the RDS CA bundle if it is
  // missing, takes the queue DSN and environment from the app .env the deploy
  // writes (the env document after it wins), and retries every minute until
  // the deploy has written that .env and built the image. A box whose daemon
  // is not running raises MissingWorker. Rehearsed end to end by
  // delphi/tests/poller/worker_boot_proof.py.
  const usrdata = (CLOUDWATCH_LOG_GROUP_NAME: string, service: string, instanceSize?: string,
    worker?: { spec: WorkerClassSpec; loginSecretName: string; agentConfigUrl: string; image: string;
      queueHosts: string }) => {
    let ld: ec2.UserData;
    ld = ec2.UserData.forLinux();
    const persistentConfigDir = '/etc/app-info';
    ld.addCommands(
      '#!/bin/bash',
      'set -e',
      'set -x',
      `sudo mkdir -p ${persistentConfigDir}`,
      `sudo chown root:root ${persistentConfigDir}`,
      `sudo chmod 755 ${persistentConfigDir}`,
      `echo "Writing service type '${service}' to ${persistentConfigDir}/service_type.txt"`,
      `echo "${service}" | sudo tee ${persistentConfigDir}/service_type.txt`,
      instanceSize ? `echo "Writing instance size '${instanceSize}' to ${persistentConfigDir}/instance_size.txt"` : '',
      instanceSize ? `echo "${instanceSize}" | sudo tee ${persistentConfigDir}/instance_size.txt` : '',
      ...(worker ? [
        `echo "Writing queue worker class '${worker.spec.workerClass}' to ${persistentConfigDir}/worker_class.txt"`,
        `echo "${worker.spec.workerClass}" | sudo tee ${persistentConfigDir}/worker_class.txt`,
        `echo "${worker.spec.containerMemory}" | sudo tee ${persistentConfigDir}/worker_memory.txt`,
        `echo "${worker.loginSecretName}" | sudo tee ${persistentConfigDir}/queue_login_secret.txt`,
        `printf '%s=%s\n' ${workerEnvDocument(worker.spec, worker)
          .map(([k, v]) => `${k} "${v}"`).join(' ')} | sudo tee ${persistentConfigDir}/polis-jobs.env`,
        `sudo chmod 644 ${persistentConfigDir}/polis-jobs.env`,
      ] : []),
      'sudo yum update -y',
      'sudo yum install -y amazon-cloudwatch-agent -y',
      'sudo dnf install -y wget ruby docker',
      'sudo systemctl start docker',
      'sudo systemctl enable docker',
      'sudo usermod -a -G docker ec2-user',
      // $(uname -m) → x86_64 on the web/delphi tiers, aarch64 on the Graviton math worker. A hardcoded
      // x86_64 binary aborts the boot script on ARM (Exec format error) and the CodeDeploy agent never installs.
      'sudo curl -L https://github.com/docker/compose/releases/download/v2.40.0/docker-compose-linux-$(uname -m) -o /usr/local/bin/docker-compose',
      'sudo chmod +x /usr/local/bin/docker-compose',
      'docker-compose --version',
      'sudo yum install -y jq',
      `export SERVICE=${service}`,
      instanceSize ? `export INSTANCE_SIZE=${instanceSize}` : '',
      CLOUDWATCH_LOG_GROUP_NAME ? `echo "${CLOUDWATCH_LOG_GROUP_NAME}" | sudo tee ${persistentConfigDir}/log_group_name.txt` : '',

      // --- CloudWatch Agent: config + start, on EVERY instance ---
      // The agent is installed above for all tiers, but until now only the
      // ollama user-data configured and started it, so only the GPU box
      // published memory. Memory is the binding resource on the math and delphi
      // tiers (all three idle at 0.5-1.3% CPU), so without this there is no
      // evidence on which to right-size them.
      //
      // Guarded with `|| true` because this function runs under `set -e`: a
      // metrics agent must never be able to abort an instance boot. The
      // nvidia_gpu section of the config collects nothing where there is no
      // GPU, so this is a no-op difference for ollama.
      'echo "Configuring CloudWatch Agent..."',
      `aws s3 cp ${worker ? worker.agentConfigUrl : cwAgentConfigAsset.s3ObjectUrl} ${cwAgentTempPath} || echo "CW agent config download failed; continuing"`,
      `sudo mkdir -p $(dirname ${cwAgentConfigPath}) || true`,
      `sudo mv ${cwAgentTempPath} ${cwAgentConfigPath} || true`,
      `sudo chmod 644 ${cwAgentConfigPath} || true`,
      `sudo chown root:root ${cwAgentConfigPath} || true`,
      'sudo systemctl enable amazon-cloudwatch-agent || true',
      'sudo systemctl start amazon-cloudwatch-agent || echo "CW agent failed to start; continuing"',

      'exec 1>>/var/log/user-data.log 2>&1',
      'echo "Finished User Data Execution at $(date)"',
      'sudo mkdir -p /etc/docker',
`cat << EOF | sudo tee /etc/docker/daemon.json
{
  "log-driver": "awslogs",
  "log-opts": {
    "awslogs-group": "${CLOUDWATCH_LOG_GROUP_NAME}",
    "awslogs-region": "${cdk.Stack.of(self).region}",
    "awslogs-stream": "${service}"
  }
}
EOF`,
    `sudo chmod 644 /etc/docker/daemon.json`,
    'sudo systemctl restart docker',
    'sudo systemctl status docker',
    ...(worker ? workerDaemonCommands(persistentConfigDir) : [])
    );
    return ld;
  };
  
// Define path for CloudWatch Agent config
// --- CloudWatch Agent Config Asset ---
// NOTE: this asset is shared by EVERY tier's user data (see usrdata() above),
// not just Ollama, so it is created unconditionally even when the Ollama stack
// is gated off.
const cwAgentConfigAsset = new s3_assets.Asset(self, 'CwAgentConfigAsset', {
  path: 'config/amazon-cloudwatch-agent.json' // Adjust path relative to cdk project root
});

// Grant the instance role read access to the asset bucket
cwAgentConfigAsset.grantRead(instanceRole);
// The worker boxes' agent config: the shared one plus disk free bytes rolled
// up by AutoScalingGroupName, for the per-class WorkerDisk alarm. Only the
// worker roles read it.
let workerAgentConfigAsset: s3_assets.Asset | undefined;
if (workers) {
  workerAgentConfigAsset = new s3_assets.Asset(self, 'WorkerCwAgentConfigAsset', { path: WORKER_AGENT_CONFIG });
  for (const role of Object.values(workers.roles)) workerAgentConfigAsset.grantRead(role);
}
const cwAgentConfigPath = '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json';
const cwAgentTempPath = '/tmp/amazon-cloudwatch-agent.json'; // Temporary download location

// --- Ollama user data (only when the GPU stack is enabled) ---
let ollamaUsrData: ec2.UserData | undefined;
if (enableOllama) {
  if (!fileSystem) {
    throw new Error('enableOllama is true but no EFS fileSystem was provided to configureLaunchTemplates');
  }
  const efsDnsName = `${fileSystem.fileSystemId}.efs.${cdk.Stack.of(self).region}.${cdk.Stack.of(self).urlSuffix}`;
  ollamaUsrData = ec2.UserData.forLinux();
  ollamaUsrData.addCommands(
    // Spread the base user data commands
    ...usrdata(logGroup.logGroupName, "ollama").render().split('\n').filter(line => line.trim() !== ''),

    // Install EFS utilities
    'echo "Installing EFS utilities for Ollama..."',
    'sudo dnf install -y amazon-efs-utils nfs-utils',

    // Start Ollama-specific setup
    'echo "Starting Ollama specific setup..."',

    // --- Mount EFS using standard NFSv4.1 ---
    `echo "Mounting EFS filesystem using NFSv4.1 and DNS Name: ${efsDnsName}"...`,
    `sudo mkdir -p ${ollamaModelDirectory}`,
    `sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport ${efsDnsName}:/ ${ollamaModelDirectory}`,
    `echo "${efsDnsName}:/ ${ollamaModelDirectory} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" | sudo tee -a /etc/fstab`,
    `sudo chown ec2-user:ec2-user ${ollamaModelDirectory}`,
    'echo "EFS mounted successfully."',

    // --- Start Ollama container ---
    'echo "Starting Ollama container..."',
    'sudo docker run -d --name ollama \\',
    '  --gpus all \\',
    '  -p 0.0.0.0:11434:11434 \\',
    `  -v ${ollamaModelDirectory}:/root/.ollama \\`,
    '  --restart unless-stopped \\',
    '  ollama/ollama serve',

    // --- Pull initial model in background ---
    '(',
    '  echo "Waiting for Ollama service (background task)..."',
    '  sleep 60',
    '  echo "Pulling default Ollama model (llama3.1:8b) in background..."',
    '  sudo docker exec ollama ollama pull llama3.1:8b || echo "Failed to pull default model initially, may need manual pull later."',
    '  echo "Background model pull task finished."',
    ') &',
    'disown',
    'echo "Ollama setup script finished."'
  );
}

  // --- Launch Templates
  const webLaunchTemplate = new ec2.LaunchTemplate(self, 'WebLaunchTemplate', {
    machineImage: machineImageWeb,
    userData: usrdata(logGroup.logGroupName, "server"),
    instanceType: instanceTypeWeb,
    securityGroup: webSecurityGroup,
    keyPair: webKeyPair,
    role: instanceRole,
  });
  const mathWorkerLaunchTemplate = new ec2.LaunchTemplate(self, 'MathWorkerLaunchTemplate', {
    machineImage: machineImageMathWorker,
    userData: usrdata(logGroup.logGroupName, "math"),
    instanceType: instanceTypeMathWorker,
    securityGroup: mathWorkerSecurityGroup,
    keyPair: mathWorkerKeyPair,
    role: instanceRole,
    blockDevices: [{
      deviceName: '/dev/xvda',
      volume: ec2.BlockDeviceVolume.ebs(20, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        deleteOnTermination: true,
      }),
    }],
  });
  // Delphi Small Launch Template
  const delphiSmallLaunchTemplate = new ec2.LaunchTemplate(self, 'DelphiSmallLaunchTemplate', {
    machineImage: machineImageDelphiSmall,
    userData: usrdata(logGroup.logGroupName, "delphi", "small"),
    instanceType: instanceTypeDelphiSmall,
    securityGroup: delphiSecurityGroup,
    keyPair: delphiSmallKeyPair,
    role: instanceRole,
    blockDevices: [
      {
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(50, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      },
    ],
  });
  // Worker class launch templates (cdk/workerClasses.ts). The service type is the row's
  // (`delphi-large` for math-large: after_install.sh then starts only the large worker, no
  // Delphi job poller, no second small poller), and the awslogs stream is that service type in
  // the same log group the capacity metric filters read. The root volume holds the on-box
  // `--build` of the delphi image and the daemon's journal.
  const workerTemplate = (spec: WorkerClassSpec, id: string) => new ec2.LaunchTemplate(self, id, {
    machineImage: machineImageDelphiLarge,
    userData: usrdata(logGroup.logGroupName, spec.serviceType, undefined, {
      spec,
      loginSecretName: workers!.settings.queueLoginSecretName,
      agentConfigUrl: workerAgentConfigAsset!.s3ObjectUrl,
      image: workers!.settings.workerImage,
      queueHosts: workers!.queueHosts,
    }),
    instanceType: spec.instanceType,
    securityGroup: delphiSecurityGroup,
    keyPair: delphiLargeKeyPair,
    role: workers!.roles[spec.name],
    blockDevices: [
      {
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(spec.rootVolumeGb, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      },
    ],
  });
  // Delphi Large Launch Template: the math-large worker when the classes are on.
  const delphiLargeLaunchTemplate = workers
    ? workerTemplate(mathLargeRow(workers.settings), 'DelphiLargeLaunchTemplate')
    : new ec2.LaunchTemplate(self, 'DelphiLargeLaunchTemplate', {
      machineImage: machineImageDelphiLarge,
      userData: usrdata(logGroup.logGroupName, "delphi", "large"),
      instanceType: instanceTypeDelphiLarge,
      securityGroup: delphiSecurityGroup,
      keyPair: delphiLargeKeyPair,
      role: instanceRole,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });
  const workerLaunchTemplates: ByClass<ec2.LaunchTemplate> = {};
  if (workers) {
    const large = mathLargeRow(workers.settings);
    workerLaunchTemplates[large.name] = delphiLargeLaunchTemplate;
    for (const spec of workers.settings.classes) {
      if (spec.name !== large.name) workerLaunchTemplates[spec.name] = workerTemplate(spec, `${spec.id}LaunchTemplate`);
    }
  }
  // Ollama Launch Template (only when the GPU stack is enabled)
  let ollamaLaunchTemplate: ec2.LaunchTemplate | undefined;
  if (enableOllama) {
    ollamaLaunchTemplate = new ec2.LaunchTemplate(self, 'OllamaLaunchTemplate', {
      machineImage: machineImageOllama,
      userData: ollamaUsrData,
      instanceType: instanceTypeOllama,
      securityGroup: ollamaSecurityGroup,
      keyPair: ollamaKeyPair,
      role: instanceRole,
      blockDevices: [
        {
          deviceName: '/dev/xvda', // Adjust if needed for DLAMI
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });
  }

  return {
    webLaunchTemplate,
    mathWorkerLaunchTemplate,
    delphiSmallLaunchTemplate,
    delphiLargeLaunchTemplate,
    ollamaLaunchTemplate,
    workerLaunchTemplates
  }
}