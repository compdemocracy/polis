// Page S4, "Boxes and deploys": the stack's Auto Scaling groups, how loaded
// their instances are, and the newest CodeDeploy deployments.
//
//   - DescribeAutoScalingGroups, filtered to the stack's groups by the
//     aws:cloudformation:stack-name tag; each group is labelled by its CDK id
//     (cdk/autoscaling.ts), so no group name, ARN or instance id is shown;
//   - CPU (AWS/EC2 CPUUtilization by AutoScalingGroupName) and the CloudWatch
//     agent's mem_used_percent and disk used_percent (CWAgent, dimensions
//     AutoScalingGroupName, ImageId, InstanceId, InstanceType, plus device,
//     fstype and path for disk: cdk/config/amazon-cloudwatch-agent.json). The
//     agent metrics carry the full dimension set, so they are found with
//     ListMetrics and read per instance, then reduced to the group's maximum;
//   - ListDeployments and BatchGetDeployments for PolisApplication /
//     PolisDeploymentGroup (cdk/codedeploy.ts): status, times, creator, the
//     revision's type and file name, instance counts and the error code (never
//     the error message).

import {
  AutoScalingGroup,
  DescribeAutoScalingGroupsCommand,
} from "@aws-sdk/client-auto-scaling";
import { Metric, MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import {
  BatchGetDeploymentsCommand,
  DeploymentInfo,
  ListDeploymentsCommand,
} from "@aws-sdk/client-codedeploy";
import {
  awsSend,
  dimension,
  lastValue,
  listMetrics,
  maxValue,
  readMetrics,
  Sender,
  Series,
} from "./awsReads";
import { OpsRow } from "./types";

export const STACK_NAME = "CdkStack";
export const CODEDEPLOY_APPLICATION = "PolisApplication";
export const CODEDEPLOY_GROUP = "PolisDeploymentGroup";
export const LOAD_WINDOW_MS = 6 * 60 * 60 * 1000;
export const LOAD_PERIOD_S = 300;
export const DEPLOY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const DEPLOYS_SHOWN = 8;

// cdk/autoscaling.ts construct ids -> what the group is for.
export const GROUP_ROLES: Record<string, string> = {
  Asg: "web",
  AsgMathWorker: "math worker (retired engine)",
  AsgDelphiSmall: "delphi small",
  AsgDelphiLarge: "delphi large",
  AsgOllama: "ollama",
};
const ROLE_ORDER = Object.keys(GROUP_ROLES);

/**
 * The CDK construct id of a group, from its logical-id tag or its generated
 * name ("CdkStack-AsgDelphiSmallASG1A2B3C4D-…"), or null.
 */
export function constructId(
  name: string | undefined,
  logicalId: string | undefined
): string | null {
  for (const v of [logicalId, name]) {
    if (!v) continue;
    const m = /(?:^|-)(Asg[A-Za-z]*?)ASG[0-9A-F]{8}(?:$|-)/.exec(v);
    if (m && m[1] in GROUP_ROLES) return m[1];
  }
  return null;
}

export function roleOf(name: string | undefined, logicalId?: string): string {
  const id = constructId(name, logicalId);
  return id ? GROUP_ROLES[id] : "other";
}

function roleRank(role: string): number {
  const i = ROLE_ORDER.findIndex((k) => GROUP_ROLES[k] === role);
  return i === -1 ? ROLE_ORDER.length : i;
}

export async function readGroups(
  autoscaling: Sender
): Promise<AutoScalingGroup[]> {
  const out: AutoScalingGroup[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const page = await awsSend(
      autoscaling,
      new DescribeAutoScalingGroupsCommand({
        Filters: [
          { Name: "tag:aws:cloudformation:stack-name", Values: [STACK_NAME] },
        ],
        MaxRecords: 100,
        NextToken: nextToken,
      })
    );
    out.push(...(page?.AutoScalingGroups || []));
    nextToken = page?.NextToken || undefined;
    pages += 1;
  } while (nextToken && pages < 3);
  return out;
}

function tag(g: AutoScalingGroup, key: string): string | undefined {
  return g.Tags?.find((t) => t.Key === key)?.Value;
}

const TYPE = /^[a-z0-9-]+\.[a-z0-9]+$/;

/** Pure: one row per group, in CDK order; aggregates only. */
export function groupRows(groups: AutoScalingGroup[]): OpsRow[] {
  return groups
    .map((g) => {
      const instances = g.Instances || [];
      const types = new Map<string, number>();
      for (const i of instances) {
        const t =
          i.InstanceType && TYPE.test(i.InstanceType)
            ? i.InstanceType
            : "other";
        types.set(t, (types.get(t) || 0) + 1);
      }
      const versions = new Set(
        instances
          .map((i) => i.LaunchTemplate?.Version)
          .filter(
            (v): v is string => typeof v === "string" && /^\d{1,6}$/.test(v)
          )
      );
      return {
        group: roleOf(
          g.AutoScalingGroupName,
          tag(g, "aws:cloudformation:logical-id")
        ),
        desired: g.DesiredCapacity ?? null,
        min: g.MinSize ?? null,
        max: g.MaxSize ?? null,
        in_service: instances.filter((i) => i.LifecycleState === "InService")
          .length,
        other_states: instances.filter((i) => i.LifecycleState !== "InService")
          .length,
        unhealthy: instances.filter(
          (i) => i.HealthStatus && i.HealthStatus !== "Healthy"
        ).length,
        types: Array.from(types.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t))
          .join(", "),
        launch_template: Array.from(versions).sort().join(", ") || null,
      };
    })
    .sort(
      (a, b) =>
        roleRank(a.group) - roleRank(b.group) || a.group.localeCompare(b.group)
    );
}

