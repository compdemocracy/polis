
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

  FB_APP_ID: '661042417336977'
};
