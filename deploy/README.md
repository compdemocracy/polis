# Polis Deploy

Tools for deploying Polis static assets to S3.

## Prerequisites

- python 3.8+
- aws cli
- heroku cli

### Push the backend code to Heroku

```bash
heroku login
git push <heroku-remote> edge:main
```

_Replace `<heroku-remote>` with the appropriate heroku remote, e.g. heroku-preprod_

### Build the Polis static assets

from the root of the project:

```bash
make ENV_FILE=<env-file> PROD build-web-assets
```

### AWS CLI

Log into AWS SSO and configure your AWS CLI with the appropriate profile.

#### First time setup (or to refresh credentials)

```bash
aws configure sso
```

follow the prompts to configure your profile.
e.g.

> SSO session name: polis-deploy
>
> SSO start URL: [aws-start-url]
>
> SSO region: us-east-1
>
> SSO registration scopes: [enter for default]
>
> CLI default client Region: us-east-1
>
> CLI default output format: json
>
> CLI profile name: polis-deploy

#### Login with the above profile

```bash
export AWS_PROFILE=polis-deploy

aws sso login

# Verify that you are logged in
aws sts get-caller-identity
```

## Python Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r dev-requirements.txt
```

## Usage

```bash
python deploy-static-assets.py --bucket <bucket-name>
```

_Replace `<bucket-name>` with the appropriate bucket name, e.g. edge.static-assets.pol.is_

Or from the root of the project:

```bash
python deploy/deploy-static-assets.py --bucket <bucket-name>
```
