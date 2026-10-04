// Page U3, "Where visitors come from": pageviews by country and by referrer
// for each of the three web apps, from the Simple Analytics Stats API.
//
// The admin console, the participation client and the report already load the
// Simple Analytics script (client-admin/public/index.html,
// client-participation/public/index.ejs, client-report/public/index.html), so
// the counts already exist on Simple Analytics' side; this page only reads
// them back with SIMPLE_ANALYTICS_API_KEY. Simple Analytics stores no personal
// data and returns only aggregates; this module passes on only ISO country
// codes, referrer hostnames and counts, and folds small entries into "Other".
//
// The three apps share one hostname, so each app is selected with the API's
// `pages` filter (comma-separated, trailing `*` wildcards), using the paths
// server/app.ts serves each app's index on.
//
// With the key unset nothing is requested and the page says so.

import { OpsRow, OpsSourceError } from "./types";

export const API_BASE = "https://simpleanalytics.com";
export const WINDOW_DAYS = 30;
export const REQUEST_TIMEOUT_MS = 5000;
// Entries below this many pageviews (summed over the apps) fold into "Other".
export const MIN_PAGEVIEWS_SHOWN = 10;
export const MAX_ROWS = 20;
const LIST_LIMIT = 1000;

export type AppDef = { id: string; label: string; pages: string[] };

// server/app.ts: conversation views (/^\/[0-9][0-9A-Za-z]+/, /explore, /share,
// /summary, /ot, /demo), admin dash routes (/m, /integrate, /account, ...),
// and the report routes (/report, /narrativeReport, /stats, ...).
export const APPS: readonly AppDef[] = [
  {
    id: "participation",
    label: "Participation",
    pages: [
      ..."0123456789".split("").map((d) => `/${d}*`),
      "/explore/*",
      "/share/*",
      "/summary/*",
      "/ot/*",
      "/demo/*",
    ],
  },
  {
    id: "admin",
    label: "Admin console",
    pages: [
      "/m/*",
      "/conversations*",
      "/integrate*",
      "/account*",
      "/other-conversations*",
      "/signin*",
      "/signout*",
      "/ops*",
      "/bot*",
    ],
  },
  {
    id: "report",
    label: "Report",
    pages: [
      "/report/*",
      "/narrativeReport/*",
      "/stats/*",
      "/commentsReport/*",
      "/topicReport/*",
      "/topicsVizReport/*",
    ],
  },
];

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validHostname(value: string): boolean {
  return HOSTNAME.test(value.trim().toLowerCase());
}

/** Why the page cannot read anything, or null when it can. */
export function unconfiguredReason(
  apiKey: string | null | undefined,
  hostname: string | null | undefined
): string | null {
  if (!apiKey || !apiKey.trim()) {
    return "Simple Analytics is not configured on this server (SIMPLE_ANALYTICS_API_KEY is unset), so this page has nothing to show.";
  }
  if (!hostname || !validHostname(hostname)) {
    return "SIMPLE_ANALYTICS_HOSTNAME is not a valid hostname, so this page has nothing to show.";
  }
  return null;
}

export function windowDates(nowMs: number) {
  const day = 24 * 60 * 60 * 1000;
  const end = new Date(nowMs).toISOString().slice(0, 10);
  const start = new Date(nowMs - (WINDOW_DAYS - 1) * day)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

export function statsUrl(hostname: string, app: AppDef, nowMs: number): string {
  const { start, end } = windowDates(nowMs);
  const params = new URLSearchParams({
    version: "6",
    fields: "pageviews,visitors,countries,referrers",
    start,
    end,
    timezone: "UTC",
    limit: String(LIST_LIMIT),
    info: "false",
    pages: app.pages.join(","),
  });
  return `${API_BASE}/${encodeURIComponent(
    hostname.trim().toLowerCase()
  )}.json?${params.toString()}`;
}

export type Entry = { value: string; pageviews: number; visitors: number };
export type AppStats = {
  pageviews: number;
  visitors: number;
  countries: Entry[];
  referrers: Entry[];
};

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new OpsSourceError("sa_malformed");
  return n;
}

function entries(value: unknown): Entry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new OpsSourceError("sa_malformed");
  return value.map((e) => {
    if (!e || typeof e !== "object") throw new OpsSourceError("sa_malformed");
    const v = (e as Record<string, unknown>).value;
    return {
      value: typeof v === "string" ? v : "",
      pageviews: count((e as Record<string, unknown>).pageviews),
      visitors: count((e as Record<string, unknown>).visitors ?? 0),
    };
  });
}

/** Validate one Stats API body. Throws OpsSourceError("sa_malformed"). */
export function parseStats(body: unknown): AppStats {
  if (!body || typeof body !== "object")
    throw new OpsSourceError("sa_malformed");
  const b = body as Record<string, unknown>;
  return {
    pageviews: count(b.pageviews),
    visitors: count(b.visitors ?? 0),
    countries: entries(b.countries),
    referrers: entries(b.referrers),
  };
}

