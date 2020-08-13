# polisDeployment

If you're interested in deploying Polis, or setting up a development environment, you've come to the right place.

## Overview of system

First things first, it helps to understand a bit how the system is set up.

| Component Name | Tech | Description |
|----------------|------|-------------|
| [`server`][dir-server] | Node.js | The main server. Handles client web requests (page loads, vote activity, etc.) |
| [`math`][dir-math] | Clojure/JVM | The math engine.  |
| [`client-participation`][dir-participation] | Javascript | The client code for end-users. |
| [`client-admin`][dir-admin] | Javascript | The client code for administrators. |
| [`client-report`][dir-report] | Node.js | The code for detailed analytics reports. |

The code in the two client-side repos compile to static assets.
We push these to s3 for CDN via `deployPreprod` and `deploy_TO_PRODUCTION`, but there is a config file for each of these projects which will allow you to configure the behavior of these scripts as described in the READMEs.
Of note though, you can use a static file server, and deploy via these scripts over `sshfs`.
Finally, for local development, these repos have hot-reload able servers you can run with the `./x` command, but note that this is not the recommended approach for serving the client assets in production.

   [dir-server]: /server
   [dir-math]: /math
   [dir-participation]: /client-participation
   [dir-admin]: /client-admin
   [dir-report]: /client-report

### Environment variables and configuration

Each of these applications currently takes configuration from a set of environment variables.
In the future we'll be moving away from this towards configuration files, but for now, the easiest way to configure the application is to have a shared set of environment variables that you keep in a file somewhere.
You might do something like the following to set up a single secure file for these purposes:

```
mkdir ~/.polis
touch ~/.polis/envvars.sh
# set environment variables here with your text editor of choice (cough; vim)
nano ~/.polis/envvars.sh
# make sure only your user can read the directory and its contents can only be read by your user for security purposes
chmod -R og-rwx ~/.polis
# if you really want to get fancy you can encrypt the file as well...
```

Then you can run `source ~/.polis/envvars.sh` to prepare any of the servers for running.

Each of the repo READMEs should have notes on what environment variables are needed, as well as templates to start off from (please raise an issue if something is missing).
And as noted, some scripts require that configuration is in a specific file somewhere, so please refer to individual repo READMEs for full details.

Of particular note, the polisServer runs on environment variables which tell it where to look for the client repositories (host & port), and affording you a lot of flexibility in how you deploy.

TODO Compile complete starter template somewhere in this repo...


## Development environment

1) Get the main server running using the Readme here: [`/server`][dir-server]
   * This includes instructions on setting up a local postgres database
2) Get the math server running using the Readme here: [`/math`][dir-math]
3) Build client repo assets using the instructions in the respective Readmes:
   * [`/client-participation`][dir-participation]
   * [`/client-admin`][dir-admin]
   * [`/client-report`][dir-report]
4) Each of the above repos also contains instructions for running a server with HMR; By default, the server should forward requests for these compiled assets to the HMR server.

## Basic/Manual deployment

Go through all steps in the Development environment, but at step (4) take compiled assets and serve with a/several static webserver(s), making sure to configure ports as described in the main polisServer Readme.

## Docker deployment

There's a [`docker-compose.yml` file in the project root](/docker-compose.yml), which can be used for running a fully functional docker development environment.

It is NOT suited for production, but it may be in the future.

### Architecture

[![architecture diagram of docker setup][arch-image]][arch-edit]

   [arch-image]: docker-architecture.png
   [arch-edit]: https://www.draw.io/#R7Vpdb5swFP01ecyEDQTy2rRrHjapUzqt3ZsHLngjGDkmkP36mWBCwCRjKHxUWh8qfP19ju%2Fx9W1n%2BmqbPjIU%2BZ%2Bpi4MZ1Nx0pt%2FPIFzqlvidGQ65wVhoucFjxM1NoDRsyG8sjUWzmLh4V2nIKQ04iapGh4YhdnjFhhijSbXZGw2qs0bIw4ph46BAtX4jLvdzq21qpX2NiecXMwNN1vxAzi%2BP0TiU882g%2Fnb8yau3qBhLtt%2F5yKXJmUl%2FmOkrRinPv7bpCgcZtAVseb%2BPF2pP62Y45G06zJcbO%2FkSWwisdTd1Vsnz5nl%2BWhw%2FFIBgV%2BAji5Rxn3o0RMFDab07bhpnw2qiVLb5RGkkjEAYf2LOD5JsFHMqTD7fBrIWp4S%2FZN0%2FmLL0KgfLvu%2FT88KhKIScHc46ZcXXYrysUHY7lop%2BKkwSuR2NmYOvYFOcRsQ8zK%2B0M%2FN2GW5nE0gSHjHdYrEe0YDhAHGyr547JI%2Bvd2pXUig%2BJIv%2FwKgcd4%2BCWM4UeiRMFZqrJCY%2B4XgToSMgiXD0KmEXQdxjxnF6dduydmHIoyZ1AkBbGpLS7UBxHv0zlysE5eZQQQWqNxLg%2BQ4zsa3RAbNgDTDNUAGDxpCAgUUHtXBiAacrcelJOkAn6dB6kw69pXTASUmHrviDExCx9zlytyScnEMsG%2FzBHtQdrP%2Fu0ModjHfpDsYldxAQcOKQSKyBju8WtjY1t7An6hZTCzDNd%2BkWOhyf3o5UdTkWA9Br3Jpf2fWJErHmMgLXzWpACeyaBORbkt1qx%2BS0ju4nx1QEdSKhtvI2AaO%2FTRYKVhHdcY%2Fh3ehomXaLhwkAg1455viaJLUFnCvLSWf%2BduVU4rBS1G5%2B5VgtNWkx1pVz97J%2Feln5ceqC72vt6xKtn%2B6Kh8nk2LX6pLeGfb98m2NGFJaidcfk6dg6Z2htdG7YjJWa3bM1W83hllCBYd4gSq6q4QJtSlXB3pBSk3sTwGlRvzp1ODZOatLH1LQJIgVHR0rNB5hGw2NocKRALawf3%2FfUQF8HUL3Eh0bKqIf5QyLVGNhM4CndIYE46xSfNALQz0vXVog2agzmAdEtXrqXt9WUOmQ4EiRd8YTWoY1y7BsIuHxf19S1x5yhKJZ%2F487xLf%2BPQH%2F4Aw%3D%3D

:tada: Contributors to Docker support:
- [@uzzal2k5](https://github.com/uzzal2k5) via [`uzzal2k5/polis_container`](https://github.com/uzzal2k5/polis_container)
- [@crkrenn](https://github.com/crkrenn) & [@david-nadaraia](https://github.com/david-nadaraia)
- [@patcon](https://github.com/patcon)
- [@ballPointPenguin](https://github.com/ballPointPenguin)

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

## Contribution notes

Please help us out as you go in setting things up by improving the deployment code and documentation!

* General/system-wide issues you come across can go in https://github.com/pol-is/polis-issues/issues, and repo specific issues in their respective issues lists
* PRs improving either documentation or deployment code are welcome, but please submit an issue to discuss before making any substantial code changes
* After you've made an issue, you can try to chat folks up at https://gitter.im/pol-is/polisDeployment

