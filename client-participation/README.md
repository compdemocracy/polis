# Polis Client Participation

This is the front-end code that participants see. It is built with backbone.js and react.js.

## Installation

### Dependencies

* Node `>= 16`
We recommend installing [nvm](https://github.com/creationix/nvm) so that you can easily switch between your favorite
flavors of node.
* NPM `>= 8`

If using nvm, run the commands below to install node and the application dependencies.

```sh
nvm install 18
nvm use 18
npm install
```

### Docker Build

If you prefer to run the Polis application using `docker compose`, see the top-level README document. This component
will be built and served as part of the `file-server` container.

If you are building this container on its own, outside of the `docker compose` context, simply use the Dockerfile
located in this directory. Optionally provide a "tag" for the image that is created:

```sh
docker build -t polis-client-participation:local .
```

But it currently does not include a development server so if you want to interface with the
application you should use the top-level `docker compose` method, or else mount and serve the built
assets in another way.

## Configuration

### embed.js

Among the assets built into the `dist/` directory is `embed.js` which is used when deploying a polis client
embedded into another website. Set the **`EMBED_SERVICE_HOSTNAME`** environment variable to your API Service hostname
when you build this app. In the top-level `docker compose` configuration, this variable is read from the `.env` file
there. e.g. `EMBED_SERVICE_HOSTNAME=api.mypolis.org`.

## Building the Application

```sh
npm run build
```

You can run `npm run build:dev` to get an unminified version which makes for easier in-browser debugging.

This app currently doesn't include a development server so if you want to interface with it you need to serve the built
assets, found in the `dist/` folder.

## Troubleshooting

If you get an error that looks something like `Error: watch /home/csmall/code/polisClientParticipation/js ENOSPC` trying to run, this may be because your system has too many watches active. If you see this, try running `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p` to increase the number of available watches on your system.
