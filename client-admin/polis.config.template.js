
module.exports = {

  domainWhitelist: [
    "^localhost$",
    "^192\\.168\\.+",
    ".+\\polis\\.collectiveintelligence\\.service\\.cabinetoffice\\.gov\\.uk$",
    "^polis\\.collectiveintelligence\\.service\\.cabinetoffice\\.gov\\.uk"
  ],

  DISABLE_INTERCOM: true,
  DISABLE_PLANS: true,

  FB_APP_ID: '661042417336977',

  //SERVICE_URL: 'http://localhost:5000',
  SERVICE_URL: 'https://polis.collectiveintelligence.service.cabinetoffice.gov.uk',


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
