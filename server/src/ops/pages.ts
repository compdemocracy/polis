// The ops page registry and its cache.
//
// A page is a list of panels. A panel is a title, a declared column list, a
// one-line source description shown in the page footer, a TTL and a `load`
// function. `load` may read Postgres through guardedRead (as U1 does) or any
// other source the server can reach, such as a third-party analytics API, so a
// page that does not touch the database fits the same registry.
//
// Caching is lazy and single-flight: nothing is read while nobody is looking,
// concurrent viewers share one load, and a fresh value is served from memory
// until its TTL passes. A failed load is served as "unavailable" with the last
// good rows for TTL x backoff, the backoff doubling on each consecutive failure
// (capped at 16) and resetting on the next success. The upper bound on work is
// therefore (web processes) x (panels) / TTL, however many tabs are open.

import { guardedRead, OpsReadError } from "./guardedRead";
import { readStatements, readVotes, WindowRow } from "./activityNow";

export type ColumnType = "label" | "count";

export type OpsColumn = { key: string; label: string; type: ColumnType };

export type OpsPanelDef = {
  id: string;
  title: string;
  // Where the numbers come from, shown verbatim under the panel.
  source: string;
  ttl_s: number;
  columns: OpsColumn[];
  load: (nowMs: number) => Promise<WindowRow[]>;
};

export type OpsPageDef = {
  id: string;
  group: "usage" | "system";
  title: string;
  summary: string;
  refresh_s: number;
  panels: OpsPanelDef[];
};

export type OpsPanelResult = {
  id: string;
  title: string;
  source: string;
  columns: OpsColumn[];
  status: "ok" | "unavailable";
  reason?: string;
  as_of_ms: number | null;
  cost_ms: number | null;
  rows: WindowRow[];
};

const MAX_BACKOFF = 16;

const windowColumn: OpsColumn = {
  key: "window",
  label: "Window",
  type: "label",
};

export const PAGES: readonly OpsPageDef[] = [
  {
    id: "activity",
    group: "usage",
    title: "Activity now",
    summary:
      "Votes, voters and new statements across every conversation in the last 5 minutes, hour and day.",
    refresh_s: 60,
    panels: [
      {
        id: "votes",
        title: "Voting",
        source:
          "votes (zid, pid, created) where created is in the window; index votes_created_idx",
        ttl_s: 60,
        columns: [
          windowColumn,
          { key: "votes", label: "Votes cast", type: "count" },
          { key: "voters", label: "Participants voting", type: "count" },
          { key: "conversations", label: "Conversations", type: "count" },
        ],
        load: (nowMs) => guardedRead((q) => readVotes(q, nowMs)),
      },
      {
        id: "statements",
        title: "New statements",
        source:
          "comments (zid, pid, created, modified, mod) written in the window; index comments_modified_idx",
        ttl_s: 60,
        columns: [
          windowColumn,
          { key: "statements", label: "Statements", type: "count" },
          { key: "authors", label: "Authors", type: "count" },
          { key: "rejected", label: "Moderated out", type: "count" },
        ],
        load: (nowMs) => guardedRead((q) => readStatements(q, nowMs)),
      },
    ],
  },
];

export function findPage(id: string): OpsPageDef | undefined {
  return PAGES.find((p) => p.id === id);
}

type Good = { rows: WindowRow[]; as_of_ms: number; cost_ms: number };

type Entry = {
  good?: Good;
  fresh_until_ms: number;
  failure?: { reason: string; until_ms: number };
  backoff: number;
  inflight?: Promise<void>;
};

export class PanelCache {
  private entries = new Map<string, Entry>();

  constructor(private readonly clock: () => number = Date.now) {}

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { fresh_until_ms: 0, backoff: 1 };
      this.entries.set(key, e);
    }
    return e;
  }

  private result(def: OpsPanelDef, e: Entry): OpsPanelResult {
    const base = {
      id: def.id,
      title: def.title,
      source: def.source,
      columns: def.columns,
      as_of_ms: e.good ? e.good.as_of_ms : null,
      cost_ms: e.good ? e.good.cost_ms : null,
      rows: e.good ? e.good.rows : [],
    };
    if (e.failure && e.failure.until_ms > this.clock()) {
      return { ...base, status: "unavailable", reason: e.failure.reason };
    }
    return { ...base, status: "ok" };
  }

  private refresh(def: OpsPanelDef, e: Entry): Promise<void> {
    const started = this.clock();
    return def
      .load(started)
      .then(
        (rows) => {
          const now = this.clock();
          e.good = { rows, as_of_ms: started, cost_ms: now - started };
          e.fresh_until_ms = now + def.ttl_s * 1000;
          e.failure = undefined;
          e.backoff = 1;
        },
        (err) => {
          const now = this.clock();
          const reason = err instanceof OpsReadError ? err.reason : "error";
          e.failure = { reason, until_ms: now + def.ttl_s * 1000 * e.backoff };
          e.fresh_until_ms = e.failure.until_ms;
          e.backoff = Math.min(e.backoff * 2, MAX_BACKOFF);
        }
      )
      .finally(() => {
        e.inflight = undefined;
      });
  }

  /** Returns the panel and whether this call was answered from memory. */
  async get(
    pageId: string,
    def: OpsPanelDef
  ): Promise<{ panel: OpsPanelResult; hit: boolean }> {
    const e = this.entry(`${pageId}/${def.id}`);
    if (this.clock() < e.fresh_until_ms && !e.inflight) {
      return { panel: this.result(def, e), hit: true };
    }
    const hit = Boolean(e.inflight);
    if (!e.inflight) e.inflight = this.refresh(def, e);
    await e.inflight;
    return { panel: this.result(def, e), hit };
  }
}
