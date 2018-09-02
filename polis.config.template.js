
module.exports = {

  domainWhitelist: [
    "^localhost$",
    "^192\\.168\\.1\\.140$",
    "^pol\\.is",
    ".+\\.pol\\.is$",
    "^xip\\.io$",
    ".+\\.xip\\.io$",
  ],

  // Switch to localhost to forward server requests through to a local server rather than a preprod server
  //SERVICE_URL: "http://localhost:5000",
  SERVICE_URL: "https://preprod.pol.is",

  PORT: 5001,

  DISABLE_INTERCOM: true,

  FB_APP_ID: '661042417336977',

  S3_BUCKET_PROD: 'pol.is',
  S3_BUCKET_PREPROD: 'preprod.pol.is',

  SCP_SUBDIR_PREPROD: 'preprod',
  SCP_SUBDIR_PROD: 'prod',


  UPLOADER: 'scp',
  // UPLOADER: 's3',
};
