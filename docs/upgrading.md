# Upgrade Guide

## Configuration Changes (Q1 2023)

`polis.config.template.js` and `polis.config.js` files are removed and no longer used.
`docker-dev.env` and `docker-db-dev.env` files are removed and no longer used.
`.env` and/or `prod.env` are now treated as the source of truth for the application and are ignored by git.
See `example.env` for default values.

Please read [configuration.md](./configuration.md) for more information and a complete list of configuration values.

Values that have been renamed or replaced:

- **`DATABASE_FOR_READS_NAME`** has been replaced by **`READ_ONLY_DATABASE_URL`**
- **`PORT`** has been renamed **`API_SERVER_PORT`**
- **`SERVICE_HOSTNAME`** has been renamed to **`EMBED_SERVICE_HOSTNAME`**
- **`STATIC_FILES_ADMINDASH_PORT`** has been renamed to **`STATIC_FILES_ADMIN_PORT`**

New values:

- **`API_DEV_HOSTNAME`**
- **`API_PROD_HOSTNAME`**
- **`ENABLE_TWITTER_WIDGETS`**
- **`GA_TRACKING_ID`**
- **`POSTGRES_HOST`**
- **`POSTGRES_PORT`**
- **`SERVER_ENV_FILE`**
- **`SERVER_LOG_LEVEL`**
- **`SERVER_LOG_TO_FILE`**
- **`STATIC_FILES_PARTICIPATION_PORT`**
