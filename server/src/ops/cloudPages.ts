// The system pages that read AWS: S2 "Math engine", S3 "Serving", S4 "Boxes
// and deploys", S5 "Cost", and the RDS metrics panel of S1 "Database".
//
// Each panel declares what it needs:
//   aws   OPS_DATA_SOURCE=aws (the instance-role clients, awsReads.ts)
//   logs  aws, plus the log group the awslogs driver writes (AWS_LOG_GROUP_NAME)
//   rds   aws, plus a DATABASE_URL that is an RDS endpoint
//   cost  aws, plus OPS_COST_EXPLORER=1 (each Cost Explorer request is billed)
// A panel whose need is not met is left out of its page and the page says
// why; a page left with no panel shows only that sentence and reads nothing.
// Panels with no need (the served label) and the Postgres panels always run.
//
// Caching is the registry's (pages.ts PanelCache: lazy, single-flight, 60 s or
// 15 min, failures held with backoff). Several panels of one page share one
// AWS read through SharedRead, so a page refresh makes each request once.

import {
  makeOpsAwsClients,
  opsRegion,
  OpsAwsClients,
  SharedRead,
  withDeadline,
} from "./awsReads";
import {
  alarmRows,
  capacityRows,
  ENGINE_EVENTS,
  eventCountRows,
  lockLabels,
  pollerRow,
  publicationRows,
  queueRow,
  readAlarms,
  readEngineEvents,
  readLock,
  readPublications,
  readStatusLines,
  readTicks,
  summarizeStatus,
  truncatedNote,
} from "./engine";
import {
  albRows,
  labelRow,
  readAlb,
  readFreshness,
  readServingEvents,
  servingEventRows,
} from "./serving";
import {
  deployRows,
  groupRows,
  loadRows,
  readDeploys,
  readGroups,
  readLoad,
} from "./fleet";
import {
  COST_TTL_MS,
  costNote,
  dailyRows,
  readAccount,
  readCost,
  serviceRows,
} from "./cost";
import { rdsInstanceId, rdsRows, readRds } from "./rdsMetrics";
import { guardedRead } from "./guardedRead";
import { MATH_LABEL } from "./consensus";
import type { OpsColumn, OpsLoadResult } from "./types";

// The registry's TTLs (pages.ts DEFAULT_TTL_S and LONG_TTL_S), repeated here
// so this module does not import pages.ts at run time.
const TTL_S = 60;
const LONG_TTL_S = 15 * 60;

export type CloudNeed = "aws" | "logs" | "rds" | "cost";

export type CloudOptions = {
  // OPS_DATA_SOURCE=aws.
  awsReads: boolean;
  // OPS_COST_EXPLORER=1.
  costExplorer: boolean;
  awsRegion?: string | null;
  // AWS_LOG_GROUP_NAME; "docker" (the compose default) means none.
  logGroupName?: string | null;
  databaseUrl?: string | null;
  // MATH_ENV, the label the server serves.
  mathEnv?: string | null;
  startedMs: number;
  // Tests pass recorded clients; production builds the instance-role ones.
  aws?: OpsAwsClients;
};

export type CloudPanel = {
  id: string;
  title: string;
  source: string;
  ttl_s: number;
  shape?: "tiles" | "stats" | "table" | "series";
  columns: OpsColumn[];
  needs?: CloudNeed;
  load: (nowMs: number) => Promise<OpsLoadResult>;
};

export type CloudPage = {
  id: string;
  group: "system";
  title: string;
  summary: string;
  refresh_s: number;
  panels: CloudPanel[];
};

