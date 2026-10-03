// /api/v3/ops/*: the protected operations pages. GET only, aggregates only.
//
// Order of checks on every request:
//
//   1. OPS_ENABLED. Off (the default): every /api/v3/ops path answers 404 and
//      nothing else runs.
//   2. A Bearer access token that passes jwtValidation (the OIDC issuer's JWKS,
//      RS256, issuer and audience). jwtValidation is mounted directly, not
//      through hybridAuth: hybridAuth maps the token to a uid and upserts users
//      and oidc_user_mappings, and ops needs no uid, so an ops request writes
//      nothing. Participant, XID and anonymous tokens fail this step.
//   3. The claim checks in src/utils/opsGate.ts (connection strategy, verified
//      email against OPS_EMAIL_DOMAINS with deny entries winning, hd).
//
// A refusal at 2 or 3 is 403 polis_err_ops_forbidden with no detail; the
// reason goes only to the ops_access log line, which carries a 12-character
// sha256 prefix of the token subject and never the email or the subject.

import crypto from "crypto";
import type { NextFunction, Response } from "express";
import logger from "../utils/logger";
import {
  decideOps,
  OpsConfigError,
  OpsEmailPolicy,
  parseOpsEmailDomains,
} from "../utils/opsGate";
import { findPage, PAGES, PanelCache } from "../ops/pages";

type Middleware = (req: any, res: Response, next: NextFunction) => unknown;

export type OpsRouteOptions = {
  enabled: boolean;
  emailDomains: string | null | undefined;
  devMode: boolean;
  namespace: string | null | undefined;
  audience: string | null | undefined;
  issuer: string | null | undefined;
  validateJwt: Middleware;
  cache?: PanelCache;
  clock?: () => number;
};

export type OpsRoutes = {
  // True only when OPS_ENABLED is on and the configuration was accepted.
  active: boolean;
  gate: Middleware;
  whoami: (req: any, res: Response) => void;
  page: (req: any, res: Response) => Promise<void>;
  notFound: (req: any, res: Response) => void;
};

function subjectHash(sub: unknown): string | null {
  if (typeof sub !== "string" || sub.length === 0) return null;
  return crypto.createHash("sha256").update(sub).digest("hex").slice(0, 12);
}

function logAccess(fields: {
  route: string;
  page?: string;
  status: number;
  reason?: string;
  sub?: unknown;
  cache?: string;
}) {
  // warn, not info: production runs at the default "warn" level, and this
  // line is the access record for the pages.
  logger.warn("ops_access", {
    route: fields.route,
    page: fields.page,
    status: fields.status,
    reason: fields.reason,
    sub_sha256: subjectHash(fields.sub),
    cache: fields.cache,
  });
}

function noStore(res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// Refusals are counted, not logged one by one: every admin page load asks
// whoami, so a line per refusal would be log volume driven by ordinary admin
// traffic. One info line per minute per process at most, with counts by
// route and reason.
const REFUSAL_LOG_INTERVAL_MS = 60 * 1000;

function makeRefusalCounter(clock: () => number) {
  let counts: Record<string, number> = {};
  let windowStart = clock();
  return (route: string, reason: string) => {
    const key = `${route}:${reason}`;
    counts[key] = (counts[key] || 0) + 1;
    const now = clock();
    if (now - windowStart >= REFUSAL_LOG_INTERVAL_MS) {
      logger.info("ops_refused", { window_ms: now - windowStart, counts });
      counts = {};
      windowStart = now;
    }
  };
}

/**
 * Decide, once at start-up, whether ops can run. Never throws: a missing auth
 * setting or a malformed OPS_EMAIL_DOMAINS logs one error and leaves ops off
 * (every ops path answers 404). The rest of the API never depends on an ops
 * setting.
 */
function startupPolicy(options: OpsRouteOptions): OpsEmailPolicy | null {
  if (!options.enabled) return null;
  const missing = [
    ["AUTH_NAMESPACE", options.namespace],
    ["AUTH_AUDIENCE", options.audience],
    ["AUTH_ISSUER", options.issuer],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.error("ops_disabled", {
      error: "polis_err_ops_auth_config_missing",
      missing,
    });
    return null;
  }
  try {
    return parseOpsEmailDomains(options.emailDomains, options.devMode);
  } catch (err) {
    logger.error("ops_disabled", {
      error: err instanceof OpsConfigError ? err.message : "invalid_config",
    });
    return null;
  }
}

/**
 * Build the ops handlers. Called once by app.ts at module load.
 */
export function createOpsRoutes(options: OpsRouteOptions): OpsRoutes {
  const policy = startupPolicy(options);
  const cache = options.cache || new PanelCache();
  const countRefusal = makeRefusalCounter(options.clock || Date.now);

  const notFound = (_req: any, res: Response) => {
    noStore(res);
    res.status(404).json({ error: "not_found" });
  };

  const forbid = (req: any, res: Response, reason: string) => {
    const route = req.params?.id !== undefined ? "page" : "whoami";
    if (route === "page" && reason !== "token_missing") {
      // A token-bearing request for page data is the access record.
      logAccess({
        route,
        page: req.params.id,
        status: 403,
        reason,
        sub: req.jwtPayload?.sub,
      });
    } else {
      countRefusal(route, reason);
    }
    noStore(res);
    res.status(403).json({ error: "polis_err_ops_forbidden" });
  };

  const gate: Middleware = (req, res, next) => {
    if (!policy) return notFound(req, res);
    const auth = req.headers?.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      return forbid(req, res, "token_missing");
    }
    // A payload from anywhere but jwtValidation is never trusted.
    req.jwtPayload = undefined;
    let settled = false;
    const after = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err || !req.jwtPayload) return forbid(req, res, "token_invalid");
      const decision = decideOps(req.jwtPayload, options.namespace, policy);
      if (!decision.ok) return forbid(req, res, decision.reason);
      next();
    };
    try {
      const r = options.validateJwt(req, res, after);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((e) =>
          after(e || new Error("token_invalid"))
        );
      }
    } catch (err) {
      after(err || new Error("token_invalid"));
    }
  };

  const whoami = (req: any, res: Response) => {
    logAccess({ route: "whoami", status: 200, sub: req.jwtPayload?.sub });
    noStore(res);
    res.status(200).json({
      ops: true,
      pages: PAGES.map((p) => ({
        id: p.id,
        group: p.group,
        title: p.title,
        summary: p.summary,
        refresh_s: p.refresh_s,
      })),
    });
  };

  const page = async (req: any, res: Response) => {
    const def = findPage(String(req.params?.id || ""));
    if (!def) {
      logAccess({ route: "page", status: 404, sub: req.jwtPayload?.sub });
      return notFound(req, res);
    }
    const panels = [];
    let hits = 0;
    for (const panel of def.panels) {
      const { panel: result, hit } = await cache.get(def.id, panel);
      if (hit) hits += 1;
      panels.push(result);
    }
    logAccess({
      route: "page",
      page: def.id,
      status: 200,
      sub: req.jwtPayload?.sub,
      cache: hits === panels.length ? "hit" : hits === 0 ? "miss" : "partial",
    });
    noStore(res);
    res.status(200).json({
      id: def.id,
      group: def.group,
      title: def.title,
      summary: def.summary,
      refresh_s: def.refresh_s,
      generated_ms: Date.now(),
      panels,
    });
  };

  return { active: policy !== null, gate, whoami, page, notFound };
}
