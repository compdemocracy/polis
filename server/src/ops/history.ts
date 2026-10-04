// Page U2, "Activity over time": platform-wide counts per day for the last 90
// days, per hour for the last 48 hours, and per month for all time. Counts
// only; no conversation is named.
//
// The day and hour series read the same two indexes as U1 (votes_created_idx,
// comments_modified_idx) with a window predicate on them; the integration test
// __tests__/integration/ops-activity-index.test.ts pins that each statement is
// answerable from an index on its window column and never by a sequential
// scan. Buckets are UTC: bucket = floor(created / bucket_ms).
//
// The monthly series reads only `conversations`. There is no index on
// conversations.created or participants.created, and adding one would be a
// schema change, so the all-time series is one pass over the small
// conversations table (a sequential scan of that table is allowed by name in
// the index test) at a long TTL. Votes per month and participants joined per
// month are not offered: either would read the whole votes or participants
// table. "Participants" per month is the trigger-maintained participant_count
// summed over the conversations started that month, and the column says so.

import type { OpsQuery } from "./guardedRead";
import { OpsRow, toCount } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

// $1 = window start (epoch ms, a bucket boundary), $2 = bucket size in ms.
export const VOTES_SERIES_SQL = `
SELECT created / $2::bigint                AS bucket,
       count(*)                            AS votes,
       count(DISTINCT (zid, pid))          AS voters,
       count(DISTINCT zid)                 AS conversations
FROM votes
WHERE created >= $1
GROUP BY 1`;

// modified >= $1 is the indexed predicate; created >= $1 keeps the count to
// statements written in the window (exact because modified >= created on
// every row, pinned by the integration test). mod = -1 is "moderated out".
export const STATEMENTS_SERIES_SQL = `
SELECT created / $2::bigint                AS bucket,
       count(*)                            AS statements,
       count(*) FILTER (WHERE mod = -1)    AS rejected
FROM comments
WHERE modified >= $1 AND created >= $1
GROUP BY 1`;

export const MONTHLY_SQL = `
SELECT to_char(date_trunc('month', to_timestamp(created / 1000.0) AT TIME ZONE 'UTC'),
               'YYYY-MM')                                   AS month,
       count(*)                                             AS conversations,
       count(*) FILTER (WHERE participant_count >= 10)      AS with_10_plus,
       coalesce(sum(participant_count), 0)                  AS participants
FROM conversations
GROUP BY 1`;

// What the index test checks. `seqScanAllowed` names the one table a
// statement may scan sequentially (the small conversations table).
export const U2_STATEMENTS = [
  {
    name: "votes per bucket",
    sql: VOTES_SERIES_SQL,
    table: "votes",
    column: "created",
    index: "votes_created_idx",
  },
  {
    name: "statements per bucket",
    sql: STATEMENTS_SERIES_SQL,
    table: "comments",
    column: "modified",
    index: "comments_modified_idx",
  },
] as const;

export const U2_MONTHLY = {
  name: "conversations per month",
  sql: MONTHLY_SQL,
  seqScanAllowed: "conversations",
} as const;

export type SeriesSpec = {
  bucketMs: number;
  buckets: number;
  label: (bucketStartMs: number) => string;
};

export const DAILY_90: SeriesSpec = {
  bucketMs: DAY_MS,
  buckets: 90,
  label: (ms) => new Date(ms).toISOString().slice(0, 10),
};

export const HOURLY_48: SeriesSpec = {
  bucketMs: HOUR_MS,
  buckets: 48,
  label: (ms) => {
    const iso = new Date(ms).toISOString();
    return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  },
};

/** First bucket index and its start in ms, so the newest bucket holds now. */
export function seriesStart(spec: SeriesSpec, nowMs: number) {
  const current = Math.floor(nowMs / spec.bucketMs);
  const first = current - spec.buckets + 1;
  return { first, current, startMs: first * spec.bucketMs };
}

function byBucket(rows: Record<string, unknown>[]) {
  const map = new Map<number, Record<string, unknown>>();
  for (const r of rows) map.set(toCount(r.bucket), r);
  return map;
}

/**
 * One row per bucket, oldest first, every bucket present (zero when nothing
 * happened). The newest bucket is still filling and is marked partial.
 */
export function shapeSeries(
  spec: SeriesSpec,
  nowMs: number,
  votes: Record<string, unknown>[],
  statements: Record<string, unknown>[]
): OpsRow[] {
  const { first, current } = seriesStart(spec, nowMs);
  const v = byBucket(votes);
  const s = byBucket(statements);
  const rows: OpsRow[] = [];
  for (let b = first; b <= current; b += 1) {
    const vr = v.get(b);
    const sr = s.get(b);
    rows.push({
      period: spec.label(b * spec.bucketMs),
      partial: b === current,
      votes: vr ? toCount(vr.votes) : 0,
      voters: vr ? toCount(vr.voters) : 0,
      conversations: vr ? toCount(vr.conversations) : 0,
      statements: sr ? toCount(sr.statements) : 0,
      rejected: sr ? toCount(sr.rejected) : 0,
    });
  }
  return rows;
}

export async function readSeries(
  query: OpsQuery,
  spec: SeriesSpec,
  nowMs: number
): Promise<OpsRow[]> {
  const { startMs } = seriesStart(spec, nowMs);
  const params = [startMs, spec.bucketMs];
  const votes = await query(VOTES_SERIES_SQL, params);
  const statements = await query(STATEMENTS_SERIES_SQL, params);
  return shapeSeries(spec, nowMs, votes, statements);
}

function monthIndex(month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return NaN;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

function monthLabel(index: number): string {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * One row per month from the first month with a conversation to the current
 * month, oldest first; months with none are zero. The current month is
 * partial.
 */
export function shapeMonthly(
  raw: Record<string, unknown>[],
  nowMs: number
): OpsRow[] {
  const now = new Date(nowMs);
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const map = new Map<number, Record<string, unknown>>();
  for (const r of raw) {
    const i = monthIndex(String(r.month));
    // A conversation dated in the future (a clock error) is not plotted.
    if (Number.isFinite(i) && i <= current) map.set(i, r);
  }
  if (map.size === 0) return [];
  const first = Math.min(...map.keys());
  const rows: OpsRow[] = [];
  for (let i = first; i <= current; i += 1) {
    const r = map.get(i);
    rows.push({
      period: monthLabel(i),
      partial: i === current,
      conversations: r ? toCount(r.conversations) : 0,
      with_10_plus: r ? toCount(r.with_10_plus) : 0,
      participants: r ? toCount(r.participants) : 0,
    });
  }
  return rows;
}

export async function readMonthly(
  query: OpsQuery,
  nowMs: number
): Promise<OpsRow[]> {
  return shapeMonthly(await query(MONTHLY_SQL, []), nowMs);
}
