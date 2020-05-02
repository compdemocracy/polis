# Polis report

## Development

Same environment variables as the rest of the apps.
Once you have the npm modules set up (`npm install`?), you can run the development server (with hot code reloading) by running `./x`.

Note that there should be a file at `.env_dev` which will be read from when you call `./x`.
This shell script file should contain a line like `export SERVICE_URL=https://polis.yourlocalns`.
This should point to whichever `polisServer` instance you like (likely either `http://localhost:5000` for a local dev instance).

## Deployment

Deploy using the `deployPreprod` and `deploy_TO_PRODUCTION`, as appropriate.

Note that you will first have to copy over the `polis.config.template.js` file to `polis.config.js`, and edit appropriately.
In particular, here you can specify the service url for the static build, as well as the uploader method and s3 bucket information.

You will also need to have AWS credentials set up at `.polis_s3_creds_client.json` if you are using S3 buckets for deployment (as specified in `polis.config.js`; other option is scp to a static file server).
The credential file should be a json that looks more or less like

```
{"key": "AKIDFDCFDFDSDFDDSEWW",
 "secret": "dfkjw3DDfkjd902k39cjglkjs039i84kjccC"}
```

