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

The CLI provides several commands to manage math worker instances and stacks:

### Create a New Stack

Creates a new CloudFormation stack containing a math worker instance and all required resources:

```bash
npx ts-node bin/math-worker.ts create \
  --env-file .env \
  --stack-name MyMathWorker
```

This creates:
- A CloudFormation stack with the specified name
- An EC2 instance running the math worker
- All required networking and security resources
- IAM roles and policies

Optional parameters:
- `--branch` - Git branch/tag/commit to use (default: edge)
- `--instance-type` - EC2 instance type (default: t3.medium)
- `--region` - AWS region (defaults to AWS_REGION environment variable)
- `--database-url` - Override the DATABASE_URL from the environment file
- `--enable-ssh` - Enable SSH access (not recommended for production)
- `--ts-auth-key` - Tailscale auth key (for development with Tailscale networking)

### List Instances

List all math worker instances and their associated stacks:
```bash
npx ts-node bin/math-worker.ts list
```

### Check Instance Status

```bash
npx ts-node bin/math-worker.ts status --instance-id i-xxxxxx
```

### Instance Lifecycle Management

Stop an instance (can be restarted later):
```bash
npx ts-node bin/math-worker.ts stop --instance-id i-xxxxxx
```

Start a previously stopped instance:
```bash
npx ts-node bin/math-worker.ts start --instance-id i-xxxxxx
```

Note: Only use start/stop for temporary instance management. The instance must be part of an existing stack created with the `create` command.

### Stack Deletion

To properly clean up all resources, delete the entire stack:
```bash
npx ts-node bin/math-worker.ts delete-stack --stack-name MyMathWorker
```

This will:
- Terminate any running instances
- Delete all associated resources (VPC, security groups, etc.)
- Remove the CloudFormation stack

### Instance Termination (Not Recommended)

```bash
npx ts-node bin/math-worker.ts terminate --instance-id i-xxxxxx
```

Warning: The `terminate` command only terminates the EC2 instance, leaving other stack resources in place. Use `delete-stack` instead for proper cleanup.

### Connect to Instance

Open a shell session to the instance (uses SSM by default):
```bash
npx ts-node bin/math-worker.ts shell --instance-id i-xxxxxx
```

If you need to use SSH (only available if SSH access was enabled during creation):
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

## Development with Tailscale

If you need to connect your math worker instance to a local PostgreSQL database during development, you can use the Tailscale development overlay. This overlay is not committed to the repository but can be set up locally:

1. Create the development overlay file:
```bash
cp lib/math-worker-stack.dev-tailscale.ts.example lib/math-worker-stack.dev-tailscale.ts
```

2. Get a Tailscale auth key:
   - Go to the [Tailscale Admin Console](https://login.tailscale.com/admin/authkeys)
   - Create a new auth key (ephemeral recommended)
   - Copy the key (it starts with `tskey-`)

3. Create an instance with Tailscale enabled:
```bash
npx ts-node bin/math-worker.ts create \
  --env-file .env \
  --ts-auth-key tskey-xxxx \
  --enable-ssh
```

The instance will:
- Join your Tailscale network automatically
- Be accessible via its Tailscale IP
- Allow you to connect to local resources (like your PostgreSQL database)

Note: The `--enable-ssh` flag is recommended when using Tailscale for easier debugging, but it's optional.

### Connecting to Local PostgreSQL

1. Make sure your local PostgreSQL is accessible via Tailscale:
   - Your machine should be connected to Tailscale
   - PostgreSQL should listen on your Tailscale IP or `0.0.0.0`
   - PostgreSQL should allow connections from the Tailscale IP range

2. Update your `.env` file to use the Tailscale connection:
```bash
DATABASE_URL=postgres://user:pass@your-machine.tail-xxxx.ts.net:5432/db
```

Or use the `--database-url` option:
```bash
npx ts-node bin/math-worker.ts create \
  --env-file .env \
  --ts-auth-key tskey-xxxx \
  --database-url postgres://user:pass@your-machine.tail-xxxx.ts.net:5432/db
```

### Security Notes

1. The Tailscale overlay is for development only and should not be used in production
2. The overlay file is git-ignored to prevent accidental commits
3. Auth keys should be ephemeral (automatically expire) for better security
4. Each developer can have their own overlay configuration

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

# Run only the quick integration tests (list and status commands)
npm test -- -t "list command|status command" --verbose --no-buffer

# Run only the full lifecycle integration test
npm test -- -t "complete instance lifecycle" --verbose --no-buffer
```

Integration tests will create actual AWS resources. Make sure you have appropriate permissions and AWS credentials configured.

## Stack Overlays

The math worker supports a flexible overlay system that allows you to extend the base stack with additional functionality without modifying the core code. Overlays are automatically discovered and loaded from the `lib/overlays` directory.

### Using Overlays

Overlays are loaded dynamically and add their own command-line options to the `create` command. To see available overlays and their options:

```bash
npx ts-node bin/math-worker.ts create --help
```

### Creating New Overlays

To create a new overlay:

1. Create a new file in `lib/overlays/` (e.g., `my-feature.ts`)
2. Use this template structure:

```typescript
import * as cdk from 'aws-cdk-lib';
import { MathWorkerStack, MathWorkerStackProps } from '../math-worker-stack';

// Define your overlay-specific properties
interface MyFeatureStackProps extends MathWorkerStackProps {
  myOption: string;
}

// Extend the base stack
class MyFeatureStack extends MathWorkerStack {
  constructor(scope: cdk.App, id: string, props: MyFeatureStackProps) {
    super(scope, id, props);
    
    // Add your overlay-specific resources/configuration here
    if (props.myOption) {
      // ... your code ...
    }
  }
}

// Export the overlay definition
export const overlayDefinition = {
  name: 'My Feature',
  optionFlag: 'myOption',
  optionDescription: 'Description of my option',
  stackClass: MyFeatureStack,
};
```

The CLI will automatically detect your overlay and add the appropriate command-line option (in this case, `--myOption`).

### Example: Tailscale Overlay

An example overlay for Tailscale support is provided in `lib/overlays/tailscale.ts.example`. To use it:

1. Copy the example:
```bash
cp lib/overlays/tailscale.ts.example lib/overlays/tailscale.ts
```

2. Create an instance with Tailscale:
```bash
npx ts-node bin/math-worker.ts create \
  --env-file .env \
  --tsAuthKey tskey-xxx
```

The example overlay demonstrates:
- How to extend the base stack
- How to add user data scripts
- How to modify security groups
- How to handle overlay-specific options

### Overlay Guidelines

1. **Keep overlays focused**: Each overlay should do one thing well
2. **Document your overlay**: Include clear comments explaining what it does
3. **Handle errors gracefully**: Validate inputs and provide helpful error messages
4. **Follow the interface**: Always export an `overlayDefinition` object
5. **Be independent**: Overlays shouldn't depend on other overlays
6. **Respect the base stack**: Extend, don't modify existing functionality
7. **Use TypeScript**: Take advantage of type safety 