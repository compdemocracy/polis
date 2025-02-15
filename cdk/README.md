# Polis Math Worker CDK

This is a CDK implementation of the Polis math worker manager. It provides infrastructure as code for deploying and managing EC2 instances running the Polis math worker, with support for both Tailscale and AWS Systems Manager (SSM) for secure access.

## Prerequisites

1. Node.js (v18 or later recommended)
2. AWS CLI installed and configured with appropriate credentials
3. AWS CDK CLI installed: `npm install -g aws-cdk`
4. [Optional] Tailscale account and auth key (if using Tailscale for networking)
5. A running PostgreSQL instance (accessible via Tailscale or directly)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Bootstrap CDK in your AWS account (first time only):
```bash
cdk bootstrap
```

## Usage

The CLI provides several commands to manage math worker instances:

### Create a New Instance

There are two ways to create an instance:

1. **Secure Production Setup** (Recommended for production):
```bash
npx ts-node bin/math-worker.ts create \
  --env-file .env
```
This creates an instance that:
- Has no inbound ports open
- Is managed via AWS Systems Manager (SSM)
- Is most secure for production use

2. **Development Setup** with SSH and Tailscale:
```bash
npx ts-node bin/math-worker.ts create \
  --env-file .env \
  --ts-auth-key 'tskey-xxxxx' \
  --enable-ssh
```
This creates an instance that:
- Has SSH access enabled (port 22)
- Uses Tailscale for secure networking
- Is suitable for development and debugging

Optional parameters:
- `--branch` - Git branch/tag/commit to use (default: edge)
- `--instance-type` - EC2 instance type (default: t3.medium)
- `--region` - AWS region (defaults to AWS_REGION environment variable)
- `--database-url` - Override the DATABASE_URL from the environment file

### List Instances

```bash
npx ts-node bin/math-worker.ts list
```

### Check Instance Status

```bash
npx ts-node bin/math-worker.ts status --instance-id i-xxxxxx
```

### Connect to Instance

Open a shell session to the instance (uses SSM by default):
```bash
npx ts-node bin/math-worker.ts shell --instance-id i-xxxxxx
```

If you need to use SSH (only available if SSH access is enabled during instance creation):
```bash
npx ts-node bin/math-worker.ts shell --instance-id i-xxxxxx --ssh
```

Note: SSM is the recommended method for production environments as it doesn't require any inbound ports to be open.

### Run Commands

Execute commands on the instance via SSM (works for all instances):
```bash
npx ts-node bin/math-worker.ts run \
  --instance-id i-xxxxxx \
  --command "docker ps"
```

### Start/Stop Instance

```bash
# Start
npx ts-node bin/math-worker.ts start --instance-id i-xxxxxx

# Stop
npx ts-node bin/math-worker.ts stop --instance-id i-xxxxxx
```

### Terminate Instance

```bash
npx ts-node bin/math-worker.ts terminate --instance-id i-xxxxxx
```

## Security Features

1. **AWS Systems Manager (SSM)**:
   - Primary method for instance management
   - No inbound ports required
   - Uses AWS IAM for authentication
   - Secure command execution and session management

2. **Optional Tailscale Integration**:
   - Secure network connectivity
   - Automatic setup during instance creation
   - Requires Tailscale auth key
   - Only enabled if `--ts-auth-key` is provided

3. **Optional SSH Access**:
   - Can be enabled with `--enable-ssh`
   - Opens port 22 for direct SSH access
   - Recommended only for development/debugging
   - Requires `--enable-ssh` even if Tailscale is used

## Development

- `npm run build` - Compile TypeScript
- `npm run watch` - Watch for changes
- `npm test` - Run all tests
- `npm run test:unit` - Run unit tests only
- `npm run test:integration` - Run integration tests

## Infrastructure Components

The CDK stack creates:

1. VPC with public subnet
2. Security group (with optional SSH access)
3. IAM role with SSM access
4. EC2 instance with:
   - Amazon Linux 2023
   - Docker
   - Optional Tailscale
   - Polis math worker

## Environment File

The environment file (`.env`) should contain the same configuration as your main Polis stack. Key variables:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db
MATH_ENV=dev
```

You can override the database URL during creation with `--database-url`.

## Notes

1. The instance uses AWS Systems Manager Session Manager by default
2. SSH access is optional and disabled by default
3. Tailscale is only installed if an auth key is provided
4. All resources are tagged with "polis-math-worker"
5. The instance automatically joins your Tailscale network if configured

## Troubleshooting

1. **Can't open a shell to the instance**:
   - Check if `--enable-ssh` was used during creation
   - Try connecting without `--ssh` flag to use SSM instead
   - Verify security group allows port 22

2. **Can't connect via SSM**:
   - Verify AWS CLI is configured correctly
   - Check instance has SSM agent running
   - Verify IAM role permissions

3. **Tailscale not connecting**:
   - Verify auth key is valid
   - Check Tailscale status with:
     ```bash
     npx ts-node bin/math-worker.ts run --instance-id i-xxx --command "sudo tailscale status"
     ```

## Testing

The project includes both unit and integration tests:

```bash
# Run unit tests only
npm run test:unit

# Run integration tests (requires AWS credentials)
npm run test:integration

# Run all tests
npm test
```

Integration tests will create actual AWS resources. Make sure you have appropriate permissions and AWS credentials configured. 