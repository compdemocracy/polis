
module.exports = {

  domainWhitelist: [
    // local ports
    "^localhost$",
    "^127\\.0\\.0\\.1$",
    "^192\\.168\\.1\\.140$",
    // sample configuration for main pol.is deployment
    "^pol\\.is",
    ".+\\.pol\\.is$",
    // These allow for local ip routing for remote dev deployment
    "^(n|ssl)ip\\.io$",
    ".+\\.(n|ssl)ip\\.io$",
    "^polis\\.local",
  ],

  DISABLE_INTERCOM: true,
  DISABLE_PLANS: true,

  FB_APP_ID: '661042417336977',

  //SERVICE_URL: 'http://localhost:5000',
  SERVICE_URL: 'https://preprod.pol.is',

  UPLOADER: 'local', // alt: s3, scp

  // Uploader settings: local
  LOCAL_OUTPUT_PATH: './build',

  // Uploader settings: s3
  S3_BUCKET_PROD: 'pol.is',
  S3_BUCKET_PREPROD: 'preprod.pol.is',

  // Uploader settings: scp
  SCP_SUBDIR_PREPROD: 'preprod',
  SCP_SUBDIR_PROD: 'prod',
};
