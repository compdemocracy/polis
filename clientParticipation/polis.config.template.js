
module.exports = {

  domainWhitelist: [
    "^localhost$",
    "^192\\.168\\.1\\.140$",
    "^pol\\.is",
    ".+\\.pol\\.is$",
    "^xip\\.io$",
    ".+\\.xip\\.io$",
  ],

  // Point to a polisServer instance (local recommended for dev)
  //SERVICE_URL: "http://localhost:5000", // local server; recommended for dev
  SERVICE_URL: "https://preprod.pol.is",

  // Note that this must match the participation client port specified in polisServer instance
  PORT: 5001,

  DISABLE_INTERCOM: true,

  // must register with facebook and get a facebook app id to use the facebook auth features
  FB_APP_ID: '661042417336977',

  // For data exports

  S3_BUCKET_PROD: 'pol.is',
  S3_BUCKET_PREPROD: 'preprod.pol.is',

  SCP_SUBDIR_PREPROD: 'preprod',
  SCP_SUBDIR_PROD: 'prod',

  UPLOADER: 'scp',
  // UPLOADER: 's3',
};
