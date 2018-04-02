# Polis
pol.is an AI powered sentiment gathering platform. More organic than surveys, less effort than focus groups.

If you don't want to deploy your own instance of Polis, you can use our SaaS version [here](https://pol.is/home)
Polis [can be easily embedded](http://docs.pol.is/usage/Embedding.html) on your page as an iframe.

## Installation

### Dependencies

* PostgreSql `(>= 9.5.4.1)`
* Node `6.11.1`
We recommend installing [nvm](https://github.com/creationix/nvm) so you can easily switch between your favorite flavors of node.
* NPM `3.3.8`

### Setup

1. Create a new datbase. You can name it whatever you please.
    ```sh
    create database polis;
    ```
1. Connect to the new database then run `postgres/db_setup_draft.sql` in its shell
    ```
    \connect polis;
    \i postgres/db_setup_draft.sql`;
    ```
1. Create development envs file
    ```sh
    $ cp .env_dev_local_db_template .env_dev
    ```
1. Update database connection settings in `.env_dev`. Replace the username, password, and database_name in the DATABASE_URL
    ```
    export DATABASE_URL=postgres://your_pg_username:your_pg_password@localhost:5432/your_pg_database_name
    ```
1. Install or set Node version.
    ```sh
    # Install
    $ nvm install 6.11.1

    # Set correct node version.
    $ nvm use 6.11.1
    ```
1. Install depedencies
    ```sh
    $ npm install
    ```
1. Run the start-up script. This will start the server.
    ```sh
    $ ./x
    ```
1. In another shell, start the [polisClientAdmin](https://github.com/pol-is/polisClientAdmin). Follow installation directions on the project README.
    ```
    $ ./x
    ```
1. Navigate to `localhost:5000`. Voila, Polis.