// ---------------------------------------------------------------------------
// Per-box load
// ---------------------------------------------------------------------------

export type LoadInputs = {
  cpu: Metric[];
  mem: Metric[];
  disk: Metric[];
};

export async function listLoadMetrics(cloudwatch: Sender): Promise<LoadInputs> {
  const [cpu, mem, disk] = await Promise.all([
    listMetrics(cloudwatch, {
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      dimensionNames: ["AutoScalingGroupName"],
    }),
    listMetrics(cloudwatch, {
      namespace: "CWAgent",
      metricName: "mem_used_percent",
    }),
    listMetrics(cloudwatch, {
      namespace: "CWAgent",
      metricName: "used_percent",
    }),
  ]);
  return {
    // Only the per-group aggregate (the one-dimension form).
    cpu: cpu.filter((m) => m.Dimensions?.length === 1),
    mem,
    // The root file system only, as the agent is configured.
    disk: disk.filter((m) => dimension(m, "path") === "/"),
  };
}

type Tagged = { id: string; kind: "cpu" | "mem" | "disk"; group: string };

/** Pure: the queries for every listed metric (at most 500), and their tags. */
export function loadQueries(inputs: LoadInputs): {
  queries: MetricDataQuery[];
  tags: Tagged[];
} {
  const queries: MetricDataQuery[] = [];
  const tags: Tagged[] = [];
  const add = (kind: Tagged["kind"], m: Metric, stat: string) => {
    const group = dimension(m, "AutoScalingGroupName");
    if (!group || queries.length >= 500) return;
    const id = `${kind}${queries.length}`;
    queries.push({
      Id: id,
      MetricStat: { Metric: m, Period: LOAD_PERIOD_S, Stat: stat },
      ReturnData: true,
    });
    tags.push({ id, kind, group });
  };
  inputs.cpu.forEach((m) => add("cpu", m, "Average"));
  inputs.mem.forEach((m) => add("mem", m, "Maximum"));
  inputs.disk.forEach((m) => add("disk", m, "Maximum"));
  return { queries, tags };
}

export async function readLoad(cloudwatch: Sender, nowMs: number) {
  const inputs = await listLoadMetrics(cloudwatch);
  const { queries, tags } = loadQueries(inputs);
  const end = Math.floor(nowMs / (LOAD_PERIOD_S * 1000)) * LOAD_PERIOD_S * 1000;
  const series = await readMetrics(
    cloudwatch,
    queries,
    end - LOAD_WINDOW_MS,
    end
  );
  return { tags, series };
}

function maxOf(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
}

