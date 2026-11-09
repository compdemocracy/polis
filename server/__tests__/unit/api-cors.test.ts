/**
 * The CORS step every /api/v3 request passes through (`addCorsHeader`,
 * mounted on `app.all("/api/v3/*")` in app.ts, followed by
 * `middleware_check_if_options`).
 *
 * The API authenticates with a bearer token in the Authorization header and
 * reads no cookie, so there is no per-origin credential to protect. A request
 * from any origin is answered by its route. When the request names an origin
 * (Origin, else Referer) or DOMAIN_OVERRIDE is set, the response carries
 * `Access-Control-Allow-Origin: *` with the allowed headers and methods, and
 * never `Access-Control-Allow-Credentials`, so no browser will make a
 * credentialed cross-origin request. A request with neither header (curl, the
 * CLI, a server-side fetch) gets no CORS headers, as before.
 *
 * Jest's global setup puts the server in test mode, which the old domain
 * check skipped, so this file runs the middleware with production settings:
 * not test mode, not dev mode, no domain override, hostname pol.is.
 */
import { describe, test, expect, jest, beforeEach } from "@jest/globals";

const mockConfig: Record<string, unknown> = {};

jest.mock("../../src/config", () => {
  const actual = (
    jest.requireActual("../../src/config") as { default: Record<string, any> }
  ).default;
  Object.assign(mockConfig, actual, {
    nodeEnv: "production",
    isTesting: false,
    isDevMode: false,
    domainOverride: null,
    getServerHostname: () => "pol.is",
  });
  return { __esModule: true, default: mockConfig };
});

// domain.ts reads the per-site embed allowlist through the pool; the CORS
// step never queries, so the pool is a stand-in.
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(), queryP_readOnly: jest.fn(), connect: jest.fn() },
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require("express");
import request from "supertest";
import logger from "../../src/utils/logger";
import { addCorsHeader } from "../../src/utils/domain";
import { middleware_check_if_options } from "../../src/server-middleware";

const ALLOW_HEADERS =
  "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With";
const ALLOW_METHODS = "GET, PUT, POST, DELETE, OPTIONS";
const UNLISTED = "https://news.example.org";

let served: string[] = [];

function app() {
  const a = express();
  a.all("/api/v3/*", addCorsHeader);
  a.all("/api/v3/*", middleware_check_if_options);
  a.get("/api/v3/nextComment", (_req: unknown, res: any) => {
    served.push("GET nextComment");
    res.json({ served: true });
  });
  a.post("/api/v3/votes", (_req: unknown, res: any) => {
    served.push("POST votes");
    res.json({ served: true });
  });
  return a;
}

const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
];

function expectCorsHeaders(headers: Record<string, string | undefined>) {
  expect(headers["access-control-allow-origin"]).toBe("*");
  expect(headers["access-control-allow-headers"]).toBe(ALLOW_HEADERS);
  expect(headers["access-control-allow-methods"]).toBe(ALLOW_METHODS);
  expect(headers["access-control-allow-credentials"]).toBeUndefined();
  expect(headers.vary).toBeUndefined();
}

function expectNoCorsHeaders(headers: Record<string, string | undefined>) {
  for (const name of CORS_HEADERS) expect(headers[name]).toBeUndefined();
}

function expectNothingLogged() {
  for (const level of ["debug", "error", "info", "warn", "log"] as const) {
    expect((logger as any)[level]).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  served = [];
  mockConfig.domainOverride = null;
  jest.clearAllMocks();
});

describe("the /api/v3 CORS step", () => {
  test("a GET from an origin no list names is served by its route, with the cookie-free CORS headers, and nothing is logged", async () => {
    const res = await request(app())
      .get("/api/v3/nextComment")
      .set("Origin", UNLISTED);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ served: true });
    expect(served).toEqual(["GET nextComment"]);
    expectCorsHeaders(res.headers);
    expectNothingLogged();
  });

  test("a POST from an origin no list names reaches its route", async () => {
    const res = await request(app())
      .post("/api/v3/votes")
      .set("Origin", UNLISTED)
      .send({});
    expect(res.status).toBe(200);
    expect(served).toEqual(["POST votes"]);
    expectCorsHeaders(res.headers);
    expectNothingLogged();
  });

  test("a request with no Origin and no Referer gets no CORS headers, as before", async () => {
    const res = await request(app()).get("/api/v3/nextComment");
    expect(res.status).toBe(200);
    expect(served).toEqual(["GET nextComment"]);
    expectNoCorsHeaders(res.headers);
    expectNothingLogged();
  });

  test("a request that names its origin only in the Referer is served with the same headers", async () => {
    const res = await request(app())
      .get("/api/v3/nextComment")
      .set("Referer", `${UNLISTED}/story/42?x=1#comments`);
    expect(res.status).toBe(200);
    expect(served).toEqual(["GET nextComment"]);
    expectCorsHeaders(res.headers);
    expectNothingLogged();
  });

  test("a request from the server's own hostname gets the same headers, with no credentials header", async () => {
    const res = await request(app())
      .get("/api/v3/nextComment")
      .set("Origin", "https://pol.is");
    expect(res.status).toBe(200);
    expectCorsHeaders(res.headers);
  });

  test("an empty Origin falls through to the Referer, and both empty means no CORS headers", async () => {
    const withReferer = await request(app())
      .get("/api/v3/nextComment")
      .set("Origin", "")
      .set("Referer", `${UNLISTED}/page`);
    expect(withReferer.status).toBe(200);
    expectCorsHeaders(withReferer.headers);
    const neither = await request(app())
      .get("/api/v3/nextComment")
      .set("Origin", "")
      .set("Referer", "");
    expect(neither.status).toBe(200);
    expectNoCorsHeaders(neither.headers);
  });

  test("OPTIONS answers 204 with the CORS headers to a preflight from any origin, and 204 without them when no origin is named", async () => {
    const preflight = await request(app())
      .options("/api/v3/votes")
      .set("Origin", UNLISTED)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization, content-type");
    expect(preflight.status).toBe(204);
    expectCorsHeaders(preflight.headers);
    expect(served).toEqual([]);
    const bare = await request(app()).options("/api/v3/votes");
    expect(bare.status).toBe(204);
    expectNoCorsHeaders(bare.headers);
    expect(served).toEqual([]);
    expectNothingLogged();
  });

  test("with DOMAIN_OVERRIDE set, every /api/v3 response carries the headers, as before, whatever the Origin", async () => {
    mockConfig.domainOverride = "polis.example.net";
    const bare = await request(app()).get("/api/v3/nextComment");
    expect(bare.status).toBe(200);
    expectCorsHeaders(bare.headers);
    const other = await request(app())
      .get("/api/v3/nextComment")
      .set("Origin", UNLISTED);
    expect(other.status).toBe(200);
    expectCorsHeaders(other.headers);
  });
});
