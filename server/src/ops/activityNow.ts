// Page U1, "Activity now": votes, voters and statements over the last
// 5 minutes, 1 hour and 24 hours, platform-wide. Counts only.
//
// Each statement reads one 24-hour slice and splits it into the shorter windows
// with FILTER, so one index range scan answers all three windows. The index each
// statement must be able to use is declared next to it and pinned by
// __tests__/integration/ops-activity-index.test.ts, which fails if the planner
// can only answer the predicate by scanning the table.
//
// Times are BIGINT epoch milliseconds in both tables. The window bounds are
// computed here from the server clock; the client never sends a number.

import type { OpsQuery } from "./guardedRead";

export const WINDOWS = [
  { key: "5m", label: "Last 5 minutes", ms: 5 * 60 * 1000 },
  { key: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
] as const;

export type WindowKey = (typeof WINDOWS)[number]["key"];

// $1 = now - 24 h, $2 = now - 1 h, $3 = now - 5 min.
export function windowBounds(nowMs: number): [number, number, number] {
  return [nowMs - WINDOWS[2].ms, nowMs - WINDOWS[1].ms, nowMs - WINDOWS[0].ms];
}

// votes(zid, pid, created): one row per vote cast, re-votes included.
// "voters" are distinct (zid, pid) pairs: a person voting in two conversations
// is two participants, which is how polis counts participation.
export const VOTES_SQL = `
SELECT count(*)                                          AS votes_24h,
       count(DISTINCT (zid, pid))                        AS voters_24h,
       count(DISTINCT zid)                               AS conversations_24h,
       count(*)                   FILTER (WHERE created >= $2) AS votes_1h,
       count(DISTINCT (zid, pid)) FILTER (WHERE created >= $2) AS voters_1h,
       count(DISTINCT zid)        FILTER (WHERE created >= $2) AS conversations_1h,
       count(*)                   FILTER (WHERE created >= $3) AS votes_5m,
       count(DISTINCT (zid, pid)) FILTER (WHERE created >= $3) AS voters_5m,
       count(DISTINCT zid)        FILTER (WHERE created >= $3) AS conversations_5m
FROM votes
WHERE created >= $1`;

// comments(zid, pid, created, modified, mod). There is no index on
// comments.created; comments_modified_idx answers "modified >= $1", and the
// extra "created >= $1" keeps the count to statements written in the window.
// That is exact because modified >= created on every row: both default to
// now_as_millis() on insert and moderation only ever raises modified (pinned
// by the same integration test). mod = -1 is "moderated out".
export const STATEMENTS_SQL = `
SELECT count(*)                                          AS statements_24h,
       count(DISTINCT (zid, pid))                        AS authors_24h,
       count(*) FILTER (WHERE mod = -1)                  AS rejected_24h,
       count(*)                   FILTER (WHERE created >= $2) AS statements_1h,
       count(DISTINCT (zid, pid)) FILTER (WHERE created >= $2) AS authors_1h,
       count(*) FILTER (WHERE created >= $2 AND mod = -1)      AS rejected_1h,
       count(*)                   FILTER (WHERE created >= $3) AS statements_5m,
       count(DISTINCT (zid, pid)) FILTER (WHERE created >= $3) AS authors_5m,
       count(*) FILTER (WHERE created >= $3 AND mod = -1)      AS rejected_5m
FROM comments
WHERE modified >= $1 AND created >= $1`;

// What the index-pinning test checks: the statement, the table it must not
// scan sequentially, and the index the predicate must be able to use.
export const U1_STATEMENTS = [
  { name: "votes", sql: VOTES_SQL, table: "votes", index: "votes_created_idx" },
  {
    name: "statements",
    sql: STATEMENTS_SQL,
    table: "comments",
    index: "comments_modified_idx",
  },
] as const;

export type WindowRow = Record<string, string | number>;

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("ops_activity_count_out_of_range");
  }
  return n;
}

// One row per window, shortest first, with the measures named in `measures`.
export function rowsByWindow(
  raw: Record<string, unknown>,
  measures: readonly string[]
): WindowRow[] {
  return WINDOWS.map((w) => {
    const row: WindowRow = { window: w.label };
    for (const m of measures) row[m] = toCount(raw[`${m}_${w.key}`]);
    return row;
  });
}

export async function readVotes(query: OpsQuery, nowMs: number) {
  const [row] = await query(VOTES_SQL, windowBounds(nowMs));
  return rowsByWindow(row || {}, ["votes", "voters", "conversations"]);
}

export async function readStatements(query: OpsQuery, nowMs: number) {
  const [row] = await query(STATEMENTS_SQL, windowBounds(nowMs));
  return rowsByWindow(row || {}, ["statements", "authors", "rejected"]);
}
