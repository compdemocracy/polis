# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

If you don't want to deploy your own instance of Polis, you can sign up for our SaaS version (complete with advanced report functionality) [here](https://pol.is/home).
Polis [can be easily embedded](http://docs.pol.is/usage/Embedding.html) on your page as an iframe.

## Installation

The below instructions are no longer officially supported; if you'd like to use them as a reference, we suggest you check out the official [Dockerfile](Dockerfile) to understand the latest build process and specific package versions.

---

### Dependencies

* PostgreSql `(~ 13.4)`
* Node `>= 16`
We recommend installing [nvm](https://github.com/creationix/nvm) so that you can easily switch between your favorite flavors of node.
* NPM `>= 8`

### Setup

1. Create a new database. You can name it whatever you please.
    ```sh
    create database polis;
    ```
    Depending on your environment and postgresql version, you may instead need to run something like `createdb polis` or `sudo -u postgres createdb polis` to get this to work.
1. Connect to the new database then run the migrations in its shell.
    ```
    \connect polis
    \i postgres/migrations/000000_initial.sql
    \i postgres/migrations/000001_update_pwreset_table.sql
    ```
    You can also separately run `psql -d polis -f postgres/migrations/000000_initial.sql` and `psql -d polis -f postgres/migrations/000001_update_pwreset_table.sql` from the shell.
1. Create development .env file
    ```sh
    $ cp example.env .env
    ```
1. Update database connection settings in `.env`. Replace the username, password, and database_name in the DATABASE_URL
    ```
    export DATABASE_URL=postgres://your_pg_username:your_pg_password@localhost:5432/your_pg_database_name
    ```
    Note that in some instances you may find that your postgres port isn't 5432 and you will need to figure out what this is.
1. Note that for running in "dev mode" on a local machine, in order to avoid http -> https rerouting and other
    issues, you'll want to run with `export DEV_MODE=true`.
1. Install or set Node version.
    ```sh
    # Install
    $ nvm install 18

    # Set correct node version.
    $ nvm use 18
    ```
1. Install depedencies
    ```sh
    $ npm install
    ```
1. Run the start-up script. This will start the server.
    ```sh
    $ ./x
    ```
1. In another shell, start the [client-admin](../client-admin). Follow installation directions on the component README.
    ```
    $ ./x
    ```
1. Navigate to `localhost:5000`. Voila, Polis.
