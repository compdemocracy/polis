# Polis
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-14-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Nightly Docker Builds](https://github.com/pol-is/polisServer/workflows/Nightly%20Docker%20Builds/badge.svg)][nightlies]
[![E2E Tests](https://github.com/pol-is/polisServer/workflows/E2E%20Tests/badge.svg)][e2e-tests]

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

Having said this, we are enthusiastic about your support in moving toward deployment-readiness.
We aspire to see future third-party deployments of polis as we cultivate a growing community of diverse contributors!
We look forward to working together :tada:

## 🙋🏾‍♀️ Get Involved

1. Say hi in our **chat** [:speech_balloon:][chat] [`gitter.com/pol-is/polisDeployment`][chat]
2. Join one of our weekly **open calls** :microphone:
    - Please please please... Newcomers welcome! [Learn more...][calls-about]
3. Visit our [**issue tracker**][issues] [:white_check_mark:][issues] to offer your skills & energies
    - We also keep a [project kanban board][board] [:checkered_flag:][board]
    - :ear: Pssssst! [Learn how...][contributing] (labels, etc.)

   [chat]: https://gitter.im/pol-is/polisDeployment
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

## 🚀 Deployment

Please see [`docs/deployment.md`](/docs/deployment.md)

## ©️  License

[AGPLv3](/LICENSE)

## Contributors ✨

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tr>
    <td align="center"><a href="http://www.metasoarous.com"><img src="https://avatars3.githubusercontent.com/u/88556?v=4" width="100px;" alt=""/><br /><sub><b>Christopher Small</b></sub></a><br /><a href="https://github.com/pol-is-trial-balloon/polis/commits?author=metasoarous" title="Code">💻</a></td>
    <td align="center"><a href="https://pol.is"><img src="https://avatars3.githubusercontent.com/u/1770265?v=4" width="100px;" alt=""/><br /><sub><b>Colin Megill</b></sub></a><br /><a href="https://github.com/pol-is-trial-balloon/polis/commits?author=colinmegill" title="Code">💻</a> <a href="#fundingFinding-colinmegill" title="Funding Finding">🔍</a> <a href="#talk-colinmegill" title="Talks">📢</a></td>
    <td align="center"><a href="https://github.com/misscs"><img src="https://avatars1.githubusercontent.com/u/51812?v=4" width="100px;" alt=""/><br /><sub><b>cs</b></sub></a><br /><a href="https://github.com/pol-is-trial-balloon/polis/commits?author=misscs" title="Code">💻</a></td>
    <td align="center"><a href="https://github.com/mbjorkegren"><img src="https://avatars3.githubusercontent.com/u/2016166?v=4" width="100px;" alt=""/><br /><sub><b>mbjorkegren</b></sub></a><br /><a href="https://github.com/pol-is-trial-balloon/polis/commits?author=mbjorkegren" title="Code">💻</a></td>
    <td align="center"><a href="http://nodescription.net"><img src="https://avatars2.githubusercontent.com/u/305339?v=4" width="100px;" alt=""/><br /><sub><b>Patrick Connolly</b></sub></a><br /><a href="https://github.com/pol-is-trial-balloon/polis/commits?author=patcon" title="Code">💻</a> <a href="#infra-patcon" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#talk-patcon" title="Talks">📢</a></td>
    <td align="center"><a href="http://virgile-dev.github.io"><img src="https://avatars0.githubusercontent.com/u/11473995?v=4" width="100px;" alt=""/><br /><sub><b>virgile-dev</b></sub></a><br /><a href="#translation-virgile-dev" title="Translation">🌍</a></td>
    <td align="center"><a href="http://openconcept.ca"><img src="https://avatars0.githubusercontent.com/u/116832?v=4" width="100px;" alt=""/><br /><sub><b>Mike Gifford</b></sub></a><br /><a href="#a11y-mgifford" title="Accessibility">️️️️♿️</a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/huulbaek"><img src="https://avatars0.githubusercontent.com/u/1862741?v=4" width="100px;" alt=""/><br /><sub><b>Thomas Huulbæk</b></sub></a><br /><a href="#translation-huulbaek" title="Translation">🌍</a></td>
    <td align="center"><a href="https://github.com/bamstam"><img src="https://avatars3.githubusercontent.com/u/9203888?v=4" width="100px;" alt=""/><br /><sub><b>Bamstam</b></sub></a><br /><a href="#translation-bamstam" title="Translation">🌍</a></td>
    <td align="center"><a href="https://github.com/drewhart"><img src="https://avatars0.githubusercontent.com/u/6105510?v=4" width="100px;" alt=""/><br /><sub><b>Drew Hart</b></sub></a><br /><a href="#translation-drewhart" title="Translation">🌍</a></td>
    <td align="center"><a href="http://www.societenumerique.gouv.fr"><img src="https://avatars3.githubusercontent.com/u/12126587?v=4" width="100px;" alt=""/><br /><sub><b>Pierre-Louis Rolle</b></sub></a><br /><a href="#translation-PLrolle" title="Translation">🌍</a></td>
    <td align="center"><a href="https://github.com/ricardopoppi"><img src="https://avatars3.githubusercontent.com/u/1162183?v=4" width="100px;" alt=""/><br /><sub><b>Ricardo Poppi</b></sub></a><br /><a href="#translation-ricardopoppi" title="Translation">🌍</a></td>
    <td align="center"><a href="https://linkedin.com/in/uzzal2k5"><img src="https://avatars0.githubusercontent.com/u/5254162?v=4" width="100px;" alt=""/><br /><sub><b>Md Shafiqul Islam</b></sub></a><br /><a href="#infra-uzzal2k5" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a></td>
    <td align="center"><a href="https://github.com/lizbarry"><img src="https://avatars3.githubusercontent.com/u/25355768?v=4" width="100px;" alt=""/><br /><sub><b>lizbarry</b></sub></a><br /><a href="#blog-lizbarry" title="Blogposts">📝</a> <a href="#talk-lizbarry" title="Talks">📢</a></td>
  </tr>
</table>

<!-- markdownlint-enable -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!