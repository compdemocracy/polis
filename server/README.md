# Polis API Server

Polis is an AI-powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

If you don't want to deploy your own instance of Polis, you can sign up for our SaaS version (complete with advanced
report functionality) [Polis Home](https://pol.is/home).

Polis [can be easily embedded](https://github.com/compdemocracy/polis-embed-examples) on your page as an iframe.

## Installation

This directory contains the API Server component of the overall Polis application.
It uses Node, Typescript and Express.js. It connects to a PostgreSQL database. See the top-level README for instructions
on building and running the whole application using `docker compose`.

For development or non-docker environments, the api server can be built and run on its own (provided there is a database
for it to connect to.)

---

### Dependencies

- PostgreSql `16`
- Node `24` (via [mise](https://mise.jdx.dev))
- NPM `>= 10`

### Setup

1\. Create development .env file

```sh
cp example.env .env
```

and edit as needed. that for running in "dev mode" on a local machine, in order to avoid http ->
https rerouting and other issues, you'll want to run with `DEV_MODE=true` (in .env or via CLI)

2\. [Create a new database](https://www.postgresql.org/docs/16/sql-createdatabase.html). You can name it whatever you
please. For example, in a `psql` shell:

```psql
CREATE DATABASE polis;
```

Depending on your environment and postgresql version, you may instead need to run something like `createdb polis` or
`sudo -u postgres createdb polis` to get this to work.

Another popular option is to run the database in docker, and perhaps other services as well, while running this
API server locally (not docker). Ensure that the postgres port is published from your docker container. This will be
the default behavior if you run `docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up postgres` from the
root folder of the polis project. To run everything but the API server in this fashion you can use
`docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up math postgres file-server ses-local`. In this case
the polis-dev database should be accessible at the default DATABASE_URL seen in server/example.env.

3\. Set `DATABASE_URL` in the environment and run the migration runner from the
repository root. A fresh Compose database does this during initialization.

```sh
cargo build --locked --release --manifest-path queue-rs/Cargo.toml -p polis-migrate
queue-rs/target/release/polis-migrate apply
queue-rs/target/release/polis-migrate check
```

Existing databases need catalog-checked reconciliation once. See
[database migrations](../docs/migrations.md) for the commands and release holds.
Do not replay the initial SQL or pass credentials as command-line arguments.

4\. Update database connection settings in `.env`. Replace the username, password, and database_name in the DATABASE_URL

```sh
DATABASE_URL=postgres://your_pg_username:your_pg_password@localhost:5432/your_pg_database_name
```

_Note that by default postgres tries to use port 5432 but can be set to something else._

5\. Install or set Node version using mise

```sh
mise use node@24
```

6\. Run the start-up script. This will install the dependencies, compile the typescript and start the server in
"development mode" so that changes are detected and re-loaded.

```sh
npm run dev
```

Alternately you can run `npm install`, and `npm start` to build and run without development reloading enabled.

Look at the "scripts" section of package.json, or run `npm run` to see additional run options.

7\. Navigate to `localhost:5000`. If you are running the **client-admin** application, or the dockerized
**file-server** you will see the Polis web application. Otherwise you will be limited to interacting with the API
directly via [Postman](https://www.postman.com/) or other tools.

8\. To run the tests, you must have a server instance with connected database running.

```sh
npm test
```

or in "watch" mode (re-run on file changes)

```sh
npm run test:watch
```
