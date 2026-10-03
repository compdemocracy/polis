// The AWS side of the ops pages: one set of read-only clients, built lazily
// with the instance role, and the helpers every AWS-backed panel shares.
//
// Credentials. The clients use fromInstanceMetadata() and never the default
// chain, so an AWS_ACCESS_KEY_ID left in the server's environment is never
// used for these reads: they always run as the EC2 instance role, which is
// granted only the read actions the pages need (one CDK statement behind
// -c enableOpsDashboards=true). Until that statement is deployed, a read the
// role may not make fails as "not_permitted" and the panel says so; nothing
// else on the page is affected.
//
// Bounds, the same shape as the Postgres path (guardedRead.ts):
//   - every request is aborted after REQUEST_TIMEOUT_MS;
//   - every panel load, however many requests or pages it makes, is abandoned
//     after LOAD_DEADLINE_MS;
//   - paginated reads stop after a fixed number of pages and say so;
//   - a failure is reported only as a closed reason code, never SDK text.
//
// Nothing here runs unless OPS_ENABLED=true and OPS_DATA_SOURCE=aws, and then
// only when a staff member opens a page (the panel cache is lazy).

import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  Metric,
  MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { CodeDeployClient } from "@aws-sdk/client-codedeploy";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { STSClient } from "@aws-sdk/client-sts";
import { fromInstanceMetadata } from "@smithy/credential-provider-imds";
import { OpsSourceError } from "./types";

export const REQUEST_TIMEOUT_MS = 5000;
export const LOAD_DEADLINE_MS = 12000;
export const DEFAULT_REGION = "us-east-1";
// Cost Explorer has a single endpoint.
export const COST_EXPLORER_REGION = "us-east-1";

/** The one method of an SDK v3 client the pages use. Tests pass fakes. */
export type Sender = {
  send: (command: any, options?: { abortSignal?: AbortSignal }) => Promise<any>;
};

export type OpsAwsClients = {
  logs: Sender;
  cloudwatch: Sender;
  autoscaling: Sender;
  codedeploy: Sender;
  costExplorer: Sender;
  sts: Sender;
};

export type OpsAwsReason =
  | "not_permitted"
  | "aws_no_credentials"
  | "aws_timeout"
  | "aws_throttled"
  | "aws_not_found"
  | "aws_malformed"
  | "aws_error";

const DENIED = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "UnauthorizedOperation",
  "UnauthorizedException",
  "AuthorizationError",
  "NotAuthorized",
]);
const THROTTLED = new Set([
  "Throttling",
  "ThrottlingException",
  "LimitExceededException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
  "ThrottledException",
]);
const NO_CREDENTIALS = new Set([
  "CredentialsProviderError",
  "ProviderError",
  "InstanceMetadataError",
]);

/** A closed reason for any failure of an AWS read. Never the SDK message. */
export function awsReason(err: unknown): string {
  if (err instanceof OpsSourceError) return err.reason;
  const e = (err || {}) as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = String(e.name || e.Code || e.code || "");
  if (DENIED.has(name) || e.$metadata?.httpStatusCode === 403) {
    return "not_permitted";
  }
  if (NO_CREDENTIALS.has(name)) return "aws_no_credentials";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    name === "RequestTimeout" ||
    name === "RequestTimeoutException"
  ) {
    return "aws_timeout";
  }
  if (THROTTLED.has(name)) return "aws_throttled";
  if (name === "ResourceNotFoundException") return "aws_not_found";
  return "aws_error";
}

