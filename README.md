# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

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


```
# first build or re-build:
docker-compose build --build-arg GIT_HASH $(git rev-parse --short HEAD) --parallel
# otherwise:
docker-compose up --detach
# to stop:
docker-compose down
# (or Ctrl+C if you did not run with --detach)

# check your ip (only necessary on docker-machine):
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
