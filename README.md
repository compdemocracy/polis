# Polis

Polis is an AI powered sentiment gathering platform. More organic than surveys and less effort than focus groups, Polis meets the basic human need to be understood, at scale.

For a detailed methods paper, see [Polis: Scaling Deliberation by Mapping High Dimensional Opinion Spaces][methods-paper].

   [methods-paper]: https://www.e-revistes.uji.es/index.php/recerca/article/view/5516/6558

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Docker Image Builds](https://github.com/compdemocracy/polis/workflows/Docker%20image%20builds/badge.svg)][docker-image-builds]
[![E2E Tests](https://github.com/compdemocracy/polis/workflows/E2E%20Tests/badge.svg)][e2e-tests]

   [docker-image-builds]: https://hub.docker.com/u/compdem
   [e2e-tests]: https://github.com/compdemocracy/polis/actions?query=workflow%3A%22E2E+Tests%22

<br/>


### 🎈 🪁 Start here! 🪁 🎈

If you're interested in using or contributing to Polis, please see the following:
- [📚 **knowledge base**][knowledge-base]: for a comprehensive wiki to help you understand and use the system
- [🌐 **main deployment**](https://pol.is): the main deployment of Polis is at <https://pol.is>, and is
  free to use for nonprofits and government
- [💬 **discussions**][discussions]: for questions (QA) and discussion
- [✔️ **issues**][issues]: for well-defined technical issues
- [🏗️ **project board**][board]: somewhat incomplete, but still useful; We stopped around the time that Projects Beta came out, and we have a [Projects Beta Board][beta-board] that we'll eventually be migrating to
- [✉️ reach out][hello]: if you are applying Polis in a high-impact context, and need more help than you're able to get through the public channels above

   [knowledge-base]: https://compdemocracy.org/Welcome
   [issues]: https://github.com/compdemocracy/polis/issues
   [board]: https://github.com/compdemocracy/polis/projects/1
   [beta-board]: https://github.com/compdemocracy/polis/projects/1
   [contributing]: /CONTRIBUTING.md#how-we-work
   [discussions]: https://github.com/compdemocracy/polis/discussions
   [hello]: mailto:hello@compdemocracy.org

If you're trying to set up a Polis deployment or development environment, then please read the rest of this document 👇 ⬇️ 👇



</br></br></br>



## ⚡ Running Polis

Polis comes with Docker infrastructure for running a complete system, whether for a [production deployment](#-production-deployment) or a [development environment](#-development-tooling) (details for each can be found in later sections of this document).
As a consequence, the only prerequisite to running Polis is that you install a recent `docker` (and Docker Desktop if you are on Mac).

If you aren't able to use Docker for some reason, the various `Dockerfile`s found in subdirectories (`math`, `server`, `*-client`) of this repository _can_ be used as a reference for how you'd set up a system manually.
If you're interested in doing the legwork to support alternative infrastructure, please [let us know in an issue](https://github.com/compdemocracy.org/issues).

### Docker & Docker Compose

Newer versions of `docker` have `docker compose` built in as a subcommand.
If you are using an older version (and don't want to upgrade), you'll need to separately install `docker-compose`, and use that instead in the instructions that follow.
Note however that the newer `docker compose` command is required to [take advantage of Docker Swarm](/docs/scaling#docker-compose-over-docker-swarm) as a scaling option.

### Building and running the containers

First clone the repository, then navigate via command line to the root directory and run the following command to build and run the docker containers.

```sh
docker compose up --build
```

If you get a permission error, try running this command with `sudo`.
If this fixes the problem, sudo will be necessary for all other commands as well.
To avoid having to use `sudo` in the future (on a Linux or Windows machine with WSL), you can follow setup instruction here: <https://docs.docker.com/engine/install/linux-postinstall/>.

Once you've built the docker images, you can run without `--build`, which may be faster.
Simply:

```sh
docker compose up
```

Any time you want to _rebuild_ the images, just reaffix `--build` when you run.

### Testing out your instance

You can now test your setup by visiting `http://localhost:80/home`.

Once the index page loads, you can create an account using the `/createuser` path.
You'll be logged in right away; email validation is not required.

When you're done working, you can end the process using `Ctrl+C`.

### Updating the system

If you want to update the system, you may need to handle the following:
* [⬆️ Run database migrations](docs/migrations.md), if there are new such
* Update docker images by running with `--build` if there have been changes to the Dockerfiles
  * consider using `--no-cache` if you'd like to rebuild from scratch, but note that this will take much longer



</br>

## 🚀 Production deployment

While the commands above will get a functional Polis system up and running, additional steps must be taken to properly configure, secure and scale the system.
In particular

* [⚙️ Configure the system](docs/configuration.md), esp:
  * the domain name you'll be serving from
  * enable and add API keys for 3rd party services (e.g. automatic comment translation, spam filtering, etc)
* [🔏 Set up SSL/HTTPS](docs/ssl.md), to keep the site secure
* [📈 Scale](docs/scaling.md) for large or many concurrent conversations

#### Support

We encourage you to take advantage of the public channels above for support setting up a deployment.
However, if you are deploying in a high impact context and need help, please [reach out to us][hello]

</br>



## 💻 Development tooling

Once you've gotten [Polis running (as described above)](#-running-polis), you can enable developer conveniences by running

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

(run with `--build` if this is your first time running, or if you need to rebuild containers)

This enables:
* Live code reloading and static type checking of the server code
* A nREPL connection port open for connecting to the running math process
* Ports open for connecting directly to the database container
* Live code reloading for the client repos (in process)
* etc.

This command takes advantage of the `docker-compose.dev.yml` _overlay_ file, which layers the developer conveniences describe above into the base system, as described in the `docker-compose.yml` file.
You can specify these `-f docker-compose.yml -f docker-compose.dev.yml` arguments for any `docker` command which you need to take advantage of these features (not just `docker compose up`).

### Testing

We use Cypress for automated, end-to-end browser testing for PRs on GitHub (see badge above).
Please see [`e2e/README.md`](/e2e/README.md) for more information on running these tests locally.

### Miscellaneous & troubleshooting

#### Git Configuration

Due to past file re-organizations, you may find the following git configuration helpful for looking at history:

```
git config --local include.path ../.gitconfig
```

#### Running as a background process

If you would like to run docker compose as a background process, run the `up` commands with the `--detach` flag, and use `docker compose down` to stop.

#### Using Docker Machine as your development environment

If your development machine is having trouble handling all of the docker containers, look into [using Docker Machine](/docs/docker-machine.md).

#### Resolving problems with npm not finding libraries

Sometimes npm/docker get in a weird state, especially with native libs, and fail to recover gracefully.
You may get a message like `Error: Cannot find module .... bcrypt`.

If this happens to you, try following the instructions here: 

https://github.com/compdemocracy/polis/issues/1391


## ©️  License

[AGPLv3 with additional permission under section 7](/LICENSE)
