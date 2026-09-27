

# Scaling Polis

The [⚡ Running Polis](/#-running-polis) instructions in the main README set up a system with only a single running instance of the `server` service ([Compose:52](../docker-compose.yml#L52)).
For very small engagements of a few hundred participants, this may be sufficient.
But for even moderate scale in terms of size and number of concurrent conversations, it will be necessary to run multiple polis-server instances to handle the number of web requests.

## Scaling approaches

#### On a single machine

Compose's replica option uses the current service name: `docker compose up --scale server=N`. Review the selected overlays, fixed host-port mappings and reverse-proxy routing before using multiple replicas; the root [service definition](../docker-compose.yml#L52) is the source for this topology.
Typically, this would be run on a single machine, and thus for even moderate scale requires that the machine being deployed on have room to accomodate running a large number of containers, and an active math worker.
This complicates the process of adjusting in real time to changing demand in a cost and resource effective manner.

For small to medium size deployments with rather steady or predictable participation rates, this may be a tenable solution.
But for deployments which expect exceptionally high, uneven and/or unpredictable participation rates, it may prove too costly in terms of computational and operations personnel resources.

#### Docker Compose over Docker Swarm

This section records the historical Docker Swarm exploration. The checked-in [Compose file](../docker-compose.yml) and [CDK entry point](../cdk/bin/cdk.ts#L21) do not establish a tested Swarm deployment procedure; the current CDK capacity reference is below. Preserve this as context for evaluating a separate deployment topology, not a claim that the Compose development setup is already validated on Swarm.

What's most uncertain at present is whether it will be possible to automatically scale servers based on demand.
A local Compose `--scale server=N` operation is distinct from a Swarm service update. No Docker Cloud or demand-based Swarm autoscaling workflow is validated by the current source.

**Note**: use the Compose command documented by the selected deployment tooling. The choice of `docker compose` spelling alone does not establish Swarm compatibility.

#### Scaling to the limits

For Polis to scale  it's most performant potential, you may need to consider additional infrastructure beyond what Docker & Docker Compose provide.

Alternative solutions you might consider:

* the historical [Heroku deployment guide](https://github.com/compdemocracy/polis/wiki/Deploying-with-Heroku)
* there has been some preliminary work to [run Polis using Kubernetes](https://github.com/compdemocracy/polis/pull/1399) (most of the remaining work has to do with [configuration](https://github.com/compdemocracy/polis/pull/1341))

These are alternative deployment approaches to evaluate against the actual service requirements; the links are historical context, not a statement of current hosting or supported capacity.
That having been said, we'd like to be able to [support scalable deployments out of the box](https://github.com/compdemocracy/polis/issues/1352), and are happy to accept pull requests which get us closer to this goal.

With all that out of the way, deploying a small Polis instance using the docker-compose infrastructure looks more or less like the development environment setup below, with one exception: Instead of running `docker compose -f docker-compose.yml -f docker-compose.dev.yml ...`, you run `docker compose -f docker-compose.yml ...` (or simply `docker compose`, since `-f` defaults to `docker-compose.yml`).
The development overlay contains development-specific settings, but simply omitting it is not a complete production configuration. Review [Makefile profile/overlay selection](../Makefile#L19), [TLS](ssl.md), and [deployment configuration](deployment-configuration.md).


## Provisioning compute power for the math worker

Regardless of which method you use above, you'll need to make sure that you provision a large enough node for the math worker to do it's business effectively.

For many simultaneous conversations, increasing the number of cores available will improve overall throughput.
For large conversations, you'll also need to consider how much RAM is available to process the data.

Keep in mind that the Polis vote matrix has dimensions `p * c`, where `c` is the number of comments, and `p` is the number of participants, and the amount of memory required to process a conversation grows proportional to this (and computational time increases with higher `c`).
For larger conversations with tens of thousands of participants and thousands of comments, you may need in the dozens of GB of RAM available.

Unfortunately, scaling the size of a worker node is not typically very easy, but this is where more advanced solutions such as Kubernetes could potentially provide additional value.


</br>

## Current CDK capacity reference

These are checked-in CDK defaults at source snapshot `0985a1a58`; they do not establish the capacity currently deployed. Environment and service inputs are in [deployment configuration](deployment-configuration.md).

| Tier | Instance type | Minimum / desired / maximum | Source |
| --- | --- | --- | --- |
| Web | `t3.medium` | 2 / 2 / 10 | [instance type](../cdk/ec2.ts#L3), [ASG](../cdk/autoscaling.ts#L46) |
| Clojure math | `r8g.2xlarge` | 1 / 1 / 1 | [instance type](../cdk/ec2.ts#L8), [ASG](../cdk/autoscaling.ts#L57) |
| Delphi small | `c7i.2xlarge` | 1 / 1 / 7 | [instance type](../cdk/ec2.ts#L14), [ASG](../cdk/autoscaling.ts#L72) |
| Delphi large | `c7i.8xlarge` | 0 / 0 / 3 | [instance type](../cdk/ec2.ts#L20), [ASG](../cdk/autoscaling.ts#L90) |
| Ollama, when enabled | `g4dn.xlarge` | 1 / 1 / 3 | [instance type](../cdk/ec2.ts#L26), [ASG](../cdk/autoscaling.ts#L26) |

Ollama infrastructure is off by default via `CDK_ENABLE_OLLAMA`; see [entry point](../cdk/bin/cdk.ts#L39). Delphi CPU target tracking targets 60%; the separate high-CPU alarm threshold is 80%. Those are not symmetric scale-in/scale-out thresholds. See [scaling policy and alarms](../cdk/autoscaling.ts#L129).

The legacy math ASG is capped at one because another instance would repeat work and writes. The Python poller validates explicit shard index/count settings; it is not made safely parallel merely by duplicating the container. See [math cap](../cdk/autoscaling.ts#L62) and [Python shard validation](../delphi/polismath/poller/service.py#L201).

Delphi's worker classification still sends conversations above 5,000 comments to the large class. A large-tier desired capacity of zero therefore matters to routing; see [job classification](../delphi/scripts/job_poller.py#L696). The import-worker ECS service has desired count zero and separate queue-based scaling rules in [import-worker-service](../cdk/lib/import-worker-service.ts#L93).
