# Polis

Polis is an AI powered sentiment gathering platform. More organic than surveys and less effort than focus groups, Polis meets the basic human need to be understood, at scale.

For a detailed methods paper, see [Polis: Scaling Deliberation by Mapping High Dimensional Opinion Spaces][methods-paper].

   [methods-paper]: https://www.e-revistes.uji.es/index.php/recerca/article/view/5516/6558

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Docker Image Builds](https://github.com/compdemocracy/polis/workflows/Docker%20image%20builds/badge.svg)][docker-image-builds]
[![E2E Tests](https://github.com/compdemocracy/polis/workflows/E2E%20Tests/badge.svg)][e2e-tests]

   [docker-image-builds]: https://hub.docker.com/u/compdem
   [e2e-tests]: https://github.com/compdemocracy/polis/actions?query=workflow%3A%22E2E+Tests%22



## 🙋🏾‍♀️ Get Involved

If you're interested in contributing to the codebase, please see the following:
- [:white_check_mark:][issues] [**issues**][issues]: for well-defined technical issues
- [:speech_balloon:][discussions] [**discussions**][discussions]: for questions about the software, or more open ended ideas and conversation which don't properly fit in issues
- Our [Project Board][board] is somewhat incomplete, but still useful; We stopped around the time that Projects Beta came out, and we have a [Projects Beta Board][beta-board] that we'll eventually be migrating to

   [issues]: https://github.com/compdemocracy/polis/issues
   [board]: https://github.com/orgs/compdemocracy/projects/1
   [beta-board]: https://github.com/orgs/compdemocracy/projects/1
   [contributing]: /CONTRIBUTING.md#how-we-work
   [discussions]: https://github.com/compdemocracy/polis/discussions


## 🚀 Deployment

The recommended path for deploying Polis is to use the Docker & Docker Compose infrastructure contained in this repository.
In particular, the `./docker-compose.yml` file describes a basic Polis topology sufficient for relatively small deployments.

The main limitation of this setup is that it only provisions a single server node, while a very active Polis conversation of tends of thousands of participants (or several smaller simultaneous sized conversations) could require multiple server nodes.
Thus, you may need to look into alternative solutions ([Heroku](https://github.com/compdemocracy/polis/wiki/Deploying-with-Heroku), Kubernetes, etc.) if you expect to exceed this level of usage.
In either case, you can take advantage of the underlying Docker infrastructure, sans docker-compose (see [the wiki for info on how to run on Heroku](https://github.com/compdemocracy/polis/wiki/Deploying-with-Heroku)).
That having been said, it is our goal to [support scalable deployments out of the box](https://github.com/compdemocracy/polis/issues/1352), and we'd be happy to accept pull requests which get us closer to this goal.

The one additional piece you'll need to handle yourself for a production deployment is SSL encryption.
Our goal is to streamline this as much as possible (see [#289](https://github.com/compdemocracy/polis/issues/289)), so again if you'd like to help with this, please submit a PR!

- See also: [Deployment: About SSL/HTTPS](docs/deployment.md#about-sslhttps)

With all that out of the way, deploying a small Polis instance using the docker-compose infrastructure looks more or less like the development environment setup below, with one exception: Instead of running `docker-compose -f docker-compose.yml -f docker-compose.dev.yml ...`, you run `docker-compose -f docker-compose.yml ...` (or simply `docker-compose`, since `-f` defaults to `docker-compose.yml`).
Any configuration options which are explicitly for development are placed in the `docker-compose.dev.yml` overlay, and can be omitted in production.

The doc at [`docs/deployment.md`](/docs/deployment.md) is currently somewhat out of date, but may provide additional useful details.

If you would like more help that you're able to get in the public channels above, we encourage your to [reach out to us](mailto:hello@compdemocracy.org).


## 💻 Development setup

The recommended way of setting up a development environment is to use `docker-compose`.
The only prerequisite is that you install `docker` (and Docker Desktop if you are on Mac).

Newer versions of `docker` have `docker compose` built in as a subcommand.
If you are using an older version (and don't want to upgrade), you'll need to separately install `docker-compose`.

### Building and running the containers

After cloning the repository, navigate via command line to the root directory and run the following command to build and run the docker containers:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

If you get a permission error, try running this command with `sudo`.
If this fixes the problem, sudo will be necessary for all other commands as well.
To avoid having to use `sudo` in the future (on a Linux or Windows machine with WSL), you can follow setup instruction here: https://docs.docker.com/engine/install/linux-postinstall/.

Once you've built, you can run the following when you want to run the project:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

That's it!

### Testing out your instance

You can now test your setup by visiting `http://localhost:80/`.

Once the index page loads, you can create an account using the `/createuser` path. You'll be logged in right away; email validation is not required.

### Configuration

The system should start running without any configuration.
However, as you go on (and especially if you are setting up a production deployment), you'll need to know how to configure the application.

At the moment, there are a number of configuration files and environment variable options scattered across the repository.
There _is_ currently an open PR which seeks to unify the configuration options which we're actively working on: https://github.com/compdemocracy/polis/pull/1341

### Scaling the polis server

If you plan on running a large conversations or lots of conversations at once,
you might bump into performance issues.

Assuming that the host has enough resources to run multiple instances of the
polis server container, you can start polis using the following command:

```sh
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up --scale server=3
```

Where `3` is the number of replicas you'd like to use.

### Kubernetes

**Warning:** This is work in progress and should not be used in production.

Under the `manifests` folder you can find a first version of polis running under
Kubernetes. It uses an in-cluster postegres as a stateful set, with a persistent
volume claim, and exposes the polis server using the cluster's ingress.

The setting of the ingress is not part of the provided resources as it will vary
between providers.

#### Todo

- [ ] Use official postgres image, decouple migrations
- [ ] Figure out and document the default resources for the services
- [ ] Document architecture, deployement, pitfalls, and best practices

### Notes

- Look for `polis.local` in the `manifests/*.yaml` and replace with your hostname

### Requirements

- Local development:
  - [Minikube](https://minikube.sigs.k8s.io/docs/)
  - [Skaffold](https://skaffold.dev/)

Skaffold deals with the local development flow, syncing updated files to their
in-cluster containers.

#### Running in Minikube

Start minikube, and enable the ingress and ingress-dns addons.

- `minikube start`
- `minikube addons enable ingress`
- `minikube addons enable ingress-dns`

You can now build and deploy the containers in the local cluster via either:

- `skaffold run` - Builds and deploys everything on demand.
- `skaffold dev` - While running will watch and automatically build and deploy
  updated containers.

The final part is to expose the nginx ingress to your local machine and connect
to it.

- `minikube tunnel` - You need to leave this running
- `open http://polis.local`

### Miscellaneous & troubleshooting

#### Git Configuration

Due to past file re-organizations, you may find the following git configuration helpful for looking at history:

```
git config --local include.path ../.gitconfig
```

#### Forcing a rebuild

To force a full re-build with no cache from previous builds you can run with `--no-cache`.

When you're done working, you can end the process using `Ctrl+C`.

#### Running as a background process

If you would like to run docker compose as a background process, run the `up` commands with the `--detach` flag, e.g.,: 

`docker-compose up --detach`

And to stop:
`docker-compose down`

#### Using Docker Machine as your development environment

https://github.com/compdemocracy/polis/wiki/Using-Docker-Machine-as-your-development-environment

#### 🔍 Testing

We use Cypress for automated, end-to-end browser testing! (See badge above.)

Please see [`e2e/README.md`](/e2e/README.md) and https://github.com/compdemocracy/polis/wiki/Running-E2E-tests-locally.

#### Resolving problems with npm not finding libraries

Sometimes npm/docker get in a weird state, especially with native libs, and fail to recover gracefully.
You may get a message like `Error: Cannot find module .... bcrypt`.

If this happens to you, try following the instructions here: 

https://github.com/compdemocracy/polis/issues/1391


## ©️  License

[AGPLv3 with additional permission under section 7](/LICENSE)
