

# Scaling Polis

The [⚡ Running Polis](/#-running-polis) instructions in the main README set up a system with only a single running instance of the polis-server container.
For very small engagements of a few hundred participants, this may be sufficient.
But for even moderate scale in terms of size and number of concurrent conversations, it will be necessary to run multiple polis-server instances to handle the number of web requests.

## Scaling approaches

#### On a single machine

The simplest way to do this is to run `docker compose up` with option `--scale polis-server=N`.
Typically, this would be run on a single machine, and thus for even moderate scale requires that the machine being deployed on have room to accomodate running a large number of containers, and an active math worker.
This complicates the process of adjusting in real time to changing demand in a cost and resource effective manner.

For small to medium size deployments with rather steady or predictable participation rates, this may be a tenable solution.
But for deployments which expect exceptionally high, uneven and/or unpredictable participation rates, it may prove too costly in terms of computational and operations personele resources.

#### Docker Compose over Docker Swarm

Docker Compose is now supposed to be able to deploy to swarm environments (such as AWS, Azure or Google) via Docker Swarm.
We have not yet tested this or fully explored it's limitations, but recommend this as the first option to consider if running Polis on a single machine is not tenable for you.

What's most uncertain at present is whether it will be possible to automatically scale servers based on demand.
However, once Docker Compose has been set up to run on Docker Cloud, you should be able to scale server nodes quickly with `docker compose --scale polis-server=N`.

**Note**: this functionality is not supported in the deprecated `docker-compose` tool (see description in previous section), but will require you to use `docker compose`.

#### Scaling to the limits

For Polis to scale  it's most performant potential, you may need to consider additional infrastructure beyond what Docker & Docker Compose provide.

Alternative solutions you might consider:

* we presently [deploy with Heroku](https://github.com/compdemocracy/polis/wiki/Deploying-with-Heroku) 
* there has been some preliminary work to [run Polis using Kubernetes](https://github.com/compdemocracy/polis/pull/1399) (most of the remaining work has to do with [configuration](https://github.com/compdemocracy/polis/pull/1341))

These solutions will allow you to take advantage of the underlying Docker infrastructure, sans Docker Compose.
That having been said, we'd like to be able to [support scalable deployments out of the box](https://github.com/compdemocracy/polis/issues/1352), and are happy to accept pull requests which get us closer to this goal.

With all that out of the way, deploying a small Polis instance using the docker-compose infrastructure looks more or less like the development environment setup below, with one exception: Instead of running `docker compose -f docker-compose.yml -f docker-compose.dev.yml ...`, you run `docker compose -f docker-compose.yml ...` (or simply `docker compose`, since `-f` defaults to `docker-compose.yml`).
Any configuration options which are explicitly for development are placed in the `docker-compose.dev.yml` overlay, and can be omitted in production.


## Provisioning compute power for the math worker

Regardless of which method you use above, you'll need to make sure that you provision a large enough node for the math worker to do it's business effectively.

For many simultaneous conversations, increasing the number of cores available will improve overall throughput.
For large conversations, you'll also need to consider how much RAM is available to process the data.

Keep in mind that the Polis vote matrix has dimensions `p * c`, where `c` is the number of comments, and `p` is the number of participants, and the amount of memory required to process a conversation grows proportional to this (and computational time increases with higher `c`).
For larger conversations with tens of thousands of participants and thousands of comments, you may need in the dozens of GB of RAM available.

Unfortunately, scaling the size of a worker node is not typically very easy, but this is where more advanced solutions such as Kubernetes could potentially provide additional value.


</br>
