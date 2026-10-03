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
//     after LOAD_DEADLINE_MS, and its remaining requests are aborted;
//   - paginated reads stop after a fixed number of pages and say so;
//   - a failure is reported only as a closed reason code, never SDK text.
//
// Nothing here runs unless OPS_ENABLED=true and OPS_DATA_SOURCE=aws, and then
// only when a staff member opens a page (the panel cache is lazy).

// SDK modules are loaded on first use (dynamic import), so a server with ops
// off, or with OPS_DATA_SOURCE unset, never loads them. Only types are
// imported statically.
import type { Metric, MetricDataQuery } from "@aws-sdk/client-cloudwatch";
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

/**
 * One request, aborted after REQUEST_TIMEOUT_MS or when `signal` (the panel's
 * deadline) fires; failures become reasons.
 */
export async function awsSend<T = any>(
  client: Sender,
  command: unknown,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw new OpsSourceError("aws_timeout");
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await client.send(command, {
      abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    throw new OpsSourceError(awsReason(err));
  }
}

/**
 * A panel load that has not settled after `ms` is reported as aws_timeout,
 * and the signal handed to `work` is aborted, so a paginated read stops
 * issuing requests instead of running on after nobody is waiting.
 */
export function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number = LOAD_DEADLINE_MS
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OpsSourceError("aws_timeout"));
    }, ms);
  });
  const running = work(controller.signal);
  running.catch(() => undefined);
  return Promise.race([running, deadline]).finally(() => clearTimeout(timer));
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
    private readonly read: (nowMs: number, signal: AbortSignal) => Promise<T>
  ) {}

  get(nowMs: number): Promise<T> {
    if (this.current && nowMs - this.current.at_ms < this.ttlMs) {
      return this.current.promise;
    }
    const promise = withDeadline((signal) => this.read(nowMs, signal));
    promise.catch(() => undefined);
    this.current = { at_ms: nowMs, promise };
    return promise;
  }
}

async function memoizedInstanceCredentials() {
  const { fromInstanceMetadata } = await import(
    "@smithy/credential-provider-imds"
  );
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
 * The production clients, loaded and built on the first AWS read. Building
 * them makes no request; the first request fetches the instance role's
 * credentials from the instance metadata service.
 */
export async function makeOpsAwsClients(
  region: string
): Promise<OpsAwsClients> {
  const [logs, cw, asg, cd, ce, sts, credentials] = await Promise.all([
    import("@aws-sdk/client-cloudwatch-logs"),
    import("@aws-sdk/client-cloudwatch"),
    import("@aws-sdk/client-auto-scaling"),
    import("@aws-sdk/client-codedeploy"),
    import("@aws-sdk/client-cost-explorer"),
    import("@aws-sdk/client-sts"),
    memoizedInstanceCredentials(),
  ]);
  const common = { region, credentials, maxAttempts: 2 };
  return {
    logs: new logs.CloudWatchLogsClient(common),
    cloudwatch: new cw.CloudWatchClient(common),
    autoscaling: new asg.AutoScalingClient(common),
    codedeploy: new cd.CodeDeployClient(common),
    costExplorer: new ce.CostExplorerClient({
      ...common,
      region: COST_EXPLORER_REGION,
    }),
    sts: new sts.STSClient(common),
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
  },
  signal?: AbortSignal
): Promise<LogRead> {
  const { FilterLogEventsCommand } = await import(
    "@aws-sdk/client-cloudwatch-logs"
  );
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
      }),
      signal
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
  endMs: number,
  signal?: AbortSignal
): Promise<Map<string, Series>> {
  const out = new Map<string, Series>();
  if (queries.length === 0) return out;
  const { GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
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
      }),
      signal
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
  },
  signal?: AbortSignal
): Promise<Metric[]> {
  const { ListMetricsCommand } = await import("@aws-sdk/client-cloudwatch");
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
      }),
      signal
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
