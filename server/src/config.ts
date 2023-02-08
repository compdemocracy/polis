import isTrue from "boolean";

const devMode = isTrue(process.env.DEV_MODE);
const domainOverride = process.env.DOMAIN_OVERRIDE || null;

export default {
  domainOverride: domainOverride as string | null,
  isDevMode: devMode as boolean,

  getServerNameWithProtocol: (req: any): string => {
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
}
