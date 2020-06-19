# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Nightly Docker Builds](https://github.com/pol-is/polisServer/workflows/Nightly%20Docker%20Builds/badge.svg)][nightlies]
[![E2E Tests](https://github.com/pol-is/polisServer/workflows/E2E%20Tests/badge.svg)][e2e-tests]
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-36-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

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
    <td align="center"><a href="http://alexlande.com/"><img src="https://avatars0.githubusercontent.com/u/808159?v=4" width="100px;" alt=""/><br /><sub><b>Alex Lande</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=alexlande" title="Code">💻</a></td>
    <td align="center"><a href="http://pol.is"><img src="https://avatars3.githubusercontent.com/u/8118319?v=4" width="100px;" alt=""/><br /><sub><b>Andrew Smith</b></sub></a><br /><a href="#content-ajsmitha7" title="Content">🖋</a> <a href="#video-ajsmitha7" title="Videos">📹</a> <a href="https://github.com/pol-is/polisServer/issues?q=author%3Aajsmitha7" title="Bug reports">🐛</a></td>
    <td align="center"><a href="https://github.com/bamstam"><img src="https://avatars3.githubusercontent.com/u/9203888?v=4" width="100px;" alt=""/><br /><sub><b>Bamstam</b></sub></a><br /><a href="#translation-bamstam" title="Translation">🌍</a></td>
    <td align="center"><a href="https://sudo-science.com"><img src="https://avatars0.githubusercontent.com/u/35609?v=4" width="100px;" alt=""/><br /><sub><b>Benjamin Rosas</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/pulls?q=is%3Apr+reviewed-by%3AballPointPenguin" title="Reviewed Pull Requests">👀</a></td>
    <td align="center"><a href="http://www.metasoarous.com"><img src="https://avatars3.githubusercontent.com/u/88556?v=4" width="100px;" alt=""/><br /><sub><b>Christopher Small</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=metasoarous" title="Code">💻</a></td>
    <td align="center"><a href="https://pol.is"><img src="https://avatars3.githubusercontent.com/u/1770265?v=4" width="100px;" alt=""/><br /><sub><b>Colin Megill</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=colinmegill" title="Code">💻</a> <a href="#fundingFinding-colinmegill" title="Funding Finding">🔍</a> <a href="#talk-colinmegill" title="Talks">📢</a> <a href="#business-colinmegill" title="Business development">💼</a></td>
    <td align="center"><a href="https://github.com/drewhart"><img src="https://avatars0.githubusercontent.com/u/6105510?v=4" width="100px;" alt=""/><br /><sub><b>Drew Hart</b></sub></a><br /><a href="#translation-drewhart" title="Translation">🌍</a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.ime.usp.br/~dguedes/"><img src="https://avatars3.githubusercontent.com/u/7079397?v=4" width="100px;" alt=""/><br /><sub><b>Dylan Guedes</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=DylanGuedes" title="Tests">⚠️</a></td>
    <td align="center"><a href="https://linktr.ee/vital.edu"><img src="https://avatars0.githubusercontent.com/u/5282301?v=4" width="100px;" alt=""/><br /><sub><b>Eduardo Vital</b></sub></a><br /><a href="#infra-vital-edu" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a></td>
    <td align="center"><a href="https://github.com/fractalcactus"><img src="https://avatars2.githubusercontent.com/u/8527715?v=4" width="100px;" alt=""/><br /><sub><b>Gabrielle Young</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=fractalcactus" title="Documentation">📖</a></td>
    <td align="center"><a href="http://TBD"><img src="https://avatars2.githubusercontent.com/u/416681?v=4" width="100px;" alt=""/><br /><sub><b>Heather</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=heatherm" title="Documentation">📖</a></td>
    <td align="center"><a href="https://herman-wu.github.io/blogs/"><img src="https://avatars3.githubusercontent.com/u/10748637?v=4" width="100px;" alt=""/><br /><sub><b>Herman Wu </b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3AHerman-Wu" title="Bug reports">🐛</a></td>
    <td align="center"><a href="https://triumphtech.io"><img src="https://avatars1.githubusercontent.com/u/9715064?v=4" width="100px;" alt=""/><br /><sub><b>James Barlow</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3AJdesk" title="Bug reports">🐛</a></td>
    <td align="center"><a href="https://github.com/joel-zilliqa"><img src="https://avatars0.githubusercontent.com/u/56012934?v=4" width="100px;" alt=""/><br /><sub><b>Joel Lim</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3Ajoel-zilliqa" title="Bug reports">🐛</a></td>
  </tr>
  <tr>
    <td align="center"><a href="http://joenio.me"><img src="https://avatars0.githubusercontent.com/u/44172?v=4" width="100px;" alt=""/><br /><sub><b>Joenio Costa</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=joenio" title="Documentation">📖</a></td>
    <td align="center"><a href="https://github.com/joshsmith2"><img src="https://avatars3.githubusercontent.com/u/3437989?v=4" width="100px;" alt=""/><br /><sub><b>Josh Smith</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=joshsmith2" title="Documentation">📖</a> <a href="https://github.com/pol-is/polisServer/issues?q=author%3Ajoshsmith2" title="Bug reports">🐛</a></td>
    <td align="center"><a href="http://kenwheeler.github.io"><img src="https://avatars2.githubusercontent.com/u/286616?v=4" width="100px;" alt=""/><br /><sub><b>Ken Wheeler</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=kenwheeler" title="Code">💻</a></td>
    <td align="center"><a href="http://onchain.consulting"><img src="https://avatars3.githubusercontent.com/u/6291612?v=4" width="100px;" alt=""/><br /><sub><b>Kenny Rowe</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3Akennyrowe" title="Bug reports">🐛</a></td>
    <td align="center"><a href="https://github.com/ebarry"><img src="https://avatars1.githubusercontent.com/u/161439?v=4" width="100px;" alt=""/><br /><sub><b>Liz Barry</b></sub></a><br /><a href="#talk-ebarry" title="Talks">📢</a> <a href="#blog-ebarry" title="Blogposts">📝</a></td>
    <td align="center"><a href="https://linkedin.com/in/uzzal2k5"><img src="https://avatars0.githubusercontent.com/u/5254162?v=4" width="100px;" alt=""/><br /><sub><b>Md Shafiqul Islam</b></sub></a><br /><a href="#infra-uzzal2k5" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#question-uzzal2k5" title="Answering Questions">💬</a></td>
    <td align="center"><a href="http://openconcept.ca"><img src="https://avatars0.githubusercontent.com/u/116832?v=4" width="100px;" alt=""/><br /><sub><b>Mike Gifford</b></sub></a><br /><a href="#a11y-mgifford" title="Accessibility">️️️️♿️</a></td>
  </tr>
  <tr>
    <td align="center"><a href="http://nodescription.net"><img src="https://avatars2.githubusercontent.com/u/305339?v=4" width="100px;" alt=""/><br /><sub><b>Patrick Connolly</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=patcon" title="Code">💻</a> <a href="#infra-patcon" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#talk-patcon" title="Talks">📢</a> <a href="https://github.com/pol-is/polisServer/pulls?q=is%3Apr+reviewed-by%3Apatcon" title="Reviewed Pull Requests">👀</a></td>
    <td align="center"><a href="http://www.societenumerique.gouv.fr"><img src="https://avatars3.githubusercontent.com/u/12126587?v=4" width="100px;" alt=""/><br /><sub><b>Pierre-Louis Rolle</b></sub></a><br /><a href="#translation-PLrolle" title="Translation">🌍</a></td>
    <td align="center"><a href="https://github.com/ricardopoppi"><img src="https://avatars3.githubusercontent.com/u/1162183?v=4" width="100px;" alt=""/><br /><sub><b>Ricardo Poppi</b></sub></a><br /><a href="#translation-ricardopoppi" title="Translation">🌍</a></td>
    <td align="center"><a href="https://github.com/rohanrichards"><img src="https://avatars2.githubusercontent.com/u/16222002?v=4" width="100px;" alt=""/><br /><sub><b>Rohan Richards</b></sub></a><br /><a href="#infra-rohanrichards" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="https://github.com/pol-is/polisServer/issues?q=author%3Arohanrichards" title="Bug reports">🐛</a></td>
    <td align="center"><a href="https://github.com/tallysmartins"><img src="https://avatars3.githubusercontent.com/u/3032943?v=4" width="100px;" alt=""/><br /><sub><b>Tallys Martins</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3Atallysmartins" title="Bug reports">🐛</a></td>
    <td align="center"><a href="https://github.com/huulbaek"><img src="https://avatars0.githubusercontent.com/u/1862741?v=4" width="100px;" alt=""/><br /><sub><b>Thomas Huulbæk</b></sub></a><br /><a href="#translation-huulbaek" title="Translation">🌍</a></td>
    <td align="center"><a href="https://github.com/crkrenn"><img src="https://avatars2.githubusercontent.com/u/6069975?v=4" width="100px;" alt=""/><br /><sub><b>crkrenn</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/pulls?q=is%3Apr+reviewed-by%3Acrkrenn" title="Reviewed Pull Requests">👀</a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/misscs"><img src="https://avatars1.githubusercontent.com/u/51812?v=4" width="100px;" alt=""/><br /><sub><b>cs</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=misscs" title="Code">💻</a> <a href="https://github.com/pol-is/polisServer/commits?author=misscs" title="Documentation">📖</a> <a href="#design-misscs" title="Design">🎨</a></td>
    <td align="center"><a href="https://github.com/dav-idcox"><img src="https://avatars1.githubusercontent.com/u/10424822?v=4" width="100px;" alt=""/><br /><sub><b>dav-idcox</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=dav-idcox" title="Documentation">📖</a></td>
    <td align="center"><a href="http://deepwinterdevelopment.com"><img src="https://avatars2.githubusercontent.com/u/581906?v=4" width="100px;" alt=""/><br /><sub><b>light24bulbs</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=light24bulbs" title="Code">💻</a></td>
    <td align="center"><a href="https://github.com/mbjorkegren"><img src="https://avatars3.githubusercontent.com/u/2016166?v=4" width="100px;" alt=""/><br /><sub><b>mbjorkegren</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=mbjorkegren" title="Code">💻</a> <a href="#question-mbjorkegren" title="Answering Questions">💬</a></td>
    <td align="center"><a href="https://github.com/sk44p"><img src="https://avatars1.githubusercontent.com/u/36816860?v=4" width="100px;" alt=""/><br /><sub><b>sk44p</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3Ask44p" title="Bug reports">🐛</a></td>
    <td align="center"><a href="http://virgile-dev.github.io"><img src="https://avatars0.githubusercontent.com/u/11473995?v=4" width="100px;" alt=""/><br /><sub><b>virgile-dev</b></sub></a><br /><a href="#translation-virgile-dev" title="Translation">🌍</a> <a href="https://github.com/pol-is/polisServer/issues?q=author%3Avirgile-dev" title="Bug reports">🐛</a></td>
    <td align="center"><a href="http://www.linkedin.com/in/tangaudrey"><img src="https://avatars1.githubusercontent.com/u/20723?v=4" width="100px;" alt=""/><br /><sub><b>唐鳳</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/issues?q=author%3Aaudreyt" title="Bug reports">🐛</a> <a href="#blog-audreyt" title="Blogposts">📝</a> <a href="https://github.com/pol-is/polisServer/commits?author=audreyt" title="Code">💻</a></td>
  </tr>
  <tr>
    <td align="center"><a href="http://sais.tw/"><img src="https://avatars3.githubusercontent.com/u/2368060?v=4" width="100px;" alt=""/><br /><sub><b>蔡仲明 (Romulus Urakagi Tsai)</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=urakagi" title="Code">💻</a></td>
  </tr>
</table>

<!-- markdownlint-enable -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!
