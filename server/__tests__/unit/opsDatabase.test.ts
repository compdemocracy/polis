// S1 shaping on generated fixtures: no query text or role names are ever
// selected, application names are cleaned, counters become per-minute rates.
import { describe, expect, test } from "@jest/globals";
import {
  CONNECTIONS_SQL,
  DATABASE_SQL,
  RateTracker,
  shapeConnections,
  shapeDatabase,
  shapeTables,
  TABLES_SQL,
} from "../../src/ops/database";

describe("the statements read no query text, user or client address", () => {
  test.each([CONNECTIONS_SQL, TABLES_SQL, DATABASE_SQL])("%#", (sql) => {
    const selected = sql.split(/\bFROM\b/i)[0];
    expect(selected).not.toMatch(/\bquery\b(?!_start)/);
    expect(selected).not.toMatch(
      /usename|usesysid|client_addr|client_hostname/
    );
  });
  test("pg_stat_statements is not used", () => {
    expect([CONNECTIONS_SQL, TABLES_SQL, DATABASE_SQL].join()).not.toMatch(
      /pg_stat_statements/
    );
  });
});

describe("shapeConnections", () => {
  test("cleans client-chosen names and merges what they collapse to", () => {
    const rows = shapeConnections([
      {
        app: "unnamed",
        state: "idle",
        connections: "20",
        waiting_on_lock: "0",
        longest_active_s: null,
        longest_idle_in_xact_s: null,
      },
      {
        app: "math-python",
        state: "active",
        connections: "1",
        waiting_on_lock: "0",
        longest_active_s: "1.5",
        longest_idle_in_xact_s: null,
      },
      {
        app: "evil'); drop",
        state: "active",
        connections: "1",
        waiting_on_lock: "1",
        longest_active_s: "9",
        longest_idle_in_xact_s: null,
      },
      {
        app: "x".repeat(41),
        state: "active",
        connections: "2",
        waiting_on_lock: "0",
        longest_active_s: "3",
        longest_idle_in_xact_s: null,
      },
    ]);
    expect(rows).toEqual([
      {
        app: "unnamed",
        state: "idle",
        connections: 20,
        waiting_on_lock: 0,
        longest_active_s: null,
        longest_idle_in_xact_s: null,
      },
      {
        app: "other",
        state: "active",
        connections: 3,
        waiting_on_lock: 1,
        longest_active_s: 9,
        longest_idle_in_xact_s: null,
      },
      {
        app: "math-python",
        state: "active",
        connections: 1,
        waiting_on_lock: 0,
        longest_active_s: 1.5,
        longest_idle_in_xact_s: null,
      },
    ]);
  });
});

describe("RateTracker", () => {
  test("first read has no rate; then per minute; a reset restarts", () => {
    const t = new RateTracker();
    expect(t.rates("k", 0, { a: 100 })).toEqual({ a: null });
    expect(t.rates("k", 120_000, { a: 160 })).toEqual({ a: 30 });
    expect(t.rates("k", 180_000, { a: 5 })).toEqual({ a: null });
    expect(t.rates("k", 240_000, { a: 15 })).toEqual({ a: 10 });
  });

  test("reads under a second apart give no rate", () => {
    const t = new RateTracker();
    t.rates("k", 0, { a: 1 });
    expect(t.rates("k", 500, { a: 2 })).toEqual({ a: null });
  });
});

describe("shapeTables", () => {
  test("only watched tables, in watch order, with rates from the second read", () => {
    const t = new RateTracker();
    const sample = (seq: number) => [
      {
        relname: "comments",
        seq_scan: "4",
        seq_tup_read: "800",
        idx_scan: "10",
        n_live_tup: "200",
        n_dead_tup: "3",
        last_vacuum_ms: "1790000000000",
      },
      {
        relname: "votes",
        seq_scan: String(seq),
        seq_tup_read: String(seq * 1000),
        idx_scan: "50",
        n_live_tup: "1000",
        n_dead_tup: "0",
        last_vacuum_ms: null,
      },
      {
        relname: "unrelated",
        seq_scan: "1",
        seq_tup_read: "1",
        idx_scan: "1",
        n_live_tup: "1",
        n_dead_tup: "0",
        last_vacuum_ms: null,
      },
    ];
    const first = shapeTables(sample(2), 0, t);
    expect(first.map((r) => r.table)).toEqual(["votes", "comments"]);
    expect(first[0].seq_scans_per_min).toBeNull();
    const second = shapeTables(sample(5), 60_000, t);
    expect(second[0]).toMatchObject({
      table: "votes",
      expected_seq: false,
      seq_scans_per_min: 3,
      seq_rows_per_min: 3000,
      idx_scans_per_min: 0,
      seq_scans_total: 5,
      live_rows: 1000,
      last_vacuum_ms: null,
    });
    expect(second[1].last_vacuum_ms).toBe(1790000000000);
  });
});

describe("shapeDatabase", () => {
  test("one row: totals now, rates from the second read", () => {
    const t = new RateTracker();
    const raw = (commits: number, hit: number, read: number) => ({
      numbackends: "31",
      xact_commit: String(commits),
      xact_rollback: "2",
      blks_read: String(read),
      blks_hit: String(hit),
      temp_bytes: "0",
      deadlocks: "1",
      conflicts: "0",
      size_bytes: "123456789",
    });
    const [a] = shapeDatabase(raw(1000, 900, 100), 0, t);
    expect(a).toMatchObject({
      backends: 31,
      cache_hit_now: null,
      cache_hit_total: 0.9,
      commits_per_min: null,
      deadlocks_total: 1,
      size_bytes: 123456789,
    });
    const [b] = shapeDatabase(raw(1600, 1890, 110), 120_000, t);
    expect(b).toMatchObject({
      commits_per_min: 300,
      rollbacks_per_min: 0,
      cache_hit_now: 0.99,
    });
  });

  test("no row is an empty panel", () => {
    expect(shapeDatabase(undefined, 0, new RateTracker())).toEqual([]);
  });
});
