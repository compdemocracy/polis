# Polis Math Worker Manager

This tool helps manage EC2 instances running the Polis math worker. It handles the complete lifecycle of instances, from creation to termination, and integrates with Tailscale for secure network access.

## Prerequisites

1. AWS CLI installed and configured with appropriate credentials
2. A Tailscale account and access to create auth keys
3. A running PostgreSQL instance accessible via Tailscale

## Complete Lifecycle Example

### 1. Get a Tailscale Auth Key

1. Go to the [Tailscale Admin Console](https://login.tailscale.com/admin/authkeys)
2. Create a new auth key (ephemeral recommended)
3. Copy the key (it starts with `tskey-`)

### 2. Create an AWS Key Pair

Create and save an AWS key pair that will be used for SSH access:

```bash
./bin/manage-aws-math-worker create-keypair --keypair-name polis-math-worker
```

This will:
- Create a new key pair in AWS
- Save the private key to `~/.ssh/polis-math-worker.pem`
- Set correct permissions (600)

You can optionally add it to your SSH agent:
```bash
ssh-add ~/.ssh/polis-math-worker.pem
```

### 3. Create an Instance

Create a new EC2 instance with the math worker:

```bash
./bin/manage-aws-math-worker create \
  --env-file .env \
  --ts-auth-key 'tskey-xxxxx'
```

The `--env-file` parameter is mandatory and should point to the same environment file used by your main Polis stack. This ensures configuration consistency across your deployment.

If you need to connect to a different database than specified in your environment file, you can use the `--override-database-url` option:

```bash
./bin/manage-aws-math-worker create \
  --env-file .env \
  --ts-auth-key 'tskey-xxxxx' \
  --override-database-url 'postgres://user:pass@host:5432/db'
```

Optional parameters:
- `--branch` - Git branch/tag/commit to use (default: edge)
- `--instance-type` - EC2 instance type (default: t3.medium)
- `--key-path` - Path to SSH private key (if not using ssh-agent)
- `--region` - AWS region (defaults to AWS_REGION environment variable, or us-west-2 if not set)
- `--keypair-name` - Name of the AWS key pair to use (default: polis-math-worker)

### 4. List and Check Status

List all math worker instances:
```bash
./bin/manage-aws-math-worker list
```

Check status of a specific instance:
```bash
./bin/manage-aws-math-worker status --instance-id i-xxxxxx
```

### 5. SSH Into Instance

Connect to the instance via SSH:
```bash
./bin/manage-aws-math-worker ssh --instance-id i-xxxxxx
```

If not using ssh-agent, specify the key path:
```bash
./bin/manage-aws-math-worker ssh \
  --instance-id i-xxxxxx \
  --key-path ~/.ssh/polis-math-worker.pem
```

### 6. Stop and Resume

Stop the instance when not needed (to save costs):
```bash
./bin/manage-aws-math-worker stop --instance-id i-xxxxxx
```

Start it again when needed:
```bash
./bin/manage-aws-math-worker start --instance-id i-xxxxxx
```

### 7. Terminate

When the instance is no longer needed, terminate it:
```bash
./bin/manage-aws-math-worker terminate --instance-id i-xxxxxx
```

**Note**: Termination is permanent and will delete all data on the instance.

## Tips

1. **Environment File**: Use the same environment file as your main Polis stack to ensure consistent configuration. You can override the database URL if needed using the `--override-database-url` option.

2. **SSH Keys**: You can either:
   - Use the SSH agent (recommended): `ssh-add ~/.ssh/polis-math-worker.pem`
   - Or specify the key path explicitly: `--key-path ~/.ssh/polis-math-worker.pem`

3. **Instance Types**: Choose an instance type based on your needs:
   - t3.medium (default) - Good for development/testing
   - t3.large or bigger - For production workloads

4. **Tailscale**: The instance will automatically join your Tailscale network during creation, enabling secure access to your PostgreSQL database.

5. **Region Selection**: The script will use regions in the following order of precedence:
   - The `--region` command line argument if provided
   - The `AWS_REGION` environment variable if set
   - The default region (us-west-2)

6. **Security Groups**: The script automatically manages security groups:
   - Creates a security group named "polis-math-worker" if it doesn't exist
   - Configures inbound SSH access (port 22)
   - Allows all outbound traffic
   - Reuses existing security group if already present

## Command Reference

```bash
Usage: ./bin/manage-aws-math-worker <command> [options]

Commands:
  create          Create and start a new EC2 instance
  create-keypair  Create a new AWS key pair and save it locally
  list           List all polis math worker instances
  start          Start an existing stopped instance
  stop           Stop a running instance
  terminate      Terminate an instance
  status         Check instance status
  ssh            SSH into the instance
```

See `./bin/manage-aws-math-worker --help` for full options and details. 