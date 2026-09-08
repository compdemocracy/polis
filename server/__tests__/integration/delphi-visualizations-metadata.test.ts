/**
 * P-003 S4 — the visualizations route's job metadata, at the real boundary.
 *
 * Round 7 shipped two defects that every unit test and probe passed straight
 * over, because their fake stores return whole rows and ignore
 * `ProjectionExpression`: the successful conversation sweep returned no rows
 * map at all (so the handler threw and the metadata came back empty), and the
 * projection omitted the very attributes the new behaviour reads. Both are
 * invisible except against DynamoDB, which actually applies a projection.
 *
 * These run the real handler against DynamoDB Local and MinIO.
 */
import { Request, Response } from "express";
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";
import {
  docClient,
  ensureJobGuardTableExists,
  ensureJobQueueTableExists,
} from "../setup/dynamodb-test-helpers";
import pgQuery from "../../src/db/pg-query";
import { handle_GET_delphi_visualizations } from "../../src/routes/delphi/visualizations";
import { JOB_QUEUE_TABLE } from "../../src/routes/delphi/jobGuard";

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    return res;
  };
  return res;
}

async function getVisualizations(reportId: string) {
  const res = makeRes();
  await handle_GET_delphi_visualizations(
    { query: { report_id: reportId } } as unknown as Request,
    res as unknown as Response
  );
  return res;
}

