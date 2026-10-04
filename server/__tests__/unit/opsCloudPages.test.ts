import { afterEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import fs from "fs";
import path from "path";
import request from "supertest";
import { createOpsRoutes, OpsRouteOptions } from "../../src/routes/ops";
import { PanelCache } from "../../src/ops/pages";
import { setOpsConnectForTests } from "../../src/ops/guardedRead";
import { OpsAwsClients, Sender } from "../../src/ops/awsReads";
import {
  albRows,
  FRESHNESS_SQL,
  readFreshness,
  servingKind,
} from "../../src/ops/serving";
import {
  constructId,
  deployRows,
  groupRows,
  loadQueries,
  loadRows,
  revisionLabel,
} from "../../src/ops/fleet";
import { costWindow, dailyRows, serviceRows } from "../../src/ops/cost";
import { rdsInstanceId, rdsRows } from "../../src/ops/rdsMetrics";

// Generated fixtures only: every AWS answer below is written here in the shape
// the SDK returns, with made-up names, ids and numbers. No AWS call is made and
// no production data is used.

const NS = "https://pol.is/";
const STAFF = {
  sub: "google-oauth2|100000000000000000001",
  [`${NS}connection_strategy`]: "google-oauth2",
  [`${NS}email`]: "staff.one@example.org",
  [`${NS}email_verified`]: true,
  [`${NS}hd`]: "example.org",
};

function fakeValidateJwt(req: any, _res: any, next: (err?: unknown) => void) {
  if (req.headers.authorization === "Bearer staff") {
    req.jwtPayload = STAFF;
    return next();
  }
  return next(new Error("invalid"));
}

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const LINES = fs
  .readFileSync(
    path.join(
      __dirname,
      "../../../delphi/tests/poller/fixtures/ops-poller-lines.txt"
    ),
    "utf8"
  )
  .trim()
  .split("\n");

type Handler = (input: any) => any;

/** A client whose send() answers by command class name from `handlers`. */
function fake(handlers: Record<string, Handler>): Sender & { send: jest.Mock } {
  return {
    send: jest.fn(async (command: any) => {
      const h = handlers[command.constructor.name];
      if (!h) throw new Error(`unexpected ${command.constructor.name}`);
      return h(command.input);
    }),
  } as any;
}

const denied = () => {
  throw Object.assign(
    new Error(
      "User: arn:aws:sts::000000000000:assumed-role/x is not authorized"
    ),
    {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    }
  );
};

function points(startMs: number, values: number[], stepMs = 300_000) {
  return {
    Timestamps: values.map((_, i) => new Date(startMs + i * stepMs)),
    Values: values,
  };
}

function recordedClients(
  over: Partial<Record<keyof OpsAwsClients, Sender>> = {}
): OpsAwsClients {
  const asgName = (id: string) => `CdkStack-${id}ASG1A2B3C4D-AbCdEf123456`;
  return {
    logs: fake({
      FilterLogEventsCommand: (input) => {
        if (input.logStreamNames[0] === "server") {
          return {
            events: [
              {
                timestamp: NOW - 1000,
                message: JSON.stringify({
                  level: "warn",
                  message: "polis_math_bundle_refused",
                  zid: 1,
                  reason: "tick_mismatch",
                  service: "server",
                }),
              },
              {
                timestamp: NOW - 5000,
                message: JSON.stringify({
                  level: "error",
                  message: "polis_err_math_malformed_repness",
                  zid: 2,
                  count: 3,
                }),
              },
            ],
          };
        }
        if (String(input.filterPattern).includes("Wrote math results")) {
          return {
            events: [
              {
                timestamp: NOW - 30_000,
                message:
                  "Wrote math results for zid=4 math_tick=8 (main+bidtopid+ptptstats)",
              },
            ],
          };
        }
        if (String(input.filterPattern).includes("memory admission")) {
          return {
            events: [
              {
                timestamp: NOW - 1000,
                message:
                  "LRU-evicting cold conversation zid=3 (cache cap=200, retained budget=1)",
              },
            ],
          };
        }
        // Status lines: the generated fixture, stamped just now.
        return {
          events: LINES.map((message) => ({ timestamp: NOW - 5000, message })),
        };
      },
    }),
    cloudwatch: fake({
      DescribeAlarmsCommand: () => ({
        MetricAlarms: [
          {
            AlarmName: "Polis-DB-HighCPUUtilization",
            StateValue: "OK",
            StateUpdatedTimestamp: new Date(NOW - 3600_000),
            StateReason: "Threshold Crossed: free text",
          },
        ],
        CompositeAlarms: [],
      }),
      ListMetricsCommand: (input) => {
        const g = asgName("AsgDelphiSmall");
        if (input.Namespace === "AWS/ApplicationELB") {
          // The stack's load balancer and another one (a probe box's).
          return {
            Metrics: [
              {
                Namespace: "AWS/ApplicationELB",
                MetricName: "RequestCount",
                Dimensions: [
                  { Name: "LoadBalancer", Value: "app/probe-alb/0123abcd" },
                ],
              },
              {
                Namespace: "AWS/ApplicationELB",
                MetricName: "RequestCount",
                Dimensions: [
                  {
                    Name: "LoadBalancer",
                    Value: "app/CdkSta-LbA1B2C-Xy12Ab34Cd56/0123456789abcdef",
                  },
                ],
              },
            ],
          };
        }
        if (input.Namespace === "AWS/EC2") {
          return {
            Metrics: [
              {
                Namespace: "AWS/EC2",
                MetricName: "CPUUtilization",
                Dimensions: [{ Name: "AutoScalingGroupName", Value: g }],
              },
            ],
          };
        }
        if (input.MetricName === "mem_used_percent") {
          return {
            Metrics: [
              {
                Namespace: "CWAgent",
                MetricName: "mem_used_percent",
                Dimensions: [
                  { Name: "AutoScalingGroupName", Value: g },
                  { Name: "ImageId", Value: "ami-0123" },
                  { Name: "InstanceId", Value: "i-0123" },
                  { Name: "InstanceType", Value: "r7i.2xlarge" },
                ],
              },
            ],
          };
        }
        return {
          Metrics: [
            {
              Namespace: "CWAgent",
              MetricName: "used_percent",
              Dimensions: [
                { Name: "AutoScalingGroupName", Value: g },
                { Name: "path", Value: "/" },
                { Name: "device", Value: "nvme0n1p1" },
                { Name: "fstype", Value: "xfs" },
                { Name: "InstanceId", Value: "i-0123" },
              ],
            },
          ],
        };
      },
      GetMetricDataCommand: (input) => ({
        MetricDataResults: input.MetricDataQueries.map((q: any) => ({
          Id: q.Id,
          ...points(
            NOW - 900_000,
            q.Id.startsWith("free_mem")
              ? [3 * 1024 ** 3, 2 * 1024 ** 3, 1024 ** 3]
              : [40, 55, 50]
          ),
        })),
      }),
    }),
    autoscaling: fake({
      DescribeAutoScalingGroupsCommand: (input) => {
        expect(input.Filters[0]).toEqual({
          Name: "tag:aws:cloudformation:stack-name",
          Values: ["CdkStack"],
        });
        return {
          AutoScalingGroups: [
            {
              AutoScalingGroupName: asgName("AsgDelphiSmall"),
              DesiredCapacity: 1,
              MinSize: 1,
              MaxSize: 2,
              Instances: [
                {
                  InstanceId: "i-0123",
                  InstanceType: "r7i.2xlarge",
                  LifecycleState: "InService",
                  HealthStatus: "Healthy",
                  LaunchTemplate: { Version: "14" },
                },
              ],
            },
            {
              AutoScalingGroupName: asgName("Asg"),
              DesiredCapacity: 2,
              MinSize: 2,
              MaxSize: 4,
              Instances: [
                {
                  InstanceId: "i-0a",
                  InstanceType: "t3.medium",
                  LifecycleState: "InService",
                  HealthStatus: "Healthy",
                  LaunchTemplate: { Version: "9" },
                },
                {
                  InstanceId: "i-0b",
                  InstanceType: "t3.medium",
                  LifecycleState: "Pending",
                  HealthStatus: "Unhealthy",
                  LaunchTemplate: { Version: "9" },
                },
              ],
            },
          ],
        };
      },
    }),
    codedeploy: fake({
      ListDeploymentsCommand: (input) => {
        expect(input).toMatchObject({
          applicationName: "PolisApplication",
          deploymentGroupName: "PolisDeploymentGroup",
        });
        return { deployments: ["d-AAAA", "d-BBBB"] };
      },
      BatchGetDeploymentsCommand: () => ({
        deploymentsInfo: [
          {
            deploymentId: "d-BBBB",
            status: "Failed",
            creator: "autoscaling",
            createTime: new Date(NOW - 7200_000),
            completeTime: new Date(NOW - 7000_000),
            errorInformation: {
              code: "HEALTH_CONSTRAINTS",
              message: "free text with arn:aws:...",
            },
            revision: {
              revisionType: "S3",
              s3Location: {
                bucket: "a-bucket",
                key: "deployments/deployment.zip",
              },
            },
            deploymentOverview: { Succeeded: 0, Failed: 1 },
          },
          {
            deploymentId: "d-AAAA",
            status: "Succeeded",
            creator: "user",
            createTime: new Date(NOW - 600_000),
            completeTime: new Date(NOW - 300_000),
            revision: {
              revisionType: "S3",
              s3Location: {
                bucket: "a-bucket",
                key: "deployments/deployment.zip",
              },
            },
            deploymentOverview: { Succeeded: 3, Failed: 0 },
          },
        ],
      }),
    }),
    costExplorer: fake({
      GetCostAndUsageCommand: (input) => {
        expect(input.Filter).toEqual({
          Dimensions: { Key: "LINKED_ACCOUNT", Values: ["000000000000"] },
        });
        return {
          ResultsByTime: [
            {
              TimePeriod: { Start: "2026-10-02", End: "2026-10-03" },
              Groups: [
                {
                  Keys: ["Amazon Relational Database Service"],
                  Metrics: { UnblendedCost: { Amount: "10.5", Unit: "USD" } },
                },
                {
                  Keys: ["Amazon Elastic Compute Cloud - Compute"],
                  Metrics: { UnblendedCost: { Amount: "20.25", Unit: "USD" } },
                },
              ],
            },
            {
              TimePeriod: { Start: "2026-09-15", End: "2026-09-16" },
              Groups: [
                {
                  Keys: ["Amazon Relational Database Service"],
                  Metrics: { UnblendedCost: { Amount: "11", Unit: "USD" } },
                },
              ],
            },
          ],
        };
      },
    }),
    sts: fake({
      GetCallerIdentityCommand: () => ({
        Account: "000000000000",
        Arn: "arn:aws:sts::000000000000:assumed-role/x/i-1",
      }),
    }),
    ...over,
  };
}

function dbClient() {
  return {
    on: jest.fn(),
    removeListener: jest.fn(),
    release: jest.fn(),
    query: jest.fn(async (q: string | { text: string }) => {
      const text = typeof q === "string" ? q : q.text;
      if (/FROM pg_locks|pg_locks l/.test(text)) {
        return {
          rows: [
            {
              label: "python",
              held: true,
              application_name: "math-python:python@ip-10-0-1-23",
            },
          ],
        };
      }
      if (/FROM math_ticks/.test(text)) {
        return {
          rows: [
            {
              conversations: "10",
              last_1h: "3",
              last_5m: "1",
              newest_ms: String(NOW - 60_000),
            },
          ],
        };
      }
      if (/WITH live AS/.test(text)) {
        return {
          rows: [
            { live: "4", no_math: "1", behind_60s: "1", max_lag_ms: "90500" },
          ],
        };
      }
      return { rows: [] };
    }),
  };
}

function appWith(over: Partial<OpsRouteOptions> = {}) {
  const ops = createOpsRoutes({
    enabled: true,
    emailDomains: "example.org",
    devMode: false,
    namespace: NS,
    audience: "users",
    issuer: "https://issuer.example.org/",
    validateJwt: fakeValidateJwt,
    cache: new PanelCache(() => NOW),
    dataSource: "aws",
    costExplorer: true,
    logGroupName: "CdkStack-LogGroupExample-abc",
    databaseUrl:
      "postgres://u:p@cdkstack-databaseb269d8bb-abcdef.c0ffee12.us-east-1.rds.amazonaws.com:5432/polis",
    mathEnv: "python",
    ...over,
  });
  const app = express();
  app.get("/api/v3/ops/whoami", ops.gate, ops.whoami);
  app.get("/api/v3/ops/page/:id", ops.gate, ops.page);
  return app;
}

async function page(app: express.Express, id: string) {
  const res = await request(app)
    .get(`/api/v3/ops/page/${id}`)
    .set("Authorization", "Bearer staff");
  expect(res.status).toBe(200);
  return res.body;
}

function panel(body: any, id: string) {
  const p = body.panels.find((x: any) => x.id === id);
  expect(p).toBeDefined();
  return p;
}

afterEach(() => setOpsConnectForTests(null));

describe("the registry", () => {
  test("whoami lists the four system pages next to the earlier ones", async () => {
    const res = await request(
      appWith({ pageOptions: { aws: recordedClients() } })
    )
      .get("/api/v3/ops/whoami")
      .set("Authorization", "Bearer staff");
    const ids = res.body.pages.map((p: any) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["db", "engine", "serving", "boxes", "cost"])
    );
    expect(
      res.body.pages
        .filter((p: any) =>
          ["engine", "serving", "boxes", "cost"].includes(p.id)
        )
        .every((p: any) => p.group === "system")
    ).toBe(true);
  });

  test("with OPS_DATA_SOURCE unset nothing is asked of AWS and each page says why", async () => {
    setOpsConnectForTests(async () => dbClient() as any);
    const aws = recordedClients();
    const app = appWith({ dataSource: "", pageOptions: { aws } });
    for (const id of ["boxes", "cost"]) {
      const body = await page(app, id);
      expect(body.panels).toEqual([]);
      expect(body.notice).toContain("OPS_DATA_SOURCE is not aws");
    }
    const engine = await page(app, "engine");
    expect(engine.panels.map((p: any) => p.id)).toEqual(["lock"]);
    expect(engine.summary).toContain(
      "Some panels are not shown: AWS reads are off"
    );
    const serving = await page(app, "serving");
    expect(serving.panels.map((p: any) => p.id)).toEqual([
      "label",
      "generation",
      "freshness",
    ]);
    const db = await page(app, "db");
    expect(db.panels.map((p: any) => p.id)).not.toContain("rds");
    for (const c of Object.values(aws))
      expect((c as any).send).not.toHaveBeenCalled();
  });

  test("OPS_COST_EXPLORER off leaves the cost page unread", async () => {
    const aws = recordedClients();
    const body = await page(
      appWith({ costExplorer: false, pageOptions: { aws } }),
      "cost"
    );
    expect(body.notice).toContain("OPS_COST_EXPLORER is not 1");
    expect((aws.costExplorer as any).send).not.toHaveBeenCalled();
    expect((aws.sts as any).send).not.toHaveBeenCalled();
  });

  test("no log group (the compose default) leaves the log panels out", async () => {
    setOpsConnectForTests(async () => dbClient() as any);
    const body = await page(
      appWith({
        logGroupName: "docker",
        pageOptions: { aws: recordedClients() },
      }),
      "engine"
    );
    expect(body.panels.map((p: any) => p.id)).toEqual(["lock", "alarms"]);
    expect(body.summary).toContain("AWS_LOG_GROUP_NAME");
  });
});