function pct(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

/** Pure: one row per group: newest and 6-hour maximum of each signal. */
export function loadRows(read: {
  tags: Tagged[];
  series: Map<string, Series>;
}): OpsRow[] {
  const byGroup = new Map<string, Tagged[]>();
  for (const t of read.tags) {
    const list = byGroup.get(t.group) || [];
    list.push(t);
    byGroup.set(t.group, list);
  }
  const rows: OpsRow[] = [];
  for (const [group, list] of byGroup) {
    const pick = (
      kind: Tagged["kind"],
      f: (s: Series | undefined) => number | null
    ) =>
      pct(
        maxOf(
          list
            .filter((t) => t.kind === kind)
            .map((t) => f(read.series.get(t.id)))
        )
      );
    const instances = new Set(
      list
        .filter(
          (t) =>
            t.kind === "mem" && (read.series.get(t.id)?.values.length || 0) > 0
        )
        .map((t) => t.id)
    ).size;
    rows.push({
      group: roleOf(group),
      cpu_now: pick("cpu", lastValue),
      cpu_max: pick("cpu", maxValue),
      mem_now: pick("mem", lastValue),
      mem_max: pick("mem", maxValue),
      disk_now: pick("disk", lastValue),
      reporting: instances,
    });
  }
  return rows.sort(
    (a, b) =>
      roleRank(String(a.group)) - roleRank(String(b.group)) ||
      String(a.group).localeCompare(String(b.group))
  );
}

// ---------------------------------------------------------------------------
// Deploys
// ---------------------------------------------------------------------------

export async function readDeploys(
  codedeploy: Sender,
  nowMs: number
): Promise<DeploymentInfo[]> {
  const list = await awsSend(
    codedeploy,
    new ListDeploymentsCommand({
      applicationName: CODEDEPLOY_APPLICATION,
      deploymentGroupName: CODEDEPLOY_GROUP,
      createTimeRange: { start: new Date(nowMs - DEPLOY_LOOKBACK_MS) },
    })
  );
  // ListDeployments answers newest first; the first 25 cover the rows shown.
  const ids: string[] = (list?.deployments || []).slice(0, 25);
  if (ids.length === 0) return [];
  const batch = await awsSend(
    codedeploy,
    new BatchGetDeploymentsCommand({ deploymentIds: ids })
  );
  return batch?.deploymentsInfo || [];
}

const FILE = /^[A-Za-z0-9._-]{1,80}$/;
const WORD = /^[A-Za-z_]{1,40}$/;

function ms(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Pure: what was deployed: the revision type and a short, safe name. */
export function revisionLabel(d: DeploymentInfo): string | null {
  const r = d.revision;
  if (!r) return null;
  if (r.revisionType === "GitHub" && r.gitHubLocation?.commitId) {
    const c = r.gitHubLocation.commitId;
    return /^[0-9a-f]{7,40}$/.test(c) ? `commit ${c.slice(0, 12)}` : "GitHub";
  }
  if (r.revisionType === "S3" && r.s3Location?.key) {
    const base = r.s3Location.key.split("/").pop() || "";
    return FILE.test(base) ? `S3 ${base}` : "S3";
  }
  return typeof r.revisionType === "string" && WORD.test(r.revisionType)
    ? r.revisionType
    : null;
}

/** Pure: the newest deployments, newest first. */
export function deployRows(infos: DeploymentInfo[]): OpsRow[] {
  return infos
    .map((d) => {
      const o = d.deploymentOverview || {};
      const word = (v: unknown) =>
        typeof v === "string" && WORD.test(v) ? v : null;
      return {
        created_ms: ms(d.createTime),
        status: word(d.status),
        completed_ms: d.completeTime ? ms(d.completeTime) : null,
        creator: word(d.creator),
        revision: revisionLabel(d),
        succeeded: o.Succeeded ?? null,
        failed: o.Failed ?? null,
        error_code: word(d.errorInformation?.code),
      };
    })
    .filter((r) => r.created_ms !== null)
    .sort((a, b) => (b.created_ms as number) - (a.created_ms as number))
    .slice(0, DEPLOYS_SHOWN);
}
