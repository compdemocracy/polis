# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

<!-- Changes to badge text in URLs below, require changes to "name" value in .github/workflows/*.yml -->
[![Nightly Docker Builds](https://github.com/pol-is/polisServer/workflows/Nightly%20Docker%20Builds/badge.svg)][nightlies]
[![E2E Tests](https://github.com/pol-is/polisServer/workflows/E2E%20Tests/badge.svg)][e2e-tests]
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-37-orange.svg?style=flat-square)](#contributors-)
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
    <td align="center"><a href='https://github.com/alexlande'><img src='https://avatars0.githubusercontent.com/u/808159?v=4' width='100px;' alt=''/><br /><sub><b>alexlande</b></sub></a><br /><a href="https://github.com/search?q=author:alexlande+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a></td>
    <td align="center"><a href='https://github.com/ajsmitha7'><img src='https://avatars3.githubusercontent.com/u/8118319?v=4' width='100px;' alt=''/><br /><sub><b>ajsmitha7</b></sub></a><br /><a href="#content-ajsmitha7" title="Content">🖋</a> <a href="#video-ajsmitha7" title="Videos">📹</a> <a href="https://github.com/search?q=involves:ajsmitha7+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/bamstam'><img src='https://avatars3.githubusercontent.com/u/9203888?v=4' width='100px;' alt=''/><br /><sub><b>bamstam</b></sub></a><br /><a href="#translation-bamstam" title="Translation">🌍</a></td>
    <td align="center"><a href='https://github.com/ballPointPenguin'><img src='https://avatars0.githubusercontent.com/u/35609?v=4' width='100px;' alt=''/><br /><sub><b>ballPointPenguin</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/pulls?q=is%3Apr+reviewed-by%3AballPointPenguin" title="Reviewed Pull Requests">👀</a></td>
    <td align="center"><a href='https://github.com/metasoarous'><img src='https://avatars3.githubusercontent.com/u/88556?v=4' width='100px;' alt=''/><br /><sub><b>metasoarous</b></sub></a><br /><a href="https://github.com/search?q=author:metasoarous+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a></td>
    <td align="center"><a href='https://github.com/colinmegill'><img src='https://avatars3.githubusercontent.com/u/1770265?v=4' width='100px;' alt=''/><br /><sub><b>colinmegill</b></sub></a><br /><a href="https://github.com/search?q=author:colinmegill+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a> <a href="#fundingFinding-colinmegill" title="Funding Finding">🔍</a> <a href="#talk-colinmegill" title="Talks">📢</a> <a href="#business-colinmegill" title="Business development">💼</a></td>
    <td align="center"><a href='https://github.com/DZNarayanan'><img src='https://avatars3.githubusercontent.com/u/17834398?v=4' width='100px;' alt=''/><br /><sub><b>DZNarayanan</b></sub></a><br /><a href="#talk-DZNarayanan" title="Talks">📢</a> <a href="#blog-DZNarayanan" title="Blogposts">📝</a></td>
  </tr>
  <tr>
    <td align="center"><a href='https://github.com/drewhart'><img src='https://avatars0.githubusercontent.com/u/6105510?v=4' width='100px;' alt=''/><br /><sub><b>drewhart</b></sub></a><br /><a href="#translation-drewhart" title="Translation">🌍</a></td>
    <td align="center"><a href='https://github.com/DylanGuedes'><img src='https://avatars3.githubusercontent.com/u/7079397?v=4' width='100px;' alt=''/><br /><sub><b>DylanGuedes</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/commits?author=DylanGuedes" title="Tests">⚠️</a></td>
    <td align="center"><a href='https://github.com/vital-edu'><img src='https://avatars0.githubusercontent.com/u/5282301?v=4' width='100px;' alt=''/><br /><sub><b>vital-edu</b></sub></a><br /><a href="#infra-vital-edu" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a></td>
    <td align="center"><a href='https://github.com/fractalcactus'><img src='https://avatars2.githubusercontent.com/u/8527715?v=4' width='100px;' alt=''/><br /><sub><b>fractalcactus</b></sub></a><br /><a href="https://github.com/search?q=author:fractalcactus+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Documentation">📖</a></td>
    <td align="center"><a href='https://github.com/heatherm'><img src='https://avatars2.githubusercontent.com/u/416681?v=4' width='100px;' alt=''/><br /><sub><b>heatherm</b></sub></a><br /><a href="https://github.com/search?q=author:heatherm+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Documentation">📖</a></td>
    <td align="center"><a href='https://github.com/Herman-Wu'><img src='https://avatars3.githubusercontent.com/u/10748637?v=4' width='100px;' alt=''/><br /><sub><b>Herman-Wu</b></sub></a><br /><a href="https://github.com/search?q=involves:Herman-Wu+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/Jdesk'><img src='https://avatars1.githubusercontent.com/u/9715064?v=4' width='100px;' alt=''/><br /><sub><b>Jdesk</b></sub></a><br /><a href="https://github.com/search?q=involves:Jdesk+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
  </tr>
  <tr>
    <td align="center"><a href='https://github.com/joel-zilliqa'><img src='https://avatars0.githubusercontent.com/u/56012934?v=4' width='100px;' alt=''/><br /><sub><b>joel-zilliqa</b></sub></a><br /><a href="https://github.com/search?q=involves:joel-zilliqa+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/joenio'><img src='https://avatars0.githubusercontent.com/u/44172?v=4' width='100px;' alt=''/><br /><sub><b>joenio</b></sub></a><br /><a href="https://github.com/search?q=author:joenio+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Documentation">📖</a></td>
    <td align="center"><a href='https://github.com/joshsmith2'><img src='https://avatars3.githubusercontent.com/u/3437989?v=4' width='100px;' alt=''/><br /><sub><b>joshsmith2</b></sub></a><br /><a href="https://github.com/search?q=author:joshsmith2+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Documentation">📖</a> <a href="https://github.com/search?q=involves:joshsmith2+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/kenwheeler'><img src='https://avatars2.githubusercontent.com/u/286616?v=4' width='100px;' alt=''/><br /><sub><b>kenwheeler</b></sub></a><br /><a href="https://github.com/search?q=author:kenwheeler+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a></td>
    <td align="center"><a href='https://github.com/kennyrowe'><img src='https://avatars3.githubusercontent.com/u/6291612?v=4' width='100px;' alt=''/><br /><sub><b>kennyrowe</b></sub></a><br /><a href="https://github.com/search?q=involves:kennyrowe+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/ebarry'><img src='https://avatars1.githubusercontent.com/u/161439?v=4' width='100px;' alt=''/><br /><sub><b>ebarry</b></sub></a><br /><a href="#talk-ebarry" title="Talks">📢</a> <a href="#blog-ebarry" title="Blogposts">📝</a></td>
    <td align="center"><a href='https://github.com/uzzal2k5'><img src='https://avatars0.githubusercontent.com/u/5254162?v=4' width='100px;' alt=''/><br /><sub><b>uzzal2k5</b></sub></a><br /><a href="#infra-uzzal2k5" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#question-uzzal2k5" title="Answering Questions">💬</a></td>
  </tr>
  <tr>
    <td align="center"><a href='https://github.com/mgifford'><img src='https://avatars0.githubusercontent.com/u/116832?v=4' width='100px;' alt=''/><br /><sub><b>mgifford</b></sub></a><br /><a href="#a11y-mgifford" title="Accessibility">️️️️♿️</a></td>
    <td align="center"><a href='https://github.com/patcon'><img src='https://avatars2.githubusercontent.com/u/305339?v=4' width='100px;' alt=''/><br /><sub><b>patcon</b></sub></a><br /><a href="https://github.com/search?q=author:patcon+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a> <a href="#infra-patcon" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#talk-patcon" title="Talks">📢</a> <a href="https://github.com/pol-is/polisServer/pulls?q=is%3Apr+reviewed-by%3Apatcon" title="Reviewed Pull Requests">👀</a></td>
    <td align="center"><a href='https://github.com/PLrolle'><img src='https://avatars3.githubusercontent.com/u/12126587?v=4' width='100px;' alt=''/><br /><sub><b>PLrolle</b></sub></a><br /><a href="#translation-PLrolle" title="Translation">🌍</a></td>
    <td align="center"><a href='https://github.com/ricardopoppi'><img src='https://avatars3.githubusercontent.com/u/1162183?v=4' width='100px;' alt=''/><br /><sub><b>ricardopoppi</b></sub></a><br /><a href="#translation-ricardopoppi" title="Translation">🌍</a></td>
    <td align="center"><a href='https://github.com/rohanrichards'><img src='https://avatars2.githubusercontent.com/u/16222002?v=4' width='100px;' alt=''/><br /><sub><b>rohanrichards</b></sub></a><br /><a href="#infra-rohanrichards" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="https://github.com/search?q=involves:rohanrichards+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/tallysmartins'><img src='https://avatars3.githubusercontent.com/u/3032943?v=4' width='100px;' alt=''/><br /><sub><b>tallysmartins</b></sub></a><br /><a href="https://github.com/search?q=involves:tallysmartins+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/huulbaek'><img src='https://avatars0.githubusercontent.com/u/1862741?v=4' width='100px;' alt=''/><br /><sub><b>huulbaek</b></sub></a><br /><a href="#translation-huulbaek" title="Translation">🌍</a></td>
  </tr>
  <tr>
    <td align="center"><a href='https://github.com/crkrenn'><img src='https://avatars2.githubusercontent.com/u/6069975?v=4' width='100px;' alt=''/><br /><sub><b>crkrenn</b></sub></a><br /><a href="https://github.com/pol-is/polisServer/pulls?q=is%3Apr+reviewed-by%3Acrkrenn" title="Reviewed Pull Requests">👀</a></td>
    <td align="center"><a href='https://github.com/misscs'><img src='https://avatars1.githubusercontent.com/u/51812?v=4' width='100px;' alt=''/><br /><sub><b>misscs</b></sub></a><br /><a href="https://github.com/search?q=author:misscs+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a> <a href="https://github.com/search?q=author:misscs+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Documentation">📖</a> <a href="#design-misscs" title="Design">🎨</a></td>
    <td align="center"><a href='https://github.com/dav-idcox'><img src='https://avatars1.githubusercontent.com/u/10424822?v=4' width='100px;' alt=''/><br /><sub><b>dav-idcox</b></sub></a><br /><a href="https://github.com/search?q=author:dav-idcox+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Documentation">📖</a></td>
    <td align="center"><a href='https://github.com/light24bulbs'><img src='https://avatars2.githubusercontent.com/u/581906?v=4' width='100px;' alt=''/><br /><sub><b>light24bulbs</b></sub></a><br /><a href="https://github.com/search?q=author:light24bulbs+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a></td>
    <td align="center"><a href='https://github.com/mbjorkegren'><img src='https://avatars3.githubusercontent.com/u/2016166?v=4' width='100px;' alt=''/><br /><sub><b>mbjorkegren</b></sub></a><br /><a href="https://github.com/search?q=author:mbjorkegren+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a> <a href="#question-mbjorkegren" title="Answering Questions">💬</a></td>
    <td align="center"><a href='https://github.com/sk44p'><img src='https://avatars1.githubusercontent.com/u/36816860?v=4' width='100px;' alt=''/><br /><sub><b>sk44p</b></sub></a><br /><a href="https://github.com/search?q=involves:sk44p+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
    <td align="center"><a href='https://github.com/virgile-dev'><img src='https://avatars0.githubusercontent.com/u/11473995?v=4' width='100px;' alt=''/><br /><sub><b>virgile-dev</b></sub></a><br /><a href="#translation-virgile-dev" title="Translation">🌍</a> <a href="https://github.com/search?q=involves:virgile-dev+org:pol-is&type=Issues" title="Bug reports">🐛</a></td>
  </tr>
  <tr>
    <td align="center"><a href='https://github.com/audreyt'><img src='https://avatars1.githubusercontent.com/u/20723?v=4' width='100px;' alt=''/><br /><sub><b>audreyt</b></sub></a><br /><a href="https://github.com/search?q=involves:audreyt+org:pol-is&type=Issues" title="Bug reports">🐛</a> <a href="#blog-audreyt" title="Blogposts">📝</a> <a href="https://github.com/search?q=author:audreyt+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a> <a href="#talk-audreyt" title="Talks">📢</a></td>
    <td align="center"><a href='https://github.com/urakagi'><img src='https://avatars3.githubusercontent.com/u/2368060?v=4' width='100px;' alt=''/><br /><sub><b>urakagi</b></sub></a><br /><a href="https://github.com/search?q=author:urakagi+repo:pol-is/polisServer+repo:pol-is/polis-documentation&type=Commits" title="Code">💻</a></td>
  </tr>
</table>

<!-- markdownlint-enable -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!
