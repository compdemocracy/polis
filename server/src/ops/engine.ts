// Page S2, "Math engine": what the Python math poller says about itself, read
// back from the log stream it already writes, plus the single-writer lock as
// Postgres sees it and the Polis-* CloudWatch alarms.
//
// Log reads (stream "delphi" of the log group the awslogs driver writes,
// AWS_LOG_GROUP_NAME):
//   - the readiness, discovery_stale and capacity lines and the standby's
//     "waiting for single-writer lock" line, last 10 minutes (one request);
//   - "Wrote math results for zid=" per minute, last 60 minutes (the zid is
//     never parsed);
//   - counts of the memory-admission, eviction, failure, parking and backfill
//     refusal lines, last 24 hours.
// Every line is checked against the poller's closed schema (readinessLine.ts)
// and only counts, ages, closed labels and short digests are relayed.

import type { StateValue } from "@aws-sdk/client-cloudwatch";
import {
  anyPhrase,
  awsSend,
  clockLabel,
  LogRead,
  readLogEvents,
  Sender,
} from "./awsReads";
import type { OpsQuery } from "./guardedRead";
import {
  Json,
  LineShapeError,
  parseCapacity,
  parseReadiness,
  parseStale,
  ReadinessLine,
} from "./readinessLine";
import { OpsRow, OpsSourceError, toCount } from "./types";

export const DELPHI_STREAM = "delphi";
export const SERVER_STREAM = "server";
export const STATUS_WINDOW_MS = 10 * 60 * 1000;
// A primary whose newest line is older than three readiness intervals is not
// reported as current.
export const CURRENT_LINE_MS = 3 * 60 * 1000;
export const PUBLICATION_WINDOW_MS = 60 * 60 * 1000;
export const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const LOCK_WAIT_PHRASE = "waiting for single-writer lock";
export const STATUS_PHRASES = [
  "math_poller readiness/1",
  "math_poller readiness_silenced/1",
  "math_poller discovery_stale/1",
  "math_poller.capacity/1",
  LOCK_WAIT_PHRASE,
] as const;
export const PUBLICATION_PHRASE = "Wrote math results for zid=";

// delphi/polismath/poller: admission.py, service.py, backfill.py.
export const ENGINE_EVENTS = [
  {
    id: "memory_admission",
    phrase: "memory admission:",
    label: "Memory admission warnings",
    // The same prefix is also logged at info (evictions, baseline updates);
    // only warning and error lines are counted. The poller's format is
    // "<time> <LEVEL> [<thread>] <logger>: <message>" (scripts/math_poller.py).
    levels: ["WARNING", "ERROR"],
  },
  {
    id: "lru_evict",
    phrase: "LRU-evicting cold conversation",
    label: "Cold conversations evicted from memory",
  },
  {
    id: "update_failed",
    phrase: "Conversation update failed for zid=",
    label: "Conversation updates failed (retried)",
  },
  {
    id: "parked",
    phrase: "PARKING zid=",
    label: "Conversations parked after repeated failures",
  },
  {
    id: "reservation_refused",
    phrase: "reservation refused",
    label: "Backfill memory reservations refused",
  },
] as const;

export type LogSource = {
  logs: Sender;
  logGroupName: string;
};

/** The newest line per class and the counts the status panels show. */
export type EngineStatus = {
  as_of_ms: number;
  primary: ReadinessLine | null;
  primaries: number;
  standbys: number;
  malformed: number;
  stale_lines: number;
  lock_waits: number;
  capacity: { small: Json | null; large: Json | null };
  truncated: boolean;
};

export function readStatusLines(
  src: LogSource,
  nowMs: number,
  signal?: AbortSignal
): Promise<LogRead> {
  return readLogEvents(
    src.logs,
    {
      logGroupName: src.logGroupName,
      stream: DELPHI_STREAM,
      filterPattern: anyPhrase(STATUS_PHRASES),
      startMs: nowMs - STATUS_WINDOW_MS,
      endMs: nowMs,
      maxPages: 3,
    },
    signal
  );
}

