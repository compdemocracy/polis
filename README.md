# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

## 🙋🏾‍♀️ Get Involved

1. Say hi in our **chat** [:speech_balloon:][chat] [`gitter.com/pol-is/polisDeployment`][chat]
2. Join one of our **open calls** [:microphone:][calls-room] [`meet.jit.si/pol.is`][calls-room]
    - Weekly community calls, [every Saturday at 19:00 UTC][calls-time] (noon PT / 3pm ET)
    - Newcomers welcome!
3. Visit our [**issue tracker**][issues] [:white_check_mark:][issues] to offer your skills & energies
    - We also keep a [project kanban board][board] [:checkered_flag:][board]
    - :ear: Pssssst! [Learn how...][contributing] (labels, etc.)

   [chat]: https://gitter.im/pol-is/polisDeployment
   [calls-room]: https://meet.jit.si/pol.is
   [calls-time]: https://www.worldtimebuddy.com/event?lid=100%2C8%2C1668341%2C5&h=100&sts=26493120&sln=19-20&a=show&euid=d53410dd-f948-c1a4-3dde-31ac0adf894d
   [calls-about]: /CONTRIBUTING.md#open-calls
   [issues]: https://github.com/pol-is/polisServer/issues
   [board]: https://github.com/orgs/pol-is/projects/1
   [contributing]: /CONTRIBUTING.md#how-we-work

<div align="right"><sup>Inspired by <a href="https://tomesh.net/get-involved/">Toronto Mesh content</a>.</sup></div>

## 💻 Development

Recommendations: Docker-Machine (on [DigitalOcean with 2GB memory][do-tut])

   [do-tut]: https://www.digitalocean.com/community/tutorials/how-to-provision-and-manage-remote-docker-hosts-with-docker-machine-on-ubuntu-16-04

```
GIT_HASH=$(git log --pretty="%h" -n 1) docker-compose up --build --detach
docker-machine ip
>>> 123.45.67.89
```

Visit your instance at: `http://123.45.67.89.xip.io/`

Sign up at `/createuser` path. You'll be logged in right away; no email validation required!

**What features still need work?**
- ~~Generated reports~~
- Data export [`polis-issues#137`](https://github.com/pol-is/polis-issues/issues/137)

## 🚀 Deployment

Please see [`docs/deployment.md`](/docs/deployment.md)

## ©️  License

[AGPLv3](/LICENSE)
