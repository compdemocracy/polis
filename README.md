# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Nightly Docker Builds](https://github.com/pol-is/polisServer/workflows/Nightly%20Docker%20Builds/badge.svg)][nightlies]
[![E2E Tests](https://github.com/pol-is/polisServer/workflows/E2E%20Tests/badge.svg)][e2e-tests]

   [nightlies]: https://hub.docker.com/u/polisdemo
   [e2e-tests]: https://github.com/pol-is/polisServer/actions?query=workflow%3A%22E2E+Tests%22

## Demos version
This fork of Polis is in development by Demos, and will differ from the main branch - for example through changes to hard-coded URLs and some tweaks to the conversation between the math and database servers. Functionality currently remain similar to that on the dev branch, so we would suggest building from there where the community below can support you - but as we develop our own features they will be documented here! 

## 🙋🏾‍♀️ Get Involved

1. Say hi in one of our **chat rooms** :speech_balloon:
    - 🦸🏼 General [`gitter.im/pol-is/polis-community`][chat]
    - 👩🏿‍💻 Software Development [`gitter.com/pol-is/polisDeployment`][chat-dev]
2. Join one of our weekly **open calls** :microphone:
    - Please please please... Newcomers welcome! [Learn more...][calls-about]
3. Visit our [**issue tracker**][issues] [:white_check_mark:][issues] to offer your skills & energies
    - We also keep a [project kanban board][board] [:checkered_flag:][board]
    - :ear: Pssssst! [Learn how...][contributing] (labels, etc.)

   [chat]: https://gitter.im/pol-is/polis-community
   [chat-dev]: https://gitter.im/pol-is/polisDeployment
   [calls-about]: /CONTRIBUTING.md#telephone_receiver-open-calls
   [issues]: https://github.com/pol-is/polisServer/issues
   [board]: https://github.com/orgs/pol-is/projects/1
   [contributing]: /CONTRIBUTING.md#how-we-work

## 💻 Development

Recommendations: Docker-Machine (on [DigitalOcean with 2GB memory][do-tut])

   [do-tut]: https://www.digitalocean.com/community/tutorials/how-to-provision-and-manage-remote-docker-hosts-with-docker-machine-on-ubuntu-16-04


### Running with docker-compose:

Before running docker-compose up for the first time,
either do a pull (faster):

`docker-compose pull`

or do a build (to utilize recent or local changes):

`docker-compose up --build --detach`

subsequently you should only need to run:

`docker-compose up --detach`

To force a full re-build with no cache from previous builds:
`docker-compose build --parallel --no-cache`

And to stop:
`docker-compose down`

_(or Ctrl+C if you did not run with --detach)_

### check your ip (only necessary on docker-machine):
```
docker-machine ip
>>> 123.45.67.89
```

Visit your instance at: `http://123.45.67.89.xip.io/`

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

Please see [`e2e/README.md`](/e2e/README.md).

## 🚀 Deployment

Please see [`docs/deployment.md`](/docs/deployment.md)

## ©️  License

[AGPLv3 with additional permission under section 7](/LICENSE)
