// Page S1, "Database": Postgres's own statistics views, read the same way on
// any Postgres (RDS or not). No query text, no role names, no client
// addresses: pg_stat_activity.query, usename and client_addr are never
// selected. pg_stat_statements is not used (ruling R5: creating the extension
// is a database change).
//
// The cumulative counters (pg_stat_user_tables, pg_stat_database) are turned
// into per-minute rates against the previous sample this process took. The
// first read after a start has no previous sample and shows totals only; a
// counter that went down (a stats reset) restarts the rate.

import type { OpsQuery } from "./guardedRead";
import { OpsRow, toCount, toNumberOrNull } from "./types";

// Grouped by the client's application_name up to its first ':' (the Python
// math poller names itself "math-python:<env>@<host>"; the Node pools set no
// name and show as "unnamed").
export const CONNECTIONS_SQL = `
SELECT coalesce(nullif(split_part(application_name, ':', 1), ''), 'unnamed') AS app,
       coalesce(state, 'unknown')                                            AS state,
       count(*)                                                              AS connections,
       max(extract(epoch FROM now() - query_start))
         FILTER (WHERE state = 'active')                                     AS longest_active_s,
       count(*) FILTER (WHERE wait_event_type = 'Lock')                      AS waiting_on_lock,
       max(extract(epoch FROM now() - xact_start))
         FILTER (WHERE state LIKE 'idle in transaction%')                    AS longest_idle_in_xact_s
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid()
GROUP BY 1, 2`;

// The tables whose sequential scans matter: a full scan of votes once a
// second held the production database at 61% CPU (September 2026).
export const WATCHED_TABLES = [
  "votes",
  "votes_latest_unique",
  "comments",
  "participants",
  "participants_extended",
  "math_main",
  "math_ticks",
  "conversations",
] as const;

// Tables whose sequential scans are expected and not drawn as alarming.
const SMALL_TABLES = new Set(["conversations", "math_ticks"]);

export const TABLES_SQL = `
SELECT relname, seq_scan, seq_tup_read, coalesce(idx_scan, 0) AS idx_scan,
       n_live_tup, n_dead_tup,
       (extract(epoch FROM greatest(last_autovacuum, last_vacuum)) * 1000)::bigint AS last_vacuum_ms
FROM pg_stat_user_tables
WHERE schemaname = 'public' AND relname = ANY($1::text[])`;

export const DATABASE_SQL = `
SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
       temp_bytes, deadlocks, conflicts,
       pg_database_size(current_database()) AS size_bytes
FROM pg_stat_database
WHERE datname = current_database()`;

const APP_NAME = /^[A-Za-z0-9 ._@/-]{1,40}$/;

/** application_name is client-chosen; anything unusual is shown as "other". */
export function cleanAppName(value: unknown): string {
  return typeof value === "string" && APP_NAME.test(value) ? value : "other";
}

export function shapeConnections(raw: Record<string, unknown>[]): OpsRow[] {
  const merged = new Map<string, OpsRow>();
  for (const r of raw) {
    const app = cleanAppName(r.app);
    const state = typeof r.state === "string" ? r.state : "unknown";
    const key = `${app}\u0000${state}`;
    const prev = merged.get(key);
    const longest = toNumberOrNull(r.longest_active_s);
    const idle = toNumberOrNull(r.longest_idle_in_xact_s);
    const maxOf = (a: unknown, b: number | null) =>
      a === null || a === undefined
        ? b
        : b === null
        ? (a as number)
        : Math.max(a as number, b);
    merged.set(key, {
      app,
      state,
      connections:
        (prev ? (prev.connections as number) : 0) + toCount(r.connections),
      waiting_on_lock:
        (prev ? (prev.waiting_on_lock as number) : 0) +
        toCount(r.waiting_on_lock),
      longest_active_s: maxOf(prev?.longest_active_s, longest),
      longest_idle_in_xact_s: maxOf(prev?.longest_idle_in_xact_s, idle),
    });
  }
  return [...merged.values()].sort(
    (a, b) =>
      (b.connections as number) - (a.connections as number) ||
      String(a.app).localeCompare(String(b.app)) ||
      String(a.state).localeCompare(String(b.state))
  );
}

