const devMode = require('boolean')(get('DEV_MODE'));

const domainOverride = process.env.DOMAIN_OVERRIDE || null;

function getServerNameWithProtocol(req) {
  let server = "https://pol.is";

  if (domainOverride) {
    server = req.protocol + "://" + domainOverride;
  }
  if (devMode) {
    // usually localhost:5000
    server = "http://" + req.headers.host;
  }

  if (req.headers.host.includes("preprod.pol.is")) {
    server = "https://preprod.pol.is";
  }
  if (req.headers.host.includes("embed.pol.is")) {
    server = "https://embed.pol.is";
  }
  if (req.headers.host.includes("survey.pol.is")) {
    server = "https://survey.pol.is";
  }
  return server;
}

function get(key) {
	return process.env[key];
}

function isDevMode() {
	return devMode;
}

module.exports = {
  domainOverride,
  getServerNameWithProtocol,
	get,
	isDevMode
};
