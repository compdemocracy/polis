// Page S5, "Cost": daily AWS cost by service, from Cost Explorer.
//
// Each GetCostAndUsage request is billed ($0.01), so this page is off unless
// OPS_COST_EXPLORER=1, and one server process makes at most one request per
// COST_TTL_MS whatever happens (a failure is held for the same time; see
// SharedRead). One request covers the page: daily UnblendedCost grouped by
// SERVICE from the first day of last month (or 30 days ago, if earlier)
// through today, filtered to this account (sts:GetCallerIdentity, which needs
// no permission), so other accounts in an organization never appear.
// Cost Explorer lags by about a day; today's and yesterday's figures are
// still filling.

import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { awsSend, dayLabel, Sender } from "./awsReads";
import { OpsRow, OpsSourceError } from "./types";

export const COST_TTL_MS = 15 * 60 * 1000;
export const DAILY_DAYS = 30;
export const SERVICES_SHOWN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// At most this many pages per read; each page is a billed request.
const MAX_PAGES = 2;

export type DailyCost = Map<string, Map<string, number>>; // day -> service -> USD

export type CostRead = {
  days: DailyCost;
  truncated: boolean;
  start: string;
  end: string;
};

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Pure: the request window, [start, end) as YYYY-MM-DD in UTC. */
export function costWindow(nowMs: number): { start: string; end: string } {
  const now = new Date(nowMs);
  const firstOfLastMonth = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - 1,
    1
  );
  const thirtyAgo = utcDay(nowMs) - (DAILY_DAYS - 1) * DAY_MS;
  return {
    start: dayLabel(Math.min(firstOfLastMonth, thirtyAgo)),
    end: dayLabel(utcDay(nowMs) + DAY_MS),
  };
}

export async function readAccount(sts: Sender): Promise<string> {
  const r = await awsSend(sts, new GetCallerIdentityCommand({}));
  const account = r?.Account;
  if (typeof account !== "string" || !/^\d{12}$/.test(account)) {
    throw new OpsSourceError("aws_malformed");
  }
  return account;
}

const SERVICE = /^[A-Za-z0-9 ()&.,:/_-]{1,80}$/;

export async function readCost(
  ce: Sender,
  account: string,
  nowMs: number
): Promise<CostRead> {
  const { start, end } = costWindow(nowMs);
  const days: DailyCost = new Map();
  let token: string | undefined;
  let pages = 0;
  do {
    const r = await awsSend(
      ce,
      new GetCostAndUsageCommand({
        TimePeriod: { Start: start, End: end },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [account] } },
        NextPageToken: token,
      })
    );
    for (const period of r?.ResultsByTime || []) {
      const day = period?.TimePeriod?.Start;
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new OpsSourceError("aws_malformed");
      }
      const services = days.get(day) || new Map<string, number>();
      for (const g of period.Groups || []) {
        const name = Array.isArray(g?.Keys) ? String(g.Keys[0]) : "";
        const amount = Number(g?.Metrics?.UnblendedCost?.Amount);
        if (!Number.isFinite(amount)) throw new OpsSourceError("aws_malformed");
        const key = SERVICE.test(name) ? name : "Other";
        services.set(key, (services.get(key) || 0) + amount);
      }
      days.set(day, services);
    }
    token = r?.NextPageToken || undefined;
    pages += 1;
  } while (token && pages < MAX_PAGES);
  return { days, truncated: Boolean(token), start, end };
}

function cents(v: number): number {
  return Math.round(v * 100) / 100;
}

function sum(m: Map<string, number> | undefined): number {
  let t = 0;
  for (const v of m?.values() || []) t += v;
  return t;
}

/** Pure: the last 30 days, oldest first, with each day's largest service. */
export function dailyRows(read: CostRead, nowMs: number): OpsRow[] {
  const rows: OpsRow[] = [];
  const today = utcDay(nowMs);
  for (let d = today - (DAILY_DAYS - 1) * DAY_MS; d <= today; d += DAY_MS) {
    const day = dayLabel(d);
    const services = read.days.get(day);
    let top: [string, number] | null = null;
    for (const [name, v] of services || []) {
      if (!top || v > top[1]) top = [name, v];
    }
    rows.push({
      period: day,
      total: services ? cents(sum(services)) : null,
      top_service: top ? top[0] : null,
      top_cost: top ? cents(top[1]) : null,
    });
  }
  return rows;
}

/**
 * Pure: per service, month to date, last month and the last 30 days; the
 * largest SERVICES_SHOWN by the last 30 days, the rest summed as "Other",
 * then the total.
 */
export function serviceRows(read: CostRead, nowMs: number): OpsRow[] {
  const now = new Date(nowMs);
  const monthStart = dayLabel(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const lastMonthStart = dayLabel(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const thirtyStart = dayLabel(utcDay(nowMs) - (DAILY_DAYS - 1) * DAY_MS);
  const totals = new Map<string, { mtd: number; last: number; d30: number }>();
  for (const [day, services] of read.days) {
    for (const [name, v] of services) {
      const t = totals.get(name) || { mtd: 0, last: 0, d30: 0 };
      if (day >= monthStart) t.mtd += v;
      else if (day >= lastMonthStart) t.last += v;
      if (day >= thirtyStart) t.d30 += v;
      totals.set(name, t);
    }
  }
  const ranked = Array.from(totals.entries()).sort(
    (a, b) => b[1].d30 - a[1].d30 || a[0].localeCompare(b[0])
  );
  const shown = ranked.slice(0, SERVICES_SHOWN);
  const rest = ranked.slice(SERVICES_SHOWN);
  const fold = (list: typeof ranked) =>
    list.reduce(
      (acc, [, t]) => ({
        mtd: acc.mtd + t.mtd,
        last: acc.last + t.last,
        d30: acc.d30 + t.d30,
      }),
      { mtd: 0, last: 0, d30: 0 }
    );
  const row = (
    service: string,
    t: { mtd: number; last: number; d30: number }
  ) => ({
    service,
    month_to_date: cents(t.mtd),
    last_month: cents(t.last),
    last_30_days: cents(t.d30),
  });
  const rows = shown.map(([name, t]) => row(name, t));
  if (rest.length)
    rows.push(row(`Other (${rest.length} services)`, fold(rest)));
  if (ranked.length) rows.push(row("Total", fold(ranked)));
  return rows;
}

export function costNote(read: CostRead): string {
  const parts = [
    `Unblended cost in USD for this account only, ${read.start} to ${read.end} (end exclusive, UTC). Cost Explorer lags by about a day: the last two days are still filling.`,
  ];
  if (read.truncated) {
    parts.push(
      "The answer had more pages than one refresh reads; totals are lower bounds."
    );
  }
  return parts.join(" ");
}
