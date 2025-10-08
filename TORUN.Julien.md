# STEPS TO RUN FROM edge


`make start` is supposed to get things running.
However, as of commit `b8c9c130`, it throws some errors, which we explain here, in a summary then in detail.

## TLDR:
- Revert Dependabot's commit `a7a060b` which updated  torch versions, to solve a dependency issue in the math python worker.
- Set `MATH_ENV=dev` instead of `=prod` in `.env`, to solve an infinite reboot loop of the clojure worker due to failing to load Datadog profiler -- which is skipped in development environment.
- Set up certificates by following the instructions at `oidc-simulator/README.md`, to allow actual sign-in.

 
## Torch dependencies issues

### Problem
Building the delphi worker throws an error about torchvision and torchd versions being in conflict.

### Solution
**Reverted torch version bump in delphi service**

Reverted commit a7a060b which bumped PyTorch from 2.3.1 to 2.8.0 in [delphi/requirements.txt](delphi/requirements.txt).

**Changes:**
- `torch==2.8.0` → `torch==2.3.1`
- Updated comment referencing CPU version from `2.8.0+cpu` → `2.3.1+cpu`
- `torchvision` and `torchaudio` versions unchanged (0.18.1 and 2.3.1 respectively)


## Math Container Boot Loop Issue

### Problem
The `math-1` Docker container enters an infinite reboot loop with this error:
```
XXXXXXXXXXXXXXXXXX REBOOTING MATH WORKER XXXXXXXXXXXXXXXXXX
Production environment detected. Attaching Datadog agent with profiling.
Error opening zip file or JAR manifest missing : /app/dd-java-agent.jar
Error occurred during initialization of VM
agent library failed to init: instrument
```

### Root Cause
- **Dockerfile location**: [math/Dockerfile](math/Dockerfile)
- **Entry point**: [math/bin/run](math/bin/run) - runs in an infinite loop
- **Error source**: Line 15 of `math/bin/run` tries to load Datadog Java agent (`-J-javaagent:/app/dd-java-agent.jar`)
- The Datadog agent JAR download (Dockerfile line 6) is failing/corrupt, causing Java to fail on startup

### What is Datadog?
**Datadog** is an Application Performance Monitoring (APM) platform that collects:
- Performance metrics
- Distributed traces
- Log aggregation
- Error tracking
- Profiling data

**Not necessary for local development** - it's designed for production monitoring.

### Solution: Disable Datadog

Edit [.env:13](.env#L13) and change:
```bash
MATH_ENV=prod
```
to:
```bash
MATH_ENV=dev
```

### How Environment Detection Works
At [math/bin/run:12](math/bin/run#L12), the script checks:
```bash
if [ "$MATH_ENV" = "prod" ]; then
```

The `MATH_ENV` variable is set in `.env` and passed to the container via [docker-compose.yml:98](docker-compose.yml#L98).

## Environment Behavior Differences

| Environment | Datadog Agent | Java Options | Command |
|-------------|---------------|--------------|---------|
| `prod` | ✅ Enabled with profiling | Multiple DD flags + profiling | `clojure -J-javaagent:/app/dd-java-agent.jar -J-Ddd.profiling.enabled=true ... -M:run full` |
| `dev` or other | ❌ Disabled | None | `clojure -M:run full` |

Both run with a 4-hour timeout (`14400` seconds).

## Set up certificates for login simulator

### Problem
The "Sign In" button at `localhost/signin` doesn't work. Multiple certificate-related errors occur:
1. **OIDC simulator crashes** with: `NoSSLError: no self signed certificate`
2. **Server fails JWT validation** with: `unable to verify the first certificate` (missing root CA)
3. **Hostname mismatch error**: `Host: host.docker.internal. is not in the cert's altnames`

### Root Cause
The OIDC simulator requires HTTPS with locally-trusted SSL certificates. Three components are needed:
1. Certificate and key files for the OIDC simulator to serve HTTPS
2. Root CA certificate for the server to trust the self-signed certificate
3. Certificate must include `host.docker.internal` as a valid hostname (Docker containers use this to reach the host)

None of these are automatically generated during build.

### Solution
Install `mkcert` and generate certificates (one-time setup):

```bash
# Install mkcert
brew install mkcert
brew install nss  # for Firefox support

# Install local Certificate Authority
mkcert -install

# Generate certificates with all required hostnames
mkdir -p ~/.simulacrum/certs
cd ~/.simulacrum/certs
mkcert -cert-file localhost.pem -key-file localhost-key.pem \
  localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal

# Copy the root CA so the server can trust the certificate
cp "$(mkcert -CAROOT)/rootCA.pem" .
```

Then restart the affected services:
```bash
docker restart polis-dev-oidc-simulator-1 polis-dev-server-1
```

### Test Sign-In
Visit [localhost/signin](http://localhost/signin) and use:
- **Email**: `admin@polis.test`
- **Password**: `Te$tP@ssw0rd*`

### What Each Component Does
- **localhost.pem & localhost-key.pem**: OIDC simulator uses these to serve HTTPS on port 3000
- **rootCA.pem**: Server container needs this to trust the self-signed certificate when fetching JWKS from the simulator
- **host.docker.internal**: Docker containers use this hostname to reach services on the host machine. The certificate must include it or you'll get `ERR_TLS_CERT_ALTNAME_INVALID` errors

### Documentation
- Full details: [oidc-simulator/README.md](oidc-simulator/README.md#prerequisites)
- Note: This requirement is documented in the simulator README and error logs, but not in the main README's Quick Start section

---