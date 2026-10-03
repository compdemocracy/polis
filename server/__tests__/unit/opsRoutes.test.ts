import { afterEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createOpsRoutes, OpsRouteOptions } from "../../src/routes/ops";
import { OpsPanelDef, PanelCache } from "../../src/ops/pages";
import { OpsReadError, setOpsConnectForTests } from "../../src/ops/guardedRead";

// Generated fixtures only. The token "validator" below stands in for
// jwtValidation: it accepts the bearer strings listed in TOKENS and sets
// req.jwtPayload exactly as express-jwt does, and refuses everything else.
const NS = "https://pol.is/";

const staff = {
  sub: "google-oauth2|100000000000000000001",
  [`${NS}connection_strategy`]: "google-oauth2",
  [`${NS}email`]: "staff.one@example.org",
  [`${NS}email_verified`]: true,
};

const TOKENS: Record<string, Record<string, unknown>> = {
  staff,
  password: { ...staff, [`${NS}connection_strategy`]: "auth0" },
  noConnection: {
    sub: staff.sub,
    [`${NS}email`]: staff[`${NS}email`],
    [`${NS}email_verified`]: true,
  },
  denied: { ...staff, [`${NS}email`]: "former@example.org" },
  outsider: { ...staff, [`${NS}email`]: "someone@example.com" },
};

function fakeValidateJwt(req: any, _res: any, next: (err?: unknown) => void) {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (TOKENS[token]) {
    req.jwtPayload = TOKENS[token];
    return next();
  }
  return next(
    Object.assign(new Error("invalid signature"), { name: "UnauthorizedError" })
  );
}

function appWith(over: Partial<OpsRouteOptions> = {}) {
  const ops = createOpsRoutes({
    enabled: true,
    emailDomains: "example.org,!former@example.org",
    devMode: false,
    namespace: NS,
    validateJwt: fakeValidateJwt,
    ...over,
  });
  const app = express();
  app.get("/api/v3/ops/whoami", ops.gate, ops.whoami);
  app.get("/api/v3/ops/page/:id", ops.gate, ops.page);
  app.all(/^\/api\/v3\/ops(\/.*)?$/, ops.notFound);
  return app;
}

afterEach(() => {
  setOpsConnectForTests(null);
});

describe("OPS_ENABLED unset", () => {
  const app = appWith({ enabled: false, emailDomains: "" });

  test.each([
    ["get", "/api/v3/ops/whoami"],
    ["get", "/api/v3/ops/page/activity"],
    ["get", "/api/v3/ops/anything/else"],
    ["post", "/api/v3/ops/whoami"],
  ])(
    "%s %s answers 404 even with a valid staff token",
    async (method, path) => {
      const agent: any = request(app);
      const res = await agent[method](path).set(
        "Authorization",
        "Bearer staff"
      );
      expect(res.status).toBe(404);
    }
  );

  test("an empty OPS_EMAIL_DOMAINS is not checked while disabled", () => {
    expect(() => appWith({ enabled: false, emailDomains: "*" })).not.toThrow();
  });
});

describe("startup guard", () => {
  test("enabled with an empty list throws", () => {
    expect(() => appWith({ emailDomains: "" })).toThrow(
      "polis_err_ops_email_domains_empty"
    );
  });
  test("enabled with a malformed entry throws", () => {
    expect(() =>
      appWith({ emailDomains: "example.org,*.example.org" })
    ).toThrow("polis_err_ops_email_domains_malformed");
  });
  test("enabled with the local test domain outside DEV_MODE throws", () => {
    expect(() => appWith({ emailDomains: "polis.test" })).toThrow(
      "polis_err_ops_email_domains_dev_only"
    );
  });
});

