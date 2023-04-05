# Upgade Guide

## Configuration Changes (Q1 2023)

Please read [configuration.md](./configuration.md) for a complete list of configuration values.

Values that have been renamed or replaced:

- **`DATABASE_FOR_READS_NAME`** has been replaced by **`READ_ONLY_DATABASE_URL`**
- **`PORT`** has been renamed **`API_SERVER_PORT`**
- **`STATIC_FILES_ADMINDASH_PORT`** has been renamed to **`STATIC_FILES_ADMIN_PORT`**
- **`SERVICE_HOSTNAME`** has been renamed to **`EMBED_SERVICE_HOSTNAME`**

New values:

- **`SERVER_ENV_FILE`**
- **`SERVER_LOG_LEVEL`**
- **`POSTGRES_HOST`**
- **`POSTGRES_PORT`**
- **`STATIC_FILES_PARTICIPATION_PORT`**
- **`SERVER_LOG_TO_FILE`**
- **`API_DEV_HOSTNAME`**
- **`API_PROD_HOSTNAME`**
- **`ENABLE_TWITTER_WIDGETS`**
- **`GA_TRACKING_ID`**
