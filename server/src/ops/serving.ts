// Page S3, "Serving": what the server hands participants and reports, and how
// fresh it is.
//
//   - the served label and its ETag form, from this process's configuration
//     (src/routes/math.ts pca2EntityTag);
//   - publications under that label from math_ticks (math_ticks is small; a
//     sequential scan is allowed);
//   - freshness: conversations with a vote in the last hour whose published
//     math is behind their newest vote (votes_created_idx, math_main's
//     (zid, math_env) unique index; last_vote_timestamp is a plain column, so
//     no math blob is read);
//   - the server's own refusal lines (src/utils/mathBundle.ts, pca.ts) from
//     the "server" log stream, counted;
//   - load balancer request counts, 5xx and response time.

import os from "os";
import type { Metric, MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import {
  anyPhrase,
  clockLabel,
  dimension,
  listMetrics,
  LogRead,
  readLogEvents,
  readMetrics,
  Sender,
  Series,
} from "./awsReads";
import { countRows, EVENT_WINDOW_MS, LogSource, SERVER_STREAM } from "./engine";
import type { OpsQuery } from "./guardedRead";
import { OpsRow, OpsSourceError, toCount, toNumberOrNull } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/** Pure: the served label, its ETag form and which process answered. */
export function labelRow(
  mathEnv: string | null | undefined,
  startedMs: number
): OpsRow {
  const label = mathEnv ? String(mathEnv) : null;
  return {
    label,
    etag: label ? `"${encodeURIComponent(label)}-<math_tick>"` : null,
    process: os.hostname().slice(0, 64),
    started_ms: startedMs,
    node: process.version,
  };
}

// Conversations with a vote in the window, and how far their published math
// is behind the newest vote.
export const FRESHNESS_SQL = `
WITH live AS (
  SELECT zid, max(created) AS last_vote
  FROM votes
  WHERE created >= $1
  GROUP BY zid
)
SELECT count(*)                                                      AS live,
       count(*) FILTER (WHERE m.zid IS NULL)                         AS no_math,
       count(*) FILTER (WHERE l.last_vote - m.last_vote_timestamp > 60000) AS behind_60s,
       max(l.last_vote - m.last_vote_timestamp)                      AS max_lag_ms
FROM live l
LEFT JOIN math_main m ON m.zid = l.zid AND m.math_env = $2`;

export async function readFreshness(
  q: OpsQuery,
  label: string,
  nowMs: number
): Promise<OpsRow> {
  const [r] = await q<Record<string, unknown>>(FRESHNESS_SQL, [
    nowMs - HOUR_MS,
    label,
  ]);
  if (!r) throw new OpsSourceError("bad_value");
  const lag = toNumberOrNull(r.max_lag_ms);
  return {
    label,
    live: toCount(r.live),
    no_math: toCount(r.no_math),
    behind_60s: toCount(r.behind_60s),
    // A negative lag (math newer than the vote read) is no lag.
    max_lag_s: lag === null ? null : Math.max(0, Math.round(lag / 100) / 10),
  };
}

// The server writes JSON lines (src/utils/logger.ts); these are the messages
// that mean a participant or report was refused math or got a repaired copy.
export const SERVING_EVENTS = [
  {
    id: "bundle_missing_companion",
    message: "polis_math_bundle_refused",
    reason: "missing_companion",
    label: "Math bundle refused: a companion row is missing",
  },
  {
    id: "bundle_tick_mismatch",
    message: "polis_math_bundle_refused",
    reason: "tick_mismatch",
    label: "Math bundle refused: companion generation differs",
  },
  {
    id: "bundle_other",
    message: "polis_math_bundle_refused",
    reason: null,
    label: "Math bundle refused: other reason",
  },
  {
    id: "malformed_group_clusters",
    message: "polis_err_math_malformed_group_clusters",
    reason: null,
    label: "Malformed group-clusters repaired",
  },
  {
    id: "malformed_repness",
    message: "polis_err_math_malformed_repness",
    reason: null,
    label: "Malformed repness repaired",
  },
  {
    id: "malformed_bidtopid",
    message: "polis_err_math_malformed_bidtopid",
    reason: null,
    label: "Malformed bidtopid entries repaired",
  },
  {
    id: "malformed_group_votes",
    message: "polis_err_math_malformed_group_votes",
    reason: null,
    label: "Malformed group-votes repaired",
  },
  {
    id: "index_mapping_mismatch",
    message: "polis_err_math_index_mapping_mismatch",
    reason: null,
    label: "Participant index mapping mismatch",
  },
] as const;

export function readServingEvents(
  src: LogSource,
  nowMs: number,
  signal?: AbortSignal
): Promise<LogRead> {
  return readLogEvents(
    src.logs,
    {
      logGroupName: src.logGroupName,
      stream: SERVER_STREAM,
      filterPattern: anyPhrase(
        Array.from(new Set(SERVING_EVENTS.map((e) => e.message)))
      ),
      startMs: nowMs - EVENT_WINDOW_MS,
      endMs: nowMs,
      maxPages: 10,
    },
    signal
  );
}

/**
 * Pure: which SERVING_EVENTS kind one server line is. The line is parsed as
 * JSON only to read `message` and, for a refusal, `reason`; nothing else in
 * it (zid, ticks) is kept.
 */
export function servingKind(line: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const message = (body as Record<string, unknown>).message;
  const reason = (body as Record<string, unknown>).reason;
  const exact = SERVING_EVENTS.find(
    (e) => e.message === message && e.reason !== null && e.reason === reason
  );
  if (exact) return exact.id;
  const any = SERVING_EVENTS.find(
    (e) => e.message === message && e.reason === null
  );
  return any ? any.id : null;
}

export function servingEventRows(read: LogRead, nowMs: number): OpsRow[] {
  const hour = new Map<string, number>();
  const day = new Map<string, number>();
  for (const e of read.events) {
    const id = servingKind(e.message);
    if (!id) continue;
    if (nowMs - e.ts <= EVENT_WINDOW_MS) day.set(id, (day.get(id) || 0) + 1);
    if (nowMs - e.ts <= HOUR_MS) hour.set(id, (hour.get(id) || 0) + 1);
  }
  return countRows(SERVING_EVENTS, hour, day, read.truncated);
}

// ---------------------------------------------------------------------------
// Load balancer
// ---------------------------------------------------------------------------

export const ALB_PERIOD_S = 300;
export const ALB_WINDOW_MS = 6 * HOUR_MS;

// The stack's load balancer (cdk/dns.ts, construct id "Lb", no explicit
// name): CloudFormation names it "<stack prefix>-Lb<hash prefix>-<random>",
// so its LoadBalancer dimension is "app/<that name>/<id>". Only that load
// balancer is read; another one in the region (a probe box's, say) is not.
export const POLIS_ALB =
  /^app\/CdkSt[A-Za-z]*-Lb[A-Za-z0-9]*-[A-Za-z0-9]+\/[0-9a-f]+$/;

/** Pure: the stack's LoadBalancer dimension value among listed metrics. */
export function polisAlb(metrics: Metric[]): string | null {
  const values = metrics
    .filter((m) => m.Dimensions?.length === 1)
    .map((m) => dimension(m, "LoadBalancer"))
    .filter((v): v is string => typeof v === "string" && POLIS_ALB.test(v))
    .sort();
  return values[0] || null;
}

// id -> [metric, statistic]
const ALB_METRICS: [string, string, string][] = [
  ["requests", "RequestCount", "Sum"],
  ["target5xx", "HTTPCode_Target_5XX_Count", "Sum"],
  ["elb5xx", "HTTPCode_ELB_5XX_Count", "Sum"],
  ["p50", "TargetResponseTime", "p50"],
  ["p95", "TargetResponseTime", "p95"],
];

export function albQueries(loadBalancer: string): MetricDataQuery[] {
  return ALB_METRICS.map(([id, name, stat]) => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "AWS/ApplicationELB",
        MetricName: name,
        Dimensions: [{ Name: "LoadBalancer", Value: loadBalancer }],
      },
      Period: ALB_PERIOD_S,
      Stat: stat,
    },
    ReturnData: true,
  }));
}