describe("the gate", () => {
  const app = appWith();

  test("no bearer token is 403", async () => {
    const res = await request(app).get("/api/v3/ops/whoami");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "polis_err_ops_forbidden" });
  });

  test("a token jwtValidation refuses (participant, XID, anonymous, forged) is 403", async () => {
    const res = await request(app)
      .get("/api/v3/ops/whoami")
      .set("Authorization", "Bearer participant-token");
    expect(res.status).toBe(403);
  });

  test.each(["password", "noConnection", "denied", "outsider"])(
    "%s is 403 with no reason in the body",
    async (token) => {
      const res = await request(app)
        .get("/api/v3/ops/whoami")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "polis_err_ops_forbidden" });
    }
  );

  test("staff get whoami with the page list and no-store headers", async () => {
    const res = await request(app)
      .get("/api/v3/ops/whoami")
      .set("Authorization", "Bearer staff");
    expect(res.status).toBe(200);
    expect(res.body.ops).toBe(true);
    expect(res.body.pages.map((p: { id: string }) => p.id)).toEqual([
      "activity",
    ]);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  test("an unknown page id is 404 after the gate", async () => {
    const res = await request(app)
      .get("/api/v3/ops/page/nope")
      .set("Authorization", "Bearer staff");
    expect(res.status).toBe(404);
  });

  test("a payload set before the gate is discarded", async () => {
    const pre = express();
    const ops = createOpsRoutes({
      enabled: true,
      emailDomains: "example.org",
      devMode: false,
      namespace: NS,
      validateJwt: (_req: any, _res: any, next: any) => next(),
    });
    pre.use((req: any, _res, next) => {
      req.jwtPayload = staff;
      next();
    });
    pre.get("/api/v3/ops/whoami", ops.gate, ops.whoami);
    const res = await request(pre)
      .get("/api/v3/ops/whoami")
      .set("Authorization", "Bearer anything");
    expect(res.status).toBe(403);
  });
});

describe("page/activity", () => {
  test("serves both U1 panels from one read-only transaction each", async () => {
    const statements: string[] = [];
    const client = {
      on: jest.fn(),
      removeListener: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (text: string) => {
        statements.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
        if (/FROM votes/.test(text)) {
          return {
            rows: [
              {
                votes_5m: "3",
                voters_5m: "2",
                conversations_5m: "1",
                votes_1h: "40",
                voters_1h: "9",
                conversations_1h: "2",
                votes_24h: "512",
                voters_24h: "60",
                conversations_24h: "7",
              },
            ],
          };
        }
        if (/FROM comments/.test(text)) {
          return {
            rows: [
              {
                statements_5m: "0",
                authors_5m: "0",
                rejected_5m: "0",
                statements_1h: "4",
                authors_1h: "3",
                rejected_1h: "1",
                statements_24h: "30",
                authors_24h: "21",
                rejected_24h: "2",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    setOpsConnectForTests(async () => client as any);
    const app = appWith({ cache: new PanelCache() });
    const res = await request(app)
      .get("/api/v3/ops/page/activity")
      .set("Authorization", "Bearer staff");
    expect(res.status).toBe(200);
    const [votes, comments] = res.body.panels;
    expect(votes.status).toBe("ok");
    expect(votes.rows).toEqual([
      { window: "Last 5 minutes", votes: 3, voters: 2, conversations: 1 },
      { window: "Last hour", votes: 40, voters: 9, conversations: 2 },
      { window: "Last 24 hours", votes: 512, voters: 60, conversations: 7 },
    ]);
    expect(comments.rows[1]).toEqual({
      window: "Last hour",
      statements: 4,
      authors: 3,
      rejected: 1,
    });
    expect(statements.filter((s) => s.startsWith("BEGIN"))).toEqual([
      "BEGIN READ ONLY",
      "BEGIN READ ONLY",
    ]);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(2);
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  test("a statement timeout shows the panel as unavailable, with a closed reason", async () => {
    const def: OpsPanelDef = {
      id: "slow",
      title: "Slow",
      source: "test",
      ttl_s: 60,
      columns: [],
      load: async () => {
        throw new OpsReadError("timeout");
      },
    };
    const cache = new PanelCache();
    const { panel } = await cache.get("p", def);
    expect(panel).toMatchObject({
      status: "unavailable",
      reason: "timeout",
      rows: [],
    });
  });
});
