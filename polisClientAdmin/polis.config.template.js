
module.exports = {

  domainWhitelist: [
    "^localhost$",
    "^192\\.168\\.1\\.140$",
    "^pol\\.is",
    ".+\\.pol\\.is$",
    "^xip\\.io$",
    ".+\\.xip\\.io$",
  ],

  DISABLE_INTERCOM: true,
  DISABLE_PLANS: true,

  FB_APP_ID: '661042417336977',

  S3_BUCKET_PROD: 'pol.is',
  S3_BUCKET_PREPROD: 'preprod.pol.is',

  SCP_SUBDIR_PREPROD: 'preprod',
  SCP_SUBDIR_PROD: 'prod',

  //SERVICE_URL: 'http://localhost:5000',
  SERVICE_URL: 'https://preprod.pol.is',

  UPLOADER: 'scp',
  // UPLOADER: 's3',
};
