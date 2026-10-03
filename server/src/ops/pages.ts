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
import { readStatements, readVotes } from "./activityNow";
import { DAILY_90, HOURLY_48, readMonthly, readSeries } from "./history";
import { readActive, readDetails, shapeTopics, thresholdNote } from "./topics";
import { makeDelphiTopicNameReader, TopicNameReader } from "./delphiTopicNames";
import { MathMemo, MATH_LABEL, readConsensus } from "./consensus";
import {
  RateTracker,
  readConnections,
  readDatabase,
  readTables,
} from "./database";
import {
  APPS,
  crossTab,
  countryKey,
  Fetcher,
  MIN_PAGEVIEWS_SHOWN,
  referrerKey,
  SimpleAnalyticsSource,
  summaryRows,
  unconfiguredReason,
  WINDOW_DAYS,
} from "./simpleAnalytics";
import {
  OpsColumn,
  OpsLoadResult,
  OpsRow,
  OpsShape,
  OpsSourceError,
} from "./types";

export type { ColumnType, OpsColumn, OpsRow, OpsShape } from "./types";

export type OpsPanelDef = {
  id: string;
  title: string;
  // Where the numbers come from, shown verbatim under the panel.
  source: string;
  ttl_s: number;
  // How the admin console draws it; "tiles" when absent.
  shape?: OpsShape;
  columns: OpsColumn[];
  load: (nowMs: number) => Promise<OpsLoadResult>;
};

export type OpsPageDef = {
  id: string;
  group: "usage" | "system";
  title: string;
  summary: string;
  refresh_s: number;
  panels: OpsPanelDef[];
  // A sentence when the page cannot read anything in this deployment (for
  // example a missing API key); the page then shows only that sentence and
  // nothing is read.
  unconfigured?: () => string | null;
};

export type OpsPanelResult = {
  id: string;
  title: string;
  source: string;
  shape: OpsShape;
  columns: OpsColumn[];
  status: "ok" | "unavailable";
  reason?: string;
  note?: string;
  as_of_ms: number | null;
  cost_ms: number | null;
  rows: OpsRow[];
};

export type OpsPageOptions = {
  // OPS_MIN_VOTERS_FOR_TEXT, already parsed (src/ops/textThreshold.ts).
  minVotersForText: number;
  simpleAnalyticsApiKey: string;
  simpleAnalyticsHostname: string;
  // Tests replace the outside readers; production uses the defaults.
  topicNames?: TopicNameReader;
  simpleAnalyticsFetch?: Fetcher;
};

const MAX_BACKOFF = 16;
// Every panel is cached for at least this long, shared by all viewers.
export const DEFAULT_TTL_S = 60;
// The 90-day and all-time series change slowly and read the most rows.
export const LONG_TTL_S = 15 * 60;

const windowColumn: OpsColumn = {
  key: "window",
  label: "Window",
  type: "label",
};

const seriesColumns: OpsColumn[] = [
  { key: "period", label: "Period (UTC)", type: "label" },
  { key: "votes", label: "Votes", type: "count", chart: true },
  { key: "voters", label: "Participants voting", type: "count", chart: true },
  { key: "conversations", label: "Conversations with votes", type: "count" },
  { key: "statements", label: "New statements", type: "count", chart: true },
  { key: "rejected", label: "Moderated out", type: "count" },
];

const SERIES_SOURCE =
  "votes (zid, pid, created) by created, index votes_created_idx; comments (created, modified, mod) written in the window, index comments_modified_idx. Buckets are UTC; the newest is still filling";

const topicColumns: OpsColumn[] = [
  { key: "topic", label: "Conversation topic", type: "text" },
  { key: "delphi_topics", label: "Delphi topics", type: "tags" },
  { key: "voters", label: "Voters, 7 days", type: "count" },
  { key: "votes", label: "Votes, 7 days", type: "count" },
  { key: "participants", label: "Participants, all time", type: "count" },
  { key: "statements", label: "Statements, all time", type: "count" },
  { key: "status", label: "Status", type: "label" },
];

