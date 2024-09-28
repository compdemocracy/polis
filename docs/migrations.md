
# Database Migrations

When we need to update the Polis database, we use SQL migration files.

During initial provisioning of your Docker containers, all the migrations will be applied in order, and you won't need to think about this.
But if we update the database schema after your initial provisioning of your server via Docker, you'll need to manually apply each new SQL migration.

- Please note: **Backups are your responsibility.** These instructions assume
  the data is disposable, and do not attempt to make backups.
  - Pull requests are welcome if you'd like to see more guidance on this.
  - Please submit an issue if you'd like to work on enabling backups through Docker Compose.
- Your database data is stored on a docker volume, which means that it will
  persist even when you destroy all your docker containers. Be mindful of this.
  - You can remove ALL volumes defined within a `docker-compose` file via: `docker compose --profile postgres down --volumes`
  - You can remove ONE volume via `docker volume ls` and `docker volume rm <name>`
- SQL migrations can be found in [`server/postgres/migrations/`][] of this
  repo.
- The path to the SQL file will be relative to its location in the docker
  container filesystem, not your host system.

For example, if we add the migration file
`server/postgres/migrations/000001_update_pwreset_table.sql`, you'd run on your
host system:

```sh
docker compose --profile postgres exec postgres psql --username postgres --dbname polis-dev --file=/docker-entrypoint-initdb.d/000001_update_pwreset_table.sql
```

You can also run a local .sql file on a postgres container instance with this syntax:

```sh
docker exec -i polis-dev-postgres-1 psql -U postgres -d polis-dev < server/postgres/migrations/000006_update_votes_rule.sql
```

where `polis-dev-postgres-1` is the name of the running container (see the output of `docker ps`), `postgres` is the db username and `polis-dev` is the database.

You'd do this for each new file, in numeric order.

   [`server/postgres/migrations/`]: /server/postgres/migrations
