# Polis configuration

Currently all of the configurable values are handled by environment variables. These are listed in the `env.example` file,
which you should copy to `.env` and modify as needed.

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
> In development, the default values of example.env should work as-is.
>
> `cp example.env .env`

By default, `docker compose` will look for and use an `.env` file if one exists. However, any value present in your
environment or passed in on the command line will overwrite those in the file. Thus you should be able to set your
configuration values in whatever way suits your given scenario. (A plain text `.env` file is not always appropriate in
production deployments.)

If you are running these applications without Docker, just make sure that any environment variables you need are set in
the environment where the application is running.

If you are doing development on a url other than `localhost` or `localhost:5000`, you need to update the
**`API_DEV_HOSTNAME`** value to your development hostname:port, e.g. `myhost:8000` or `api.testserver.net`.
**`DEV_MODE`** should be `true`.

If you are deploying to a custom domain (not `pol.is`) then you need to update both the **`API_PROD_HOSTNAME`** and
**`DOMAIN_OVERRIDE`** values to your custom hostname (omitting `http(s)://` protocol).
**`DEV_MODE`** should be `false`.

### General Settings

- **`ADMIN_UIDS`** an array of user UUIDs for site admins. These users will have moderator capabilities on all conversations hosted on the site.
- **`EMAIL_TRANSPORT_TYPES`** comma-separated list of email services to use (see [Email Transports](#email-transports) below)
- **`GIT_HASH`** Set programatically using `git rev-parse HEAD` (e.g. in Makefile) to tag docker container versions and other release assets. Can be left blank.
- **`MATH_ENV`** Set to prod (default), preprod, or dev. In cases where a single database is used for multiple environments, this value is used by the API service to request the correct data. (Using a single DB for multiple environments is no longer recommended.)
- **`SERVER_ENV_FILE`** The name of an environment file to be passed into the API Server container by docker compose. Defaults to ".env" if left blank. Used especially for building a "test" version of the project for end-to-end testing.
- **`SERVER_LOG_LEVEL`** Used by Winston.js in the API server to determine how much logging to output. Reasonable values are "debug", "info", and "error". Defaults to "info".

### Database

- **`READ_ONLY_DATABASE_URL`** (optional) Database replica for reads.
- **`POSTGRES_DB`** database name (e.g. "polis-dev")
- **`POSTGRES_HOST`** database host (e.g. postgres:5432 if using docker compose, localhost:5432 if using local db)
- **`POSTGRES_PASSWORD`** database password
- **`POSTGRES_PORT`** typically 5432
- **`POSTGRES_USER`** typically "postgres". Any username will be used by the docker container to create a db user.
- **`DATABASE_URL`** should be the combination of above values, `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}/${POSTGRES_DB}`

### Docker Concerns

- **`TAG`** used by **`COMPOSE_PROJECT_NAME`** below. Defaults to "dev".
- **`COMPOSE_PROJECT_NAME`** Used by docker compose to label containers and volumes. Useful in development if you are (re)-building and deleting groups of docker assets.

### Ports

- **`API_SERVER_PORT`** typically 5000. Used internally within a docker network and/or behind a proxy. A `PORT` value is used as a fallback if `API_SERVER_PORT` is not set (for Heroku comptability).
- **`HTTP_PORT`** typically 80. Port exposed by Nginx reverse proxy.
- **`HTTPS_PORT`** typically 443. Port exposed by Nginx reverse proxy.
- **`STATIC_FILES_PORT`** typically 8080. Used internally within a docker network and/or behind a proxy.
- **`STATIC_FILES_ADMIN_PORT`** same as **`STATIC_FILES_PORT`** unless you are hosting client-admin separately from file-server. Useful in local development.
- **`STATIC_FILES_PARTICIPATION_PORT`** same as **`STATIC_FILES_PORT`** unless you are hosting client-participation separately from file-server. Useful in local development.

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
- **`DEV_MODE`** Set this to `true` in development and `false` otherwise. Used by API Server to make a variety of assumptions about HTTPS, logging, notifications, etc.
- **`RUN_PERIODIC_EXPORT_TESTS`** Set this to `true` to run periodic export tests, sent to the **`ADMIN_EMAIL_DATA_EXPORT_TEST`** address.
- **`SERVER_LOG_TO_FILE`** Set this to `true` to tell Winston.js to also write log files to server/logs/. Defaults to `false`. *Note that if using docker compose, server/logs is mounted as a persistent volume.*
- **`SHOULD_USE_TRANSLATION_API`** Set this to `true` if using Google translation service. See [Enabling Comment Translation](#enabling-comment-translation) below.

### URL/Hostname Settings

- **`API_DEV_HOSTNAME`** typically "localhost" unless you are running a development instance elsewhere.
- **`API_PROD_HOSTNAME`** the hostname of your site (e.g. pol.is, or example.com). Should match **`DOMAIN_OVERRIDE`**. (In the future these two options may be combined into one.)
- **`DOMAIN_OVERRIDE`** the hostname of your site. Should match **`API_PROD_HOSTNAME`**.
- **`DOMAIN_WHITELIST_ITEM_01`** - **`08`** up to 8 possible additional whitelisted domains for client applications to make API requests from. Typical setups that use the same URL for the API service as for the public-facing web sites do not need to configure these.
- **`EMBED_SERVICE_HOSTNAME`** should match **`API_DEV_HOSTNAME`** in production, or **`API_DEV_HOSTNAME`** in development. Embedded conversations make API requests to this host.
- **`SERVICE_URL`** used by client-report to make API calls. Only necessary if client-report is hosted separately from the API service. Can be left blank.
- **`STATIC_FILES_HOST`** Used by the API service to fetch static assets (the compiled client applications) from a static file server. Within a docker compose network this is "file-server", but could be an external hostname, such as a CDN.

### Third Party API Credentials

(All are optional, and omitting them will disable the related feature.)

- **`AKISMET_ANTISPAM_API_KEY`** Comment spam detection and filtering.
- **`AWS_REGION`** Used for S3 data import/export.
- **`ENABLE_TWITTER_WIDGETS`** set to `true` to enable twitter widgets on the client-admin authentication pages.
- **`FB_APP_ID`** Must register with Facebook to get an ID to enable Facebook App connectivity.
- **`GA_TRACKING_ID`** For using Google Analytics on client pages.
- **`GOOGLE_CREDENTIALS_BASE64`** Required if using Google Translate API. (See below).
- **`GOOGLE_CREDS_STRINGIFIED`** Alternative to **`GOOGLE_CREDENTIALS_BASE64`** (See below).
- **`MAILGUN_API_KEY`**, **`MAILGUN_DOMAIN`** If using Mailgun as an email transport.
- **`MAXMIND_LICENSEKEY`**, **`MAXMIND_USERID`** If using IP Geolocation service Maxmind.
- **`TWITTER_CONSUMER_KEY`**, **`TWITTER_CONSUMER_SECRET`** For Twitter integration.
- **`AWS_ACCESS_KEY_ID`**, **`AWS_SECRET_ACCESS_KEY`** If using Amazon SES as an email transport.

### Deprecated

- **`ENCRYPTION_PASSWORD_00001`** (deprecated) a password used to encrypt and decrypt participants' IP addresses. Can be left blank.
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

   [translate-strings]: /client-participation/js/strings/en_us.js#L96-L98
   [gtranslate-quickstart]: https://cloud.google.com/translate/docs/basic/setup-basic
   [base64-encoder]: https://codepen.io/bsngr/pen/awuDh

## Email Transports

We use [Nodemailer] to send email. Nodemailer uses various built-in and
packaged *email transports* to send email via SMTP or API, either directly or
via third-party platforms.

Each transport needs a bit of hardcoded scaffold configuration to make it work,
which we welcome via code contribution. But after this, others can easily use
the same email transport by setting some configuration values via environment
variable or otherwise.

We use **`EMAIL_TRANSPORT_TYPES`** to set email transports and their fallback
order. Each transport has a keyword (e.g., `maildev`). You may set one or more
transports, separated by commas. If you set more than one, then each transport
will "fallback" to the next on failure.

For example, if you set `aws-ses,mailgun`, then we'll try to send via
`aws-ses`, but on failure, we'll try to send via `mailgun`. If Mailgun fails,
the email will not be sent.

   [Nodemailer]: https://nodemailer.com/about/

### Configuring transport: `maildev`

Note: The [MailDev][] email transport is for **development purposes only**. Ensure it's disabled in production!

1. Add `maildev` into the **`EMAIL_TRANSPORT_TYPES`** configuration.

This transport will work automatically when running via Docker Compose with the development overlay, accessible on port
1080.

   [MailDev]: https://github.com/maildev/maildev

### Configuring transport: `aws-ses`

1. Add `aws-ses` into the **`EMAIL_TRANSPORT_TYPES`** configuration.
2. Set the **`AWS_ACCESS_KEY_ID`** and **`AWS_SECRET_ACCESS_KEY`** configuration.

### Configuring transport: `mailgun`

1. Add `mailgun` into the **`EMAIL_TRANSPORT_TYPES`** configuration.
2. Set the **`MAILGUN_API_KEY`** and **`MAILGUN_DOMAIN`** configuration.

### Adding a new transport

1. [Find a transport for the service you require][transports] (or write your
   own!)
2. Add any new transport configuration to `getMailOptions(...)` in
   [`server/email/senders.js`][mail-senders].
3. Submit a pull request.

   [transports]: https://github.com/search?q=nodemailer+transport
   [mail-senders]: /server/email/senders.js
