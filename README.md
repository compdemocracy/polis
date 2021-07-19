# Polis
Polis is an AI powered sentiment gathering platform. More organic than surveys and less effort than focus groups, Polis meets a basic human need to be understood, at scale.

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Docker Image Builds](https://github.com/compdemocracy/polis/workflows/Docker%20image%20Builds/badge.svg)][docker-image-builds]
[![E2E Tests](https://github.com/compdemocracy/polis/workflows/E2E%20Tests/badge.svg)][e2e-tests]

   [nightlies]: https://hub.docker.com/u/compdem
   [e2e-tests]: https://github.com/compdemocracy/polis/actions?query=workflow%3A%22E2E+Tests%22

## :construction: Disclaimer

The installation instructions below are currently focused on setting up a **development environment**.
These instructions should **NOT** be considered sufficient for _production_ deployment without additional setup.
We do **NOT** make guarantees of easy setup or management, push-button deployment, security, technical support, future migration paths, data integrity, etc.

Having said this, some of the core pieces of infrastructure described below are potentially useful in a production context, if used correctly.
In particular, each subdirectory of the project has its own `Dockerfile` which could potentially be used as part of a deploy strategy.
The `docker-compose.yml` is currently focused on development environment, but will soon transition to being production focused, with development conveniences extracted as a separate compose file.

- See also: [Deployment: About SSL/HTTPS](docs/deployment.md#about-sslhttps)

If you'd like to set up your own deployment of Polis, we encourage your to [reach out to us](mailto:hello@compdemocracy.org) for support.
We look forward to working together :tada:


## 🙋🏾‍♀️ Get Involved

If you're interested in contributing to the codebase, please see the following:
- [:white_check_mark:][issues] [**issues**][issues]: for well-defined technical issues
- [:speech_balloon:][discussions] [**discussions**][discussions]: for questions about the software, or more open ended ideas and conversation which don't properly fit in issues (to be clear, not technical support)
- [:speech_balloon:][chat-dev] [**chat**][chat-dev]: if you're interested in connecting with other developers to get orientation around the project
- more to come soon, hopefully (including kanban board and orientation documentation)!

   [chat-dev]: https://gitter.im/pol-is/polisDeployment
   [issues]: https://github.com/compdemocracy/polis/issues
   [board]: https://github.com/orgs/compdemocracy/projects/1
   [contributing]: /CONTRIBUTING.md#how-we-work
   [discussions]: https://github.com/compdemocracy/polis/discussions

## 💻 Development

If you have a small machine or little hard drive space, you may want to consider running the below with Docker-Machine ([DigitalOcean with 2GB memory][do-tut] should be sufficient)

   [do-tut]: https://www.digitalocean.com/community/tutorials/how-to-provision-and-manage-remote-docker-hosts-with-docker-machine-on-ubuntu-16-04


### Running with docker-compose:

Before running docker-compose up for the first time:

After cloning, navigate via command line to the root of this repository.

Next, either do a pull (faster):

`docker-compose pull`

If you get a permission error, try running `sudo docker-compose pull`, and sudo will be necessary for all other commands as well. To avoid having to run `sudo` in the future, you can follow setup instruction here: https://docs.docker.com/engine/install/linux-postinstall/

or do a build (to utilize recent or local changes):

`docker-compose up --build`

once you've either pulled or built, you can run the following when you want to run the project:

`docker-compose up`

To force a full re-build with no cache from previous builds:
`docker-compose build --parallel --no-cache`

You can end the process using `Ctrl+C`

###### Running as a background process

If you would like to run docker compose as a background process, run the `up` commands with the `--detach` flag, e.g.,: 

`docker-compose up --detach`

And to stop:
`docker-compose down`

### check your ip (only necessary on docker-machine):
```
docker-machine ip
>>> 123.45.67.89
```

Visit your instance at: `http://123.45.67.89.sslip.io/`

Or visit a native docker instance at `http://localhost:80/`

Sign up at `/createuser` path. You'll be logged in right away; no email validation required!

**What features still need work?**
- ~~Generated reports~~
- Data export [`polis-issues#137`](https://github.com/pol-is/polis-issues/issues/137)

**Note:** Due to past file re-organizations, you may find the following git configuration helpful for looking at history:

```
git config --local include.path ../.gitconfig
```

## 🔍 Testing

We use Cypress for automated, end-to-end browser testing! (See badge above.)

Please see [`e2e/README.md`](/e2e/README.md) and [`CONTRIBUTING.md`](/CONTRIBUTING.md#running-e2e-tests).

## 🚀 Deployment

Please see [`docs/deployment.md`](/docs/deployment.md)

## ©️  License

[AGPLv3 with additional permission under section 7](/LICENSE)
