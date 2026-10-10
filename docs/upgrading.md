# Upgrade Guide

## Migration runner transition

Use [the migration runner](migrations.md) before replacing services. Existing
databases need one catalog-checked `reconcile` before their first runner deploy;
new databases initialize through the runner. Missing or changed history prevents
API startup. Migrations 000019/23/24/27 now apply during deployment; the coordinator
000021 remains explicitly held in this release. This installs schema only, not
queue producers or workers. PostgreSQL 17+ is required.

Read the [per-deployment upgrade paths and read-only report](migration-upgrade-notes.md)
before the first transition. One explicit release manifest selects the files;
M20/M21/M25/M26 are outside this forward release. Historical M4/M5/M7 never
execute automatically: absence of their removal targets permits ADOPTED receipts,
while retained targets stop for review without deletion. The
[named legacy contract](migration-legacy-contract.md) preserves supported live
variants, and the [release map](migration-release-map.md) distinguishes shipped
source from actual execution and unassigned semantic versions.

Install **release A** (safe hooks, no runner or startup check) successfully on
EVERY deployment-group instance before this release B. CodeDeploy executes
ApplicationStop from the previous successful revision. A's first transition may
still interrupt service; B's migration refusal preserves A's running services.
An instance that missed A must not receive B. Rolling back to pre-A hooks removes
this protection; restore A before retrying B.

AfterInstall builds the runner, invokes `polis-migrate deploy`, and only after
success replaces the role's services. Under one database advisory lock, deploy
reconciles the catalog through 000022 if history is absent/legacy on an existing
database, applies the selected pending migrations, and checks readiness. A fresh
database goes directly to apply; modern history is checked rather than adopted
again. Any mismatch stops. No error is used as a signal to retry reconciliation.
This release's production-shaped transition adopts 20 files and applies only
M19/M23/M24/M27. Existing queue catalogs newer than the adoption bound still require
their separately reviewed explicit reconciliation before this deploy.

ValidateService checks the server's HTTP and database routes, plus container
liveness; Delphi/worker checks prove container/process liveness only. Validation
failure fails deployment, not an automatic container rollback or schema undo.
Successful earlier migrations may remain after a later failure. Preserve backup
and migration-specific recovery procedures. No automatic down migration runs.

## Configuration Changes (Q1 2023)

`polis.config.template.js` and `polis.config.js` files are removed and no longer used.
`docker-dev.env` and `docker-db-dev.env` files are removed and no longer used.
`.env` and/or `prod.env` are now treated as the source of truth for the application and are ignored by git.
See `example.env` for local example values; runtime defaults depend on the read site. CDK/deployed secret inputs and Compose interpolation are distinct layers ([deployment configuration](deployment-configuration.md)).

Please read [configuration.md](./configuration.md) for onboarding and the [environment reference](configuration-env-reference.md) for the full scoped read-site inventory, fallback and secret status.

Values that have been renamed or replaced:

- **`DATABASE_FOR_READS_NAME`** has been replaced by **`READ_ONLY_DATABASE_URL`**
- **`API_SERVER_PORT`** is preferred, but **`PORT`** remains a fallback before `5000` ([config:10](../server/src/config.ts#L10)).
- **`SERVICE_HOSTNAME`** has been renamed to **`EMBED_SERVICE_HOSTNAME`**
- **`STATIC_FILES_ADMINDASH_PORT`** has been renamed to **`STATIC_FILES_ADMIN_PORT`**

Values introduced in that historical migration:

- **`API_DEV_HOSTNAME`**
- **`API_PROD_HOSTNAME`**
- **`GA_TRACKING_ID`**
- **`POSTGRES_HOST`**
- **`POSTGRES_PORT`**
- **`SERVER_ENV_FILE`**
- **`SERVER_LOG_LEVEL`**
- **`SERVER_LOG_TO_FILE`**
- **`STATIC_FILES_PARTICIPATION_PORT`**

## Current reader behavior and obsolete-name accounting

| Historical name / claim | Current source behavior |
| --- | --- |
| `DATABASE_FOR_READS_NAME` | No current source reader found. The API reads `READ_ONLY_DATABASE_URL`, falling back to `DATABASE_URL`; see [config:143](../server/src/config.ts#L143). |
| `PORT` renamed to `API_SERVER_PORT` | `PORT` remains an API fallback after `API_SERVER_PORT`; Python component configuration also reads `PORT`. See [API config:10](../server/src/config.ts#L10), [Python config:257](../delphi/polismath/components/config.py#L257). |
| `SERVICE_HOSTNAME` | No current source reader found. Legacy participation webpack uses `EMBED_SERVICE_HOSTNAME`; Alpha URL inputs are separate. See [webpack:86](../client-participation/webpack.config.js#L86), [Alpha net:13](../client-participation-alpha/src/lib/net.ts#L13). |
| `STATIC_FILES_ADMINDASH_PORT` | No current source reader found. API config reads `STATIC_FILES_ADMIN_PORT` with `STATIC_FILES_PORT` fallback; see [config:147](../server/src/config.ts#L147). |
| `DELPHI_MAX_WORKERS`, `DELPHI_WORKER_MEMORY` | Existing provisioning/configuration helpers write these names, but no current application read was found. They remain documented as historical helper outputs in `delphi/CLAUDE.md`, not active worker controls. The [start wrapper](../delphi/start_poller.py#L22) reads `MAX_WORKERS` and passes `--max-workers` to the job poller; see [job_poller.py:1395](../delphi/scripts/job_poller.py#L1395). |
| `DELPHI_CONTAINER_MEMORY`, `DELPHI_CONTAINER_CPUS` | Still read by Compose, with `16g` / `2` fallbacks; see [Compose:151](../docker-compose.yml#L151). They are not deleted or confused with the worker controls above. |

The removed old config-file names (`polis.config.js`, `polis.config.template.js`, `docker-dev.env`, `docker-db-dev.env`) are not the current Compose input path. See [server env-file selection](../docker-compose.yml#L58) and [Makefile overlay selection](../Makefile#L19).
