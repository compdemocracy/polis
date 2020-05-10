# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

## Development

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

**Note:** To configure some convenience options for your local git repo, we recommend running once:

```
git config --local include.path ../.gitconfig
```

## :rocket: Deployment

Please see [`docs/deployment.md`](/docs/deployment.md)

## :copyright: License

[AGPLv3](/LICENSE)
