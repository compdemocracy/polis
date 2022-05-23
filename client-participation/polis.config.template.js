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

  // Point to a polisServer instance (local recommended for dev)
  //SERVICE_URL: "http://localhost:5000", // local server; recommended for dev
  SERVICE_URL: "http:localhost:5000",

  // Used for setting appropriate hostname for embedding.
  //SERVICE_HOSTNAME: "123.45.67.89.sslip.io",
  SERVICE_HOSTNAME: "localhost",

  // Note that this must match the participation client port specified in polisServer instance
  PORT: 5001,

  DISABLE_INTERCOM: true,

  // must register with facebook and get a facebook app id to use the facebook auth features
  FB_APP_ID: "661042417336977",

  // For data exports

  UPLOADER: "local", // alt: s3, scp

  // Uploader settings: local
  LOCAL_OUTPUT_PATH: "./build",

  // Uploader settings: s3
  S3_BUCKET_PROD: "pol.is",
  S3_BUCKET_PREPROD: "preprod.pol.is",

  // Uploader settings: scp
  SCP_SUBDIR_PREPROD: "preprod",
  SCP_SUBDIR_PROD: "prod",
};
