import _ from "underscore";
import httpProxy from "http-proxy";
import { failJson } from "../utils/fail";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import type { ExpressRequest, ExpressResponse } from "../d";

function writeDefaultHead(
  req: ExpressRequest,
  res: ExpressResponse,
  next: () => void
) {
  res.set({
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  next();
}

function redirectIfNotHttps(
  req: {
    headers: { [x: string]: string; host: string };
    method: string;
    path: string;
    url: string;
  },
  res: {
    end: () => any;
    status: (arg0: number) => {
      send: (arg0: string) => any;
    };
    writeHead: (arg0: number, arg1: { Location: string }) => void;
  },
  next: () => any
) {
  // Exempt dev mode or healthcheck path from HTTPS check
  if (
    Config.isDevMode ||
    req.path === "/api/v3/testConnection" ||
    Config.useNetworkHost
  ) {
    return next();
  }

  // Check if the request is already HTTPS
  const isHttps = req.headers["x-forwarded-proto"] === "https";

  if (!isHttps) {
    logger.debug("redirecting to https", { headers: req.headers });
    // Only redirect GET requests; otherwise, send a 400 error for non-GET methods
    if (req.method === "GET") {
      res.writeHead(302, {
        Location: `https://${req.headers.host}${req.url}`,
      });
      return res.end();
    } else {
      res.status(400).send("Please use HTTPS when submitting data.");
    }
  }
  return next();
}

const whitelistedDomains = [
  Config.getServerHostname(),
  ...Config.whitelistItems,
  "localhost:5000",
  "localhost:5001",
  "localhost:5010",
  "", // for API
];

function hasWhitelistMatches(host: string): boolean {
  // Remove protocol if present
  const hostWithoutProtocol = host.replace(/^https?:\/\//, "");

  // Check each whitelisted domain
  return whitelistedDomains.some((pattern) => {
    if (!pattern) return false;

    // Check for exact match or subdomain match
    if (hostWithoutProtocol === pattern) {
      return true;
    }

    // Check if it's a subdomain (e.g., sub.example.com matches example.com)
    if (hostWithoutProtocol.endsWith("." + pattern)) {
      return true;
    }

    return false;
  });
}

function addCorsHeader(
  req: ExpressRequest,
  res: ExpressResponse,
  next: (arg0?: string) => any
) {
  // Determine the origin
  let origin = "";
  if (Config.domainOverride) {
    origin = `${req.protocol}://${Config.domainOverride}`;
  } else {
    // Use Origin header first, fall back to Referer
    const originHeader = req.get("Origin") || req.get("Referer") || "";
    // Clean up the origin - remove fragment and path
    origin = originHeader
      .replace(/#.*$/, "")
      .replace(/^([^\/]*\/\/[^\/]*).*/, "$1");
  }

  // Determine if domain validation should be skipped.
  const isTestingMode = Config.nodeEnv === "test" || Config.isTesting;
  const isDevAndLocalhost =
    Config.isDevMode && origin && origin.includes("localhost");

  const shouldSkipValidation =
    Config.domainOverride || // Skip if domain override is set.
    !origin || // Skip if there's no origin header.
    isTestingMode || // Skip in test environments.
    isDevAndLocalhost; // Skip for localhost in dev mode.

  // If validation is not skipped, check the origin against the whitelist.
  if (!shouldSkipValidation) {
    if (!hasWhitelistMatches(origin)) {
      logger.info("CORS: domain not whitelisted", {
        origin,
        path: req.path,
        headers: req.headers,
      });
      return next("unauthorized domain: " + origin);
    }
  }

  // Set CORS headers
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Headers",
      "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With"
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET, PUT, POST, DELETE, OPTIONS"
    );
  }

  return next();
}

async function isParentDomainWhitelisted(
  domain: string,
  zid: number,
  isWithinIframe: boolean,
  domain_whitelist_override_key: string | null
): Promise<boolean> {
  try {
    // Fetch whitelist configuration
    const config = await pg.queryP_readOnly(
      `SELECT sdw.domain_whitelist, sdw.domain_whitelist_override_key
       FROM site_domain_whitelist sdw
       JOIN users u ON u.site_id = sdw.site_id  
       JOIN conversations c ON c.owner = u.uid
       WHERE c.zid = $1`,
      [zid]
    );

    logger.debug("isParentDomainWhitelisted", {
      domain,
      zid,
      isWithinIframe,
    });

    // No whitelist means all domains allowed
    if (!config?.[0]?.domain_whitelist?.length) {
      logger.debug("isParentDomainWhitelisted : no whitelist");
      return true;
    }

    const whitelistDomains = config[0].domain_whitelist
      .split(",")
      .map((d) => d.trim());

    // Check override key
    if (
      domain_whitelist_override_key &&
      config[0].domain_whitelist_override_key === domain_whitelist_override_key
    ) {
      return true;
    }

    // Special case: allow pol.is outside iframe if whitelisted
    if (!isWithinIframe && whitelistDomains.includes("*.pol.is")) {
      logger.debug("isParentDomainWhitelisted : *.pol.is");
      return true;
    }

    // Check if domain matches any whitelist pattern
    const isAllowed = whitelistDomains.some((pattern) =>
      isDomainMatch(domain, pattern)
    );

    logger.debug("isParentDomainWhitelisted : " + isAllowed);
    return isAllowed;
  } catch (err) {
    logger.error("Error checking domain whitelist", err);
    throw err;
  }
}

// Helper function for domain pattern matching
function isDomainMatch(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    // Wildcard matching: *.example.com matches sub.example.com and example.com
    const baseDomain = pattern.slice(2);
    return domain === baseDomain || domain.endsWith("." + baseDomain);
  }
  // Exact match
  return domain === pattern;
}

function extractDomainFromReferrer(
  referrer: string | undefined,
  isWithinIframe: boolean
): string {
  if (!referrer) {
    logger.debug("No referrer provided");
    return "";
  }

  try {
    if (isWithinIframe) {
      // Extract parent_url parameter from iframe referrer
      const parentUrlMatch = referrer.match(/parent_url=([^&]*)/);
      if (parentUrlMatch) {
        const decodedUrl = decodeURIComponent(parentUrlMatch[1]);
        const url = new URL(decodedUrl);
        const domain = url.host; // host includes port, hostname doesn't
        logger.debug("Extracted domain from iframe parent_url", {
          referrer,
          decodedUrl,
          domain,
        });
        return domain;
      }
    } else {
      // Extract host from regular referrer
      const url = new URL(referrer);
      const domain = url.host; // host includes port, hostname doesn't
      logger.debug("Extracted domain from regular referrer", {
        referrer,
        domain,
      });
      return domain;
    }
  } catch (err) {
    logger.debug("Failed to parse referrer URL", { referrer, error: err });
  }

  logger.debug("Could not extract domain from referrer", {
    referrer,
    isWithinIframe,
  });
  return "";
}

async function denyIfNotFromWhitelistedDomain(
  req: ExpressRequest & {
    headers?: { referrer?: string; referer?: string };
    p: { zid: number; domain_whitelist_override_key: any };
  },
  res: ExpressResponse,
  next: (arg0?: string) => void
) {
  try {
    // Skip domain validation during testing (consistent with CORS validation)
    const isTestingMode = Config.nodeEnv === "test" || Config.isTesting;
    if (isTestingMode) {
      return next();
    }

    const referrer = req.headers?.referrer || req.headers?.referer;
    const isWithinIframe = referrer?.includes("parent_url") || false;

    const domain = extractDomainFromReferrer(referrer, isWithinIframe);
    const zid = req.p.zid;

    // In development mode, be more permissive with localhost origins
    if (Config.isDevMode && domain && domain.startsWith("localhost")) {
      return next();
    }

    const isAllowed = await isParentDomainWhitelisted(
      domain,
      zid,
      isWithinIframe,
      req.p.domain_whitelist_override_key
    );

    if (isAllowed) {
      next();
    } else {
      logger.warn("Domain not whitelisted", { domain, zid, referrer });
      res.status(403).json({ error: "polis_err_domain" });
    }
  } catch (err) {
    logger.error("Error checking domain whitelist", err);
    res.status(403).json({ error: "polis_err_domain_misc" });
  }
}

async function setDomainWhitelist(
  uid: number,
  newWhitelist: string
): Promise<void> {
  // Check if record exists first
  const rows = (await pg.queryP(
    "select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));",
    [uid]
  )) as any[];

  if (!rows || !rows.length) {
    // Insert new record
    await pg.queryP(
      "insert into site_domain_whitelist (site_id, domain_whitelist) values ((select site_id from users where uid = ($1)), $2);",
      [uid, newWhitelist]
    );
  } else {
    // Update existing record
    await pg.queryP(
      "update site_domain_whitelist set domain_whitelist = ($2) where site_id = (select site_id from users where uid = ($1));",
      [uid, newWhitelist]
    );
  }
}

async function getDomainWhitelist(uid: number): Promise<string> {
  const rows = await pg.queryP(
    `SELECT domain_whitelist 
     FROM site_domain_whitelist 
     WHERE site_id = (SELECT site_id FROM users WHERE uid = $1)`,
    [uid]
  );
  return rows?.[0]?.domain_whitelist || "";
}

async function handle_GET_domainWhitelist(
  req: ExpressRequest & { p: { uid?: any } },
  res: ExpressResponse
) {
  try {
    const whitelist = await getDomainWhitelist(req.p.uid);
    res.json({
      domain_whitelist: whitelist,
    });
  } catch (err) {
    logger.error("Failed to get domain whitelist", err);
    failJson(res, 500, "polis_err_get_domainWhitelist_misc", err);
  }
}

async function handle_POST_domainWhitelist(
  req: ExpressRequest & { p: { uid?: any; domain_whitelist: any } },
  res: ExpressResponse
) {
  try {
    await setDomainWhitelist(req.p.uid, req.p.domain_whitelist);
    res.json({
      domain_whitelist: req.p.domain_whitelist,
    });
  } catch (err) {
    logger.error("Failed to set domain whitelist", err);
    failJson(res, 500, "polis_err_post_domainWhitelist_misc", err);
  }
}

function addStaticFileHeaders(res: ExpressResponse) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function proxy(
  req: ExpressRequest & { headers?: { host?: string }; path: any },
  res: ExpressResponse
) {
  const hostname = Config.staticFilesHost;

  if (!hostname) {
    const requestHost = req.headers?.host || "";
    const serverHostRegex = new RegExp(Config.getServerHostname() + "$");

    logger.error("Static files host not configured", {
      requestHost,
      serverHostname: Config.getServerHostname(),
    });

    // Return appropriate error based on host match
    const errorMessage = serverHostRegex.test(requestHost)
      ? "Static files host not configured"
      : `Invalid proxy request from host: ${requestHost}`;

    return failJson(
      res,
      500,
      "polis_err_proxy_serving_to_domain",
      new Error(errorMessage)
    );
  }

  if (Config.isDevMode) {
    addStaticFileHeaders(res);
  }

  const port = Config.staticFilesParticipationPort;
  const routingProxy = httpProxy.createProxyServer();

  // Update host header for proper routing
  if (req.headers) {
    req.headers.host = hostname;
  }

  // Handle proxy errors
  routingProxy.on("error", (err: Error) => {
    logger.error("Proxy error", { error: err, path: req.path });
    failJson(res, 502, "polis_err_proxy_error", err);
  });

  // @ts-ignore - Legacy Express v3 proxy type mismatch
  routingProxy.web(req, res, {
    target: {
      host: hostname,
      port: port,
    },
  });
}

function makeRedirectorTo(path: string) {
  return function redirectHandler(req: ExpressRequest, res: ExpressResponse) {
    const protocol = Config.isDevMode ? "http" : "https";
    const host = req.headers.host || Config.getServerHostname();
    const url = `${protocol}://${host}${path}`;

    res.writeHead(302, { Location: url });
    res.end();
  };
}

export {
  addCorsHeader,
  denyIfNotFromWhitelistedDomain,
  handle_GET_domainWhitelist,
  handle_POST_domainWhitelist,
  makeRedirectorTo,
  proxy,
  redirectIfNotHttps,
  writeDefaultHead,
};