/** Pure: the status panels' view of the last 10 minutes of lines. */
export function summarizeStatus(read: LogRead, nowMs: number): EngineStatus {
  // Newest readiness line per instance digest.
  const byInstance = new Map<string, { line: ReadinessLine; ts: number }>();
  const capacity: { small: Json | null; large: Json | null } = {
    small: null,
    large: null,
  };
  const capacityTs = { small: 0, large: 0 };
  let malformed = 0;
  let staleLines = 0;
  let lockWaits = 0;
  for (const e of read.events) {
    try {
      const r = parseReadiness(e.message);
      if (r) {
        const prev = byInstance.get(r.instance_sha256);
        if (!prev || e.ts >= prev.ts) {
          byInstance.set(r.instance_sha256, { line: r, ts: e.ts });
        }
        continue;
      }
      if (parseStale(e.message)) {
        staleLines += 1;
        continue;
      }
      const c = parseCapacity(e.message);
      if (c) {
        const klass = c.class === "large" ? "large" : "small";
        // A primary's line wins over a standby's null counts.
        const current = capacity[klass];
        const better =
          current === null ||
          (c.role === "primary" && current.role !== "primary") ||
          (c.role === current.role && e.ts >= capacityTs[klass]);
        if (better) {
          capacity[klass] = c;
          capacityTs[klass] = e.ts;
        }
        continue;
      }
      if (e.message.includes(LOCK_WAIT_PHRASE)) {
        lockWaits += 1;
        continue;
      }
      // Matched the filter but is none of the known lines (for example the
      // large class's own lines carry a class token): not counted.
    } catch (err) {
      if (err instanceof LineShapeError || err instanceof SyntaxError) {
        malformed += 1;
      } else {
        throw err;
      }
    }
  }
  let primary: ReadinessLine | null = null;
  let primaryTs = 0;
  let primaries = 0;
  let standbys = 0;
  for (const { line, ts } of byInstance.values()) {
    if (nowMs - ts > CURRENT_LINE_MS) continue;
    if (line.role === "primary") {
      primaries += 1;
      if (ts >= primaryTs) {
        primary = line;
        primaryTs = ts;
      }
    } else {
      standbys += 1;
    }
  }
  return {
    as_of_ms: nowMs,
    primary,
    primaries,
    standbys,
    malformed,
    stale_lines: staleLines,
    lock_waits: lockWaits,
    capacity,
    truncated: read.truncated,
  };
}

function seconds(ms: unknown): number | null {
  return typeof ms === "number" ? Math.round(ms / 100) / 10 : null;
}

function shortCommit(v: unknown): string | null {
  return typeof v === "string" ? v.slice(0, 12) : null;
}

function shortImage(v: unknown): string | null {
  return typeof v === "string" ? v.replace(/^sha256:/, "").slice(0, 12) : null;
}

/** Pure: the "Math poller" stats row. */
export function pollerRow(s: EngineStatus): OpsRow {
  const p = s.primary;
  const lineAge = p ? Math.max(0, s.as_of_ms - p.emitted_ms) : null;
  const d = p ? p.discovery : null;
  return {
    progress: p
      ? `${p.progress}${
          p.silenced ? " (heartbeat silenced by an alert test)" : ""
        }`
      : "no primary line in the last 3 minutes",
    line_age_s: seconds(lineAge),
    discovery_age_s:
      d && typeof d.last_success_age_ms === "number" && lineAge !== null
        ? seconds(d.last_success_age_ms + lineAge)
        : null,
    consecutive: d ? d.consecutive : null,
    failures_since_success: d ? d.failures_since_success : null,
    last_error: d ? d.last_error || "none" : null,
    primaries: s.primaries,
    standbys: s.standbys,
    stale_lines: s.stale_lines,
    lock_waits: s.lock_waits,
    malformed: s.malformed,
    source_commit: p ? shortCommit(p.source_commit) : null,
    image: p ? shortImage(p.image_digest) : null,
  };
}

/** Pure: the "Work queue and memory admission" stats row. */
export function queueRow(s: EngineStatus): OpsRow {
  const p = s.primary;
  const q = p ? p.queue : null;
  const a = p ? p.admission : null;
  const sw = p ? p.sweep : null;
  return {
    pending: q ? q.pending : null,
    in_flight: q ? q.in_flight : null,
    parked: q ? q.parked : null,
    oldest_live_s: q ? seconds(q.oldest_live_age_ms) : null,
    oldest_backfill_s: q ? seconds(q.oldest_backfill_age_ms) : null,
    oldest_work_s: q ? seconds(q.oldest_work_age_ms) : null,
    budget_mb: a ? a.budget_mb : null,
    reserved_mb: a ? a.reserved_mb : null,
    granted: a ? a.granted : null,
    held: a ? a.held : null,
    waiting: a ? a.waiting : null,
    sweep_no: sw ? sw.sweep_no : null,
    sweep_status: sw ? sw.status : null,
    sweep_unresolved: sw ? sw.unresolved : null,
  };
}

