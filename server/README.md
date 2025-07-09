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

* PostgreSql `(~ 13.4)`
* Node `>= 16`
We recommend installing [nvm](https://github.com/creationix/nvm) so that you can easily switch between your favorite
flavors of node.
* NPM `>= 8`

### Setup

1\. Create development .env file

  ```sh
  cp example.env .env
  ```

  and edit as needed.  that for running in "dev mode" on a local machine, in order to avoid http ->
  https rerouting and other issues, you'll want to run with `DEV_MODE=true` (in .env or via CLI)

2\. [Create a new database](https://www.postgresql.org/docs/13/sql-createdatabase.html). You can name it whatever you
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
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up math postgres file-server maildev`. In this case
  the polis-dev database should be accessible at the default DATABASE_URL seen in server/example.env.

3\. Connect to the new database then run the migrations in its shell. You can skip this step if you built the
  database with docker compose.

  ```psql
  \connect polis
  \i postgres/migrations/000000_initial.sql
  \i postgres/migrations/000001_update_pwreset_table.sql
  \i postgres/migrations/000002_add_xid_constraint.sql
  \i postgres/migrations/000003_add_origin_permanent_cookie_columns.sql
  \i postgres/migrations/000004_drop_waitinglist_table.sql
  \i postgres/migrations/000005_drop_slack_stripe_canvas.sql
  \i postgres/migrations/000006_update_votes_rule.sql
  \i postgres/migrations/000007_drop_geolocation_fields.sql
  \i postgres/migrations/000008_add_comment_priority.sql
  \i postgres/migrations/000009_add_uuid_to_zinvites.sql
  ```

  You can also separately run `psql -d polis -f postgres/migrations/000000_initial.sql` and
  `psql -d polis -f postgres/migrations/000001_update_pwreset_table.sql` etc. from the shell.

  Alternatively, you can use the provided migration script to run all migrations in sequence:

  ```sh
  # Using DATABASE_URL from environment
  ./bin/run-migrations.sh
  
  # Or providing the URL as argument
  ./bin/run-migrations.sh "postgres://username:password@localhost:5432/polis"
  ```

4\. Update database connection settings in `.env`. Replace the username, password, and database_name in the DATABASE_URL

  ```sh
  DATABASE_URL=postgres://your_pg_username:your_pg_password@localhost:5432/your_pg_database_name
  ```

  _Note that by default postgres tries to use port 5432 but can be set to something else._

5\. Install or set Node version. For example, if using [nvm](https://github.com/nvm-sh/nvm)

  ```sh
  # Install
  $ nvm install 20

  # Set correct node version.
  $ nvm use 20
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
