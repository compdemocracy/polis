# polisDeployment

If you're interested in deploying Polis, or setting up a development environment, you've come to the right place.

## Overview of system

First things first, it helps to understand a bit how the system is set up.

The main server is a node app located at https://github.com/pol-is/polisServer.
This handles web requests from clients, including page loads, vote activity, etc.

The next big piece is the math engine, located at https://github.com/pol-is/polisMath.
This piece is written in Clojure, and thus runs on the JVM.

Client code has been separated out into https://github.com/pol-is/polisClientParticipation and https://github.com/pol-is/polisClientAdmin.
The code in these repos compile to static assets.
We push these to s3 for CDN via `deployPreprod` and `deploy_TO_PRODUCTION`, but there is a config file for each of these projects which will allow you to configure the behavior of these scripts as described in the READMEs.
Of note though, you can use a static file server, and deploy via these scripts over `sshfs`.
Finally, for local development, these repos have hot-reload able servers you can run with the `./x` command, but note that this is not the recommended approach for serving the client assets in production.

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


## Basic deployment

* Best place to start is the main server repo: https://github.com/pol-is/polisServer, which has instructions on setting up the database.
* Then math server: https://github.com/pol-is/polisMath
* Then build client repos and serve from some static file server...

## Docker deployment

* There's a docker-compose.yml file in https://github.com/pol-is/polisServer/blob/master/docker-compose.yml which has some instructions on running a partial dev environment with docker-compose.
* Some one else did some dockerization work here https://github.com/uzzal2k5/polis_container.

Ultimately, it would be great if all of this content was merged into this `polis-deploy` repo.


## Contribution notes

Please help us out as you go in setting things up by improving the deployment code and documentation!

* General/system-wide issues you come across can go in https://github.com/pol-is/polis-issues/issues, and repo specific issues in their respective issues lists
* PRs improving either documentation or deployment code are welcome, but please submit an issue to discuss before making any substantial code changes