/** Pure: one row per poller class that logged a capacity line. */
export function capacityRows(s: EngineStatus): OpsRow[] {
  const rows: OpsRow[] = [];
  for (const klass of ["small", "large"] as const) {
    const c = s.capacity[klass];
    if (!c) continue;
    const pick = (k: string) => (k in c ? c[k] : null);
    rows.push({
      class: klass,
      role: c.role,
      label: c.label,
      routing: pick("routing") === null ? null : pick("routing") ? "on" : "off",
      large_demand: pick("large_demand"),
      pending_promotion: pick("pending_promotion"),
      exceeds_largest: pick("exceeds_largest"),
      oldest_unresolved_s: seconds(pick("oldest_unresolved_age_ms")),
      refusals_total: pick("refusals_total"),
      routed_total: pick("routed_total"),
      promoted_total: pick("promoted_total"),
      busy: pick("busy"),
      queued: pick("queued"),
      unfit: pick("unfit"),
      refusal: pick("refusal"),
    });
  }
  return rows;
}

export function readPublications(
  src: LogSource,
  nowMs: number,
  signal?: AbortSignal
): Promise<LogRead> {
  return readLogEvents(
    src.logs,
    {
      logGroupName: src.logGroupName,
      stream: DELPHI_STREAM,
      filterPattern: `"${PUBLICATION_PHRASE}"`,
      startMs: nowMs - PUBLICATION_WINDOW_MS,
      endMs: nowMs,
      maxPages: 5,
    },
    signal
  );
}

