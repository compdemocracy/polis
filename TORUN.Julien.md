# STEPS TO RUN FROM edge


`make start` is supposed to get things running.
However, as of commit `b8c9c130`, it throws some errors, which we explain here, in a summary then in detail.

## TLDR:
- Revert Dependabot's commit `a7a060b` which updated  torch versions, to solve a dependency issue in the math python worker.
- Set `MATH_ENV=dev` instead of `=prod` in `.env`, to solve an infinite reboot loop of the clojure worker due to failing to load Datadog profiler -- which is skipped in development environment.

 
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

---