describe("Delphi visualizations job metadata", () => {
  let zid: string;
  let reportId: string;
  const written: string[] = [];

  beforeAll(async () => {
    await ensureJobQueueTableExists();
    await ensureJobGuardTableExists();

    const setup = await setupAuthAndConvo({ createConvo: true });
    const { agent } = await getJwtAuthenticatedAgent(setup.testUser);
    const rows = (await pgQuery.queryP(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [setup.conversationId]
    )) as { zid: number }[];
    zid = rows[0].zid.toString();

    await agent
      .post("/api/v3/reports")
      .send({ conversation_id: setup.conversationId });
    const listed = await agent
      .get(`/api/v3/reports?conversation_id=${setup.conversationId}`)
      .send();
    reportId = JSON.parse(listed.text)[0].report_id;
  });

  async function putJob(item: Record<string, unknown>) {
    written.push(String(item.job_id));
    await docClient.send(
      new PutCommand({
        TableName: JOB_QUEUE_TABLE,
        Item: {
          conversation_id: zid,
          report_id: reportId,
          job_type: "FULL_PIPELINE",
          created_at: new Date().toISOString(),
          // The attributes a projection could silently drop.
          job_config: JSON.stringify({ include_moderation: false }),
          job_results: "{}",
          ...item,
        },
      })
    );
  }

  afterEach(async () => {
    for (const jobId of written.splice(0)) {
      await docClient.send(
        new DeleteCommand({
          TableName: JOB_QUEUE_TABLE,
          Key: { job_id: jobId },
        })
      );
    }
  });

  it("returns job metadata for a conversation with rows", async () => {
    // The regression: a successful sweep returned no rows map, the handler
    // threw while building metadata, and the catch swallowed it into an empty
    // job list — with every liveness assertion still passing.
    await putJob({ job_id: `viz-pending-${Date.now()}`, status: "PENDING" });

    const res = await getVisualizations(reportId);

    expect(res.body.status).toBe("success");
    expect(res.body.jobs.length).toBeGreaterThan(0);
    expect(res.body.jobs[0].workLive).toBe(true);
  });

  it("reports a completed conversation as not live", async () => {
    await putJob({
      job_id: `viz-done-${Date.now()}`,
      status: "COMPLETED",
      process_exit_confirmed: true,
      completed_at: new Date().toISOString(),
    });

    const res = await getVisualizations(reportId);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].workLive).toBe(false);
  });

  it("carries the successor of a withdrawn job through the projection", async () => {
    // superseded_by has to survive the Scan's ProjectionExpression, or the
    // client can never follow it.
    const winnerId = `viz-winner-${Date.now()}`;
    const withdrawnId = `viz-withdrawn-${Date.now()}`;
    await putJob({ job_id: winnerId, status: "PROCESSING" });
    await putJob({
      job_id: withdrawnId,
      status: "FAILED",
      superseded_by: winnerId,
      withdrawn_reason: "superseded_by_unguarded_producer",
      process_exit_confirmed: true,
      completed_at: new Date().toISOString(),
    });

    const res = await getVisualizations(reportId);
    const withdrawn = res.body.jobs.find(
      (job: any) => job.jobId === withdrawnId
    );
    expect(withdrawn).toBeDefined();
    expect(withdrawn.supersededBy).toBe(winnerId);
    // And the winner is reachable in the same response, so the client can
    // actually hand over.
    expect(res.body.jobs.some((job: any) => job.jobId === winnerId)).toBe(true);
  });

  it("keeps the timestamps a terminal row is pruned by", async () => {
    const completedAt = new Date(Date.now() - 86_400_000).toISOString();
    const jobId = `viz-old-${Date.now()}`;
    await putJob({
      job_id: jobId,
      status: "COMPLETED",
      process_exit_confirmed: true,
      completed_at: completedAt,
    });

    const res = await getVisualizations(reportId);
    const job = res.body.jobs.find((entry: any) => entry.jobId === jobId);
    expect(job.completedAt).toBe(completedAt);
  });

  it("does not leak the payload or the output through the projection", async () => {
    await putJob({ job_id: `viz-lean-${Date.now()}`, status: "PENDING" });

    const res = await getVisualizations(reportId);
    const job = res.body.jobs[0];
    expect(job.job_config).toBeUndefined();
    expect(job.logs).toBeUndefined();
  });

  it("still answers when the index has no rows for the report", async () => {
    const res = await getVisualizations(reportId);
    expect(res.body.status).toBe("success");
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it("cheaply prunes a long history of old terminal roots", async () => {
    // Without completed_at in the projection every one of these looks undated,
    // becomes an adoption candidate, and the 25-candidate budget fails the
    // scope closed.
    const { admitDelphiJob } = await import("../../src/routes/delphi/jobGuard");
    for (let index = 0; index < 32; index++) {
      await putJob({
        job_id: `viz-history-${index}-${Date.now()}`,
        status: "COMPLETED",
        process_exit_confirmed: true,
        completed_at: new Date(
          Date.now() - 86_400_000 * (index + 1)
        ).toISOString(),
      });
    }

    const jobId = `viz-new-${Date.now()}`;
    written.push(jobId);
    const admission = await admitDelphiJob({
      scope: {
        conversationId: zid,
        reportId,
        jobType: "FULL_PIPELINE",
        jobConfig: JSON.stringify({ include_moderation: false }),
      },
      jobItem: {
        job_id: jobId,
        status: "PENDING",
        worker_id: "none",
        conversation_id: zid,
        report_id: reportId,
        job_type: "FULL_PIPELINE",
        job_config: JSON.stringify({ include_moderation: false }),
        created_at: new Date().toISOString(),
      },
    });

    expect(admission.outcome).toBe("created");

    // Clean the guard this created.
    const { scopeGuardKey, JOB_GUARD_TABLE } = await import(
      "../../src/routes/delphi/jobGuard"
    );
    await docClient.send(
      new DeleteCommand({
        TableName: JOB_GUARD_TABLE,
        Key: {
          guard_key: scopeGuardKey({
            conversationId: zid,
            reportId,
            jobType: "FULL_PIPELINE",
            jobConfig: "",
          }),
        },
      })
    );
  });

  it("leaves no stray rows behind", async () => {
    const result = await docClient.send(
      new QueryCommand({
        TableName: JOB_QUEUE_TABLE,
        IndexName: "ConversationIndex",
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: { ":cid": zid },
      })
    );
    expect(result.Items || []).toHaveLength(0);
  });
});
