// The CloudWatch half of page S1, "Database": the RDS instance's own metrics
// for the last 6 hours at 5-minute points. The instance is the one the
// server's DATABASE_URL points at: an RDS endpoint's first label is the DB
// instance identifier (<id>.<hash>.<region>.rds.amazonaws.com). A database
// that is not an RDS endpoint has no such metrics and the panel is not shown.

import { MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { clockLabel, readMetrics, Sender, Series } from "./awsReads";
import { OpsRow } from "./types";

export const RDS_PERIOD_S = 300;
export const RDS_WINDOW_MS = 6 * 60 * 60 * 1000;

const RDS_HOST =
  /^([a-z][a-z0-9-]{0,62})\.[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/;

/** The DB instance identifier of an RDS endpoint URL, or null. */
export function rdsInstanceId(
  databaseUrl: string | null | undefined
): string | null {
  if (!databaseUrl) return null;
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const m = RDS_HOST.exec(host);
  return m ? m[1] : null;
}

// id -> [metric, statistic, scale to the shown unit]
const METRICS: [string, string, string, number][] = [
  ["cpu", "CPUUtilization", "Average", 1],
  ["connections", "DatabaseConnections", "Maximum", 1],
  ["burst", "BurstBalance", "Minimum", 1],
  ["read_iops", "ReadIOPS", "Average", 1],
  ["write_iops", "WriteIOPS", "Average", 1],
  ["read_ms", "ReadLatency", "Average", 1000],
  ["write_ms", "WriteLatency", "Average", 1000],
  ["queue", "DiskQueueDepth", "Average", 1],
  ["free_mem_mb", "FreeableMemory", "Minimum", 1 / (1024 * 1024)],
  ["free_disk_gb", "FreeStorageSpace", "Minimum", 1 / (1024 * 1024 * 1024)],
];

export function rdsQueries(instanceId: string): MetricDataQuery[] {
  return METRICS.map(([id, name, stat]) => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "AWS/RDS",
        MetricName: name,
        Dimensions: [{ Name: "DBInstanceIdentifier", Value: instanceId }],
      },
      Period: RDS_PERIOD_S,
      Stat: stat,
    },
    ReturnData: true,
  }));
}

export function readRds(cloudwatch: Sender, instanceId: string, nowMs: number) {
  const end = Math.floor(nowMs / (RDS_PERIOD_S * 1000)) * RDS_PERIOD_S * 1000;
  return readMetrics(
    cloudwatch,
    rdsQueries(instanceId),
    end - RDS_WINDOW_MS,
    end
  );
}

/** Pure: one row per 5-minute point, oldest first. */
export function rdsRows(series: Map<string, Series>): OpsRow[] {
  const at = new Map<number, OpsRow>();
  for (const [id, , , scale] of METRICS) {
    const s = series.get(id);
    if (!s) continue;
    s.ts.forEach((t, i) => {
      const row = at.get(t) || { period: clockLabel(t) };
      row[id] = Math.round(s.values[i] * scale * 10) / 10;
      at.set(t, row);
    });
  }
  return Array.from(at.keys())
    .sort((a, b) => a - b)
    .map((t) => {
      const row = at.get(t) as OpsRow;
      const out: OpsRow = { period: row.period };
      for (const [id] of METRICS) out[id] = row[id] ?? null;
      return out;
    });
}
