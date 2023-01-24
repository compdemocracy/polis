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
  ],

  // Used for setting appropriate hostname for embedding.
  //SERVICE_HOSTNAME: "123.45.67.89.sslip.io",
  SERVICE_HOSTNAME: "localhost",

  // must register with facebook and get a facebook app id to use the facebook auth features
  FB_APP_ID: "661042417336977"
};