describe("pages from recorded answers", () => {
  test("engine", async () => {
    setOpsConnectForTests(async () => dbClient() as any);
    const body = await page(
      appWith({ pageOptions: { aws: recordedClients() } }),
      "engine"
    );
    for (const p of body.panels)
      expect({ id: p.id, status: p.status }).toEqual({
        id: p.id,
        status: "ok",
      });
    expect(panel(body, "poller").rows[0]).toMatchObject({
      primaries: 1,
      standbys: 1,
    });
    expect(panel(body, "queue").rows[0]).toMatchObject({ budget_mb: 4000 });
    expect(panel(body, "capacity").rows.map((r: any) => r.class)).toEqual([
      "small",
      "large",
    ]);
    expect(panel(body, "lock").rows[0]).toEqual({
      label: "python",
      held: "held",
      holder: "math-python:python@ip-10-0-1-23",
    });
    expect(panel(body, "publications").rows).toHaveLength(60);
    expect(
      panel(body, "events").rows.find((r: any) => r.event.startsWith("Cold"))
        .last_1h
    ).toBe(1);
    expect(panel(body, "alarms").rows).toEqual([
      {
        alarm: "Polis-DB-HighCPUUtilization",
        state: "OK",
        since_ms: NOW - 3600_000,
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /free text|arn:aws|i-0123456789abcdef0/
    );
  });

  test("serving", async () => {
    setOpsConnectForTests(async () => dbClient() as any);
    const aws = recordedClients();
    const body = await page(appWith({ pageOptions: { aws } }), "serving");
    for (const p of body.panels) expect(p.status).toBe("ok");
    expect(panel(body, "label").rows[0]).toMatchObject({
      label: "python",
      etag: '"python-<math_tick>"',
    });
    expect(panel(body, "generation").rows[0]).toMatchObject({
      conversations: 10,
      last_5m: 1,
    });
    expect(panel(body, "freshness").rows[0]).toEqual({
      label: "python",
      live: 4,
      no_math: 1,
      behind_60s: 1,
      max_lag_s: 90.5,
    });
    const refusals = panel(body, "refusals").rows;
    expect(
      refusals.find((r: any) => r.event.includes("generation differs")).last_1h
    ).toBe(1);
    expect(
      refusals.find((r: any) => r.event.includes("repness")).last_24h
    ).toBe(1);
    expect(
      refusals.find((r: any) => r.event.includes("bidtopid"))
    ).toBeDefined();
    expect(refusals.every((r: any) => r.coverage === "complete")).toBe(true);
    expect(panel(body, "requests").rows.length).toBeGreaterThan(0);
    // Only the stack's load balancer is read, never the probe box's.
    const metricCalls = (aws.cloudwatch as any).send.mock.calls
      .map((c: any) => c[0])
      .filter((c: any) => c.constructor.name === "GetMetricDataCommand");
    const lbs = new Set(
      metricCalls.flatMap((c: any) =>
        c.input.MetricDataQueries.map(
          (q: any) => q.MetricStat.Metric.Dimensions[0].Value
        )
      )
    );
    expect([...lbs]).toEqual([
      "app/CdkSta-LbA1B2C-Xy12Ab34Cd56/0123456789abcdef",
    ]);
  });

  test("boxes", async () => {
    const body = await page(
      appWith({ pageOptions: { aws: recordedClients() } }),
      "boxes"
    );
    for (const p of body.panels) expect(p.status).toBe("ok");
    expect(panel(body, "fleet").rows).toEqual([
      {
        group: "web",
        desired: 2,
        min: 2,
        max: 4,
        in_service: 1,
        other_states: 1,
        unhealthy: 1,
        types: "t3.medium ×2",
        launch_template: "9",
      },
      {
        group: "delphi small",
        desired: 1,
        min: 1,
        max: 2,
        in_service: 1,
        other_states: 0,
        unhealthy: 0,
        types: "r7i.2xlarge",
        launch_template: "14",
      },
    ]);
    expect(panel(body, "load").rows).toEqual([
      {
        group: "delphi small",
        cpu_now: 50,
        cpu_max: 55,
        mem_now: 50,
        mem_max: 55,
        disk_now: 50,
        reporting: 1,
      },
    ]);
    const deploys = panel(body, "deploys").rows;
    expect(deploys[0]).toMatchObject({
      status: "Succeeded",
      creator: "user",
      revision: "S3 deployment.zip",
      succeeded: 3,
    });
    expect(deploys[1]).toMatchObject({
      status: "Failed",
      creator: "autoscaling",
      error_code: "HEALTH_CONSTRAINTS",
    });
    expect(JSON.stringify(body)).not.toMatch(
      /CdkStack-Asg|i-0a|a-bucket|free text/
    );
  });

  test("cost", async () => {
    const body = await page(
      appWith({ pageOptions: { aws: recordedClients() } }),
      "cost"
    );
    for (const p of body.panels) expect(p.status).toBe("ok");
    const daily = panel(body, "daily");
    expect(daily.rows).toHaveLength(30);
    expect(
      daily.rows.find((r: any) => r.period === "2026-10-02")
    ).toMatchObject({
      total: 30.75,
      top_service: "Amazon Elastic Compute Cloud - Compute",
      top_cost: 20.25,
    });
    expect(daily.note).toContain("this account only");
    const services = panel(body, "services").rows;
    expect(services[services.length - 1]).toEqual({
      service: "Total",
      month_to_date: 30.75,
      last_month: 11,
      last_30_days: 41.75,
    });
  });

  test("db gains the RDS panel, read for the instance DATABASE_URL names", async () => {
    setOpsConnectForTests(async () => dbClient() as any);
    const aws = recordedClients();
    const body = await page(appWith({ pageOptions: { aws } }), "db");
    const rds = panel(body, "rds");
    expect(rds.status).toBe("ok");
    expect(rds.rows[rds.rows.length - 1]).toMatchObject({
      cpu: 50,
      free_mem_mb: 1024,
    });
    const call = (aws.cloudwatch as any).send.mock.calls[0][0].input;
    expect(call.MetricDataQueries[0].MetricStat.Metric.Dimensions).toEqual([
      {
        Name: "DBInstanceIdentifier",
        Value: "cdkstack-databaseb269d8bb-abcdef",
      },
    ]);
  });
});

describe("a read the instance role may not make", () => {
  test("shows not_permitted on that panel only; the page still answers", async () => {
    setOpsConnectForTests(async () => dbClient() as any);
    const cloudwatch = fake({
      DescribeAlarmsCommand: denied,
      GetMetricDataCommand: denied,
      ListMetricsCommand: denied,
    });
    const app = appWith({
      pageOptions: { aws: recordedClients({ cloudwatch }) },
    });
    const engine = await page(app, "engine");
    expect(panel(engine, "alarms")).toMatchObject({
      status: "unavailable",
      reason: "not_permitted",
      rows: [],
    });
    expect(panel(engine, "poller").status).toBe("ok");
    expect(panel(engine, "lock").status).toBe("ok");
    const boxes = await page(app, "boxes");
    expect(panel(boxes, "load").reason).toBe("not_permitted");
    expect(panel(boxes, "fleet").status).toBe("ok");
    expect(JSON.stringify([engine, boxes])).not.toMatch(
      /not authorized|arn:aws/
    );
  });

  test.each(["autoscaling", "codedeploy", "costExplorer", "logs"] as const)(
    "%s denied -> not_permitted",
    async (which) => {
      setOpsConnectForTests(async () => dbClient() as any);
      const handlers: Record<string, Handler> = {
        DescribeAutoScalingGroupsCommand: denied,
        ListDeploymentsCommand: denied,
        GetCostAndUsageCommand: denied,
        FilterLogEventsCommand: denied,
      };
      const app = appWith({
        pageOptions: { aws: recordedClients({ [which]: fake(handlers) }) },
      });
      const pageId = {
        autoscaling: "boxes",
        codedeploy: "boxes",
        costExplorer: "cost",
        logs: "engine",
      }[which];
      const panelId = {
        autoscaling: "fleet",
        codedeploy: "deploys",
        costExplorer: "daily",
        logs: "poller",
      }[which];
      expect(panel(await page(app, pageId), panelId)).toMatchObject({
        status: "unavailable",
        reason: "not_permitted",
      });
    }
  );

  test("Cost Explorer is asked at most once per 12 hours, failures included", async () => {
    let now = NOW;
    const ce = fake({ GetCostAndUsageCommand: denied });
    const aws = recordedClients({ costExplorer: ce });
    const app = appWith({
      cache: new PanelCache(() => now),
      pageOptions: { aws },
    });
    // The panel cache retries a failure after 60 s; the shared read does not.
    jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await page(app, "cost");
      now += 61_000;
      await page(app, "cost");
      now += 6 * 60 * 60_000;
      await page(app, "cost");
      expect(ce.send).toHaveBeenCalledTimes(1);
      now = NOW + 12 * 60 * 60_000 + 1000;
      await page(app, "cost");
      expect(ce.send).toHaveBeenCalledTimes(2);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe("shaping", () => {
  test("constructId reads the CDK id from the generated name or the logical-id tag", () => {
    expect(
      constructId("CdkStack-AsgDelphiLargeASG0F1E2D3C-Xy", undefined)
    ).toBe("AsgDelphiLarge");
    expect(constructId(undefined, "AsgASG12345678")).toBe("Asg");
    expect(constructId("CdkStack-SomethingElse-Xy", undefined)).toBeNull();
    expect(
      groupRows([
        { AutoScalingGroupName: "probe-group", Instances: [] } as any,
      ])[0].group
    ).toBe("other");
  });

  test("loadQueries never exceeds 500 queries", () => {
    const m = {
      Namespace: "CWAgent",
      MetricName: "mem_used_percent",
      Dimensions: [{ Name: "AutoScalingGroupName", Value: "g" }],
    };
    const { queries } = loadQueries({
      cpu: [],
      mem: Array(600).fill(m),
      disk: [],
    });
    expect(queries).toHaveLength(500);
    expect(loadRows({ tags: [], series: new Map() })).toEqual([]);
  });

  test("revision labels never carry a bucket or an odd key", () => {
    expect(
      revisionLabel({
        revision: {
          revisionType: "S3",
          s3Location: { bucket: "b", key: "x/y z;.zip" },
        },
      } as any)
    ).toBe("S3");
    expect(
      revisionLabel({
        revision: {
          revisionType: "GitHub",
          gitHubLocation: { commitId: "0123456789abcdef0123" },
        },
      } as any)
    ).toBe("commit 0123456789ab");
    expect(deployRows([{ createTime: undefined } as any])).toEqual([]);
  });

  test("servingKind reads only message and reason", () => {
    expect(
      servingKind(
        '{"message":"polis_math_bundle_refused","reason":"missing_companion"}'
      )
    ).toBe("bundle_missing_companion");
    expect(
      servingKind(
        '{"message":"polis_math_bundle_refused","reason":"new_reason"}'
      )
    ).toBe("bundle_other");
    expect(servingKind("not json polis_math_bundle_refused")).toBeNull();
  });

  test("freshness binds the hour and the label, and clamps a negative lag", async () => {
    const q: any = async (text: string, values: unknown[]) => {
      expect(text).toBe(FRESHNESS_SQL);
      expect(values).toEqual([NOW - 3600_000, "python"]);
      return [{ live: "1", no_math: "0", behind_60s: "0", max_lag_ms: "-500" }];
    };
    expect((await readFreshness(q, "python", NOW)).max_lag_s).toBe(0);
  });

  test("ALB and RDS rows are one per point, oldest first", () => {
    const s = (vals: number[]) => ({
      ts: vals.map((_, i) => NOW + i * 300_000),
      values: vals,
    });
    const alb = albRows(
      new Map([
        ["requests", s([10, 20])],
        ["p95", s([0.25, 0.5])],
      ])
    );
    expect(alb).toEqual([
      {
        period: "12:00",
        requests: 10,
        target5xx: 0,
        elb5xx: 0,
        p50_ms: null,
        p95_ms: 250,
      },
      {
        period: "12:05",
        requests: 20,
        target5xx: 0,
        elb5xx: 0,
        p50_ms: null,
        p95_ms: 500,
      },
    ]);
    const rds = rdsRows(
      new Map([
        ["cpu", s([12.34])],
        ["read_ms", s([0.0021])],
      ])
    );
    expect(rds[0]).toMatchObject({
      period: "12:00",
      cpu: 12.3,
      read_ms: 2.1,
      burst: null,
    });
  });

  test("rdsInstanceId accepts only an RDS endpoint", () => {
    expect(
      rdsInstanceId("postgres://u:p@mydb.abc123.us-east-1.rds.amazonaws.com/x")
    ).toBe("mydb");
    expect(rdsInstanceId("postgres://u:p@localhost:5432/polis")).toBeNull();
    expect(rdsInstanceId("not a url")).toBeNull();
    expect(rdsInstanceId(undefined)).toBeNull();
  });

  test("the cost window covers last month and the last 30 days", () => {
    expect(costWindow(Date.UTC(2026, 9, 3, 12))).toEqual({
      start: "2026-09-01",
      end: "2026-10-04",
    });
    expect(costWindow(Date.UTC(2026, 2, 31))).toEqual({
      start: "2026-02-01",
      end: "2026-04-01",
    });
    expect(costWindow(Date.UTC(2026, 0, 5))).toEqual({
      start: "2025-12-01",
      end: "2026-01-06",
    });
  });

  test("services past the tenth fold into Other, then a total", () => {
    const day = new Map<string, number>();
    for (let i = 0; i < 12; i++)
      day.set(`Service ${String(i).padStart(2, "0")}`, 12 - i);
    const read = {
      days: new Map([["2026-10-01", day]]),
      truncated: false,
      start: "",
      end: "",
    };
    const rows = serviceRows(read, Date.UTC(2026, 9, 3));
    expect(rows).toHaveLength(12);
    expect(rows[10]).toEqual({
      service: "Other (2 services)",
      month_to_date: 3,
      last_month: 0,
      last_30_days: 3,
    });
    expect(rows[11].service).toBe("Total");
    expect(dailyRows(read, Date.UTC(2026, 9, 3))[29]).toMatchObject({
      period: "2026-10-03",
      total: null,
    });
  });
});
