# Polis Admin Console

The web interface for creating and administering polis conversations. It is built with React.js.

## Installation

### Dependencies

- Node `>= 16`
  We recommend installing [nvm](https://github.com/creationix/nvm) so that you can easily switch between your favorite
  flavors of node.
- NPM `>= 8`

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
docker build -t polis-client-admin:local .
docker run -p 8080:8080 --name polis-client-admin polis-client-admin:local npm start
```

Now you can see the web interface at [http://localhost:8080], but if it is not connected to the Server API you won't
get very far. Still it can be useful for developing and debugging builds.

## Configuration

### Common Problems

If you having troubles with npm dependencies try run the commands below:

```sh
rm -rf node_modules
npm install
```

## Running Application

This will run the webpack dev server which will rebuild as you make changes.

```sh
npm start
```

Now you can see the web interface at [http://localhost:8080]. You will still need to run the rest of the Polis
application components (via docker compose or otherwise) to have a functional interface.

The client-admin will look for an API server at whatever domain and port it is itself running on, e.g. `localhost`.

_In the future this should become more customizable._

## Building for Production

To build static assets into `build/` for a production deployment, run

```sh
npm run build:prod
```

_The polis file-server process builds and serves these assets when docker compose is used._

See the "scripts" section of the package.json file for other run and build options.
