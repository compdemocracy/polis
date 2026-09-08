/**
 * P-003 S3 — server-side active-work deduplication for Delphi job submission.
 *
 * Before this guard, both HTTP producers minted a fresh id and did an
 * unconditional PutItem, so a user who reloaded and resubmitted during a long
 * PENDING paid for two Anthropic batch runs. These cases exercise the guard
 * against real DynamoDB Local: repeat and concurrent submissions collapse onto
 * one job, a durably terminal job stops blocking, and a terminal parent with a
 * live checker descendant still does.
 */
import { Request, Response } from "express";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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
import { handle_POST_delphi_jobs } from "../../src/routes/delphi/jobs";
import { handle_POST_delphi_batch_reports } from "../../src/routes/delphi/batchReports";
import {
  idempotencyGuardKey,
  JOB_GUARD_TABLE,
  JOB_QUEUE_TABLE,
  scopeGuardKey,
} from "../../src/routes/delphi/jobGuard";

interface CapturedResponse {
  statusCode: number;
  body: any;
}

function makeRes(): Response & CapturedResponse {
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

describe("Delphi job submission deduplication", () => {
  let zid: string;
  let reportId: string;
  const guardKeys = new Set<string>();

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

  async function listJobs(): Promise<any[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: JOB_QUEUE_TABLE,
        IndexName: "ConversationIndex",
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: { ":cid": zid },
      })
    );
    return result.Items || [];
  }

  async function readGuard(guardKey: string): Promise<any> {
    const result = await docClient.send(
      new GetCommand({
        TableName: JOB_GUARD_TABLE,
        Key: { guard_key: guardKey },
        ConsistentRead: true,
      })
    );
    return result.Item;
  }

  async function setStatus(jobId: string, status: string): Promise<void> {
    await docClient.send(
      new UpdateCommand({
        TableName: JOB_QUEUE_TABLE,
        Key: { job_id: jobId },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
      })
    );
  }

  async function addCheckerDescendant(
    parentJobId: string,
    status: string
  ): Promise<void> {
    // Shaped like the checker row 801_narrative_report_batch.py schedules.
    await docClient.send(
      new PutCommand({
        TableName: JOB_QUEUE_TABLE,
        Item: {
          job_id: `batch_check_${parentJobId}_1`,
          batch_job_id: parentJobId,
          conversation_id: zid,
          status,
          job_type: "AWAITING_NARRATIVE_BATCH",
          created_at: new Date().toISOString(),
        },
      })
    );
  }

  afterEach(async () => {
    for (const job of await listJobs()) {
      await docClient.send(
        new DeleteCommand({
          TableName: JOB_QUEUE_TABLE,
          Key: { job_id: job.job_id },
        })
      );
    }
    for (const guardKey of guardKeys) {
      await docClient.send(
        new DeleteCommand({
          TableName: JOB_GUARD_TABLE,
          Key: { guard_key: guardKey },
        })
      );
    }
    guardKeys.clear();
  });

  function trackPipelineGuard(body: Record<string, unknown>) {
    const scope = {
      conversationId: zid,
      reportId: (body.report_id as string) ?? null,
      jobType: String(body.job_type ?? "FULL_PIPELINE"),
      jobConfig: JSON.stringify({
        include_moderation: body.include_moderation ?? false,
      }),
    };
    guardKeys.add(scopeGuardKey(scope));
    if (body.idempotency_key) {
      guardKeys.add(idempotencyGuardKey(scope, String(body.idempotency_key)));
    }
  }

  function submitJob(body: Record<string, unknown> = {}) {
    trackPipelineGuard(body);
    const res = makeRes();
    const req = {
      p: { delphiEnabled: true },
      body: { conversation_id: zid, ...body },
    } as unknown as Request;
    return handle_POST_delphi_jobs(req, res).then(() => res);
  }

  function submitBatchReport(body: Record<string, unknown> = {}) {
    const merged = {
      report_id: reportId,
      model: "test-model",
      max_batch_size: 20,
      no_cache: false,
      include_moderation: false,
      ...body,
    };
    guardKeys.add(
      scopeGuardKey({
        conversationId: zid,
        reportId: merged.report_id,
        jobType: "CREATE_NARRATIVE_BATCH",
        jobConfig: JSON.stringify({
          job_type: "CREATE_NARRATIVE_BATCH",
          stages: [
            {
              stage: "CREATE_NARRATIVE_BATCH_CONFIG_STAGE",
              config: {
                model: merged.model,
                max_batch_size: merged.max_batch_size,
                no_cache: merged.no_cache,
                report_id: merged.report_id,
                include_moderation: merged.include_moderation,
              },
            },
          ],
        }),
      })
    );
    const res = makeRes();
    const req = {
      p: { delphiEnabled: true },
      body: merged,
    } as unknown as Request;
    return Promise.resolve(
      handle_POST_delphi_batch_reports(req, res) as any
    ).then(() => res);
  }

  it("creates one job and reports it as not deduplicated", async () => {
    const res = await submitJob();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(typeof res.body.job_id).toBe("string");
    expect(res.body.deduplicated).toBe(false);
    expect(res.body.job_status).toBe("PENDING");
    expect(await listJobs()).toHaveLength(1);
  });

  it("returns the existing PENDING job instead of enqueuing a duplicate", async () => {
    const first = await submitJob();
    const second = await submitJob();

    expect(second.body.status).toBe("success");
    expect(second.body.job_id).toBe(first.body.job_id);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.job_status).toBe("PENDING");
    expect(await listJobs()).toHaveLength(1);
  });

  it("keeps deduplicating once the job has been claimed", async () => {
    const first = await submitJob();
    await setStatus(first.body.job_id, "PROCESSING");

    const second = await submitJob();
    expect(second.body.job_id).toBe(first.body.job_id);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.job_status).toBe("PROCESSING");
    expect(await listJobs()).toHaveLength(1);
  });

  it("keeps deduplicating in AWAITING_RECHECK and LOCKED_FOR_CHECKING", async () => {
    const first = await submitJob();
    for (const status of ["AWAITING_RECHECK", "LOCKED_FOR_CHECKING"]) {
      await setStatus(first.body.job_id, status);
      const repeat = await submitJob();
      expect(repeat.body.job_id).toBe(first.body.job_id);
      expect(repeat.body.deduplicated).toBe(true);
      expect(repeat.body.job_status).toBe(status);
    }
    expect(await listJobs()).toHaveLength(1);
  });

  it("writes exactly one row for concurrent submissions", async () => {
    const responses = await Promise.all([
      submitJob(),
      submitJob(),
      submitJob(),
      submitJob(),
    ]);

    const jobs = await listJobs();
    expect(jobs).toHaveLength(1);
    for (const res of responses) {
      expect(res.body.status).toBe("success");
      expect(res.body.job_id).toBe(jobs[0].job_id);
    }
    expect(
      responses.filter((res) => res.body.deduplicated === false)
    ).toHaveLength(1);
  });

  it("lets a new submission through once the job is terminal", async () => {
    const first = await submitJob();
    await setStatus(first.body.job_id, "COMPLETED");

    const second = await submitJob();
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.job_id).not.toBe(first.body.job_id);
    expect(await listJobs()).toHaveLength(2);
  });

  it("lets a new submission through after a FAILED job", async () => {
    const first = await submitJob();
    await setStatus(first.body.job_id, "FAILED");

    const second = await submitJob();
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.job_id).not.toBe(first.body.job_id);
  });

  it("holds the guard while a checker descendant of a completed parent is live", async () => {
    const first = await submitJob();
    await setStatus(first.body.job_id, "COMPLETED");
    await addCheckerDescendant(first.body.job_id, "PENDING");

    const second = await submitJob();
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.job_id).toBe(first.body.job_id);
    // Parent plus descendant, and no new root job.
    expect(await listJobs()).toHaveLength(2);
  });

  it("releases the guard once the descendant is terminal too", async () => {
    const first = await submitJob();
    await setStatus(first.body.job_id, "COMPLETED");
    await addCheckerDescendant(first.body.job_id, "COMPLETED");

    const second = await submitJob();
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.job_id).not.toBe(first.body.job_id);
  });

  it("releases the guard when the job row was removed by a reset", async () => {
    const first = await submitJob();
    await docClient.send(
      new DeleteCommand({
        TableName: JOB_QUEUE_TABLE,
        Key: { job_id: first.body.job_id },
      })
    );

    const second = await submitJob();
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.job_id).not.toBe(first.body.job_id);
  });

  it("treats a different job config as different work", async () => {
    const first = await submitJob({ include_moderation: false });
    const second = await submitJob({ include_moderation: true });

    expect(second.body.deduplicated).toBe(false);
    expect(second.body.job_id).not.toBe(first.body.job_id);
    expect(await listJobs()).toHaveLength(2);
  });

  it("rejects a reused idempotency key with a conflicting payload", async () => {
    const first = await submitJob({
      include_moderation: false,
      idempotency_key: "conflict-key",
    });
    expect(first.body.deduplicated).toBe(false);

    const conflicting = await submitJob({
      include_moderation: true,
      idempotency_key: "conflict-key",
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.body.status).toBe("error");
    expect(conflicting.body.job_id).toBe(first.body.job_id);
    expect(await listJobs()).toHaveLength(1);
  });

  it("replays the same job for a repeated idempotency key and payload", async () => {
    const first = await submitJob({ idempotency_key: "replay-key" });
    const second = await submitJob({ idempotency_key: "replay-key" });

    expect(second.body.job_id).toBe(first.body.job_id);
    expect(second.body.deduplicated).toBe(true);
    expect(await listJobs()).toHaveLength(1);
  });

  it("clears the idempotency alias with the guard it belongs to", async () => {
    const scope = {
      conversationId: zid,
      reportId: null,
      jobType: "FULL_PIPELINE",
      jobConfig: JSON.stringify({ include_moderation: false }),
    };
    const first = await submitJob({ idempotency_key: "cleared-key" });
    expect(
      await readGuard(idempotencyGuardKey(scope, "cleared-key"))
    ).toBeDefined();

    await setStatus(first.body.job_id, "COMPLETED");
    await submitJob();

    expect(await readGuard(idempotencyGuardKey(scope, "cleared-key"))).toBe(
      undefined
    );
  });

  it("deduplicates repeated batch report submissions", async () => {
    const first = await submitBatchReport();
    expect(first.body.status).toBe("success");
    expect(first.body.deduplicated).toBe(false);
    // Existing response fields stay as older clients expect them.
    expect(first.body.batch_id).toBe(first.body.job_id);
    expect(first.body.model).toBe("test-model");
    expect(first.body.report_id).toBe(reportId);
    expect(first.body.max_batch_size).toBe(20);
    expect(first.body.no_cache).toBe(false);

    const second = await submitBatchReport();
    expect(second.body.status).toBe("success");
    expect(second.body.job_id).toBe(first.body.job_id);
    expect(second.body.batch_id).toBe(first.body.job_id);
    expect(second.body.deduplicated).toBe(true);
    expect(await listJobs()).toHaveLength(1);
  });

  it("does not let a batch report submission block a full pipeline job", async () => {
    await submitBatchReport();
    const pipeline = await submitJob({ report_id: reportId });

    expect(pipeline.body.deduplicated).toBe(false);
    expect(await listJobs()).toHaveLength(2);
  });
});
