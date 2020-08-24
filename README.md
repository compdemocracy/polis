# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Nightly Docker Builds](https://github.com/pol-is/polisServer/workflows/Nightly%20Docker%20Builds/badge.svg)][nightlies]
[![E2E Tests](https://github.com/pol-is/polisServer/workflows/E2E%20Tests/badge.svg)][e2e-tests]
[![All Contributors](https://img.shields.io/github/all-contributors/pol-is/polis/all-contributors-redux)](#-contributors)

   [nightlies]: https://hub.docker.com/u/polisdemo
   [e2e-tests]: https://github.com/pol-is/polisServer/actions?query=workflow%3A%22E2E+Tests%22

## :construction: Disclaimer

- The documentation and configuration in this code repository is **for development ONLY**,
and emphatically **NOT intended for production deployment**.
- We do NOT make guarantees of easy setup or management, push-button deployment, security,
firm development timelines, technical support, future migration paths, data integrity,
existence of bugs, or completeness of existing features.
All of the above is actively in flux on `dev` branch.
- Work in the issue queue and codebase is being done in part by passionate volunteer contributors.
They will often be experimenting with unproven project infrastructure that is unsupported by the Polis organization,
e.g. pre-built docker images.
- See also: [Deployment: About SSL/HTTPS](docs/deployment.md#about-sslhttps)

Having said this, we are enthusiastic about your support in moving toward deployment-readiness.
We aspire to see future third-party deployments of polis as we cultivate a growing community of diverse contributors!
We look forward to working together :tada:

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

## ✨ Contributors

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tr>
    <td align="center"><a href='https://sudo-science.com/'><img src='https://avatars0.githubusercontent.com/u/35609?v=4?s=100' width='100px;' alt=''/><br /><sub><b>Benjamin Rosas</b></sub></a></td>
    <td align="center"><a href='http://www.metasoarous.com/'><img src='https://avatars3.githubusercontent.com/u/88556?v=4?s=100' width='100px;' alt=''/><br /><sub><b>Christopher Small</b></sub></a></td>
    <td align="center"><a href='https://pol.is/'><img src='https://avatars3.githubusercontent.com/u/1770265?v=4?s=100' width='100px;' alt=''/><br /><sub><b>Colin Megill</b></sub></a></td>
    <td align="center"><a href='http://nodescription.net/'><img src='https://avatars2.githubusercontent.com/u/305339?v=4?s=100' width='100px;' alt=''/><br /><sub><b>Patrick Connolly</b></sub></a></td>
    <td align="center"><a href='https://github.com/misscs'><img src='https://avatars1.githubusercontent.com/u/51812?v=4?s=100' width='100px;' alt=''/><br /><sub><b>cs</b></sub></a></td>
    <td align="center"><a href='https://github.com/mbjorkegren'><img src='https://avatars3.githubusercontent.com/u/2016166?v=4?s=100' width='100px;' alt=''/><br /><sub><b>mbjorkegren</b></sub></a></td>
    <td align="center"><a href='http://sais.tw/'><img src='https://avatars3.githubusercontent.com/u/2368060?v=4?s=100' width='100px;' alt=''/><br /><sub><b>蔡仲明 (Romulus Urakagi Tsai)</b></sub></a></td>
  </tr>
</table>

<!-- markdownlint-enable -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!
