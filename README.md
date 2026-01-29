# Polis

Polis is an AI powered sentiment gathering platform. More organic than surveys and less effort than focus groups.

For a detailed methods paper, see [Polis: Scaling Deliberation by Mapping High Dimensional Opinion Spaces][methods-paper].

   [methods-paper]: https://www.e-revistes.uji.es/index.php/recerca/article/view/5516/6558

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![DPG Badge](https://img.shields.io/badge/Verified-DPG-3333AB?logo=data:image/svg%2bxml;base64,PHN2ZyB3aWR0aD0iMzEiIGhlaWdodD0iMzMiIHZpZXdCb3g9IjAgMCAzMSAzMyIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTE0LjIwMDggMjEuMzY3OEwxMC4xNzM2IDE4LjAxMjRMMTEuNTIxOSAxNi40MDAzTDEzLjk5MjggMTguNDU5TDE5LjYyNjkgMTIuMjExMUwyMS4xOTA5IDEzLjYxNkwxNC4yMDA4IDIxLjM2NzhaTTI0LjYyNDEgOS4zNTEyN0wyNC44MDcxIDMuMDcyOTdMMTguODgxIDUuMTg2NjJMMTUuMzMxNCAtMi4zMzA4MmUtMDVMMTEuNzgyMSA1LjE4NjYyTDUuODU2MDEgMy4wNzI5N0w2LjAzOTA2IDkuMzUxMjdMMCAxMS4xMTc3TDMuODQ1MjEgMTYuMDg5NUwwIDIxLjA2MTJMNi4wMzkwNiAyMi44Mjc3TDUuODU2MDEgMjkuMTA2TDExLjc4MjEgMjYuOTkyM0wxNS4zMzE0IDMyLjE3OUwxOC44ODEgMjYuOTkyM0wyNC44MDcxIDI5LjEwNkwyNC42MjQxIDIyLjgyNzdMMzAuNjYzMSAyMS4wNjEyTDI2LjgxNzYgMTYuMDg5NUwzMC42NjMxIDExLjExNzdMMjQuNjI0MSA5LjM1MTI3WiIgZmlsbD0id2hpdGUiLz4KPC9zdmc+Cg==)](https://digitalpublicgoods.net/r/polis)
[![Docker Image Builds](https://github.com/compdemocracy/polis/workflows/Docker%20image%20builds/badge.svg)][docker-image-builds]
[![E2E Tests](https://github.com/compdemocracy/polis/workflows/E2E%20Tests/badge.svg)][e2e-tests]

   [docker-image-builds]: https://hub.docker.com/u/compdem
   [e2e-tests]: https://github.com/compdemocracy/polis/actions?query=workflow%3A%22E2E+Tests%22

---

## 🎈 🪁 Start here! 🪁 🎈

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
   [discussions]: https://github.com/compdemocracy/polis/discussions
   [hello]: mailto:hello@compdemocracy.org

If you're trying to set up a Polis deployment or development environment, then please read the rest of this document 👇 ⬇️ 👇

---

## ⚡ Running Polis

Polis comes with Docker infrastructure for running a complete system, whether for a [production deployment](#-production-deployment) or a [development environment](#-development-tooling) (details for each can be found in later sections of this document).
As a consequence, the only prerequisite to running Polis is that you install a recent `docker` (and Docker Desktop if you are on Mac or Windows).

If you aren't able to use Docker for some reason, the various Dockerfiles found in subdirectories (`math`, `server`, `delphi`, `*-client`) of this repository _can_ be used as a reference for how you'd set up a system manually.
If you're interested in doing the legwork to support alternative infrastructure, please [let us know in an issue](https://github.com/compdemocracy.org/issues).

### Quick Start

#### 1. Install and Configure SSL Certificates

Polis uses locally trusted SSL certificates for the OIDC authentication simulator. This is a one-time setup:

```sh
# Install mkcert (macOS with Homebrew)
brew install mkcert
brew install nss  # if you use Firefox

# Other platforms: https://github.com/FiloSottile/mkcert#installation
```

```sh
# Install the local Certificate Authority
mkcert -install

# Generate certificates for localhost
mkdir -p ~/.simulacrum/certs
cd ~/.simulacrum/certs
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal

# Copy the root CA certificate (needed for server-to-server communication)
cp "$(mkcert -CAROOT)/rootCA.pem" ~/.simulacrum/certs/
```

**Important**: After running `mkcert -install`, completely restart your browser to trust the certificates.

#### 2. Generate JWT Keys

Polis uses JWT keys for participant authentication. Generate them with:

```sh
make generate-jwt-keys
```

This creates `server/keys/jwt-private.pem` and `server/keys/jwt-public.pem`.

#### 3. Start Polis

```sh
cp example.env .env
make start
```

That should run docker compose with the development overlay (see below) and default configuration values.

You may encounter an error on mac if AirPlay receiver is enabled, which defaults to port 5000 and collides with Polis API_SERVER_PORT. You can change this in your `.env` file or disable AirPlay receiver in system settings.

Visit `localhost:80/createuser` and get started.

### Docker & Docker Compose

Newer versions of `docker` have `docker compose` built in as a subcommand.
If you are using an older version (and don't want to upgrade), you'll need to separately install `docker-compose`, and use that instead in the instructions that follow.
Note however that the newer `docker compose` command is required to [take advantage of Docker Swarm](/docs/scaling#docker-compose-over-docker-swarm) as a scaling option.

Many convenient commands are found in the Makefile. Run `make help` for a list of available commands.

### Building and running the containers

First clone the repository, then navigate via command line to the root directory and run the following command to build and run the docker containers.

Copy the example.env file and modify as needed (although it should just work as is for development and testing purposes).

```sh
cp example.env .env
```

```sh
docker compose --profile postgres --profile local-services up --build
```

If you get a permission error, try running this command with `sudo`.
If this fixes the problem, sudo will be necessary for all other commands as well.
To avoid having to use `sudo` in the future (on a Linux or Windows machine with WSL), [you can follow setup instructions here.](https://docs.docker.com/engine/install/linux-postinstall/)

Once you've built the docker images, you can run without `--build`, which may be faster. Run

```sh
docker compose --profile postgres --profile local-services up
```

or simply

```sh
make start
```

Any time you want to _rebuild_ the images, just reaffix `--build` when you run. Another way to
easily rebuild and start your containers is with `make start-rebuild`.

If you have only changed configuration values in .env, you can recreate your containers without
fully rebuilding them with `--force-recreate`. For example:

```sh
docker compose --profile postgres --profile local-services down
docker compose --profile postgres --profile local-services up --force-recreate
```

To see what the environment of your containers is going to look like, run:

```sh
docker compose --profile postgres --profile local-services convert
```

#### Using a local or remote (non-docker) database

Omit the `--profile postgres` flag to use a local or remote database. You will need to set the `DATABASE_URL` environment variable in your `.env` file to point to your database.

When using `make` commands, setting POSTGRES_DOCKER to `true` or `false` will determine whether to automatically include `--profile postgres` when it calls out to `docker compose`.

#### Production Mode Shortcuts

The commands in the Makefile can be prefaced with PROD. If so, the "dev overlay" configuration in `docker-compose.dev.yml` will be ignored.
Ports from services other than the HTTP proxy (80/443) will not be exposed. Containers will not mount local directories, watch for changes,
or rebuild themselves. In theory this should be one way to run Polis in a production environment.

You need a `prod.env` file:

`cp example.env prod.env` (and update accordingly).

Then you can run things like:

```sh
make PROD start

make PROD start-rebuild
```

### Running without Local Cloud Service Emulators

If you want to run the stack without the local MinIO and DynamoDB services (e.g., to test connecting to real AWS services configured in your .env file), simply omit the --profile local-services flag.

Example: Run with the containerized DB but connect to external/real cloud services:

```sh
docker compose --profile postgres up
```

Example: Run with an external DB and external/real cloud services (closest to production):

```sh
docker compose up
```

### Testing out your instance

You can now test your setup by visiting `http://localhost:80/home`.

#### Using Predefined Test Accounts

When running with `make start` or the development configuration, an OIDC Simulator automatically starts with predefined test users. You can log in immediately using:

- **Email**: `admin@polis.test`
- **Password**: `Te$tP@ssw0rd*`

Additional test users are available:

- `moderator@polis.test` / `Te$tP@ssw0rd*`
- `test.user.0@polis.test` through `test.user.49@polis.test` (all with password `Te$tP@ssw0rd*`)

Due to limitations of the OIDC Simulator, you cannot register new admin users in development and test environments.

#### Shutting down

When you're done working, you can end the process using `Ctrl+C`, or typing `docker compose --profile postgres --profile local-services down`
if you are running in "detached mode".

### Updating the system

If you want to update the system, you may need to handle the following:

- [⬆️ Run database migrations](docs/migrations.md), if there are new such
- Update docker images by running with `--build` if there have been changes to the Dockerfiles
  - consider using `--no-cache` if you'd like to rebuild from scratch, but note that this will take much longer

---

## 🚀 Production deployment

While the commands above will get a functional Polis system up and running, additional steps must be taken to properly configure, secure and scale the system.
In particular

- [⚙️ Configure the system](docs/configuration.md), esp:
  - the domain name you'll be serving from
  - enable and add API keys for 3rd party services (e.g. automatic comment translation, spam filtering, etc)
- [🔏 Set up SSL/HTTPS](docs/ssl.md), to keep the site secure
- [📈 Scale](docs/scaling.md) for large or many concurrent conversations

### Support

We encourage you to take advantage of the public channels above for support setting up a deployment.
However, if you are deploying in a high impact context and need help, please [reach out to us][hello]

---

## 💻 Development tooling

Once you've gotten [Polis running (as described above)](#-running-polis), you can enable developer conveniences by running

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up
```

(run with `--build` if this is your first time running, or if you need to rebuild containers)

This enables:

- Live code reloading and static type checking of the server code
- A nREPL connection port open for connecting to the running math process
- Ports open for connecting directly to the database container
- Live code reloading for the client repos (in process)
- etc.

This command takes advantage of the `docker-compose.dev.yml` _overlay_ file, which layers the developer conveniences describe above into the base system, as described in the `docker-compose.yml` file.
You can specify these `-f docker-compose.yml -f docker-compose.dev.yml` arguments for any `docker` command which you need to take advantage of these features (not just `docker compose --profile postgres up`).

You can create your own `docker-compose.x.yml` file as an overlay and add or modify any values you need to differ
from the defaults found in the `docker-compose.yml` file and pass it as the second argument to the `docker compose -f` command above.

### Testing

We use Cypress for automated, end-to-end browser testing for PRs on GitHub (see badge above).
Please see [`e2e/README.md`](/e2e/README.md) for more information on running these tests locally.

### Miscellaneous & troubleshooting

#### Docker Problems

A lot of issues might be resolved by killing all docker containers and/or restarting docker entirely. If that doesn't
work, this will wipe all of your polis containers and volumes (**INCLUDING THE DATABASE VOLUME, so don't use this in prod!**) and completely rebuild them:

`make start-FULL-REBUILD`

see also `make help` for additional commands that might be useful.

#### Git Configuration

Due to past file re-organizations, you may find the following git configuration helpful for looking at history:

```sh
git config --local include.path ../.gitconfig
```

#### Running as a background process

If you would like to run docker compose as a background process, run the `up` commands with the `--detach` flag, and use `docker compose --profile postgres --profile local-services down` to stop.

#### Using Docker Machine as your development environment

If your development machine is having trouble handling all of the docker containers, look into [using Docker Machine](/docs/docker-machine.md).

#### Resolving problems with npm not finding libraries

Sometimes npm/docker get in a weird state, especially with native libs, and fail to recover gracefully.
You may get a message like `Error: Cannot find module .... bcrypt`.

If this happens to you, try
[following the instructions here.](https://github.com/compdemocracy/polis/issues/1391)

#### Issues with Apple Silicon (M1 & M2) chips

You may find it necessary to install some dependencies, namely nodejs and postgres stuff, in a [Rosetta terminal](https://support.apple.com/en-us/HT211861). Create an issue or reach out if you are having strange build issues on Apple computers.

## ©️  License

[AGPLv3 with additional permission under section 7](/LICENSE)
