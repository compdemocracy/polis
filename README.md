# Polis report

## Development

Same environment variables as the rest of the apps.
Once you have the npm modules set up (`npm install`?), you can run the development server (with hot code reloading) by running `./x`.

## Deployment

Deploy using the `deployPreprod` and `deploy_TO_PRODUCTION`, as appropriate.

Note that you will first have to copy over the `polis.config.template.js` file to `polis.config.js`, and edit appropriately.
You will also need to have AWS credentials set up at `.polis_s3_creds_client.json` (this should look like...).

