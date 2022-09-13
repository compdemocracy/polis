# Polis configuration

Several configuration files and dozens of environment variables are currently required to configure the system, a relic of Polis' pre-monorepo days..
There's [been some work](https://github.com/compdemocracy/polis/pull/1341) to unify these configuration options, but for the moment, you'll have to configure each of the individual subcomponents of the project separately.


</br>


## Overview

First things first, it helps to understand a bit how the system is set up.

| Component Name | Tech | Config | Description |
|----------------|------|-------------|
| [`server`][dir-server] | Node.js | `ENV` (`server/docker-dev.env`) | The main server. Handles client web requests (page loads, vote activity, etc.) |
| [`math`][dir-math] | Clojure/JVM | `ENV` (`math/docker-dev.env`) | The math engine.  |
| [`client-participation`][dir-participation] | Javascript | `client-participation/polis.config.js` | The client code for end-users. |
| [`client-admin`][dir-admin] | Javascript | `client-admin/polis.config.js` | The client code for administrators. |
| [`client-report`][dir-report] | Node.js | `client-report/polis.config.js` | The code for detailed analytics reports. |

   [dir-server]: /server
   [dir-math]: /math
   [dir-participation]: /client-participation
   [dir-admin]: /client-admin
   [dir-report]: /client-report

While this document will try to outline some of the more important configuration steps and options, you'll need to see the individual READMEs for more detailed descriptions of how to configure these components.


## Environment variables

The server and math worker are both configured via environment variables, and where configuration overlaps, the usage patterns are identical.
If you're running Polis with Docker and Docker Compose, there's a `docker-dev.env` file in each of these repositories which can be configured, and will be passed on to the running containers when you run `docker compose up`.

In production, you'll want to override these values, which you can do in a number of ways with `docker compose` ([(documentation here)](https://docs.docker.com/compose/environment-variables/)).
It's recommended that you use an environment file with restrictive file permissions, and pass this through to `docker compose` with the `--env-file` option.

You could do something like this:

```sh
mkdir ~/.polis
touch ~/.polis/prod.env
# set environment variables here with your default text editor (vim, emacs, nano, etc.)
edit ~/.polis/prod.env
# for security purposes, make sure the directory and its concents can only be read by your user
chmod -R og-rwx ~/.polis
# if you really want to get fancy you can encrypt the file as well... (excercise left to reader)

# Once you're done, run like this
docker compose up --env-file ~/.polis/prod.env
```

## Enabling Comment Translation

**Note:** This feature is optional.

We use Google to automatically translate submitted comments into the language of participants, as detected by the browser's language.

1. Ensure the `client-participation` [user interface is manually translated][translate-ui] into participant language(s).
    - Noteworthy strings include: [`showTranslationButton`, `hideTranslationButton`, `thirdPartyTranslationDisclaimer`][translate-strings]
1. Click `Set up a project` button within the [Cloud Translation Quickstart Guide][gtranslate-quickstart].
    - Follow the wizard and download the JSON private key, aka credentials file.
1. Convert the file contents into a base64-encoded string. You can do this in many ways, including:
    - copying its contents into [a client-side base64 encoder web app][base64-encoder] (inspect the simple JS code), or
    - using your workstation terminal: `cat path/to/My-Project-abcdef0123456789.json | base64` (linux/mac)
1. Configure `GOOGLE_CREDENTIALS_BASE64` within `server/docker-dev.env`
1. Configure `SHOULD_USE_TRANSLATION_API=true` within `server/docker-dev.env`

   [translate-ui]: #translating-the-user-interface
   [translate-strings]: /client-participation/js/strings/en_us.js#L96-L98
   [gtranslate-quickstart]: https://cloud.google.com/translate/docs/basic/setup-basic
   [base64-encoder]: https://codepen.io/bsngr/pen/awuDh


## Email Transports

We use [Nodemailer][] to send email. Nodemailer uses various built-in and
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

This transport will work automatically when running via Docker Compose, accessible on port 1080.

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

