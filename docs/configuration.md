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

By default, `docker compose` will look for and use an `.env` file if one exists. However, any value present in your
environment or passed in on the command line will overwrite those in the file. Thus you should be able to set your
configuration values in whatever way suits your given scenario. (A plain text `.env` file is not always appropriate in
production deployments.)

If you are running these applications without Docker, just make sure that any environment variables you need are set in
the environment where the application is running.

If you are doing development on a url other than `localhost` or `localhost:5000`, you need to update the
API_DEV_HOSTNAME value to your development hostname:port, e.g. `myhost:8000` or `api.testserver.net`.
DEV_MODE should be `true`.

If you are deploying to a custom domain (not pol.is) than you need to update both the API_PROD_HOSTNAME and
DOMAIN_OVERRIDE values to your custom hostname (omitting http(s):// protocol).
DEV_MODE should be `false`.

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

4. Set `GOOGLE_CREDENTIALS_BASE64` in `.env`

5. Set `SHOULD_USE_TRANSLATION_API=true` in `.env`

translate strings can be found in: `client-participation/js/strings/en_us.js`

   [translate-strings]: /client-participation/js/strings/en_us.js#L96-L98
   [gtranslate-quickstart]: https://cloud.google.com/translate/docs/basic/setup-basic
   [base64-encoder]: https://codepen.io/bsngr/pen/awuDh

## Email Transports

We use [Nodemailer] to send email. Nodemailer uses various built-in and
packaged _email transports_ to send email via SMTP or API, either directly or
via third-party platforms.

Each transport needs a bit of hardcoded scaffold configuration to make it work,
which we welcome via code contribution. But after this, others can easily use
the same email transport by setting some configuration values via environment
variable or otherwise.

We use `EMAIL_TRANSPORT_TYPES` to set email transports and their fallback
order. Each transport has a keyword (e.g., `maildev`). You may set one or more
transports, separated by commas. If you set more than one, then each transport
will "fallback" to the next on failure.

For example, if you set `aws-ses,mailgun`, then we'll try to send via
`aws-ses`, but on failure, we'll try to send via `mailgun`. If Mailgun fails,
the email will not be sent.

   [Nodemailer]: https://nodemailer.com/about/

### Configuring transport: `maildev`

Note: The [MailDev][] email transport is for **development purposes only**. Ensure it's disabled in production!

1. Add `maildev` into the `EMAIL_TRANSPORT_TYPES` configuration.

This transport will work automatically when running via Docker Compose with the development overlay, accessible on port
1080.

   [MailDev]: https://github.com/maildev/maildev

### Configuring transport: `aws-ses`

1. Add `aws-ses` into the `EMAIL_TRANSPORT_TYPES` configuration.
2. Set the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` configuration.

### Configuring transport: `mailgun`

1. Add `mailgun` into the `EMAIL_TRANSPORT_TYPES` configuration.
2. Set the `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` configuration.

### Adding a new transport

1. [Find a transport for the service you require][transports] (or write your
   own!)
2. Add any new transport configuration to `getMailOptions(...)` in
   [`server/email/senders.js`][mail-senders].
3. Submit a pull request.

   [transports]: https://github.com/search?q=nodemailer+transport
   [mail-senders]: /server/email/senders.js
