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
   [arch-edit]: https://www.draw.io/?title=docker-architecture#R7Vrfb5swEP5r8pgJY37lNWm7PKxSp3Rrt5fKBRe8AkaO05D99TPBBIhpSlkGVFqlRviwjf3d3ee7kydwEaWfGUqCa%2BrhcKJrXjqBFxNdnxmW%2BM0Eu1xgWFou8BnxchEoBSvyG0th0W1DPLyudeSUhpwkdaFL4xi7vCZDjNFtvdsTDetfTZCPFcHKRaEqvSMeD3KpY2qlfImJHxRfBpp884jcZ5%2FRTSy%2FN9Hh0%2F4vfx2hYi7Zfx0gj24rIng5gQtGKc%2BfonSBwwzaArZ83NUrbw%2FrZjjmbQZMZytn%2B3VjI7CEXuoutrer2%2BlhcXxXAII9gY9sUsYD6tMYhZeldL7fNM6m1USr7POF0kQIgRD%2BwpzvpLLRhlMhCngUyrc4Jfw%2BG%2F7JlK0fcrLs%2BSKtNnZFI%2BZsVxmUNX8U82WNcti%2BVYxTYZLIremGufgENoU1IuZjfqKfmffLcKt8QCrhM6YRFusRHRgOEScvdbtD0nz9Q79SheJBavEdGpXzvqBwI78U%2ByROpwmj6U5Rdl2V24BwvErQHpatcPe62l6F8gUzjtOTm5dvLUManGQLoDtSsC2dDxRWGVQcr6CVswOmK4A9kRBP15iJbQ0OmK0fAaYZKmC60SdgwOrAGe5GwOlJXP4RgYBOBKL9MwKBLQlEHxWBQMUf3JCIvU%2BRF5F4dA4xa%2FAHp1d3sP%2B7Qyt3MD6kOxivuYOAgBOXJGINdHi3cLSxuYUzUrcYW5hpfki3gPrw6u2oqi5m0YN6jXPrVw69oUSsuYzAoVkPKIFzRAH5luSwIzM5rKO75ZgKoY4k1FZyEzB4bmIpWCV0zX2G14OjZTotEhMAej1yzOE5SXILqDLLgWfeOnJqcVhJamc%2FcuyWnGQNdeTM719u7hfBJvXAz6X2bYaWN%2FMiMRmddu2Pqt5xFa5shev2JdShec7Q2vBcvxUrtcbnaI5ayS2hAv3kIEqtquEAbSpV6WdA6vvjhWuli2v3GS5Xic%2FMu8joRBmDxaWN3tiokreDSf0vPbk5drSPfeHgHMUc%2BcqU2PHtmeCs3yhUV8u%2BI%2FAg6ziognp%2FHtSMk1oONDVthEjpgyOlVopMoyFN7h0pcJTw9cnKzUipKSAEusrVfSNlHCeAfSLVGPKOoMjSobT8qiqqkWvjfkHjGXj2c8xRFG20O8c6nD6n9qkWlRlOhJJOeEJP1eQjdu2zmtwYyHVxhPPZfpdk%2FhDtvSfbaxP8VZ2oEau2QWJf2d6pRVY8gEb%2Blj%2Bt1%2BE5rF8x9QYo2%2BcxTZcUejV%2FNbRQQCLR%2FqJTFYoQPeJwfrimtKAhZfvOxUUlOJejLkjki4WF5FH8CipKHlDGQlcJpon4gH51R9kzZg93NELxg5jYfX4QqKTi%2F1MS%2B2fA3DKMOubQUjG3GzC334%2B5aJbXrnJKL6%2B2wcs%2F

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

## Creating a Facebook App

A Facebook app is required for sign-in via Facebook Login.

1. Visit [`developers.facebook.com`](https://developers.facebook.com/) and create an app via "My Apps".
2. Enter any _Display Name_ and click `Create App ID`.
3. Click `Set Up` under "Facebook Login" (ignore the setup wizard that appears).
    <details>
      <summary>Screenshot</summary>

      ![screenshot](/docs/images/facebook-app-1.png)
    </details>
4. Click `Settings > Basic` and add your domain (or IP) to _App Domains_.
    <details>
      <summary>Screenshot</summary>

      ![screenshot](/docs/images/facebook-app-2.png)
    </details>
5. Note the _App ID_.
6. Configure `FB_APP_ID` within `polis.config.js` of both the participation and admin client components.
7. Configure `EXTRA_FACEBOOK_PERMS` within `docker-compose.yml`. Useable permission scopes are:
    - `email` - required?
    - `user_friends` - optional. allows account-holders to see their friends in visualizations if those friends have also connected Facebook to Polis.
8. Rebuild your docker environment.

## Contribution notes

Please help us out as you go in setting things up by improving the deployment code and documentation!

* General/system-wide issues you come across can go in https://github.com/pol-is/polis-issues/issues, and repo specific issues in their respective issues lists
* PRs improving either documentation or deployment code are welcome, but please submit an issue to discuss before making any substantial code changes
* After you've made an issue, you can try to chat folks up at https://gitter.im/pol-is/polisDeployment

