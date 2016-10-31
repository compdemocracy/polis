# PolisClientAdmin install guide

This instructions assume you are running Debian Stretch.

Run as root:

    # apt-get install npm curl git

Following the [nodejs v6.x](https://github.com/nodesource/distributions#deb)
run as root.

    # curl -sL https://deb.nodesource.com/setup_6.x | bash -
    # apt-get install -y nodejs

Install dependencies via `npm`:

    $ npm install

If you are running polisServer locally, be sure to set
the `SERVICE_URL` environment varible in the `.env_dev` file.

Run polisClientAdmin:

    $ . .env_dev
    $ nodejs dev-server.js