const COUNTRY = /^[A-Z]{2}$/;
const REFERRER_HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/** Only an ISO 3166 alpha-2 code passes; anything else is "Unknown". */
export function countryKey(value: string): string {
  const v = value.trim().toUpperCase();
  return COUNTRY.test(v) ? v : "Unknown";
}

/**
 * Only a bare hostname passes (a leading "www." is dropped); an empty value
 * is "Direct / none"; anything else (a path, a query string, free text) is
 * "Other", so nothing but a hostname is ever shown.
 */
export function referrerKey(value: string): string {
  const v = value.trim().toLowerCase();
  if (!v) return "Direct / none";
  const host = v.replace(/^www\./, "");
  return REFERRER_HOST.test(host) ? host : "Other";
}

/**
 * One row per key with a column per app plus the total, sorted by total;
 * keys under MIN_PAGEVIEWS_SHOWN in total, and everything past MAX_ROWS, fold
 * into "Other". Pure.
 */
export function crossTab(
  perApp: Record<string, Entry[]>,
  keyOf: (value: string) => string,
  keyColumn: string
): OpsRow[] {
  const totals = new Map<string, Record<string, number>>();
  for (const app of APPS) {
    for (const e of perApp[app.id] || []) {
      const key = keyOf(e.value);
      const t = totals.get(key) || {};
      t[app.id] = (t[app.id] || 0) + e.pageviews;
      totals.set(key, t);
    }
  }
  const sum = (t: Record<string, number>) =>
    APPS.reduce((n, a) => n + (t[a.id] || 0), 0);
  const ranked = [...totals.entries()]
    .filter(([k]) => k !== "Other")
    .sort((a, b) => sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]));
  const shown: [string, Record<string, number>][] = [];
  const other: Record<string, number> = { ...(totals.get("Other") || {}) };
  for (const [key, t] of ranked) {
    if (shown.length < MAX_ROWS && sum(t) >= MIN_PAGEVIEWS_SHOWN) {
      shown.push([key, t]);
    } else {
      for (const a of APPS) other[a.id] = (other[a.id] || 0) + (t[a.id] || 0);
    }
  }
  if (sum(other) > 0) shown.push(["Other", other]);
  return shown.map(([key, t]) => {
    const row: OpsRow = { [keyColumn]: key };
    for (const a of APPS) row[a.id] = t[a.id] || 0;
    row.total = sum(t);
    return row;
  });
}

export function summaryRows(stats: Record<string, AppStats>): OpsRow[] {
  return APPS.map((a) => ({
    app: a.label,
    pageviews: stats[a.id]?.pageviews ?? 0,
    visitors: stats[a.id]?.visitors ?? 0,
  }));
}

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const defaultFetch: Fetcher = (url, init) => fetch(url, init);

/** Read one app's stats. Rejects only with OpsSourceError. */
export async function fetchAppStats(
  apiKey: string,
  hostname: string,
  app: AppDef,
  nowMs: number,
  fetcher: Fetcher = defaultFetch
): Promise<AppStats> {
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await fetcher(statsUrl(hostname, app, nowMs), {
      headers: { "Api-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: unknown })?.name;
    throw new OpsSourceError(
      name === "TimeoutError" || name === "AbortError"
        ? "sa_timeout"
        : "sa_unreachable"
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new OpsSourceError("sa_unauthorized");
  }
  if (res.status === 404) throw new OpsSourceError("sa_not_found");
  if (res.status === 429) throw new OpsSourceError("sa_rate_limited");
  if (res.status < 200 || res.status >= 300) {
    throw new OpsSourceError("sa_http_error");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OpsSourceError("sa_malformed");
  }
  return parseStats(body);
}

export type SimpleAnalyticsReport = {
  stats: Record<string, AppStats>;
  window: { start: string; end: string };
};

/**
 * The three panels of the page share one read: concurrent and repeated calls
 * inside `ttlMs` get the same promise, so one page refresh costs three API
 * requests (one per app), not nine.
 */
export class SimpleAnalyticsSource {
  private current?: { at_ms: number; promise: Promise<SimpleAnalyticsReport> };

  constructor(
    private readonly apiKey: string,
    private readonly hostname: string,
    private readonly ttlMs: number,
    private readonly fetcher: Fetcher = defaultFetch
  ) {}

  read(nowMs: number): Promise<SimpleAnalyticsReport> {
    if (this.current && nowMs - this.current.at_ms < this.ttlMs) {
      return this.current.promise;
    }
    const promise = Promise.all(
      APPS.map((app) =>
        fetchAppStats(this.apiKey, this.hostname, app, nowMs, this.fetcher)
      )
    ).then((list) => {
      const stats: Record<string, AppStats> = {};
      APPS.forEach((app, i) => (stats[app.id] = list[i]));
      return { stats, window: windowDates(nowMs) };
    });
    this.current = { at_ms: nowMs, promise };
    // A failure is shared too (the three panels report the same reason) and
    // retried after the TTL; the panel cache adds its own backoff on top.
    promise.catch(() => undefined);
    return promise;
  }
}
