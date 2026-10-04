// U3 on generated fixtures: no request without a key, the key only in a
// header, closed failure reasons, and only country codes, referrer hostnames
// and counts reaching the page.
import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  APPS,
  countryKey,
  crossTab,
  fetchAppStats,
  parseStats,
  referrerKey,
  SimpleAnalyticsSource,
  statsUrl,
  unconfiguredReason,
  windowDates,
} from "../../src/ops/simpleAnalytics";
import { buildPages, PanelCache } from "../../src/ops/pages";
import { createOpsRoutes } from "../../src/routes/ops";

const NOW = Date.UTC(2026, 9, 3, 12);
const KEY = "sa_api_key_generatedfixture";

function body(scale: number) {
  return {
    pageviews: 100 * scale,
    visitors: 40 * scale,
    countries: [
      { value: "US", pageviews: 60 * scale, visitors: 20 },
      { value: "DE", pageviews: 30 * scale, visitors: 10 },
      { value: "NZ", pageviews: 3, visitors: 1 },
      { value: "not a code", pageviews: 7 * scale, visitors: 1 },
    ],
    referrers: [
      { value: "www.example.org", pageviews: 50 * scale, visitors: 9 },
      { value: "", pageviews: 30 * scale, visitors: 9 },
      { value: "example.com/path?user=someone", pageviews: 20, visitors: 1 },
    ],
  };
}

function fetcherFor(status = 200) {
  return jest.fn(async (url: string) => ({
    status,
    json: async () =>
      body(url.includes("report") ? 1 : url.includes("%2Fm%2F") ? 2 : 3),
  }));
}

describe("configuration", () => {
  test("no key, nothing to show", () => {
    expect(unconfiguredReason("", "pol.is")).toMatch(
      /SIMPLE_ANALYTICS_API_KEY/
    );
    expect(unconfiguredReason(undefined, "pol.is")).not.toBeNull();
  });
  test("a bad hostname, nothing to show", () => {
    expect(unconfiguredReason(KEY, "pol.is/evil?x=1")).toMatch(/HOSTNAME/);
    expect(unconfiguredReason(KEY, "localhost")).not.toBeNull();
  });
  test("key and hostname: configured", () => {
    expect(unconfiguredReason(KEY, "pol.is")).toBeNull();
  });
});

describe("statsUrl", () => {
  test("version 6, the window, the app's pages filter, and never the key", () => {
    const url = new URL(statsUrl("pol.is", APPS[2], NOW));
    expect(url.origin + url.pathname).toBe(
      "https://simpleanalytics.com/pol.is.json"
    );
    expect(url.searchParams.get("version")).toBe("6");
    expect(url.searchParams.get("fields")).toBe(
      "pageviews,visitors,countries,referrers"
    );
    expect(url.searchParams.get("start")).toBe("2026-09-04");
    expect(url.searchParams.get("end")).toBe("2026-10-03");
    expect(url.searchParams.get("pages")).toContain("/report/*");
    expect(url.toString()).not.toContain(KEY);
    expect(windowDates(NOW)).toEqual({
      start: "2026-09-04",
      end: "2026-10-03",
    });
  });

  test("participation is every conversation path, admin is the console paths", () => {
    const pages = (i: number) =>
      new URL(statsUrl("pol.is", APPS[i], NOW)).searchParams.get("pages");
    expect(pages(0)).toContain("/0*,/1*");
    expect(pages(0)).toContain("/9*");
    expect(pages(1)).toContain("/m/*");
  });
});

describe("fetchAppStats", () => {
  test("sends the key as the Api-Key header", async () => {
    const f = fetcherFor();
    await fetchAppStats(KEY, "pol.is", APPS[0], NOW, f as any);
    const [, init] = f.mock.calls[0] as any;
    expect(init.headers["Api-Key"]).toBe(KEY);
    expect(init.signal).toBeDefined();
  });

  test.each([
    [401, "sa_unauthorized"],
    [403, "sa_unauthorized"],
    [404, "sa_not_found"],
    [429, "sa_rate_limited"],
    [500, "sa_http_error"],
  ])("HTTP %p is %p", async (status, reason) => {
    const err = await fetchAppStats(
      KEY,
      "pol.is",
      APPS[0],
      NOW,
      fetcherFor(status) as any
    ).catch((e) => e);
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain(KEY);
  });

  test("a network failure and a timeout have their own reasons", async () => {
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    const slow = async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    expect(
      (
        await fetchAppStats(KEY, "pol.is", APPS[0], NOW, down as any).catch(
          (e) => e
        )
      ).reason
    ).toBe("sa_unreachable");
    expect(
      (
        await fetchAppStats(KEY, "pol.is", APPS[0], NOW, slow as any).catch(
          (e) => e
        )
      ).reason
    ).toBe("sa_timeout");
  });

  test.each([
    null,
    "text",
    { visitors: 1 },
    { pageviews: -1 },
    { pageviews: 1, countries: "US" },
    { pageviews: 1, countries: [{ value: "US", pageviews: "many" }] },
  ])("malformed body %p is refused", (b) => {
    expect(() => parseStats(b)).toThrow(
      expect.objectContaining({ reason: "sa_malformed" })
    );
  });
});

