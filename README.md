[![Build Status](https://travis-ci.org/pol-is/polisClientAdmin.svg?branch=master)](https://travis-ci.org/pol-is/polisClientAdmin) [![Code Climate](https://codeclimate.com/github/pol-is/polisClientAdmin/badges/gpa.svg)](https://codeclimate.com/github/pol-is/polisClientAdmin) [![Test Coverage](https://codeclimate.com/github/pol-is/polisClientAdmin/badges/coverage.svg)](https://codeclimate.com/github/vital-edu/sala-de-espera/coverage)

Polis Admin Console
===================

Configuration
-------------

Install the NVM following the instructions: [NVM Installation Guide](https://github.com/creationix/nvm#install-script).

Them run the commands below to install the correct Node.JS version and the application dependencies.

```sh
nvm install 6.2.0
npm install
```

### Common Problems

If you having troubles with npm dependencies try run the commands below:

```sh
npm cache clear
npm install
```

Running Application
-------------------

```sh
nvm use 6.2.0
npm start
```

Running Tests
-------------

We use the Jest Testing Framework.

```sh
npm test
```

Building and Deploying for Production
-------------------------------------

To build static assets for a production deployment, run

```sh
gulp dist
```

As a convenience, the `deploy_TO_PRODUCTION` script is provided for deploying to AWS S3 or via SCP to a static file server.
For S3 deployment, place your AWS credentials in a JSON file at `.polis_s3_creds_client.json` that looks like this:

```json
{"key": "XXXXXXX", "secret": "YYYYYYY"}
```

---

### Icons from the Noun Project

* Checklist by David Courey from the Noun Project
* AI by mungang kim from the Noun Project
* Science by Akriti Bhusal from the Noun Project
* Success File by Ben Davis from the Noun Project

## Collections to look into

* https://thenounproject.com/vectorsmarket/collection/project-management-line-icon/?i=1326778


**Want to contribute to this project?** See the [Contribution Guide](CONTRIBUTING.md) for more informations.
