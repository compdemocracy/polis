# Polis report

Interface for working with polis reports. It is built with React.js.

## Installation

### Dependencies

* Node `>= 18`
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

If you prefer to run the Polis application using `docker compose`, see the top-level README document. This will be built and served as part of the `file-server` container.

If you are building this container on its own, outside of the `docker compose` context, simply use the Dockerfile
located in this directory. Optionally provide a "tag" for the image that is created:

```sh
docker build -t polis-client-report:local .
docker run -p 5010:5010 --name polis-client-report polis-client-admin:local npm start
```

Now you can see the web interface at [http://localhost:5010], but if it is not connected to the Server API you won't
get very far. Still it can be useful for developing and debugging builds.

## Configuration

The folowing environment variable can be set when building and running this application. If using the top-level `docker compose` configuration, it can be found in the `.env` file there.

**`SERVICE_URL`**: (Optional) The URL of your API Server. Set this value if your API Server is not on the same domain as your client-report.
Currently this is only used in development.

You will also need to have AWS credentials set up at `.polis_s3_creds_client.json` if you are using S3
buckets for deployment.

The credential file should be a json that looks more or less like

```json
{"key": "AKIDFDCFDFDSDFDDSEWW",
 "secret": "dfkjw3DDfkjd902k39cjglkjs039i84kjccC"}
```

## Running Application

This will run the webpack dev server which will rebuild as you make changes.

```sh
npm start
```

Now you can see the web interface at [http://localhost:5010]. You will still need to run the rest of the Polis
application components (via docker compose or otherwise) to have a functional interface.

## Deployment

To build static assets into `dist/` for a production deployment, run

```sh
npm run build:prod
```

_The polis file-server process builds and serves these assets when docker compose is used._

See the "scripts" section of the package.json file for other run and build options.
