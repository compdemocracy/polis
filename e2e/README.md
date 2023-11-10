# polis-e2e

End-To-End Tests written with cypress.io

## Dependencies

- node `>= 18`

## Quickstart

from the polis root directory:

```sh
make TEST start
```

and in another shell:

```sh
make e2e-install
make e2e-run
```

## Setup

(from within the e2e directory)

```sh
npm install
```

(or, from the root directory)

```sh
make e2e-install
```

See [System Requirements](https://docs.cypress.io/guides/getting-started/installing-cypress#System-requirements) for additional needs that your operating system might have.

There are few ways to run the end-to-end (e2e) test suite. They can be run in a browser, or headless. They can be run within a dockerized environment or directly on a development machine, or in a cloud system such as GitHub Actions. In any case, you need 3 things:

1. A URL that points to a running instance of polis.
2. A `maildev` service with port 1080 exposed.
3. A Google Service Account Key (optional) to enable Google Translation API.

Running `docker compose` with either the `docker-compose.dev.yml` or `docker-compose.test.yml` overlay will get you #1 and #2. (See the top-level documentation for configuring and running polis.)

The helpful shortcut `make TEST start` will build (if necessary) and start all of the dockerized services in a test environment,
making use of `docker-compose.test.yml` and the `test.env` configuration values. This is the preferred way.

If you want to run tests that require integration with Google Translation API, refer to the Byzantine [documentation at Google Cloud](https://cloud.google.com/docs/authentication/client-libraries).

## Running the tests

To run the tests "headlessly" from the command line, simply run:

(from within the e2e directory)

```sh
npm test
```

(or from the root directory)

```sh
make e2e-run
```

To open a Cypress user interface and run the tests in a browser of your choosing, run:

```sh
npm start
```

You can also run one-off test files or groups of test files with commands like:

```sh
npm run cy:run -- --spec "cypress/e2e/my-spec.cy.js"
npm run cy:run -- --spec "cypress/e2e/login/**/*"
```

Read more about the [Cypress command line options here](https://docs.cypress.io/guides/guides/command-line).

## Notes

- The default base url for running tests against, is <http://localhost>
- The default browser is electron. On the command line the default is headless electron unless you include a `--browser` option.
- You may override the base url with a command like so: `CYPRESS_BASE_URL=http://123.45.67.89.sslip.io npm test`
- `cypress/support/commands.js`: where we keep oft-used commands, e.g., for logging in, creating conversations, etc.
- Tests which require third-party credentials are confined to `cypress/e2e/third-party-integration` and are not included in the default test run `npm test`.
  - To run all tests, you may use `npm run cy:run -- --spec "cypress/e2e/**/*"` or simply `npm run test:all`
- We are not, as of yet, including any Component tests in this suite.
- The docker compose `test` configuration, using the `docker-compose.test.yml` overlay and/or `make TEST ...` commands are intended for running polis in a prod-like way with a couple of exceptions: including a maildev server with port 1080 exposed, and passing along some modified environment variables found in `test.env`. This is especially useful for CI server situations and not really necessary for local development. Running the tests against the `dev` docker compose configuration should work fine too.
- The test suite creates a lot of data and writes it to a Postgres database. It will generate fresh data with every run and so it is a good idea to drop the database (or docker volume) occasionally. However, having a database full of random data is sometimes helpful for manual testing and development. You will accumulate random test data in whatever environment the tests are run.
  - **DON'T RUN CYPRESS TESTS IN PRODUCTION**