const consensusColumns: OpsColumn[] = [
  { key: "conversation", label: "Conversation", type: "group" },
  { key: "finding", label: "Finding", type: "label" },
  { key: "statement", label: "Statement", type: "text" },
  { key: "agree", label: "Agree", type: "percent" },
  { key: "detail", label: "How it was measured", type: "label" },
];

function appColumns(keyColumn: OpsColumn): OpsColumn[] {
  return [
    keyColumn,
    ...APPS.map((a) => ({
      key: a.id,
      label: `${a.label} pageviews`,
      type: "count" as const,
    })),
    { key: "total", label: "Total", type: "count" },
  ];
}

/** The page registry. Built once by createOpsRoutes; reads nothing itself. */
export function buildPages(options: OpsPageOptions): OpsPageDef[] {
  const minVoters = options.minVotersForText;
  const topicNames = options.topicNames || makeDelphiTopicNameReader();
  const memo = new MathMemo();
  const tracker = new RateTracker();
  const saUnconfigured = () =>
    unconfiguredReason(
      options.simpleAnalyticsApiKey,
      options.simpleAnalyticsHostname
    );
  const sa = new SimpleAnalyticsSource(
    options.simpleAnalyticsApiKey,
    options.simpleAnalyticsHostname,
    DEFAULT_TTL_S * 1000,
    options.simpleAnalyticsFetch
  );
  const saSource = (what: string) =>
    `Simple Analytics Stats API, site ${options.simpleAnalyticsHostname}, last ${WINDOW_DAYS} days (UTC), ${what}; each app selected by the paths server/app.ts serves it on; under ${MIN_PAGEVIEWS_SHOWN} pageviews in total folds into Other`;
  const threshold = `Named only with at least ${minVoters} distinct voters in the last 7 days (OPS_MIN_VOTERS_FOR_TEXT)`;

  return [
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
          ttl_s: DEFAULT_TTL_S,
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
          ttl_s: DEFAULT_TTL_S,
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
    {
      id: "history",
      group: "usage",
      title: "Activity over time",
      summary:
        "Votes, voters and new statements per hour for two days and per day for ninety days, and conversations started per month since the beginning.",
      refresh_s: 60,
      panels: [
        {
          id: "hourly",
          title: "Per hour, last 48 hours",
          source: SERIES_SOURCE,
          ttl_s: DEFAULT_TTL_S,
          shape: "series",
          columns: seriesColumns,
          load: (nowMs) => guardedRead((q) => readSeries(q, HOURLY_48, nowMs)),
        },
        {
          id: "daily",
          title: "Per day, last 90 days",
          source: SERIES_SOURCE,
          ttl_s: LONG_TTL_S,
          shape: "series",
          columns: seriesColumns,
          load: (nowMs) => guardedRead((q) => readSeries(q, DAILY_90, nowMs)),
        },
        {
          id: "monthly",
          title: "Per month, all time",
          source:
            "conversations (created, participant_count), one pass over the conversations table (no index on created; votes and participants are not read). Months are UTC",
          ttl_s: LONG_TTL_S,
          shape: "series",
          columns: [
            { key: "period", label: "Month (UTC)", type: "label" },
            {
              key: "conversations",
              label: "Conversations started",
              type: "count",
              chart: true,
            },
            {
              key: "with_10_plus",
              label: "Of those, with 10+ participants",
              type: "count",
            },
            {
              key: "participants",
              label: "Participants in conversations started that month",
              type: "count",
              chart: true,
            },
          ],
          load: (nowMs) => guardedRead((q) => readMonthly(q, nowMs)),
        },
      ],
    },
    {
      id: "origin",
      group: "usage",
      title: "Where visitors come from",
      summary: `Pageviews of the participation, admin and report apps by country and by referring site over the last ${WINDOW_DAYS} days, from Simple Analytics.`,
      refresh_s: 60,
      unconfigured: saUnconfigured,
      panels: [
        {
          id: "apps",
          title: "Pageviews by app",
          source: saSource("total pageviews and visitors"),
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: [
            { key: "app", label: "App", type: "label" },
            { key: "pageviews", label: "Pageviews", type: "count" },
            { key: "visitors", label: "Visitors", type: "count" },
          ],
          load: async (nowMs) => summaryRows((await sa.read(nowMs)).stats),
        },
        {
          id: "countries",
          title: "By country",
          source: saSource("countries (ISO 3166 codes)"),
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: appColumns({
            key: "country",
            label: "Country",
            type: "label",
          }),
          load: async (nowMs) => {
            const { stats } = await sa.read(nowMs);
            return crossTab(
              Object.fromEntries(
                APPS.map((a) => [a.id, stats[a.id].countries])
              ),
              countryKey,
              "country"
            );
          },
        },
        {
          id: "referrers",
          title: "By referring site",
          source: saSource("referrers (hostnames only)"),
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: appColumns({
            key: "referrer",
            label: "Referring site",
            type: "label",
          }),
          load: async (nowMs) => {
            const { stats } = await sa.read(nowMs);
            return crossTab(
              Object.fromEntries(
                APPS.map((a) => [a.id, stats[a.id].referrers])
              ),
              referrerKey,
              "referrer"
            );
          },
        },
      ],
    },
    {
      id: "topics",
      group: "usage",
      title: "What people are talking about",
      summary:
        "The most active conversations of the last 7 days, with their topic and the topic names Delphi found in their statements.",
      refresh_s: 60,
      panels: [
        {
          id: "active",
          title: "Most active conversations, last 7 days",
          source: `votes (zid, pid, created) in the window, index votes_created_idx; conversations (topic, participant_count, is_active) by primary key; comments counted by comments_zid_idx; Delphi topic names from DynamoDB Delphi_CommentClustersLLMTopicNames (newest run, coarsest layer). ${threshold}`,
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: topicColumns,
          load: async (nowMs) => {
            const { split, details } = await guardedRead(async (q) => {
              const s = await readActive(q, nowMs, minVoters);
              const d = await readDetails(
                q,
                s.named.map((c) => c.zid)
              );
              return { split: s, details: d };
            });
            // DynamoDB is read after the transaction ends, so no database
            // connection is held while waiting on it.
            const names = await topicNames(split.named.map((c) => c.zid));
            const failed = [...names.values()].filter((n) => n === null).length;
            let note = thresholdNote(split, minVoters);
            if (failed > 0) {
              note += ` Delphi topic names could not be read for ${failed} of them.`;
            }
            return { rows: shapeTopics(split, details, names), note };
          },
        },
      ],
    },
    {
      id: "consensus",
      group: "usage",
      title: "What consensus they found",
      summary:
        "For the conversations on the topics page: the statements every opinion group tends to agree with, and the statement that sets each group apart, from the published math.",
      refresh_s: 60,
      panels: [
        {
          id: "findings",
          title: "Common ground and what sets each group apart",
          source: `math_main.data for math_env "${MATH_LABEL}" (group-votes, group-aware-consensus, repness), read as client-report reads them; statement text from comments (zid, tid) only when visible to participants. ${threshold}`,
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: consensusColumns,
          load: async (nowMs) => {
            const r = await guardedRead((q) =>
              readConsensus(q, nowMs, minVoters, memo)
            );
            return { rows: r.rows, note: thresholdNote(r.split, minVoters) };
          },
        },
      ],
    },
    {
      id: "db",
      group: "system",
      title: "Database",
      summary:
        "Who holds database connections, which large tables are being scanned sequentially, and the database's own counters. Read from Postgres's statistics views; no query text.",
      refresh_s: 60,
      panels: [
        {
          id: "connections",
          title: "Connections by application and state",
          source:
            "pg_stat_activity for this database, client backends only, grouped by application_name up to its first ':' (query text, user and client address are not read)",
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: [
            { key: "app", label: "Application", type: "label" },
            { key: "state", label: "State", type: "label" },
            { key: "connections", label: "Connections", type: "count" },
            {
              key: "waiting_on_lock",
              label: "Waiting on a lock",
              type: "count",
            },
            {
              key: "longest_active_s",
              label: "Longest running statement",
              type: "number",
              unit: "s",
              digits: 1,
            },
            {
              key: "longest_idle_in_xact_s",
              label: "Longest idle in transaction",
              type: "number",
              unit: "s",
              digits: 1,
            },
          ],
          load: () => guardedRead((q) => readConnections(q)),
        },
        {
          id: "tables",
          title: "Sequential-scan watch",
          source:
            "pg_stat_user_tables; rates are per minute between this server process's last two reads (blank on the first read). A sequential scan of votes, comments or math_main reads the whole table",
          ttl_s: DEFAULT_TTL_S,
          shape: "table",
          columns: [
            { key: "table", label: "Table", type: "label" },
            {
              key: "seq_scans_per_min",
              label: "Seq scans / min",
              type: "number",
              digits: 1,
            },
            {
              key: "seq_rows_per_min",
              label: "Rows read by seq scans / min",
              type: "number",
              digits: 0,
            },
            {
              key: "idx_scans_per_min",
              label: "Index scans / min",
              type: "number",
              digits: 0,
            },
            { key: "live_rows", label: "Live rows", type: "count" },
            { key: "dead_rows", label: "Dead rows", type: "count" },
            { key: "last_vacuum_ms", label: "Last vacuum", type: "time" },
          ],
          load: (nowMs) => guardedRead((q) => readTables(q, nowMs, tracker)),
        },
        {
          id: "counters",
          title: "Database counters",
          source:
            "pg_stat_database for this database and pg_database_size; per-minute values are between this server process's last two reads",
          ttl_s: DEFAULT_TTL_S,
          shape: "stats",
          columns: [
            { key: "backends", label: "Connections", type: "count" },
            {
              key: "cache_hit_now",
              label: "Cache hit ratio, last interval",
              type: "percent",
            },
            {
              key: "cache_hit_total",
              label: "Cache hit ratio since stats reset",
              type: "percent",
            },
            {
              key: "commits_per_min",
              label: "Commits / min",
              type: "number",
              digits: 0,
            },
            {
              key: "rollbacks_per_min",
              label: "Rollbacks / min",
              type: "number",
              digits: 1,
            },
            {
              key: "temp_bytes_per_min",
              label: "Temp file bytes / min",
              type: "number",
              digits: 0,
            },
            {
              key: "deadlocks_per_min",
              label: "Deadlocks / min",
              type: "number",
              digits: 1,
            },
            {
              key: "deadlocks_total",
              label: "Deadlocks since stats reset",
              type: "count",
            },
            { key: "size_bytes", label: "Database size, bytes", type: "count" },
          ],
          load: (nowMs) => guardedRead((q) => readDatabase(q, nowMs, tracker)),
        },
      ],
    },
  ];
}

export function findPage(
  pages: readonly OpsPageDef[],
  id: string
): OpsPageDef | undefined {
  return pages.find((p) => p.id === id);
}

type Good = {
  rows: OpsRow[];
  note?: string;
  as_of_ms: number;
  cost_ms: number;
};

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
      shape: def.shape || "tiles",
      columns: def.columns,
      note: e.good ? e.good.note : undefined,
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
        (loaded) => {
          const now = this.clock();
          const { rows, note } = Array.isArray(loaded)
            ? { rows: loaded, note: undefined }
            : loaded;
          e.good = { rows, note, as_of_ms: started, cost_ms: now - started };
          e.fresh_until_ms = now + def.ttl_s * 1000;
          e.failure = undefined;
          e.backoff = 1;
        },
        (err) => {
          const now = this.clock();
          const reason =
            err instanceof OpsReadError || err instanceof OpsSourceError
              ? err.reason
              : "error";
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
