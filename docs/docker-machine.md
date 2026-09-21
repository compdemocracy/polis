

# Running Polis with docker machine

This is the historical Docker Machine remote-development procedure. If local performance, platform or licensing constraints prevent running the full system, a separately configured remote development host is an option; this page does not establish that Docker Machine works with a current provider account or SDK. The checked-in deployment path is described in [deployment configuration](deployment-configuration.md), with source capacity in [scaling](scaling.md).
To find out more, visit the Docker Machine project's repository:

https://github.com/docker/machine

Follow the instructions there on how to set up Docker Machine and connect to a hosting provider.
The commands below are retained for maintaining an existing Docker Machine setup. Confirm the intended remote development target before using them; they provision or modify remote resources. Then:
1. Create a remote docker machine
   1. For AWS, this would look like `docker-machine create --driver amazonec2 --amazonec2-open-port 5000 --amazonec2-region us-east-2 remote-polis`
   1. This creates a machine called `remote-polis`.
1. Connect your shell to the docker machine: `eval "$(docker-machine env remote-polis)"`
1. Build and launch the polis server on the remote docker machine: `cd polis; docker compose up`. Select the intended profiles and environment using [the Makefile](../Makefile#L19); the root service is `server` ([Compose:52](../docker-compose.yml#L52)).

You should see something like this

```
NAME          ACTIVE   DRIVER       STATE     URL                         SWARM   DOCKER      ERRORS
remote-polis  *        amazonec2    Running   tcp://A.BB.CCC.DDD:EEEE             v19.03.12
```

Next:

1. Find the IP address of the docker machine (A.BB.CCC.DDD above)
1. Visit the host port configured by the selected overlay/proxy. The API defaults to internal port 5000, while the root proxy maps `HTTP_PORT`/`HTTPS_PORT` with fallbacks 80/443 ([API config:10](../server/src/config.ts#L10), [Compose:256](../docker-compose.yml#L256)). The historical direct-API example is http://A.BB.CCC.DDD:5000.
1. Useful commands for a remote docker machine:
    1. `docker-machine ls` to see a list of available “machines”.
    2. `docker-machine start <name>`
    3. `docker-machine stop <name>`
    4. `docker-machine ssh <name>` to open an SSH session to the specified instance.
    5. `docker-machine rm <name>` permanently remove instance.
1. Remember to stop (`docker-machine stop <name>`) and delete (`docker-machine rm <name>`) remote instance to avoid unwanted charges.

Configuration values and local/host/container endpoint differences are documented in [configuration](configuration.md) and its [per-site reference](configuration-env-reference.md). These instructions do not describe the deployed cloud state.
