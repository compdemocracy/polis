import boolean from "boolean";

let POLIS_ROOT = process.env.POLIS_ROOT
var config = require(POLIS_ROOT + 'config/config.js');

const devMode = boolean(config.get('dev_mode'));

const domainOverride = config.get('domain_override') || null;

function getServerNameWithProtocol(req: any) {
  let server = "https://pol.is";

  if (domainOverride) {
    server = req.protocol + "://" + domainOverride;
  }
  if (devMode) {
    // usually localhost:5000
    server = req.protocol + "://" + req.headers.host;
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

function isDevMode() {
  return devMode;
}

export { domainOverride, getServerNameWithProtocol, get, isDevMode };
export default { domainOverride, getServerNameWithProtocol, get, isDevMode };
