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

Sign up at `/createuser` path.


## :rocket: Deployment

Please see [`docs/deployment.md`](/docs/deployment.md)

## :copyright: License

[AGPLv3](/LICENSE)