export async function readAlb(
  cloudwatch: Sender,
  nowMs: number,
  signal?: AbortSignal
) {
  const listed = await listMetrics(
    cloudwatch,
    {
      namespace: "AWS/ApplicationELB",
      metricName: "RequestCount",
      dimensionNames: ["LoadBalancer"],
    },
    signal
  );
  const lb = polisAlb(listed);
  if (!lb) throw new OpsSourceError("aws_not_found");
  const end = Math.floor(nowMs / (ALB_PERIOD_S * 1000)) * ALB_PERIOD_S * 1000;
  return readMetrics(
    cloudwatch,
    albQueries(lb),
    end - ALB_WINDOW_MS,
    end,
    signal
  );
}

/**
 * Pure: one row per 5-minute point, oldest first. A point with no requests is
 * a zero; a missing response time stays missing.
 */
export function albRows(series: Map<string, Series>): OpsRow[] {
  const at = new Map<number, OpsRow>();
  const put = (id: string, scale: number, round: (v: number) => number) => {
    const s = series.get(id);
    if (!s) return;
    s.ts.forEach((t, i) => {
      const row = at.get(t) || { period: clockLabel(t) };
      row[id] = round(s.values[i] * scale);
      at.set(t, row);
    });
  };
  put("requests", 1, Math.round);
  put("target5xx", 1, Math.round);
  put("elb5xx", 1, Math.round);
  put("p50", 1000, (v) => Math.round(v));
  put("p95", 1000, (v) => Math.round(v));
  return Array.from(at.keys())
    .sort((a, b) => a - b)
    .map((t) => {
      const row = at.get(t) as OpsRow;
      return {
        period: row.period,
        requests: row.requests ?? 0,
        target5xx: row.target5xx ?? 0,
        elb5xx: row.elb5xx ?? 0,
        p50_ms: row.p50 ?? null,
        p95_ms: row.p95 ?? null,
      };
    });
}