const LOG_GROUP = /^[A-Za-z0-9_./#-]{1,512}$/;

export function usableLogGroup(name: string | null | undefined): string | null {
  if (!name || name === "docker" || !LOG_GROUP.test(name)) return null;
  return name;
}

/** Why a need is not met on this server, or null when it is. */
export function unmetReason(
  need: CloudNeed | undefined,
  o: CloudOptions
): string | null {
  if (!need) return null;
  if (!o.awsReads) {
    return "AWS reads are off on this server (OPS_DATA_SOURCE is not aws)";
  }
  if (need === "logs" && !usableLogGroup(o.logGroupName)) {
    return "no CloudWatch log group is configured (AWS_LOG_GROUP_NAME)";
  }
  if (need === "rds" && !rdsInstanceId(o.databaseUrl)) {
    return "the database is not an RDS endpoint";
  }
  if (need === "cost" && !o.costExplorer) {
    return "Cost Explorer reads are off (OPS_COST_EXPLORER is not 1; each request is billed $0.01)";
  }
  return null;
}

const s = (key: string, label: string, digits = 1): OpsColumn => ({
  key,
  label,
  type: "number",
  unit: "s",
  digits,
});
const c = (key: string, label: string): OpsColumn => ({
  key,
  label,
  type: "count",
});
const l = (key: string, label: string): OpsColumn => ({
  key,
  label,
  type: "label",
});
const n = (
  key: string,
  label: string,
  unit?: string,
  digits = 1,
  chart = false
): OpsColumn => ({
  key,
  label,
  type: "number",
  ...(unit ? { unit } : {}),
  digits,
  ...(chart ? { chart: true } : {}),
});
const usd = (key: string, label: string, chart = false): OpsColumn =>
  n(key, label, "USD", 2, chart);

const eventColumns: OpsColumn[] = [
  l("event", "Line"),
  c("last_1h", "Last hour"),
  c("last_24h", "Last 24 hours"),
  l("coverage", "Scan"),
];

/** The RDS metrics panel for page S1 (pages.ts adds it to "db"). */
export function rdsPanel(
  o: CloudOptions,
  aws: () => Promise<OpsAwsClients>
): CloudPanel {
  const id = rdsInstanceId(o.databaseUrl);
  return {
    id: "rds",
    title: "RDS instance, last 6 hours",
    source: `CloudWatch AWS/RDS for the instance DATABASE_URL points at (DBInstanceIdentifier ${
      id || "none"
    }), 5-minute points: CPUUtilization, DatabaseConnections, BurstBalance (gp2 burst credit), Read/WriteIOPS, Read/WriteLatency, DiskQueueDepth, FreeableMemory, FreeStorageSpace`,
    ttl_s: TTL_S,
    shape: "series",
    needs: "rds",
    columns: [
      l("period", "Time (UTC)"),
      n("cpu", "CPU", "%", 1, true),
      n("connections", "Connections", undefined, 0, true),
      n("burst", "Burst balance", "%", 1, true),
      n("read_iops", "Read IOPS", undefined, 1),
      n("write_iops", "Write IOPS", undefined, 1),
      n("read_ms", "Read latency", "ms", 1),
      n("write_ms", "Write latency", "ms", 1),
      n("queue", "Disk queue depth", undefined, 1),
      n("free_mem_mb", "Freeable memory", "MB", 0),
      n("free_disk_gb", "Free storage", "GB", 1),
    ],
    load: async (now) =>
      rdsRows(
        await withDeadline(async (sig) =>
          readRds((await aws()).cloudwatch, id as string, now, sig)
        )
      ),
  };
}

/** The S2-S5 pages. Builds nothing that reads until a panel loads. */
export function buildCloudPages(
  o: CloudOptions,
  aws: () => Promise<OpsAwsClients>
): CloudPage[] {
  const logGroupName = usableLogGroup(o.logGroupName) || "";
  const logSrc = async () => ({ logs: (await aws()).logs, logGroupName });
  const label = o.mathEnv || MATH_LABEL;

  const status = new SharedRead(TTL_S * 1000, async (now, sig) =>
    summarizeStatus(await readStatusLines(await logSrc(), now, sig), now)
  );
  const publications = new SharedRead(TTL_S * 1000, async (now, sig) =>
    readPublications(await logSrc(), now, sig)
  );
  const engineEvents = new SharedRead(LONG_TTL_S * 1000, async (now, sig) =>
    readEngineEvents(await logSrc(), now, sig)
  );
  const servingEvents = new SharedRead(LONG_TTL_S * 1000, async (now, sig) =>
    readServingEvents(await logSrc(), now, sig)
  );
  let account: string | null = null;
  const cost = new SharedRead(COST_TTL_MS, async (now, sig) => {
    const clients = await aws();
    account = account || (await readAccount(clients.sts, sig));
    return readCost(clients.costExplorer, account, now, sig);
  });

  const streamSource = (stream: string, what: string) =>
    `CloudWatch Logs FilterLogEvents, log group ${
      logGroupName || "(none)"
    }, stream "${stream}", ${what}`;

  return [
    {
      id: "engine",
      group: "system",
      title: "Math engine",
      summary:
        "The Python math poller's own readiness, queue, memory admission and capacity lines, its single-writer lock as Postgres sees it, publications per minute, and the Polis CloudWatch alarms.",
      refresh_s: 30,
      panels: [
        {
          id: "poller",
          title: "Math poller",
          source: streamSource(
            "delphi",
            'lines "math_poller readiness/1", "discovery_stale/1" and "waiting for single-writer lock" in the last 10 minutes, each checked against the poller\'s closed schema (delphi/polismath/poller/readiness.py); the newest primary line of the last 3 minutes is shown'
          ),
          ttl_s: TTL_S,
          shape: "stats",
          needs: "logs",
          columns: [
            l("progress", "Progress"),
            s("line_age_s", "Line age", 0),
            s("discovery_age_s", "Since both poll loops last succeeded", 0),
            c("consecutive", "Consecutive successes"),
            c("failures_since_success", "Failures since last success"),
            l("last_error", "Last error class"),
            c("primaries", "Primaries"),
            c("standbys", "Standbys"),
            c("stale_lines", "Discovery-stale lines, 10 min"),
            c("lock_waits", "Lock waits logged, 10 min"),
            c("malformed", "Lines failing the schema"),
            l("source_commit", "Source commit"),
            l("image", "Image digest"),
          ],
          load: async (now) => {
            const st = await status.get(now);
            return {
              rows: [pollerRow(st)],
              note: st.truncated
                ? "More lines than one refresh reads; counts are lower bounds."
                : undefined,
            };
          },
        },
        {
          id: "queue",
          title: "Work queue and memory admission",
          source: streamSource(
            "delphi",
            "the queue, admission and sweep objects of the same readiness line"
          ),
          ttl_s: TTL_S,
          shape: "stats",
          needs: "logs",
          columns: [
            c("pending", "Pending"),
            c("in_flight", "In flight"),
            c("parked", "Parked"),
            s("oldest_live_s", "Oldest live work", 0),
            s("oldest_backfill_s", "Oldest backfill work", 0),
            s("oldest_work_s", "Oldest work", 0),
            n("budget_mb", "Memory budget", "MB", 0),
            n("reserved_mb", "Reserved", "MB", 0),
            c("granted", "Reservations granted"),
            c("held", "Reservations held"),
            c("waiting", "Waiting for memory"),
            c("sweep_no", "Backfill sweep"),
            l("sweep_status", "Sweep status"),
            c("sweep_unresolved", "Unresolved in sweep"),
          ],
          load: async (now) => [queueRow(await status.get(now))],
        },
        {
          id: "capacity",
          title: "Capacity demand",
          source: streamSource(
            "delphi",
            'the "math_poller.capacity/1" JSON line of each poller class in the last 10 minutes (delphi/polismath/poller/capacity.py), a primary\'s line preferred'
          ),
          ttl_s: TTL_S,
          shape: "table",
          needs: "logs",
          columns: [
            l("class", "Class"),
            l("role", "Role"),
            l("label", "Label"),
            l("routing", "Routing"),
            c("large_demand", "Large demand"),
            c("pending_promotion", "Pending promotion"),
            c("exceeds_largest", "Exceeds largest"),
            s("oldest_unresolved_s", "Oldest unresolved", 0),
            c("refusals_total", "Refusals"),
            c("routed_total", "Routed"),
            c("promoted_total", "Promoted"),
            c("busy", "Busy (large)"),
            c("queued", "Queued (large)"),
            c("unfit", "Unfit (large)"),
            l("refusal", "Refusing because"),
          ],
          load: async (now) => {
            const st = await status.get(now);
            const rows = capacityRows(st);
            return {
              rows,
              note: rows.length
                ? undefined
                : "No capacity line in the last 10 minutes (a poller that predates the capacity line, or no poller).",
            };
          },
        },
        {
          id: "lock",
          title: "Single-writer lock",
          source:
            "pg_locks and pg_stat_activity: the advisory lock hashtext('polis-math-python:' || label) the poller holds (delphi/scripts/math_poller.py), and the holder's application_name (math-python:<label>@<host>)",
          ttl_s: TTL_S,
          shape: "table",
          columns: [
            l("label", "Label"),
            l("held", "Lock"),
            l("holder", "Holder"),
          ],
          load: () =>
            guardedRead((q) =>
              readLock(q, lockLabels(label, MATH_LABEL, `${MATH_LABEL}-large`))
            ),
        },
        {
          id: "publications",
          title: "Publications per minute, last hour",
          source: streamSource(
            "delphi",
            '"Wrote math results for zid=" lines (delphi/polismath/poller/math_writer.py) per UTC minute; the zid is not read'
          ),
          ttl_s: TTL_S,
          shape: "series",
          needs: "logs",
          columns: [
            l("period", "Minute (UTC)"),
            { ...c("publications", "Publications"), chart: true },
          ],
          load: async (now) => {
            const read = await publications.get(now);
            const rows = publicationRows(read, now);
            if (rows.length) rows[rows.length - 1].partial = true;
            return { rows, note: truncatedNote(read) };
          },
        },
        {
          id: "events",
          title: "Memory pressure and failures",
          source: streamSource(
            "delphi",
            `lines containing ${ENGINE_EVENTS.map((e) => `"${e.phrase}"`).join(
              ", "
            )} in the last 24 hours, counted (delphi/polismath/poller admission.py, service.py, backfill.py)`
          ),
          ttl_s: LONG_TTL_S,
          shape: "table",
          needs: "logs",
          columns: eventColumns,
          load: async (now) => {
            const read = await engineEvents.get(now);
            return {
              rows: eventCountRows(read, now, ENGINE_EVENTS),
              note: truncatedNote(read),
            };
          },
        },
        {
          id: "alarms",
          title: "CloudWatch alarms",
          source:
            'CloudWatch DescribeAlarms, names starting "Polis-" (cdk/alarms.ts, cdk/db.ts, cdk/mathPollerAlarms.ts); state and since when, no reason text',
          ttl_s: TTL_S,
          shape: "table",
          needs: "aws",
          columns: [
            l("alarm", "Alarm"),
            l("state", "State"),
            { key: "since_ms", label: "Since", type: "time" },
          ],
          load: async () =>
            alarmRows(
              await withDeadline(async (sig) =>
                readAlarms((await aws()).cloudwatch, sig)
              )
            ),
        },
      ],
    },
    {
      id: "serving",
      group: "system",
      title: "Serving",
      summary:
        "Which math label this server serves, how recently it was published, whether live conversations' math is behind their newest vote, the server's math refusal lines, and load balancer traffic.",
      refresh_s: 30,
      panels: [
        {
          id: "label",
          title: "Served label",
          source:
            "this server process: MATH_ENV and the pca2 ETag form (src/routes/math.ts pca2EntityTag), host name, start time and Node version",
          ttl_s: TTL_S,
          shape: "stats",
          columns: [
            l("label", "Label"),
            l("etag", "ETag"),
            l("process", "Answered by"),
            { key: "started_ms", label: "Process started", type: "time" },
            l("node", "Node"),
          ],
          load: async () => [labelRow(o.mathEnv, o.startedMs)],
        },
        {
          id: "generation",
          title: "Publications under the served label",
          source:
            "math_ticks (math_env, modified): conversations with math under the label, how many were published in the last 5 minutes and hour, and the newest (a small table, read in one pass)",
          ttl_s: TTL_S,
          shape: "stats",
          columns: [
            l("label", "Label"),
            c("conversations", "Conversations with math"),
            c("last_5m", "Published, last 5 min"),
            c("last_1h", "Published, last hour"),
            { key: "newest_ms", label: "Newest publication", type: "time" },
          ],
          load: async (now) => [
            await guardedRead((q) => readTicks(q, label, now)),
          ],
        },
        {
          id: "freshness",
          title: "Freshness of live conversations",
          source:
            "votes (zid, created) in the last hour, index votes_created_idx, against math_main.last_vote_timestamp for the served label by its (zid, math_env) unique index; no math blob is read",
          ttl_s: TTL_S,
          shape: "stats",
          columns: [
            l("label", "Label"),
            c("live", "Conversations with a vote, last hour"),
            c("no_math", "Of those, without math"),
            c("behind_60s", "Math more than 60 s behind"),
            s("max_lag_s", "Largest lag", 0),
          ],
          load: async (now) => [
            await guardedRead((q) => readFreshness(q, label, now)),
          ],
        },
        {
          id: "refusals",
          title: "Math refusals and repairs",
          source: streamSource(
            "server",
            "JSON lines whose message is polis_math_bundle_refused (by reason), polis_err_math_malformed_* or polis_err_math_index_mapping_mismatch in the last 24 hours (src/utils/mathBundle.ts, src/utils/pca.ts), counted"
          ),
          ttl_s: LONG_TTL_S,
          shape: "table",
          needs: "logs",
          columns: eventColumns,
          load: async (now) => {
            const read = await servingEvents.get(now);
            return {
              rows: servingEventRows(read, now),
              note: truncatedNote(read),
            };
          },
        },
        {
          id: "requests",
          title: "Load balancer, last 6 hours",
          source:
            "CloudWatch AWS/ApplicationELB, 5-minute points: RequestCount, HTTPCode_Target_5XX_Count and HTTPCode_ELB_5XX_Count summed over the account's load balancers, TargetResponseTime p50 and p95 (the worst load balancer)",
          ttl_s: TTL_S,
          shape: "series",
          needs: "aws",
          columns: [
            l("period", "Time (UTC)"),
            { ...c("requests", "Requests"), chart: true },
            { ...c("target5xx", "Target 5xx"), chart: true },
            c("elb5xx", "Load balancer 5xx"),
            n("p50_ms", "Response time p50", "ms", 0),
            n("p95_ms", "Response time p95", "ms", 0, true),
          ],
          load: async (now) =>
            albRows(
              await withDeadline(async (sig) =>
                readAlb((await aws()).cloudwatch, now, sig)
              )
            ),
        },
      ],
    },
    {
      id: "boxes",
      group: "system",
      title: "Boxes and deploys",
      summary:
        "The stack's Auto Scaling groups and their instances, CPU, memory and disk per group over 6 hours, and the newest CodeDeploy deployments.",
      refresh_s: 60,
      panels: [
        {
          id: "fleet",
          title: "Auto Scaling groups",
          source:
            "Auto Scaling DescribeAutoScalingGroups, groups tagged aws:cloudformation:stack-name = CdkStack, named by their CDK id (cdk/autoscaling.ts); no group names, ARNs or instance ids",
          ttl_s: TTL_S,
          shape: "table",
          needs: "aws",
          columns: [
            l("group", "Group"),
            c("desired", "Desired"),
            c("min", "Min"),
            c("max", "Max"),
            c("in_service", "In service"),
            c("other_states", "Other states"),
            c("unhealthy", "Unhealthy"),
            l("types", "Instance types"),
            l("launch_template", "Launch template version"),
          ],
          load: async () =>
            groupRows(
              await withDeadline(async (sig) =>
                readGroups((await aws()).autoscaling, sig)
              )
            ),
        },
        {
          id: "load",
          title: "Load per group, last 6 hours",
          source:
            "CloudWatch ListMetrics and GetMetricData, 5-minute points: AWS/EC2 CPUUtilization by AutoScalingGroupName (average); CWAgent mem_used_percent and used_percent of / per instance (maximum), reduced to the group's maximum",
          ttl_s: TTL_S,
          shape: "table",
          needs: "aws",
          columns: [
            l("group", "Group"),
            n("cpu_now", "CPU now", "%"),
            n("cpu_max", "CPU max", "%"),
            n("mem_now", "Memory now", "%"),
            n("mem_max", "Memory max", "%"),
            n("disk_now", "Disk / now", "%"),
            c("reporting", "Instances reporting memory"),
          ],
          load: async (now) =>
            loadRows(
              await withDeadline(async (sig) =>
                readLoad((await aws()).cloudwatch, now, sig)
              )
            ),
        },
        {
          id: "deploys",
          title: "Newest deployments",
          source:
            "CodeDeploy ListDeployments and BatchGetDeployments, application PolisApplication, group PolisDeploymentGroup (cdk/codedeploy.ts), last 7 days, the newest by start time: status, times, creator (user, autoscaling, ...), revision type and file name, instance counts, error code only",
          ttl_s: TTL_S,
          shape: "table",
          needs: "aws",
          columns: [
            { key: "created_ms", label: "Started", type: "time" },
            l("status", "Status"),
            { key: "completed_ms", label: "Finished", type: "time" },
            l("creator", "Started by"),
            l("revision", "Revision"),
            c("succeeded", "Instances succeeded"),
            c("failed", "Instances failed"),
            l("error_code", "Error code"),
          ],
          load: async (now) =>
            deployRows(
              await withDeadline(async (sig) =>
                readDeploys((await aws()).codedeploy, now, sig)
              )
            ),
        },
      ],
    },
    {
      id: "cost",
      group: "system",
      title: "Cost",
      summary:
        "Daily AWS cost for this account by service over the last 30 days, and month to date against last month, from Cost Explorer. Read at most once per 12 hours per server process (one or two billed requests).",
      refresh_s: 60 * 60,
      panels: [
        {
          id: "daily",
          title: "Per day, last 30 days",
          source:
            "Cost Explorer GetCostAndUsage, DAILY, UnblendedCost grouped by SERVICE, filtered to this account (sts:GetCallerIdentity); at most one read per 12 hours per process, one or two requests ($0.01 each)",
          ttl_s: COST_TTL_MS / 1000,
          shape: "series",
          needs: "cost",
          columns: [
            l("period", "Day (UTC)"),
            usd("total", "Total", true),
            l("top_service", "Largest service"),
            usd("top_cost", "Its cost"),
          ],
          load: async (now) => {
            const read = await cost.get(now);
            const rows = dailyRows(read, now);
            rows.slice(-2).forEach((r) => (r.partial = true));
            return { rows, note: costNote(read) };
          },
        },
        {
          id: "services",
          title: "By service",
          source:
            "the same Cost Explorer answer: per service, month to date, last month and the last 30 days, the ten largest by the last 30 days",
          ttl_s: COST_TTL_MS / 1000,
          shape: "table",
          needs: "cost",
          columns: [
            l("service", "Service"),
            usd("month_to_date", "Month to date"),
            usd("last_month", "Last month"),
            usd("last_30_days", "Last 30 days"),
          ],
          load: async (now) => serviceRows(await cost.get(now), now),
        },
      ],
    },
  ];
}

/**
 * Drop the panels whose need is not met and say why in the page. Returns the
 * page and, when nothing is left, the sentence that replaces it.
 */
export function applyNeeds<
  P extends { summary: string; panels: { needs?: CloudNeed }[] }
>(page: P, o: CloudOptions): { page: P; notice: string | null } {
  const reasons = new Set<string>();
  const panels = page.panels.filter((p) => {
    const r = unmetReason(p.needs, o);
    if (r) reasons.add(r);
    return !r;
  });
  if (reasons.size === 0) return { page, notice: null };
  const why = Array.from(reasons).join("; ");
  if (panels.length === 0) {
    return {
      page: { ...page, panels },
      notice: `Nothing on this page can be read here: ${why}.`,
    };
  }
  return {
    page: {
      ...page,
      panels,
      summary: `${page.summary} Some panels are not shown: ${why}.`,
    },
    notice: null,
  };
}

/** The lazily built instance-role clients, or the ones a test passed. */
export function lazyClients(o: CloudOptions): () => Promise<OpsAwsClients> {
  let clients: Promise<OpsAwsClients> | null = o.aws
    ? Promise.resolve(o.aws)
    : null;
  return () => {
    if (!clients) {
      clients = makeOpsAwsClients(opsRegion(o.awsRegion));
      // A failed load (it should not happen) is retried on the next read.
      clients.catch(() => {
        clients = null;
      });
    }
    return clients;
  };
}
