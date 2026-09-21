# Polis configuration

Most application settings are environment variables. Copy the repository-root `example.env` to `.env` and modify it for your launch path; example values are not universal runtime defaults. CDK context and explicit CLI/config arguments are separate configuration inputs.

The [environment read reference](configuration-env-reference.md) records all 233 named inputs and 680 read sites in the scoped API, Delphi, coordinator and CDK source, including file:line, fallback and secret status. The [deployment reference](deployment-configuration.md) connects those settings to all 153 P065 service entries and explains dynamic/SDK input limits.

</br>

## Overview

First things first, it helps to understand a bit how the system is set up.

| Component Name | Tech | Description |
|----------------|------|--------|
| [`server`][dir-server] | Node.js | The main server. Handles client web requests (page loads, vote activity, etc.) |
| [`math`][dir-math] | Clojure/JVM | The math engine.  |
| [`client-participation`][dir-participation] | Javascript | The client code for end-users. |
| [`client-admin`][dir-admin] | Javascript | The client code for administrators. |
| [`client-report`][dir-report] | Node.js | The code for detailed analytics reports. |
| [client-participation-alpha](../client-participation-alpha) | Astro / React | Participation client with a Node server adapter; see [adapter configuration](../client-participation-alpha/astro.config.mjs#L15). |
| [delphi](../delphi) | Python | Narrative pipeline and opt-in PostgreSQL math poller; launch paths and defaults differ. |
| [coordinator-rs](../coordinator-rs) | Rust | Coordinator substrate and diagnostic/bridge tools; configuration alone does not grant publication authority. |

   [dir-server]: /server
   [dir-math]: /math
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
- **`MATH_ENV`** Selects the math namespace, such as `prod`, `preprod`, `dev` or an explicitly isolated namespace. The API reads it without a fallback ([config:128](../server/src/config.ts#L128)); Compose maps `prod` for Clojure math/Delphi ([Compose:88](../docker-compose.yml#L88), [114](../docker-compose.yml#L114)). The standalone Python poller defaults to `dev` ([poller:234](../delphi/polismath/poller/service.py#L234)); the opt-in `math-python` service uses `MATH_PYTHON_ENV` with fallback `python` ([Compose:176](../docker-compose.yml#L176)). Keep intended reader/writer namespaces aligned; there is no single global default.
- **`MATH_LOG_LEVEL`** Used by the math service to determine how much logging to output. Reasonable values are `debug`, `info`, `warn`, and `error`. Defaults to `warn`.
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
