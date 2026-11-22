# Polis configuration

Most application settings are environment variables. Copy the repository-root `example.env` to `.env` and modify it for your launch path; example values are not universal runtime defaults. CDK context and explicit CLI/config arguments are separate configuration inputs.

The data export and vote import file formats, including the vote sign every file declares, are described in [export and import file formats](export-format.md).

The [environment read reference](configuration-env-reference.md) records all 233 named inputs and 680 read sites in the scoped API, Delphi, coordinator and CDK source, including file:line, fallback and secret status. The [deployment reference](deployment-configuration.md) connects those settings to all 153 P065 service entries and explains dynamic/SDK input limits.

</br>

## Overview

First things first, it helps to understand a bit how the system is set up.

| Component Name | Tech | Description |
|----------------|------|--------|
| [`server`][dir-server] | Node.js | The main server. Handles client web requests (page loads, vote activity, etc.) |
| [`client-participation`][dir-participation] | Javascript | The client code for end-users. |
| [`client-admin`][dir-admin] | Javascript | The client code for administrators. |
| [`client-report`][dir-report] | Node.js | The code for detailed analytics reports. |
| [client-participation-alpha](../client-participation-alpha) | Astro / React | Participation client with a Node server adapter; see [adapter configuration](../client-participation-alpha/astro.config.mjs#L15). |
| [delphi](../delphi) | Python | Narrative pipeline and the math engine (the `math-python` PostgreSQL poller, which replaced the retired Clojure `math` service); launch paths and defaults differ. |
| [coordinator-rs](../coordinator-rs) | Rust | Coordinator substrate and diagnostic/bridge tools; configuration alone does not grant publication authority. |

   [dir-server]: /server
   [dir-participation]: /client-participation
   [dir-admin]: /client-admin
   [dir-report]: /client-report

While this document will try to outline some of the more important configuration steps and options, you'll need to see
the individual READMEs for more detailed descriptions of how to configure these components.

## Environment variables and .env

> **Quickstart**
>
> Start with `example.env` for local development, then follow the selected profiles and service prerequisites. External integrations need their own configuration; copying the example does not establish working credentials.
>
> `cp example.env .env`

By default, `docker compose` will look for and use an `.env` file if one exists. However, any value present in your
environment or passed in on the command line will overwrite those in the file. Thus you should be able to set your
configuration values in whatever way suits your given scenario. (A plain text `.env` file is not always appropriate in
production deployments.)

Compose interpolation and container environment are separate layers: the server explicitly imports `${SERVER_ENV_FILE:-.env}` ([Compose:58](../docker-compose.yml#L58)), while other services map individual values. [Makefile:19](../Makefile#L19) selects overlays/profiles. A setting present in the host `.env` does not automatically reach every process.

If you are running these applications without Docker, just make sure that any environment variables you need are set in
the environment where the application is running.

If you are doing development on a url other than `localhost` or `localhost:5000`, you need to update the
**`API_DEV_HOSTNAME`** value to your development hostname:port, e.g. `myhost:8000` or `api.testserver.net`.
**`DEV_MODE`** should be `true`.

If you are deploying to a custom domain (not `pol.is`) then you need to update both the **`API_PROD_HOSTNAME`** and
**`DOMAIN_OVERRIDE`** values to your custom hostname (omitting `http(s)://` protocol).
**`DEV_MODE`** should be `false`.

### General Settings

- **`ADMIN_UIDS`** an array of user UIDs for site admins. These users will have moderator capabilities on all conversations hosted on the site.
- **`EMAIL_TRANSPORT_TYPES`** comma-separated list of email services to use (see [Email Transports](#email-transports) below)
- **`GIT_HASH`** Full lowercase source commit from `git rev-parse HEAD` (e.g. in `Makefile`), embedded with root `VERSION` at build time. The existing CI labels `test` and `characterization` are also accepted, explicitly reported with source `test-label`, unknown distance and development channel; they cannot assert stable provenance. Archive builds also accept `POLIS_BUILD_DISTANCE` for the first-parent distance from stable; omitted metadata is reported as `unknown`.
- **`MATH_ENV`** The math namespace the readers serve: `python` (the Python engine's rows, served in production), `prod` (rows the retired Clojure engine left behind; no longer updated), `dev`, `preprod` or an explicitly isolated namespace. The API reads it without a fallback ([config:128](../server/src/config.ts#L128)); Compose passes it to Delphi with fallback `prod` ([Compose:128](../docker-compose.yml#L128)); production sets it explicitly. It does not set the writer's label in `docker-compose.yml`: the `math-python` service writes `MATH_PYTHON_ENV` with fallback `python` ([Compose:191](../docker-compose.yml#L191)), so moving `MATH_ENV` moves only the readers. The standalone Python poller defaults to `dev` ([poller:234](../delphi/polismath/poller/service.py#L234)). The dev overlay runs `math-python` without a profile and has it write `MATH_ENV` unless `MATH_PYTHON_ENV` is set ([dev overlay:39](../docker-compose.dev.yml#L39)).
- **`SERVER_ENV_FILE`** The name of an environment file to be passed into the API Server container by docker compose. Defaults to `.env` if left blank. Used especially for building a `test` version of the project for end-to-end testing.
- **`SERVER_LOG_LEVEL`** Used by Winston.js in the API server. Common values are `debug`, `info`, `warn`, and `error`. The config module reads the raw value ([config:116](../server/src/config.ts#L116)); the logger then falls back to `warn` ([logger.ts:9](../server/src/utils/logger.ts#L9)).

### Database

- **`READ_ONLY_DATABASE_URL`** (optional) Database replica for reads.

#### Required when using the docker postgres service (optional)

- **`POSTGRES_DB`** database name (e.g. `polis-dev`)
- **`POSTGRES_HOST`** database hostname (e.g. `postgres` within Compose, `localhost` from the host). Keep the port separate when mapped to Delphi `DATABASE_HOST` ([Compose:136](../docker-compose.yml#L136)).
- **`POSTGRES_PASSWORD`** database password
- **`POSTGRES_PORT`** typically 5432
- **`POSTGRES_USER`** typically `postgres`. Any username will be used by the docker container to create a db user.

#### Required in all cases

- **`DATABASE_URL`** should be the combination of above values, `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}` (URL-encode user/password components)
- **`POSTGRES_DOCKER`** Selects the local database profile through [Makefile:26](../Makefile#L26). Set it explicitly to `false` for an external database or `true` for the local profile; Make parses the configured value rather than applying an application default.

#### DynamoDB

- **`DYNAMODB_ENDPOINT`** (optional) DynamoDB endpoint. The server shared builder uses the AWS SDK endpoint when absent ([dynamoClient:41](../server/src/utils/dynamoClient.ts#L41)); Python constructors have distinct local fallbacks. Follow the [per-site reference](configuration-env-reference.md), especially when moving between host and container networking.

#### Connection budget

The participant-facing path — submitting a vote, submitting a comment, and
getting the next statement — must always answer promptly and must never wait on
or be rejected because of other work. Everything else (reports, data exports,
the math engine, the analysis service, imports, admin views) is capped so it can
never take the database connections that path needs. There is no read replica;
the isolation is the connection count per workload, not a separate host. Keep the
sum of the caps below comfortably under the database's `max_connections`.

The API server opens these pools per process ([pg-query.ts](../server/src/db/pg-query.ts)):

- **The participation pools**, a read-write pool and a read pool, used by the
  participation routes and nothing else: `POST /votes`, `POST /comments`,
  `GET /nextComment` and `GET /participationInit`, from their first middleware
  to the bookkeeping they schedule. Each route enters them first
  ([app.ts](../server/app.ts)), and every query made while serving it runs
  there, so no other work can hold the connections a vote needs. A
  participation query waits for a connection and is never refused under load.
  The read pool reads the replica when `READ_ONLY_DATABASE_URL` names one, as
  the read pool below does; otherwise the primary. They are created on the first
  participation request, so a process that serves none (the import worker) never
  opens them.
- **The read-write and read pools**, for everything else: the other requests a
  participant makes (the opinion map `GET /math/pca2`, the comment list,
  `GET /votes`, topic selection), admin views, report page tallies, imports.
  They have no acquire timeout and no statement timeout, on purpose: a
  participant's request that has to wait for a connection waits and is
  answered; it is never refused.
- **A results pool** for Delphi result reads (`RESULT_SNAPSHOT_POOL_MAX`, 8 in
  production), created only under the Postgres result backend. The topical
  routing of the next statement reads results on the participation read-write
  pool instead.
- **The report/export pool** and **the agent exchange pool** (2 connections,
  5 s acquire, 60 s statement), below.

The participation pools and the read-write and read pools are each `max` 12 in
production (2 in dev, 3 when a read replica is configured); the participation
pools can be set:

- **`PARTICIPATION_POOL_MAX`** maximum connections for the participation read-write pool. Default: as above (12 in production).
- **`PARTICIPATION_READ_POOL_MAX`** maximum connections for the participation read pool. Default: as above (12 in production). With no read replica it is a second pool on the primary, like the read pool.
- **`PARTICIPATION_ACQUIRE_TIMEOUT_MS`** how long a participation query waits for one of those connections. Default `60000`; `0` waits without limit. Only participation work holds these connections, each for milliseconds (a vote takes 4.6 ms at the median and 15.3 ms at p99 on a local stack), so no load of votes and comments comes near this: a wait this long, six times the participation client's 10 s request timeout, means the database has stopped answering, and the request then fails instead of joining a queue that grows without end. It is not a load-shedding bound; do not lower it to one. These pools have no statement timeout; the transactions that need one set it with `SET LOCAL`.

Reports, data exports and heavy admin reads run on a deliberately small pool of
their own, with their own, longer bounds:

- **`REPORT_EXPORT_POOL_MAX`** maximum connections for the report/export/heavy-admin-read pool. Default `1`: reports, exports and heavy admin reads run one at a time, and the rest wait up to the acquire timeout. Reports, the `/api/v3/dataExport` CSV routes ([report.ts](../server/src/report.ts)), the comment-clusters export, `conversationStats` and the moderator participant query run here; participant-facing reads never do.
- **`REPORT_EXPORT_ACQUIRE_TIMEOUT_MS`** how long a report/export waits for one of those connections before it is rejected. Default `30000`. When the pool is full a new report/export fails here (it degrades itself) rather than waiting on, or spilling into, a participant-facing connection.
- **`REPORT_EXPORT_STATEMENT_TIMEOUT_MS`** per-statement cap for that pool, applied as each connection is created. Default `300000` (five minutes), generous so today's largest exports still succeed. Streamed exports read their cursor in small batches, so this bounds a single runaway statement rather than a long stream. Raise it if a deployment has larger exports; lowering it can make a large report or export time out.

The other workloads cap themselves through their own pool settings, each a member of the budget:

- **Math engines** read `DATABASE_POOL_SIZE` (the Clojure engine's HikariCP pool, default 3; the Python engine's pool, default 5) and the Python engine also reads **`DATABASE_MAX_OVERFLOW`** (default 10), so one Python engine process uses at most 5 + 10 = 15 pooled connections plus one dedicated writer-lock connection. One process per shard.
- **`POLIS_JOBS_CONCURRENCY`** the queue daemon's worker count (default 1); each daemon uses two connections plus one per running job.
- **`POLIS_API_DB_POOL`** the typed read API server's pool (default 8), with **`POLIS_API_DB_ACQUIRE_TIMEOUT_MS`** (2000) and **`POLIS_API_DB_STATEMENT_TIMEOUT_MS`** (3000).
- **`POLIS_API_PCA_CACHE_ENTRIES`** maximum conversations retained in the per-process PCA cache, including their math and presentation bodies. Default `300`; blank uses the default and invalid values refuse startup. Accepts positive integers. `CACHE_MATH_RESULTS=false` keeps at most one conversation. The byte limit below also applies. Other route caches are unchanged.
- **`POLIS_API_PCA_CACHE_BYTES`** bounds retained PCA math and presentation bodies together (bytes; default `201326592`, or 192 MiB). Blank uses the default; invalid, negative or out-of-range values refuse startup. The cache evicts least-recently-used conversations until both its entry and byte limits hold. An oversized conversation is served without retaining it; an oversized presentation also drops its source. `0` retains no bodies: every request reads the full math row, parses and rebuilds it, including gzip. Very small budgets repeatedly rebuild larger conversations; cyclic polling of a set just above either bound can miss on every request. `/health.pcaCache` reports entries, accounted bytes, both limits, byte/entry eviction counts and oversized admissions. Accounting includes parsed object capacities, gzip bodies, allocation padding and entry metadata, counting shared math/presentation storage once; it is not process RSS. The default leaves 320 MiB of a 512 MiB container for transient builds, active responses, database buffers, allocator retention and other memory. Concurrent or exceptionally large requests can still exceed that headroom. Values above the container limit are accepted silently because configuration parsing does not inspect deployment limits; such an override can remove memory protection. Evictions change cache misses, not response encoding or headers.
- The import worker reuses the API server's read-write and read pools (never the participation pools), so it carries those pools' per-process budget; it scales to a small number of tasks on queue depth.

Production total against its single primary (no read replica; the RDS
instance uses the default parameter group, so `max_connections` is RDS's
default for a db.t3.large, its memory divided by 9531392, about 900;
`SHOW max_connections` gives the exact value). One API server's pools hold at
most 12 + 12 (participation) + 12 + 12 (read-write, read) + 1 (report/export)
+ 2 (agent exchange) = 51 connections, up from 27 before the participation
pools, plus 8 for the results pool under the Postgres result backend only
(59, up from 35). Idle connections close after 10 s, so these are ceilings,
not the usual count. The fleet as deployed runs 2 API servers (the web group's
desired and minimum count), so the API servers reach at most 102 (118 with the
results pool), and with ~16 for the Python math engine on the analysis box the
total is about 120-135, well under `max_connections` and the connection alarm
at 500. The import worker (0 tasks normally, at most 5 on queue depth) opens
only the read-write, read and report/export pools, up to 25 each. If the web
group scales out, each further server adds at most 51-59; size
`max_connections`, the alarm and any per-login limits against the sum of all
the caps above.

### Docker Concerns

- **`TAG`** selects Compose image tags; defaults to `dev` at [Compose:242](../docker-compose.yml#L242). Project naming is configured separately.
- **`COMPOSE_PROJECT_NAME`** Used by docker compose to label containers and volumes. Useful in development if you are (re)-building and deleting groups of docker assets.

### Ports

- **`API_SERVER_PORT`** typically 5000. Used internally within a docker network and/or behind a proxy. The exact fallback order is `API_SERVER_PORT`, then `PORT`, then `5000` ([config:10](../server/src/config.ts#L10)).
- **`HTTP_PORT`** typically 80. Port exposed by Nginx reverse proxy.
- **`HTTPS_PORT`** typically 443. Port exposed by Nginx reverse proxy.
- **`STATIC_FILES_PORT`** typically 8080. Used internally within a docker network and/or behind a proxy.
- **`STATIC_FILES_ADMIN_PORT`** same as **`STATIC_FILES_PORT`** unless you are hosting client-admin separately from file-server. Useful in local development.
- **`STATIC_FILES_PARTICIPATION_PORT`** same as **`STATIC_FILES_PORT`** unless you are hosting client-participation separately from file-server. Useful in local development. Both admin/participation paths ultimately fall back to `8080` ([config:147](../server/src/config.ts#L147)).

### Email Addresses

- **`ADMIN_EMAIL_DATA_EXPORT`** email address from which data export emails are sent.
- **`ADMIN_EMAIL_EMAIL_TEST`** email address to receive backup email system test.
- **`ADMIN_EMAILS`** array of email addresses to receive team notifications.
- **`POLIS_FROM_ADDRESS`** email address from which other emails are sent.

### Boolean Flags

(All can be left blank, or `false`)

- **`CACHE_MATH_RESULTS`** Set this to `true` to instruct the API server to use LRU caching for results from the math service. Default is `true` if left blank.
- **`DATABASE_SSL`** Set this to `true` for some production environments. Default is `false`.
- **`DEV_MODE`** Set this to `true` in development and `false` otherwise. Used by API Server to make a variety of assumptions about HTTPS, logging, notifications, etc.
- **`SERVER_LOG_TO_FILE`** Set this to `true` to tell Winston.js to also write log files to server/logs/. Defaults to `false`. *Note that if using docker compose, server/logs is mounted as a persistent volume.*
- **`SHOULD_USE_TRANSLATION_API`** Set this to `true` if using Google translation service. See [Enabling Comment Translation](#enabling-comment-translation) below.
- **`USE_NETWORK_HOST`** Set this to `true` if using server within an internal network (e.g. AWS) such that SSL is not required.

### URL/Hostname Settings

- **`API_DEV_HOSTNAME`** defaults to `localhost:5000` in [config:5](../server/src/config.ts#L5); set it to the development hostname and port you actually use.
- **`API_PROD_HOSTNAME`** the hostname of your site (e.g. `pol.is`, or `example.com`). Should match **`DOMAIN_OVERRIDE`**. (In the future these two options may be combined into one.)
- **`DOMAIN_OVERRIDE`** the hostname of your site. Should match **`API_PROD_HOSTNAME`**.
- **`EMBED_SERVICE_HOSTNAME`** is a legacy participation build input with fallback `pol.is` ([webpack:86](../client-participation/webpack.config.js#L86)); set it for the target environment. Alpha uses separate `PUBLIC_SERVICE_URL` / `INTERNAL_SERVICE_URL` inputs ([net.ts:13](../client-participation-alpha/src/lib/net.ts#L13)).
- **`SERVICE_URL`** used by client-report to make API calls. Only necessary if client-report is hosted separately from the API service. Can be left blank.
- **`STATIC_FILES_HOST`** Used by the API service to fetch static assets (the compiled client applications) from a static file server. Within the docker compose setup this is `file-server`, but could be an external hostname, such as a CDN or S3 bucket.

### Authentication

- **`AUTH_ISSUER`** The OIDC tenant domain URL for standard user authentication (e.g. `https://your-tenant.auth0.com/`).
- **`AUTH_AUDIENCE`** The API identifier/audience for OIDC (e.g. `users` or `https://your-api.com`).
- **`AUTH_CLIENT_ID`** The OIDC SPA client ID for your application.
- **`JWKS_URI`** The JWKS URI for your OIDC tenant (e.g. `https://your-tenant.auth0.com/.well-known/jwks.json`).
- **`POLIS_JWT_ISSUER`** The issuer for in-house JWTs (XID and anonymous participants). Defaults to `https://pol.is/`.
- **`POLIS_JWT_AUDIENCE`** The audience for in-house JWTs. Defaults to `participants`.
- **`JWT_PRIVATE_KEY_PATH`** Path to the RSA private key for signing in-house JWTs.
- **`JWT_PUBLIC_KEY_PATH`** Path to the RSA public key for validating in-house JWTs.
- **`JWT_PRIVATE_KEY`** Base64-encoded RSA private key (alternative to file path).
- **`JWT_PUBLIC_KEY`** Base64-encoded RSA public key (alternative to file path).
- **`OIDC_CACHE_KEY_PREFIX`** Legacy participation cache-key prefix, default `oidc.user` ([webpack:88](../client-participation/webpack.config.js#L88)); Compose maps it to Alpha `PUBLIC_OIDC_CACHE_KEY_PREFIX` ([Compose:47](../docker-compose.yml#L47)).
- **`OIDC_CACHE_KEY_ID_TOKEN_SUFFIX`** The suffix for the OIDC cache key. Defaults to `@@user@@`.

### Polis 2 permission

Starting Polis 2 work (a Delphi pipeline run, a narrative batch, a collective statement, the legacy narrative) needs an account that may use Polis 2, and then the conversation's owner or a site administrator ([generationOwner.ts](../server/src/routes/delphi/generationOwner.ts)). Whether the account may use Polis 2 is answered in one place, [entitlement.ts](../server/src/routes/delphi/entitlement.ts), and `GET /api/v3/delphi/me` gives the signed-in caller the same answer as `{"delphi_entitled": true}` or `{"delphi_entitled": false}`.

- **`POLIS_DELPHI_ENTITLEMENT`** Where that answer comes from. Read at startup by [config](../server/src/config.ts) as `delphiEntitlement`; any value other than the three below stops the server.
  - `claim` (the default, also when unset or blank): the access token's `${AUTH_NAMESPACE}delphi_enabled` claim, set by the identity provider. The database is never read for this.
  - `claim_or_db`: the claim, or else a row for the account in the `delphi_entitlements` table (migration `000048`).
  - `db`: a row in `delphi_entitlements` only; the claim is not consulted.

  With `claim_or_db` or `db` each of those requests makes one read of `delphi_entitlements` by primary key on the server's ordinary read-write pool; votes, comments and the next comment never make it. The vote CSV import (`POST /api/v3/votes-bulk`) still reads the claim directly under every value.

### Operations pages

The admin console can show read-only, aggregate operations pages at `/ops` (served by `/api/v3/ops/*`). They are off by default.

- **`OPS_ENABLED`** Set to `true` (or `1`, `yes`, `on`) to switch the pages on. Unset or anything else: every `/api/v3/ops` path answers 404, the server does not serve `/ops`, and the admin console shows no link. Read at [config](../server/src/config.ts) as `opsEnabled`. When it is on, the server also needs `AUTH_NAMESPACE`, `AUTH_AUDIENCE` and `AUTH_ISSUER`; if any is missing it logs one `ops_disabled` error at start-up and keeps the pages off.
- **`OPS_EMAIL_DOMAINS`** Who may open the pages; read only when `OPS_ENABLED=true`. A comma-separated list; entries are trimmed and lower-cased, and empty entries are ignored. Each entry is one of:
  - a **domain**, e.g. `example.org`: the verified email's domain part equals it exactly (`evilexample.org`, `sub.example.org` and `example.org.example.com` do not match), **and** the login carries Google's `hd` (hosted domain) equal to that domain. Only Google Workspace accounts of the domain have `hd`, so a consumer Google account once created on a domain address is refused. A deployment whose domain is not on Google Workspace has no `hd` and must list people by address;
  - an **address**, e.g. `someone@example.org`: the verified email equals it exactly; no `hd` is required (an `hd`, if present, must still equal the email's domain);
  - either form prefixed with **`!`**, e.g. `!former@example.org`: a deny entry. A deny match wins over every allow entry.

  Examples: `OPS_EMAIL_DOMAINS=example.org` (everyone at one domain); `OPS_EMAIL_DOMAINS=example.org,collaborator@example.com` (plus one outside address); `OPS_EMAIL_DOMAINS=example.org,!former@example.org` (everyone at the domain except one person). With `OPS_ENABLED=true`, a list with no allow entry or a malformed entry (a `*`, whitespace inside an entry, more than one `@`, a leading `@`, a domain without a dot, any character outside printable ASCII) is logged once at start-up as an `ops_disabled` error naming the entry, and the pages stay off (404). The rest of the API is unaffected. An allow entry on `polis.test` is refused the same way unless `DEV_MODE=true`.

A request is let through only when, in this order: `OPS_ENABLED=true`; it carries an OIDC access token that passes the server's issuer, audience and signature checks (participant, XID and anonymous tokens do not); the token's `${AUTH_NAMESPACE}connection_strategy` claim is `google-oauth2`; `${AUTH_NAMESPACE}email_verified` is `true`; `${AUTH_NAMESPACE}email` is printable ASCII and matches `OPS_EMAIL_DOMAINS` with no deny entry matching; and `${AUTH_NAMESPACE}hd` equals the email's domain (required when the email is admitted by a domain entry, optional for an address entry). The identity provider must add the `connection_strategy` claim (and `hd` when the login has one); until it does, every request is refused. Refusals answer 403 `polis_err_ops_forbidden`. Refused page reads with a token are logged as `ops_access` lines with the reason; other refusals (mostly the admin console's `whoami` check for logins without access) are counted and summarised in at most one `ops_refused` info line per minute per process. An ops request does not create or update any user record.

What the pages read, all from the server process (nothing is read while nobody has a page open, and each panel is cached for at least 60 s and shared by every viewer):

- **Activity now** and **Activity over time**: platform-wide counts from `votes` and `comments`, on the `votes(created)` and `comments(modified)` indexes, per hour (48 h), per day (90 d), and conversations started per month (one pass over `conversations`).
- **What people are talking about** and **What consensus they found**: the most active conversations of the last 7 days with their topic, Delphi topic names (DynamoDB `Delphi_CommentClustersLLMTopicNames`), and the common-ground and group-distinctive statements from the published math (`math_main`, label `python`), with statement text only for statements visible to participants.
- **Database**: Postgres statistics views (`pg_stat_activity` without query text, user or client address; `pg_stat_user_tables`; `pg_stat_database`). The `pg_read_all_stats` role is optional: without it, sessions of other database roles are still counted but their state shows as "not visible (counts only)". (On RDS the master user has it.)
- **Where visitors come from**: the Simple Analytics Stats API (below).
- **Math engine**, **Serving**, **Boxes and deploys** and **Cost**, and the RDS panel of **Database**: AWS reads, only with `OPS_DATA_SOURCE=aws` (below). The Postgres parts of Math engine and Serving (the math poller's single-writer lock in `pg_locks`, publications in `math_ticks`, and how far live conversations' `math_main.last_vote_timestamp` is behind their newest vote, on the `votes(created)` index) run either way.

Every database read runs in a `READ ONLY` transaction with a 3 s statement timeout, one at a time per server process, with a client-side timeout so a lost connection cannot hold the pages' one connection.

- **`OPS_MIN_VOTERS_FOR_TEXT`** The topics and consensus pages show a conversation's topic, its Delphi topic names and statement text only when it had at least this many distinct voters in the last 7 days; below that it is counted, never named. A whole number, at least 1. Default `20`. Any other value is logged once as an `ops_config_invalid` error and `20` is used, so a typo cannot lower it. Read at [config](../server/src/config.ts) as `opsMinVotersForText`.
- **`SIMPLE_ANALYTICS_API_KEY`** A Simple Analytics API key (Simple Analytics account settings) for the "Where visitors come from" page, which shows pageviews of the participation, admin and report apps by country and by referring site over the last 30 days. Sent only as the `Api-Key` header to `simpleanalytics.com`, never logged or returned. Unset (the default): the page says so and reads nothing.
- **`SIMPLE_ANALYTICS_HOSTNAME`** The site name the apps report under in Simple Analytics. Default `pol.is`. The three apps share it and are told apart by the paths the server serves each one on.
- **`OPS_DATA_SOURCE`** Set to `aws` to let the system pages read AWS: CloudWatch Logs (`FilterLogEvents` on the `delphi` and `server` streams of `AWS_LOG_GROUP_NAME`: the math poller's readiness, capacity and lock lines, publications per minute, memory-admission and failure lines, and the server's math refusal lines, all counted or checked against the poller's closed schema), CloudWatch metrics and alarms (`GetMetricData`, `ListMetrics`, `DescribeAlarms` for names starting `Polis-`), Auto Scaling (`DescribeAutoScalingGroups`), CodeDeploy (`ListDeployments`, `BatchGetDeployments` for `PolisApplication`/`PolisDeploymentGroup`) and, with `OPS_COST_EXPLORER`, Cost Explorer. Unset or anything else (the default): those panels are left out, each page says why, and nothing is requested from AWS. Read at [config](../server/src/config.ts) as `opsDataSource`. The reads always use the EC2 instance role through the instance metadata service, never `AWS_ACCESS_KEY_ID`, so the role must carry the read actions above (logs reads are already in its managed policies; the rest are one CDK statement behind `-c enableOpsDashboards=true`). Until it does, each affected panel shows "not permitted" and the rest of the page still works. Every request has a 5 s timeout and every panel a 12 s deadline, after which its remaining requests are aborted; a 24-hour log count whose scan hit its page limit is marked partial; a failure is shown as a short reason code, never AWS error text. The log group is `AWS_LOG_GROUP_NAME` (written by the deploy hook); with it unset or `docker`, the log panels are left out. The RDS panel reads the instance whose endpoint `DATABASE_URL` names, and is left out when that is not an RDS endpoint. The load balancer panel reads only the stack's load balancer (the `Lb` construct, named `<stack>-Lb…`). The AWS SDK clients are loaded on the first AWS read, so a server with these pages off loads none of them.
- **`OPS_COST_EXPLORER`** Set to `1` (or `true`) to show the Cost page: daily unblended cost by service for this AWS account over the last 30 days, and month to date against last month. Off by default because every Cost Explorer request is billed ($0.01). Read only when `OPS_DATA_SOURCE=aws`; each server process makes at most one read per 12 hours, failed or not, and only while someone has the page open. A read is one request, or two when Cost Explorer pages its answer, so the bound is two billed requests per web process per 12 hours. The request's end date is tomorrow (exclusive), so today's partial day is included. Needs `ce:GetCostAndUsage` on the instance role. Read at [config](../server/src/config.ts) as `opsCostExplorer`.

### Third Party API Credentials

(Requirements depend on the selected integration and launch path. Missing values do not universally disable a feature cleanly; constructors and request paths can fail. See the [service inventory](deployment-configuration.md#external-service-touchpoints).)

- **`GA_TRACKING_ID`** For using Google Analytics on client pages.
- **`GOOGLE_CREDENTIALS_BASE64`** Required if using Google Translate API. (See below).
- **`GOOGLE_CREDS_STRINGIFIED`** Alternative to **`GOOGLE_CREDENTIALS_BASE64`** (See below).
- **`AWS_REGION`** Used for some data import/export.
- **`AWS_ACCESS_KEY_ID`**, **`AWS_SECRET_ACCESS_KEY`** Useful for AWS SDK operations.
  Leave both **unset** in production to use the AWS default credential provider
  chain (the EC2 instance role). Set both to real static credentials to use them
  explicitly; temporary credentials are not supported here, as `AWS_SESSION_TOKEN`
  is not read — put those on the default chain instead. Setting either to the
  literal string `local` is rejected when the shared DynamoDB builder would otherwise use the default chain: the SDK's environment provider would send
  that placeholder to AWS, so the DynamoDB clients refuse to start and report
  `polis_err_aws_credentials_placeholder`. Its explicit local-endpoint branch bypasses that guard and supplies public emulator credentials ([builder:160](../server/src/utils/dynamoClient.ts#L160)). For local development set
  `DYNAMODB_ENDPOINT` (and `AWS_S3_ENDPOINT` for MinIO) instead. These two
  variables are shared by every AWS client in the server and delphi containers —
  DynamoDB, S3/MinIO, SES and SQS — so declare each exactly once per environment
  file. The explicit credential-pair/placeholder rules above belong to the server
  [shared DynamoDB builder](../server/src/utils/dynamoClient.ts#L52); they do not
  establish identical credential behavior for every Python or AWS client.
- **`ANTHROPIC_API_KEY`** For using Anthropic as a generative AI model.
- **`GEMINI_API_KEY`** For using Gemini as a generative AI model.
- **`OPENAI_API_KEY`** For using OpenAI as a generative AI model.

### Delphi LLM Selection

The `delphi` service has no `env_file`, so it sees only the keys its `environment` block lists ([Compose:137](../docker-compose.yml#L137)). Setting any other key in `.env` or the production env document has no effect on the job service. `delphi/tests/test_compose_math_env.py` fails if the Delphi code reads a provider or model key that Compose does not forward.

- **`LLM_PROVIDER`** Topic-naming provider: `anthropic` (Batch API) or `ollama`. Compose fallback `anthropic`.
- **`ANTHROPIC_MODEL`** Narrative-report model, and the topic-naming fallback when `ANTHROPIC_TOPIC_MODEL` is empty.
- **`ANTHROPIC_TOPIC_MODEL`** Topic-naming model. Resolution order is `ANTHROPIC_TOPIC_MODEL`, then `ANTHROPIC_MODEL`, then `claude-haiku-4-5-20251001` ([topic_naming:76](../delphi/umap_narrative/topic_naming.py#L76)). Compose fallback empty.
- **`TOPIC_BATCH_MAX_WAIT_SECONDS`** Longest wait, in seconds, for one layer's Anthropic topic-naming batch. Compose fallback `1800`.
- **`SENTENCE_TRANSFORMER_MODEL`** Local embedding model for the narrative pipeline, kept to its first 384 dimensions and normalized. Compose fallback `ibm-granite/granite-embedding-311m-multilingual-r2`. With `DELPHI_EMBED_MODEL_PATH` set (the Compose default) it must name the directory's model or be empty, else the run is refused. Without it, the default model is fetched by name once, at the revision in `delphi/embedding-model.lock.json`, and checked against that lock before every load; any other name is loaded from the model hub as given, unchecked.
- **`DELPHI_EMBED_MODEL_PATH`**, **`DELPHI_EMBED_MODEL_LOCK`** The embedding model's directory and its lock; every file is checked against the lock before the model loads, and nothing is downloaded. Compose fallbacks for the `delphi` service are the copy baked into the image, `/opt/polis/embedding/granite-embedding-311m-multilingual-r2` and `/opt/polis/embedding/granite-embedding-311m-multilingual-r2.lock.json`, the same as the Delphi shadow's. Another model needs both, with `SENTENCE_TRANSFORMER_MODEL` naming it.
- **`OLLAMA_HOST`**, **`OLLAMA_ENDPOINT`**, **`OLLAMA_MODEL`** Used only when `LLM_PROVIDER=ollama`. `OLLAMA_ENDPOINT` is the older name for `OLLAMA_HOST`. Compose fallbacks are empty.

### Comment Embeddings Table

Off by default; nothing changes until it is set, and off is today's behaviour byte for byte.

- **`DELPHI_EMBEDDINGS_TABLE`** (default off) When set to exactly `1`, the Delphi job daemon and the graph stages store and read comment embeddings as one row per comment in the `delphi_comment_embeddings` table (migration 000038) instead of the `Delphi_CommentEmbeddings` codec family, which a few thousand comments of 384 floats already overflow at the family's 64 MiB bound. It is read by the `polis-jobs` daemon ([config.rs](../queue-rs/src/jobs/config.rs)) and carried from the daemon into each Delphi child through the job frame, never through the child's environment (graph children run with a cleared environment). Because the Delphi service does not read it from its own environment, it is not listed in the `delphi` Compose `environment` block. Only the graph path (`graph_embed`/`graph_cluster`) routes to the table today; the legacy full pipeline keeps writing the codec family.

### Topic Map Document

Off by default; nothing changes until it is set, and off is today's behaviour byte for byte.

- **`DELPHI_TOPIC_MAP_DOCUMENT`** (default off) When set to `1` (surrounding white space is ignored; any other value is off) on a Delphi job daemon whose results go to Postgres (`DELPHI_RESULT_BACKEND=postgres`), each full pipeline run ends by storing its topic map in its own result batch, beside the families it is drawn from, as the family `Delphi_TopicMapDocument` (migration 000049 must be applied first, or the run fails when the daemon stores the family). The daemon passes its environment to the run, which reads the setting in [topic_map.py](../delphi/polismath/delphi_storage/topic_map.py) and calls the image's `polis-topic-map store`. A map is the `polis-topic-map/1` document, its gzip and its SHA-256; a run with nothing to draw, or whose document would be a row over 1 MiB, stores one `no_map` row with the reason; beside either, an `execution` row holds the run's own record of its steps (its comment selection and counts, each step's seconds, the parameters of UMAP, the clustering, the keywords and the topic naming), which the document's provenance repeats. The document holds no comment text: no per-comment text, and the only topic names it keeps are generic ones (`Topic <n>`) and the keyword fallback's keywords, never the example comment the fallback appends; every other name, a model's free-form name among them, is shown as `Topic <n>`, because nothing checks a model's name to be free of a comment's words. Who wrote each name (a model, or a fallback after a missing or empty response) is recorded by the naming itself in the execution row, never read from the name. Nothing calls a model. In Compose it is passed to the `delphi-shadow` daemon only (`${DELPHI_TOPIC_MAP_DOCUMENT:-0}`); a run of any other backend stores nothing and logs that it did not. `DELPHI_TOPIC_MAP_BIN` names another generator binary (tests only). For runs stored before the setting, `polis-topic-map from-run --env ENV --job ID --out DIR`, run where the daemon's queue settings are, writes the same family file and the document to a directory and never writes to the database (a run stored before the step has no execution record, and its document says so).

  **Rollback floor: once a run has stored a map, no release older than the one that added this setting can run or read that run's conversation in that publication scope.** An older Delphi image refuses every later run whose previous results hold the family (`unsupported base family`), and an older Rust API refuses that run's typed run record (the family is not one it knows). Turning the setting off afterwards does not remove stored maps (stored results are immutable) and does not restore compatibility. Before setting it, make the release that added it the oldest release either the Delphi service or the API will be rolled back to.

### Delphi Shadow Job Graphs

`DELPHI_SHADOW_GRAPH_CONVERSATIONS` is a comma- or whitespace-separated list
of conversation codes. It is empty by default: no graph admission, graph
polling, additional roster query, or graph log is made. Only list conversations
whose comments are already public: the current graph copies comment text into
immutable snapshots, and has no retention delete path. The featured set is
independent and unchanged.

`DELPHI_SHADOW_GRAPH_ENV` defaults to `shadow-graph-1` and must be a distinct
`shadow-` namespace from `DELPHI_SHADOW_ENV`. Enabling the list requires the
separately installed admission-function extension and a daemon claiming the
four graph stages in that namespace. Without those prerequisites, keep the
list empty. This code does not change the served result namespace.

Graph runs have four job ids: embedding, UMAP with EVoC, TF-IDF keywords, and
keyword topic labels. The last step writes model `none` and no narrative.
Admission refuses more than 2,000 comments or a specification over 1 MiB.
The existing shadow pacing, daily run and storage budgets apply. The scheduler
waits for every node and confirmed process exits, publishes with a generation
check, and logs each job id, run id, stage, elapsed execution seconds and bytes.
Finished results are retained when a later node fails. A deadline or dead node
cancels unfinished nodes through the queue's fenced management operation.

### Delphi Shadow Comment Rules

Every Delphi shadow full-pipeline run embeds every comment of its
conversation, and lays out (UMAP), clusters (EVoC) and names the comments of
one rule. Every conversation the shadow runs is run under
`participant_visible/1`. Two lists of conversation codes add runs under the
other rules; they replace nothing. Both are read as `DELPHI_SHADOW_BENCHMARK`
is: commas or white space, a repeat kept at its first place, an entry that is
not 1 to 64 letters and digits refused at startup by its position. Both are
empty by default, and then every run is as it was.

| Rule | Lays out | Run for |
|---|---|---|
| `participant_visible/1` | what participants are shown (the server's participant comment list) | every conversation the shadow runs |
| `all_comments/1` | every comment: unmoderated, moderated in and moderated out | the conversations `DELPHI_SHADOW_ALL_COMMENTS` lists, as well |
| `all_but_moderated_out/1` | every comment but the moderated-out ones, whatever strict moderation says | the conversations `DELPHI_SHADOW_ALL_BUT_MODERATED_OUT` lists, as well |

A conversation on both lists runs under all three rules. Each (conversation,
rule) is its own job:
- its own admission key and run record, which names the rule
  (`config_effective.selection`, with the digest and count of what it lays
  out);
- its own publication scope (`delphi`, `delphi:all_comments`,
  `delphi:all_but_moderated_out`), so no rule's results replace another's;
- its own decision whether anything changed, read from its newest run in the
  database.

A run under a list's rule is made when what that rule keeps has changed since
its newest run, within the same rerun interval. A moderation that does not
change what a rule keeps runs nothing under it. A selection that changed and
changed back runs again, because the run it would return to has been
superseded. Two codes of one conversation in one list are one run.

A list adds runs, not candidates: a listed conversation is run only when the
benchmark, featured or current set picks it, within the same comment cap,
pacing, time and storage limits, after the sets' own runs. Taking a code off a
list stops new runs under that rule and deletes nothing. Every run under a
list's rule checks, in the same database snapshot as its census, that a code
of that list still names the conversation; when none does, nothing is queued
and the codes are read again. The job-graph path is separate and follows none
of these rules. No reader serves these runs.

### Delphi Shadow Resources

Read only where the Delphi shadow runs (its services start on the exact line `DELPHI_SHADOW_ENABLED=1`). Compose alone reads this key, for the `delphi-shadow` container's limit; no service sees it.

- **`DELPHI_SHADOW_CONTAINER_CPUS`** (`delphi-shadow`, default `2`) the shadow daemon's CPU limit ([Compose:541](../docker-compose.yml#L541)), behind the lowest CPU weight of any service. The daemon runs one library thread (torch, Numba, OpenMP, OpenBLAS) per CPU of the limit; a positive number sets that many CPUs. `0` removes the limit: the shadow then takes the CPU nothing else is using and its libraries count the box's CPUs. Measured with `make check-delphi-shadow-cpu-priority` ([local checks](local-checks.md)), the math engine's recompute ran, while the shadow embedded, about 5-7 % slower with the 2-CPU limit and 9-13 % with none on a 12-vCPU arm64 host, and 16-17 % and 41-43 % on a 6-core, 12-thread x86 desktop with hyperthreading. Keep a limit on a burstable instance, where an unlimited shadow would spend the CPU credits the whole box runs on.

### Large Memory Class

Off by default; nothing here changes behaviour until `MATH_CAPACITY_ROUTING=1`. The design is in [MATH_POLLER_DESIGN.md §7-§8](../delphi/docs/MATH_POLLER_DESIGN.md). Compose lists every setting explicitly (`math-python` has no `env_file`), so a value set in `.env` or the deployment env document reaches the container only through these lines.

There is no resident large worker. With routing on, a conversation the small poller's estimator says would not fit becomes one `math_rebuild` job of worker class `large` on the Postgres job queue (`polis-queue`, migrations 000019 and 000023 plus the `polis-queue/3` functions), inserted by `math-python` through the queue's SQL functions. The large box runs the `polis-jobs` daemon as a worker of class `large`; for each job it runs `scripts/math_poller.py --job` as a child, which computes exactly that conversation (a cold full-history rebuild under its own memory budget) and publishes it under the literal label `python-large`; `math-python` promotes the staged bundle into its own label.

| Service | Role | Label (`math_env`) and lock |
|---|---|---|
| `math-python` | small poller, the single writer of the served label; routes, enqueues, promotes | `MATH_PYTHON_ENV` (`python`) |
| the queue child (`math_poller.py --job`, under the daemon on the large box) | computes one conversation per job, writes only the staged label | `python-large` (its `MATH_ENV`, bound to the job's frame) |

- **`MATH_CAPACITY_ROUTING`** (`math-python`, default `0`) `1` sizes each cold touch before computing it and hands a conversation above `MATH_CAPACITY_ROUTE_FRACTION` (0.9; `MATH_CAPACITY_KEEP_FRACTION` 0.7 once routed) of the small compute capacity to the large class. A routed conversation is not computed by the small poller at all, so do not set it without the queue and a large box. `MATH_CAPACITY_RESIZE_S` (3600) bounds re-sizing; `MATH_CAPACITY_STATE_PATH` (unset) keeps the records across restarts.
- **`MATH_CAPACITY_QUEUE_DSN`**, **`MATH_CAPACITY_QUEUE_ENV`** (`math-python`, unset) the queue: a libpq DSN for a login that is a member of `polis_queue_executor` (the poller's publication path keeps `DATABASE_URL`; the queue login has no table access and is checked on every call), and the queue env namespace. Unset: routed conversations are not enqueued (logged at start). With them set, the capacity line's `large_demand` (queued + waiting jobs of class `large`) and `large_leased` (running) are the queue's counts (`pq_class_depth`, migration 000024); without them `large_demand` is the records' count and `large_leased` is null. `large_poisoned` counts routed conversations the queue refused as poisoned (their last three rebuild jobs died under this source commit); they are parked until a new deploy or a ruling. A staged bundle is promoted only on the receipt of the job that produced it (succeeded, finalized, its manifest naming the staged bundle), so without the queue nothing is promoted.
- **`MATH_CAPACITY_PROMOTE`** (`math-python`, default `0`; needs routing) promotes staged `python-large` bundles into `python`.
- **`MATH_CAPACITY_RESTAGE`** (`math-python`, unset) a 16-64 hex nonce that marks every routed conversation for one fresh job and promotion; remove it after use.
- **`MATH_CAPACITY_LARGE_BUDGET_MB`** (both, unset) the large class's budget; the queue child refuses a job (exit 2) when it exceeds 0.85 of its own memory limit.
- The staged label is the literal `python-large` on both sides, so no env document can point the hand-off at a served label; the child also refuses to run under `prod` or `python`, under the job's target label, or with the small poller's routing, promotion, restage or backfill settings in its environment.
- `MATH_CAPACITY_CLASS` is pinned to `small` on `math-python`; `large` refuses to start (the large class is a child, not a poller).

Deploy hooks: a box whose `/etc/app-info/service_type.txt` says `delphi-large` writes the readiness identity lines and starts no compose service here; its worker is the `polis-jobs` daemon of class `large`, whose service definition lands with the daemon. A `delphi` box is unchanged (`delphi` and `math-python`).

### Datadog Tracing (Delphi)

- **`DD_TRACE_ENABLED`** Set to `true` to start the Delphi job poller under `ddtrace-run` ([Dockerfile](../delphi/Dockerfile)); any other value, or unset, starts it with plain `python`. Compose forwards it to the `delphi` service with fallback `false` ([Compose:174](../docker-compose.yml#L174)). Turn it on only where a Datadog agent is reachable: without one the tracer logs a failed-send error and traceback on every flush. The `ddtrace` package stays in the image. The API server loads `dd-trace` in production independently ([index:10](../server/index.ts#L10)); that library also reads `DD_TRACE_ENABLED` from the server's env file, where unset means enabled.

### Deprecated

- **`ENCRYPTION_PASSWORD_00001`** (legacy) remains a config input, including the `LOGIN_CODE_PEPPER` fallback ([config:120](../server/src/config.ts#L120)); do not classify it as unread solely because it is in this historical section.

## Enabling Comment Translation

**Note:** This feature is optional.

We use Google to automatically translate submitted comments into the language of participants, as detected by the
browser's language.

1. Ensure the `client-participation` user interface is manually translated into participant language(s).
    - Noteworthy strings include: [`showTranslationButton`, `hideTranslationButton`,
      `thirdPartyTranslationDisclaimer`][translate-strings]

2. Click `Set up a project` button within the
   [Cloud Translation Quickstart Guide][gtranslate-quickstart].
    - Follow the wizard and download the JSON private key, aka credentials file.

3. Convert the file contents into a base64-encoded string. You can do this in many ways, including:
    - copying its contents into [a client-side base64 encoder web app][base64-encoder]
      (inspect the simple JS code), or
    - using your workstation terminal: `cat path/to/My-Project-abcdef0123456789.json | base64` (linux/mac)

4. Set **`GOOGLE_CREDENTIALS_BASE64`** in `.env`

5. Set `SHOULD_USE_TRANSLATION_API=true` in `.env`

translate strings can be found in: `client-participation/js/strings/en_us.js`

   [translate-strings]: /client-participation/js/strings/en_us.js
   [gtranslate-quickstart]: https://cloud.google.com/translate/docs/basic/setup-basic
   [base64-encoder]: https://codepen.io/bsngr/pen/awuDh

## Email Transports

The current sender uses AWS SES ([senders.ts:1](../server/src/email/senders.ts#L1)). `EMAIL_TRANSPORT_TYPES` and Mailgun names still have config reads, but that alone does not mean the current sender selects a Mailgun transport. Follow the sender implementation and the [service inventory](deployment-configuration.md).

Source-only server entry points that skip the build use the root `VERSION` read once at startup. Without generated metadata, `/api/v3/version` reports `<VERSION>+dev.unknown.unknown`, commit `unknown`, distance `null`, channel `development`, and source `unverified-archive`. Normal build, watch, and npm test entry points still generate and embed the build identity first.

### Embedding model selection by result environment

`DELPHI_EMBED_MODEL_BY_ENV` is an optional JSON object mapping each result
namespace to an exact model identity from `polis-jobs graph-registry`. Unset
preserves the full pipeline's existing selection and the shadow graph's granite
default. A setting for one namespace does not change another. In the full
pipeline an explicit mapping takes precedence over `SENTENCE_TRANSFORMER_MODEL`;
it must still match the offline directory's verified lock. A graph's model must
also be reported by its actual image before admission. Unknown names and absent
models refuse; there is no fallback to a different model. Installing another
model in an image never selects it. The current image carries one offline
embedding model; multiple models require a future image and corresponding
registry implementations before any setting can select them.

The deployment check validates the mapping's shape. The typed admission and
worker check the implementation and producing artifact schemas. Model selection
changes no historical result and enables no graph conversation list.

### Same-host graph executor and recovery

`DELPHI_SHADOW_GRAPH_ENABLED=1` selects the `delphi-shadow-graph` service on
Delphi deployments. For local Compose, enable the `delphi-shadow-graph` profile
as well as `delphi-shadow`. The conversation list still decides new admissions;
clearing it stops new graphs but leaves recovery active for retained state.
The default is disabled. No other service changes when this profile is off.

The graph executor runs as PID 1 in a private namespace, one graph step at a
time, offline with the same pinned model directory and lock. It receives
`DELPHI_EMBED_MODEL_BY_ENV` exactly as the scheduler does, which decides each
graph's model at admission; the deploy check refuses the two differing. Its named local
volume contains the attempt journal and a binding to `/etc/machine-id` from
that host. On a host without that file, create a persistent, unique host identity
file once, and name its absolute path in `DELPHI_SHADOW_GRAPH_HOST_ID_FILE`.
The file must already exist; never copy the identity together with the journal.
This is an operator-maintained host identity, not hardware attestation.
Retain the volume across container replacement. Never copy it to
another host or share it between hosts. The daemon refuses a journal bound to
another host, or old entries without that binding. Two daemons cannot hold the
same journal lock. On the same host, replacement of the PID 1 container kills
its namespace's processes; a host reboot kills the prior boot's processes.
A daemon restart in the same namespace needs both its recorded daemon and
child process group gone. A missing process-group record is not exit proof.
An entry written under another boot is confirmed only once its attempt's lease
has expired by database time (`graph_recovery` reason
`another_boot_lease_live` while it waits, `another_boot_lease_expired` when it
is confirmed). A copied identity file therefore does not confirm an attempt
whose original still renews its lease. It does confirm one whose original is
alive but has stopped renewing for longer than a lease (a paused container, a
stopped daemon, a frozen machine): writes stay fenced, so the cost is a false
exit record and the step computed twice. An honest reboot waits about one
lease with the defaults (`POLIS_JOBS_LEASE_SECONDS`, default 120), up to one
lease plus one reaper interval (`POLIS_JOBS_REAP_SECONDS`) when that is set
longer.

The deploy check of the executor's composed settings refuses the executor
alone: with an invalid setting the executor is not started, and the scheduler
is started with `DELPHI_SHADOW_GRAPH_CONVERSATIONS` composed blank (one more
Compose file, `docker-compose.shadow-graph-off.yml`, given to the shadow's
start only), so it admits no graph that nothing could claim; the
full-pipeline shadow still starts. The deploy says so in one line beginning
`Error:` that names the refused settings and that list, never a value. A
graph already in flight from an earlier deploy is still watched, as when the
list is cleared, and is let go if nothing claims it (below). A later deploy
with valid settings admits graphs again: at its first cycle when it deploys a
new commit; a deploy of the same commit (the usual way a setting is corrected)
first waits out any hold that a let-go started meanwhile.

A graph none of whose nodes is claimed within ten minutes (no executor
running, unstartable, crash-looping before its first claim) is cancelled and
let go (`graph_unclaimed`, with the reason, the count of graphs let go in a
row in that env and the hold that follows), so the full-pipeline shadow waits
minutes, not the job deadline. A graph found cancelled with no node ever
claimed, or past the job deadline with none claimed, is let go the same way
(reason `cancelled_unclaimed`). The ten minutes are a constant
(`UNCLAIMED_DEADLINE` in `queue-rs/src/shadow/graph.rs`), not a setting: a
running executor claims within one of its polls (`POLIS_JOBS_POLL_SECONDS`,
default 5), and the deploy pulls every image before starting anything and
starts the executor before the shadow, so on a deploy the executor is never
still being pulled when a graph is admitted. Where it is slower than ten
minutes to start (an image still being pulled or built by a local
`docker compose up`, a slow host, a scheduler restarted with an old graph in
flight), that graph is let go and admitted again, as below; nothing is lost.

After a let-go no graph is admitted in that env for an hour, doubling with
each let-go in a row up to a day (`UNCLAIMED_HOLD`, `UNCLAIMED_HOLD_MAX`),
or until the next code version, whichever is first; the scheduler says so
once per hold (`graph_admission_held`, reason `graph_unclaimed`, with the
count, the seconds until it resumes and the let-go graphs' ids). The code
version is `DELPHI_SHADOW_CODE_VERSION`, which the deploy hook sets to the
deployed commit: a deploy of a new commit ends a hold at once, and a restart
or a deploy of the same commit does not. The full-pipeline shadow goes on
throughout. When the hold ends, the conversation let go is admitted again,
though nothing about it changed, as a new graph: its admission key names the
let-go graph (`graph_admitted` with `after_let_go`). A claim on any graph
the scheduler watches in that env resets the count
(`graph_unclaimed_cleared`): one seen while the graph runs (a graph admitted
after the hold, or the let-go graph itself when an executor's claim lands
before its cancel, which then loses and that node runs), or one on record
when the graph ends cancelled (the claim landed and the cancel still won).
Nothing else resets the count; a new code version ends the hold but keeps
the count. A let-go graph whose cancel raced an executor's claim, either way,
is admitted again at once as a new graph, with no hold: the cancel was the
scheduler's own and the claim proves an executor exists, so the conversation
is not skipped (`graph_let_go_raced`, with the graph id and the
conversation's position in `DELPHI_SHADOW_GRAPH_CONVERSATIONS`, never its
code). If the node the executor claimed died before the next poll, that is an
ordinary failure instead (below). The hold, the count and the
let-go graphs are kept in the scheduler state (`graph_unclaimed`), so a
restart keeps them. Each graph admitted again adds its rows to the database,
as any graph does, and counts against the shadow's storage budget.

The state keeps, per conversation, only the last graph let go, for at most
256 conversations per env; the database keeps every graph. When the state
does not name a snapshot's last let-go graph (the state file was lost, the
conversation's entry was dropped from the 256, or the snapshot changed, was
let go, and came back), the admission reads that graph from the database and
names it in its key (`graph_let_go_recovered`, with the count): it is a new
graph at once, not each cancelled graph of the chain answered and let go
again with one hold per link. With no state for the env at all (a lost state
file) the count of let-gos in a row is the database's too (the env's newest
graphs, while each had every node cancelled and none ever claimed, stopping
at the first claimed one), and no hold is in force until the next let-go, as
after a new code version: the build that let the last one go is not known.

A graph cancelled after an executor claimed it, when the cancel was not the
scheduler's own let-go, follows one rule: one whose claimed node was cancelled
by a person, or at the job deadline while it ran, in a graph the scheduler
watched. The same rule applies to a fully cancelled graph with a claim on
record that the scheduler finds only in the database, with no record of it
in its state (a lost state file, or a snapshot that changed and came back).
That includes the scheduler's own let-go whose cancel raced a claim, once the
state that knew it was lost: the database cannot tell it from a person's
cancel, so it is treated as one. The scheduler writes one line on standard error
beginning `Error:` that names the graph, the conversation's position in
`DELPHI_SHADOW_GRAPH_CONVERSATIONS` ("entry 2", counting each code once, as
the list's parser names an entry it refuses) and the reason,
`cancelled_after_claim`; never the conversation's code, which is its address
(anyone holding it can open the conversation, and while it is open vote and
comment in it), and both of the scheduler's output streams go to the same
log. The graph is counted failed; its snapshot is not admitted again until it
changes; and no graph env is held, so every other listed conversation goes
on at once. No hold, because the hold exists for a graph nobody claimed and a
claim proves an executor exists, and because one conversation must not hold
up every other; no retry, because a person's cancel should stand and a graph
cancelled at the job deadline would most likely overrun it again. A graph
whose node died (`dead`) and whose remaining nodes the scheduler then
cancelled, a let-go whose claimed node died included, is an ordinary
failure: counted failed, not admitted again until its snapshot changes, no
hold, and no such line (the node's own line says it died).

Publication of a finished graph is tried once per poll, up to three times,
the count kept in the scheduler state; a transient failure keeps the graph
(`graph_publish_retry`). A graph whose publication is given up
(`graph_publish_failed`) is not taken up again by recovery, and its snapshot
is not remembered as seen: when a later build or a change reconsiders the
conversation, the same snapshot's admission answers with that graph if the
graph's specification is unchanged (the same stage code, runtime, models and
expected generation), and then only its publication runs again. A build that
changes any of those admits a new graph, and all its steps run again.

The scheduler cancels overdue graphs at `DELPHI_SHADOW_JOB_DEADLINE_SECONDS`
(default 14400). It keeps their scopes held and polls recovery in the background;
other conversations may resume full-pipeline work. The same conversation stays
excluded while its graph scope is held. A lost host or volume cannot supply exit
proof: `graph_recovery_pending` means just that, never successful recovery.
While any graph is deferred no new graph is admitted, in any graph env; the
scheduler says so once, with the deferred graphs' ids
(`graph_admission_held`, reason `graph_deferred`).
Database recovery errors stop admissions until the database can be read again.

The default ceilings are 16 GiB for the full-pipeline daemon, 6 GiB for the graph
executor (`DELPHI_SHADOW_GRAPH_CONTAINER_MEMORY`), and 256 MiB for the scheduler:
22.25 GiB total, plus math, database, web services and the operating system.
Resident memory in both daemons counts even when admissions are serial. Recovery
may overlap an unknown old graph with work for another conversation; provision
for both ceilings. Each daemon has a 2-CPU cap by default; the graph executor's
setting is `DELPHI_SHADOW_GRAPH_CONTAINER_CPUS`. CPU weight and OOM priority make
this optional work yield first; they do not reserve capacity for participation.

One small machine (a laptop running everything under Compose) must hold
whatever runs at once. The ceilings are ceilings, not reservations, but
together with the database, the math engine, the web services and the
operating system they should fit the machine: the full-pipeline daemon's is
`DELPHI_SHADOW_CONTAINER_MEMORY` (`delphi-shadow`, default `16g`), the graph
executor's `DELPHI_SHADOW_GRAPH_CONTAINER_MEMORY` (`delphi-shadow-graph`,
default `6g`), and the scheduler's a fixed 256 MiB. The graph executor is
optional: with `DELPHI_SHADOW_GRAPH_ENABLED` unset on a deployment, or the
`delphi-shadow-graph` profile off under local Compose, and
`DELPHI_SHADOW_GRAPH_CONVERSATIONS` empty, it does not run and its ceiling
does not apply; leave it off unless both ceilings fit. Under Docker Desktop
on macOS a bind mount resolves on macOS itself, which has no
`/etc/machine-id` for the executor's host identity: create a persistent,
unique file once and name its absolute path in
`DELPHI_SHADOW_GRAPH_HOST_ID_FILE`, or the executor does not start. (Under
Colima the bind resolves inside its Linux VM, which has one.) What was
measured, with `delphi/tests/shadow/graph_stage_memory.py`: each graph
stage's peak resident memory, each stage run alone in a fresh container of
the Delphi test image, on the 316 comments of the public biodiversity
conversation in `delphi/real_data`, under 2 CPUs and the executor's thread
settings, with the embeddings table on (linux/arm64 under Colima on an Apple
M4 Pro): 2.24 GiB for `graph_embed`, 0.85 GiB for `graph_cluster`, 0.18 GiB
for `graph_topics` and 23 MiB for `graph_narrative`. The executor's own
daemon is not in those figures, and larger conversations (admission allows
up to 2,000 comments) were not measured. The full-pipeline daemon was not
measured here at all: size `DELPHI_SHADOW_CONTAINER_MEMORY` by measuring it
on the conversations it will run.

State written by the previous release loads with empty recovery fields. When no
graph has been enabled, state serialization and full-pipeline behavior are
unchanged. Before rolling back, drain every graph, including deferred graphs,
and verify its scope was released. Older schedulers ignore the new deferred
fields and cannot enforce those exclusions. They also ignore the publication
count and the given-up publications, so they may try a given-up graph's
publication again, and they ignore the graphs let go as unclaimed, so they
neither hold admission after one nor admit its unchanged conversation again.
Do not remove scheduler state or a
journal to force progress.