/** One request, aborted after REQUEST_TIMEOUT_MS; failures become reasons. */
export async function awsSend<T = any>(
  client: Sender,
  command: unknown
): Promise<T> {
  try {
    return await client.send(command, {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OpsSourceError(awsReason(err));
  }
}

/**
 * A panel load that has not settled after `ms` is reported as aws_timeout.
 * The requests themselves are bounded by REQUEST_TIMEOUT_MS each, so the
 * abandoned work ends on its own.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number = LOAD_DEADLINE_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpsSourceError("aws_timeout")), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * One read shared by several panels: concurrent and repeated calls inside
 * `ttlMs` get the same promise, a failure included, so a page refresh makes
 * each request once and a failed read is not retried before `ttlMs` (the
 * Cost Explorer page relies on this as its rate limit).
 */
export class SharedRead<T> {
  private current?: { at_ms: number; promise: Promise<T> };

  constructor(
    private readonly ttlMs: number,
    private readonly read: (nowMs: number) => Promise<T>
  ) {}

  get(nowMs: number): Promise<T> {
    if (this.current && nowMs - this.current.at_ms < this.ttlMs) {
      return this.current.promise;
    }
    const promise = withDeadline(this.read(nowMs));
    promise.catch(() => undefined);
    this.current = { at_ms: nowMs, promise };
    return promise;
  }
}

function memoizedInstanceCredentials() {
  const provider = fromInstanceMetadata({ timeout: 1000, maxRetries: 1 });
  let cached: { value: any; until: number } | undefined;
  let inflight: Promise<any> | undefined;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.value;
    if (!inflight) {
      inflight = provider()
        .then((value) => {
          const exp = value.expiration ? value.expiration.getTime() : 0;
          // Refresh five minutes before the role's credentials expire.
          cached = {
            value,
            until: exp ? exp - 5 * 60 * 1000 : Date.now() + 5 * 60 * 1000,
          };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };
}

/** A configured region, or us-east-1 for unset or the "local" placeholder. */
export function opsRegion(configured: string | null | undefined): string {
  return configured && configured !== "local" ? configured : DEFAULT_REGION;
}

/**
 * The production clients. Constructing them makes no request; the first
 * request fetches the instance role's credentials from the instance
 * metadata service.
 */
export function makeOpsAwsClients(region: string): OpsAwsClients {
  const credentials = memoizedInstanceCredentials();
  const common = { region, credentials, maxAttempts: 2 };
  return {
    logs: new CloudWatchLogsClient(common),
    cloudwatch: new CloudWatchClient(common),
    autoscaling: new AutoScalingClient(common),
    codedeploy: new CodeDeployClient(common),
    costExplorer: new CostExplorerClient({
      ...common,
      region: COST_EXPLORER_REGION,
    }),
    sts: new STSClient(common),
  };
}

// ---------------------------------------------------------------------------
// CloudWatch Logs
// ---------------------------------------------------------------------------

export type LogEvent = { ts: number; message: string };
export type LogRead = { events: LogEvent[]; truncated: boolean };

export const LOG_PAGE_LIMIT = 10000;

/**
 * FilterLogEvents on one stream of the log group, with a constant filter
 * pattern, following nextToken for at most `maxPages` pages. `truncated` says
 * the window had more than was read.
 */
export async function readLogEvents(
  logs: Sender,
  params: {
    logGroupName: string;
    stream: string;
    filterPattern: string;
    startMs: number;
    endMs: number;
    maxPages: number;
  }
): Promise<LogRead> {
  const events: LogEvent[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const page = await awsSend(
      logs,
      new FilterLogEventsCommand({
        logGroupName: params.logGroupName,
        logStreamNames: [params.stream],
        filterPattern: params.filterPattern,
        startTime: params.startMs,
        endTime: params.endMs,
        limit: LOG_PAGE_LIMIT,
        nextToken,
      })
    );
    for (const e of page?.events || []) {
      if (typeof e?.timestamp === "number" && typeof e?.message === "string") {
        events.push({ ts: e.timestamp, message: e.message });
      }
    }
    nextToken = page?.nextToken || undefined;
    pages += 1;
  } while (nextToken && pages < params.maxPages);
  events.sort((a, b) => a.ts - b.ts);
  return { events, truncated: Boolean(nextToken) };
}

/** `?"a" ?"b"`: an event matching any of the quoted phrases. */
export function anyPhrase(phrases: readonly string[]): string {
  for (const p of phrases) {
    if (p.includes('"')) throw new Error("a filter phrase cannot hold a quote");
  }
  return phrases.map((p) => `?"${p}"`).join(" ");
}

// ---------------------------------------------------------------------------
// CloudWatch metrics
// ---------------------------------------------------------------------------

export type Series = { ts: number[]; values: number[] };

/**
 * GetMetricData for up to 500 queries, oldest point first, following
 * NextToken for at most five pages. Returns the points by query id.
 */
export async function readMetrics(
  cloudwatch: Sender,
  queries: MetricDataQuery[],
  startMs: number,
  endMs: number
): Promise<Map<string, Series>> {
  const out = new Map<string, Series>();
  if (queries.length === 0) return out;
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const page = await awsSend(
      cloudwatch,
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: new Date(startMs),
        EndTime: new Date(endMs),
        ScanBy: "TimestampAscending",
        NextToken: nextToken,
      })
    );
    for (const r of page?.MetricDataResults || []) {
      if (typeof r?.Id !== "string") continue;
      const s = out.get(r.Id) || { ts: [], values: [] };
      const ts: unknown[] = r.Timestamps || [];
      const values: unknown[] = r.Values || [];
      ts.forEach((t, i) => {
        const ms = t instanceof Date ? t.getTime() : Date.parse(String(t));
        const v = values[i];
        if (
          Number.isFinite(ms) &&
          typeof v === "number" &&
          Number.isFinite(v)
        ) {
          s.ts.push(ms);
          s.values.push(v);
        }
      });
      out.set(r.Id, s);
    }
    nextToken = page?.NextToken || undefined;
    pages += 1;
  } while (nextToken && pages < 5);
  for (const s of out.values()) {
    const order = s.ts.map((_, i) => i).sort((a, b) => s.ts[a] - s.ts[b]);
    s.ts = order.map((i) => s.ts[i]);
    s.values = order.map((i) => s.values[i]);
  }
  return out;
}

/** ListMetrics for one metric name, recently active, at most five pages. */
export async function listMetrics(
  cloudwatch: Sender,
  params: {
    namespace: string;
    metricName: string;
    dimensionNames?: string[];
  }
): Promise<Metric[]> {
  const out: Metric[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const page = await awsSend(
      cloudwatch,
      new ListMetricsCommand({
        Namespace: params.namespace,
        MetricName: params.metricName,
        Dimensions: params.dimensionNames?.map((Name) => ({ Name })),
        RecentlyActive: "PT3H",
        NextToken: nextToken,
      })
    );
    out.push(...(page?.Metrics || []));
    nextToken = page?.NextToken || undefined;
    pages += 1;
  } while (nextToken && pages < 5);
  return out;
}

export function dimension(metric: Metric, name: string): string | undefined {
  return metric.Dimensions?.find((d) => d.Name === name)?.Value;
}

/** "HH:MM" in UTC. */
export function clockLabel(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** "YYYY-MM-DD" in UTC. */
export function dayLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function lastValue(s: Series | undefined): number | null {
  return s && s.values.length ? s.values[s.values.length - 1] : null;
}

export function maxValue(s: Series | undefined): number | null {
  return s && s.values.length ? Math.max(...s.values) : null;
}