/** Pure: publications per UTC minute for the last 60 minutes, oldest first. */
export function publicationRows(read: LogRead, nowMs: number): OpsRow[] {
  const minute = 60 * 1000;
  const last = Math.floor(nowMs / minute) * minute;
  const first = last - 59 * minute;
  const counts = new Map<number, number>();
  for (const e of read.events) {
    if (!e.message.includes(PUBLICATION_PHRASE)) continue;
    const m = Math.floor(e.ts / minute) * minute;
    if (m < first || m > last) continue;
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  const rows: OpsRow[] = [];
  for (let m = first; m <= last; m += minute) {
    rows.push({ period: clockLabel(m), publications: counts.get(m) || 0 });
  }
  return rows;
}

export function readEngineEvents(
  src: LogSource,
  nowMs: number,
  signal?: AbortSignal
): Promise<LogRead> {
  return readLogEvents(
    src.logs,
    {
      logGroupName: src.logGroupName,
      stream: DELPHI_STREAM,
      filterPattern: anyPhrase(ENGINE_EVENTS.map((e) => e.phrase)),
      startMs: nowMs - EVENT_WINDOW_MS,
      endMs: nowMs,
      maxPages: 10,
    },
    signal
  );
}

/**
 * Pure: counts per kind of line over the last hour and day. Each event is
 * classified by its first matching phrase (and, where a kind names levels,
 * only at those levels); its text goes no further.
 *
 * A scan that hit its page cap is partial: FilterLogEvents reads forward from
 * the window's start, so what is missing is the newest part. The 24-hour
 * count is then a lower bound and the last-hour count is unknown (null), and
 * every row says "partial".
 */
export function eventCountRows(
  read: LogRead,
  nowMs: number,
  kinds: readonly {
    id: string;
    phrase: string;
    label: string;
    levels?: readonly string[];
  }[]
): OpsRow[] {
  const hour = new Map<string, number>();
  const day = new Map<string, number>();
  for (const e of read.events) {
    const kind = kinds.find(
      (k) =>
        e.message.includes(k.phrase) &&
        (!k.levels || k.levels.some((l) => e.message.includes(` ${l} [`)))
    );
    if (!kind) continue;
    if (nowMs - e.ts <= EVENT_WINDOW_MS) {
      day.set(kind.id, (day.get(kind.id) || 0) + 1);
    }
    if (nowMs - e.ts <= HOUR_MS) {
      hour.set(kind.id, (hour.get(kind.id) || 0) + 1);
    }
  }
  return countRows(kinds, hour, day, read.truncated);
}

export function countRows(
  kinds: readonly { id: string; label: string }[],
  hour: Map<string, number>,
  day: Map<string, number>,
  truncated: boolean
): OpsRow[] {
  return kinds.map((k) => ({
    event: k.label,
    last_1h: truncated ? null : hour.get(k.id) || 0,
    last_24h: day.get(k.id) || 0,
    coverage: truncated ? "partial" : "complete",
  }));
}

export function truncatedNote(read: LogRead): string | undefined {
  return read.truncated
    ? "Partial: more lines matched than one refresh reads, and the scan stopped before reaching the newest lines. The 24-hour counts are lower bounds and the last-hour counts are unknown."
    : undefined;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export const ALARM_PREFIX = "Polis-";
const ALARM_NAME = /^Polis-[A-Za-z0-9_.-]{1,200}$/;
const STATE_ORDER: Record<string, number> = {
  ALARM: 0,
  INSUFFICIENT_DATA: 1,
  OK: 2,
};

type AlarmLike = {
  AlarmName?: string;
  StateValue?: StateValue | string;
  StateUpdatedTimestamp?: Date | string;
};

/** DescribeAlarms for the Polis- prefix, metric and composite, 3 pages. */
export async function readAlarms(
  cloudwatch: Sender,
  signal?: AbortSignal
): Promise<AlarmLike[]> {
  const { DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
  const out: AlarmLike[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const page = await awsSend(
      cloudwatch,
      new DescribeAlarmsCommand({
        AlarmNamePrefix: ALARM_PREFIX,
        AlarmTypes: ["MetricAlarm", "CompositeAlarm"],
        MaxRecords: 100,
        NextToken: nextToken,
      }),
      signal
    );
    out.push(...(page?.MetricAlarms || []), ...(page?.CompositeAlarms || []));
    nextToken = page?.NextToken || undefined;
    pages += 1;
  } while (nextToken && pages < 3);
  return out;
}

/** Pure: name, state and since when; firing alarms first. No reason text. */
export function alarmRows(alarms: AlarmLike[]): OpsRow[] {
  return alarms
    .filter(
      (a) => typeof a.AlarmName === "string" && ALARM_NAME.test(a.AlarmName)
    )
    .map((a) => {
      const ts =
        a.StateUpdatedTimestamp instanceof Date
          ? a.StateUpdatedTimestamp.getTime()
          : Date.parse(String(a.StateUpdatedTimestamp));
      const state = String(a.StateValue || "");
      return {
        alarm: a.AlarmName as string,
        state: state in STATE_ORDER ? state : "UNKNOWN",
        since_ms: Number.isFinite(ts) ? ts : null,
      };
    })
    .sort(
      (a, b) =>
        (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) ||
        a.alarm.localeCompare(b.alarm)
    );
}

// ---------------------------------------------------------------------------
// The single-writer lock, from Postgres
// ---------------------------------------------------------------------------

// delphi/scripts/math_poller.py _HOLDER_SQL and _LOCK_KEY_MATCH, for several
// labels at once: the poller's advisory lock is keyed on
// hashtext('polis-math-python:' || label), and a bigint key k appears in
// pg_locks as classid = high 32 bits, objid = low 32 bits, objsubid = 1.
export const LOCK_SQL = `
SELECT k.label, l.pid IS NOT NULL AS held, a.application_name
FROM unnest($1::text[]) AS k(label)
LEFT JOIN pg_locks l
  ON l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
 AND ((l.classid::bigint << 32) | l.objid::bigint)
     = hashtext('polis-math-python:' || k.label)::bigint
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
ORDER BY k.label`;

const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;
// The poller names its lock connection math-python:<label>@<hostname>.
const HOLDER = /^math-python:[A-Za-z0-9_.-]{1,64}@[A-Za-z0-9_.-]{1,128}$/;

export function lockLabels(...labels: (string | null | undefined)[]): string[] {
  return Array.from(
    new Set(labels.filter((l): l is string => !!l && LABEL.test(l)))
  );
}

export async function readLock(
  q: OpsQuery,
  labels: string[]
): Promise<OpsRow[]> {
  const rows = await q<{
    label: string;
    held: boolean;
    application_name: unknown;
  }>(LOCK_SQL, [labels]);
  return rows.map((r) => {
    const app = r.application_name;
    return {
      label: String(r.label),
      held: r.held ? "held" : "free",
      holder: !r.held
        ? null
        : typeof app === "string" && HOLDER.test(app)
        ? app
        : app === null || app === undefined || app === ""
        ? "not visible"
        : "other",
    };
  });
}

// ---------------------------------------------------------------------------
// Publications as Postgres sees them (math_ticks; a seq scan of a small table
// is allowed, see R2.2).
// ---------------------------------------------------------------------------

export const TICKS_SQL = `
SELECT count(*)                                  AS conversations,
       count(*) FILTER (WHERE modified >= $2)    AS last_1h,
       count(*) FILTER (WHERE modified >= $3)    AS last_5m,
       max(modified)                             AS newest_ms
FROM math_ticks
WHERE math_env = $1`;

export async function readTicks(
  q: OpsQuery,
  label: string,
  nowMs: number
): Promise<OpsRow> {
  const [r] = await q<Record<string, unknown>>(TICKS_SQL, [
    label,
    nowMs - HOUR_MS,
    nowMs - 5 * 60 * 1000,
  ]);
  if (!r) throw new OpsSourceError("bad_value");
  return {
    label,
    conversations: toCount(r.conversations),
    last_1h: toCount(r.last_1h),
    last_5m: toCount(r.last_5m),
    newest_ms: r.newest_ms === null ? null : toCount(r.newest_ms),
  };
}