type Sample = { at_ms: number; values: Record<string, number> };

/** Per-minute rates between this process's consecutive samples. */
export class RateTracker {
  private last = new Map<string, Sample>();

  /**
   * Record `values` for `key` at `atMs` and return per-minute rates for the
   * named counters, or null for each when there is no usable previous sample
   * (first read, a counter reset, or less than a second apart).
   */
  rates(
    key: string,
    atMs: number,
    values: Record<string, number>
  ): Record<string, number | null> {
    const prev = this.last.get(key);
    this.last.set(key, { at_ms: atMs, values });
    const out: Record<string, number | null> = {};
    const minutes = prev ? (atMs - prev.at_ms) / 60000 : 0;
    for (const [name, value] of Object.entries(values)) {
      const before = prev?.values[name];
      out[name] =
        prev && before !== undefined && value >= before && minutes >= 1 / 60
          ? (value - before) / minutes
          : null;
    }
    return out;
  }
}

export function shapeTables(
  raw: Record<string, unknown>[],
  atMs: number,
  tracker: RateTracker
): OpsRow[] {
  const byName = new Map<string, Record<string, unknown>>();
  for (const r of raw) byName.set(String(r.relname), r);
  return WATCHED_TABLES.filter((t) => byName.has(t)).map((table) => {
    const r = byName.get(table) as Record<string, unknown>;
    const counters = {
      seq_scan: toCount(r.seq_scan),
      seq_tup_read: toCount(r.seq_tup_read),
      idx_scan: toCount(r.idx_scan),
    };
    const rates = tracker.rates(`table:${table}`, atMs, counters);
    return {
      table,
      expected_seq: SMALL_TABLES.has(table),
      seq_scans_per_min: rates.seq_scan,
      seq_rows_per_min: rates.seq_tup_read,
      idx_scans_per_min: rates.idx_scan,
      seq_scans_total: counters.seq_scan,
      live_rows: toCount(r.n_live_tup),
      dead_rows: toCount(r.n_dead_tup),
      last_vacuum_ms: toNumberOrNull(r.last_vacuum_ms),
    };
  });
}

export function shapeDatabase(
  raw: Record<string, unknown> | undefined,
  atMs: number,
  tracker: RateTracker
): OpsRow[] {
  if (!raw) return [];
  const counters = {
    xact_commit: toCount(raw.xact_commit),
    xact_rollback: toCount(raw.xact_rollback),
    blks_read: toCount(raw.blks_read),
    blks_hit: toCount(raw.blks_hit),
    temp_bytes: toCount(raw.temp_bytes),
    deadlocks: toCount(raw.deadlocks),
  };
  const r = tracker.rates("database", atMs, counters);
  const interval =
    r.blks_hit === null ||
    r.blks_read === null ||
    r.blks_hit + r.blks_read === 0
      ? null
      : r.blks_hit / (r.blks_hit + r.blks_read);
  const total = counters.blks_hit + counters.blks_read;
  return [
    {
      backends: toCount(raw.numbackends),
      cache_hit_now: interval,
      cache_hit_total: total === 0 ? null : counters.blks_hit / total,
      commits_per_min: r.xact_commit,
      rollbacks_per_min: r.xact_rollback,
      temp_bytes_per_min: r.temp_bytes,
      deadlocks_per_min: r.deadlocks,
      deadlocks_total: counters.deadlocks,
      size_bytes: toCount(raw.size_bytes),
    },
  ];
}

export async function readConnections(query: OpsQuery) {
  return shapeConnections(await query(CONNECTIONS_SQL, []));
}

export async function readTables(
  query: OpsQuery,
  atMs: number,
  tracker: RateTracker
) {
  return shapeTables(await query(TABLES_SQL, [WATCHED_TABLES]), atMs, tracker);
}

export async function readDatabase(
  query: OpsQuery,
  atMs: number,
  tracker: RateTracker
) {
  const [row] = await query(DATABASE_SQL, []);
  return shapeDatabase(row, atMs, tracker);
}