describe("only codes, hostnames and counts pass", () => {
  test.each([
    ["US", "US"],
    ["gb", "GB"],
    ["", "Unknown"],
    ["United States", "Unknown"],
  ])("country %p -> %p", (v, k) => expect(countryKey(v)).toBe(k));

  test.each([
    ["www.Example.org", "example.org"],
    ["news.ycombinator.com", "news.ycombinator.com"],
    ["", "Direct / none"],
    ["example.com/path?user=someone", "Other"],
    ["someone@example.com", "Other"],
    ["two words", "Other"],
  ])("referrer %p -> %p", (v, k) => expect(referrerKey(v)).toBe(k));

  test("crossTab: a column per app, sorted by total, small entries folded", () => {
    const rows = crossTab(
      {
        participation: parseStats(body(3)).countries,
        admin: parseStats(body(2)).countries,
        report: parseStats(body(1)).countries,
      },
      countryKey,
      "country"
    );
    expect(rows).toEqual([
      { country: "US", participation: 180, admin: 120, report: 60, total: 360 },
      { country: "DE", participation: 90, admin: 60, report: 30, total: 180 },
      {
        country: "Unknown",
        participation: 21,
        admin: 14,
        report: 7,
        total: 42,
      },
      // NZ: 9 pageviews in total, under 10, folded.
      { country: "Other", participation: 3, admin: 3, report: 3, total: 9 },
    ]);
  });
});

describe("SimpleAnalyticsSource", () => {
  test("three panels share one read of three requests inside the TTL", async () => {
    const f = fetcherFor();
    const src = new SimpleAnalyticsSource(KEY, "pol.is", 60_000, f as any);
    await Promise.all([
      src.read(NOW),
      src.read(NOW + 1),
      src.read(NOW + 59_000),
    ]);
    expect(f).toHaveBeenCalledTimes(3);
    await src.read(NOW + 60_000);
    expect(f).toHaveBeenCalledTimes(6);
  });
});

describe("the page through the route", () => {
  const NS = "https://pol.is/";
  const staff = {
    sub: "google-oauth2|1",
    [`${NS}connection_strategy`]: "google-oauth2",
    [`${NS}email`]: "staff@example.org",
    [`${NS}email_verified`]: true,
    [`${NS}hd`]: "example.org",
  };
  function appWith(apiKey: string, f: any) {
    const ops = createOpsRoutes({
      enabled: true,
      emailDomains: "example.org",
      devMode: false,
      namespace: NS,
      audience: "users",
      issuer: "https://issuer.example.org/",
      validateJwt: (req: any, _res: any, next: any) => {
        req.jwtPayload = staff;
        next();
      },
      cache: new PanelCache(),
      pages: buildPages({
        minVotersForText: 20,
        simpleAnalyticsApiKey: apiKey,
        simpleAnalyticsHostname: "pol.is",
        simpleAnalyticsFetch: f,
        topicNames: async () => new Map(),
      }),
    });
    const app = express();
    app.get("/api/v3/ops/page/:id", ops.gate, ops.page);
    return app;
  }

  test("without a key the page is one sentence and nothing is requested", async () => {
    const f = fetcherFor();
    const res = await request(appWith("", f))
      .get("/api/v3/ops/page/origin")
      .set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.notice).toMatch(/SIMPLE_ANALYTICS_API_KEY is unset/);
    expect(res.body.panels).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  test("with a key: three tables from three requests, the key nowhere in the body", async () => {
    const f = fetcherFor();
    const res = await request(appWith(KEY, f))
      .get("/api/v3/ops/page/origin")
      .set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.panels.map((p: any) => [p.id, p.status, p.shape])).toEqual([
      ["apps", "ok", "table"],
      ["countries", "ok", "table"],
      ["referrers", "ok", "table"],
    ]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.panels[0].rows).toEqual([
      { app: "Participation", pageviews: 300, visitors: 120 },
      { app: "Admin console", pageviews: 200, visitors: 80 },
      { app: "Report", pageviews: 100, visitors: 40 },
    ]);
    expect(JSON.stringify(res.body.panels[2].rows)).not.toContain("someone");
  });

  test("a refused key shows every panel unavailable with the same closed reason", async () => {
    const res = await request(appWith(KEY, fetcherFor(401)))
      .get("/api/v3/ops/page/origin")
      .set("Authorization", "Bearer t");
    expect(res.body.panels.map((p: any) => p.reason)).toEqual([
      "sa_unauthorized",
      "sa_unauthorized",
      "sa_unauthorized",
    ]);
  });
});
