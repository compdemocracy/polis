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
- **`GIT_HASH`** Set programmatically using `git rev-parse HEAD` (e.g. in `Makefile`) to tag docker container versions and other release assets. Can be left blank.
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
- **`ADMIN_EMAIL_DATA_EXPORT_TEST`** email address to receive periodic export test results, if configured below.
- **`ADMIN_EMAIL_EMAIL_TEST`** email address to receive backup email system test.
- **`ADMIN_EMAILS`** array of email addresses to receive team notifications.
- **`POLIS_FROM_ADDRESS`** email address from which other emails are sent.

### Boolean Flags

(All can be left blank, or `false`)

- **`BACKFILL_COMMENT_LANG_DETECTION`** Set to `true`, if Comment Translation was enabled, to instruct the server upon the next initialization (reboot) to backfill detected language of stored comments. Default `false`.
- **`CACHE_MATH_RESULTS`** Set this to `true` to instruct the API server to use LRU caching for results from the math service. Default is `true` if left blank.
- **`DATABASE_SSL`** Set this to `true` for some production environments. Default is `false`.
- **`DEV_MODE`** Set this to `true` in development and `false` otherwise. Used by API Server to make a variety of assumptions about HTTPS, logging, notifications, etc.
- **`RUN_PERIODIC_EXPORT_TESTS`** Set this to `true` to run periodic export tests, sent to the **`ADMIN_EMAIL_DATA_EXPORT_TEST`** address.
- **`SERVER_LOG_TO_FILE`** Set this to `true` to tell Winston.js to also write log files to server/logs/. Defaults to `false`. *Note that if using docker compose, server/logs is mounted as a persistent volume.*
- **`SHOULD_USE_TRANSLATION_API`** Set this to `true` if using Google translation service. See [Enabling Comment Translation](#enabling-comment-translation) below.
- **`USE_NETWORK_HOST`** Set this to `true` if using server within an internal network (e.g. AWS) such that SSL is not required.

### URL/Hostname Settings

- **`API_DEV_HOSTNAME`** defaults to `localhost:5000` in [config:5](../server/src/config.ts#L5); set it to the development hostname and port you actually use.
- **`API_PROD_HOSTNAME`** the hostname of your site (e.g. `pol.is`, or `example.com`). Should match **`DOMAIN_OVERRIDE`**. (In the future these two options may be combined into one.)
- **`DOMAIN_OVERRIDE`** the hostname of your site. Should match **`API_PROD_HOSTNAME`**.
- **`DOMAIN_WHITELIST_ITEM_01`** - **`08`** up to 8 possible additional whitelisted domains for client applications to make API requests from. Typical setups that use the same URL for the API service as for the public-facing web sites do not need to configure these.
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

- **`AKISMET_ANTISPAM_API_KEY`** Comment spam detection and filtering.
- **`GA_TRACKING_ID`** For using Google Analytics on client pages.
- **`GOOGLE_CREDENTIALS_BASE64`** Required if using Google Translate API. (See below).
- **`GOOGLE_CREDS_STRINGIFIED`** Alternative to **`GOOGLE_CREDENTIALS_BASE64`** (See below).
- **`MAILGUN_API_KEY`**, **`MAILGUN_DOMAIN`** If using Mailgun as an email transport.
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
- **`SENTENCE_TRANSFORMER_MODEL`** Local embedding model for the narrative pipeline. Compose fallback `all-MiniLM-L6-v2`.
- **`OLLAMA_HOST`**, **`OLLAMA_ENDPOINT`**, **`OLLAMA_MODEL`** Used only when `LLM_PROVIDER=ollama`. `OLLAMA_ENDPOINT` is the older name for `OLLAMA_HOST`. Compose fallbacks are empty.

### Large Memory Class

Off by default; nothing here changes behaviour until `MATH_CAPACITY_ROUTING=1`. The design is in [MATH_POLLER_DESIGN.md §7-§8](../delphi/docs/MATH_POLLER_DESIGN.md). Compose lists every setting explicitly (`math-python` has no `env_file`), so a value set in `.env` or the deployment env document reaches the container only through these lines.

There is no resident large worker. With routing on, a conversation the small poller's estimator says would not fit becomes one `math_rebuild` job of worker class `large` on the Postgres job queue (`polis-queue`, migrations 000019 and 000023 plus the `polis-queue/3` functions), inserted by `math-python` through the queue's SQL functions. The large box runs the `polis-jobs` daemon as a worker of class `large`; for each job it runs `scripts/math_poller.py --job` as a child, which computes exactly that conversation (a cold full-history rebuild under its own memory budget) and publishes it under the literal label `python-large`; `math-python` promotes the staged bundle into its own label.

| Service | Role | Label (`math_env`) and lock |
|---|---|---|
| `math-python` | small poller, the single writer of the served label; routes, enqueues, promotes | `MATH_PYTHON_ENV` (`python`) |
| the queue child (`math_poller.py --job`, under the daemon on the large box) | computes one conversation per job, writes only the staged label | `python-large` (its `MATH_ENV`, bound to the job's frame) |

- **`MATH_CAPACITY_ROUTING`** (`math-python`, default `0`) `1` sizes each cold touch before computing it and hands a conversation above `MATH_CAPACITY_ROUTE_FRACTION` (0.9; `MATH_CAPACITY_KEEP_FRACTION` 0.7 once routed) of the small compute capacity to the large class. A routed conversation is not computed by the small poller at all, so do not set it without the queue and a large box. `MATH_CAPACITY_RESIZE_S` (3600) bounds re-sizing; `MATH_CAPACITY_STATE_PATH` (unset) keeps the records across restarts.
- **`MATH_CAPACITY_QUEUE_DSN`**, **`MATH_CAPACITY_QUEUE_ENV`**, **`MATH_CAPACITY_QUEUE_LOGIN_SECRET`** (`math-python`, unset) the queue: a libpq DSN for a login that is a member of `polis_queue_executor` (the poller's publication path keeps `DATABASE_URL`; the queue login has no table access and is checked on every call), the queue env namespace, and the NAME of the Secrets Manager secret holding that login's password (a JSON object with `password`, the shape the jobs daemon reads). The DSN must not carry a password; a DSN that does is refused. With routing on, a missing DSN, a missing source commit, or a queue that does not answer refuses routing: the small poller computes those conversations itself, as with routing off, and the capacity line says `queue_unreachable=1` until the queue answers (cost-reduction plan P-084). Admission caps: no new job while 20 jobs of class `large` are queued or waiting (`queue_full=1` on the line; the conversation stays routed), and at most 2 new jobs per conversation per day. The request key is the digest of the intent (env, scope, labels, input watermark), so asking again for the same demand reuses one binding row. With them set, the capacity line's `large_demand` (queued + waiting jobs of class `large`) and `large_leased` (running) are the queue's counts (`pq_class_depth`, migration 000024); without them `large_demand` is the records' count and `large_leased` is null. `large_poisoned` counts routed conversations the queue refused as poisoned (their last three rebuild jobs died under this source commit); they are parked until a new deploy or a ruling. A staged bundle is promoted only on the receipt of the job that produced it (succeeded, finalized, its manifest naming the staged bundle), so without the queue nothing is promoted.
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
- **`WEBSERVER_PASS`** (deprecated) basic auth setting for certain requests sent between math and api services.
- **`WEBSERVER_USERNAME`** (deprecated) basic auth setting for certain requests sent between math and api services.

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
