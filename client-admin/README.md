# Polis Admin Console

The below instructions are no longer officially supported; if you'd like to use them as a reference, we suggest you check out the official [Dockerfile](Dockerfile) to understand the latest build process and specific package versions.

---

## Configuration

Install the NVM following the instructions: [NVM Installation Guide](https://github.com/creationix/nvm#install-script).

Them run the commands below to install the correct Node.JS version and the application dependencies.

```sh
nvm install 14.14.0
npm install
```

### Common Problems

If you having troubles with npm dependencies try run the commands below:

```sh
npm cache clear
npm install
```

## Running Application

```sh
nvm use 14.14.0
npm start
```

## Running Tests

We aspire to use the Jest Testing Framework. We welcome contributors to help us write tests!

```sh
# Doesn't work right now. Will need to reinstall jest.
npm test
```

## Building for Production

To build static assets into `dist/` for a production deployment, run

```sh
npm run build:prod
```

Deployment is currently performed via Docker, and so no other deployment scripts are provided.
