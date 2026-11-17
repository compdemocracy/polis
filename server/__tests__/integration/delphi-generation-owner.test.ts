/**
 * The four routes that start Delphi work (a pipeline run, a narrative batch, a
 * collective statement, the legacy narrative) against the real stack: the
 * server, Postgres, DynamoDB Local and the OIDC simulator.
 *
 * The delphi_enabled claim is still checked first and answered as before. A
 * caller with the claim must also own the conversation the request names;
 * otherwise the reply is HTTP 403 with one code, and no job is written.
 *
 * admin@polis.test carries the claim in the simulator
 * (oidc-simulator/rules/add-custom-claims.js); the pooled test users do not.
 * test.env lists no site administrators (ADMIN_UIDS=[]).
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";
import {
  cleanupDelphiJobs,
  docClient,
  ensureJobGuardTableExists,
  ensureJobQueueTableExists,
} from "../setup/dynamodb-test-helpers";
import pgQuery from "../../src/db/pg-query";
import { JOB_QUEUE_TABLE } from "../../src/routes/delphi/jobGuard";

const NOT_OWNER = "polis_err_delphi_not_conversation_owner";
const refused = { error: NOT_OWNER, message: NOT_OWNER, status: 403 };

async function zidOf(conversationId: string): Promise<number> {
  const rows = (await pgQuery.queryP(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  )) as { zid: number }[];
  return rows[0].zid;
}

async function reportFor(agent: Agent, conversationId: string): Promise<string> {
  await agent.post("/api/v3/reports").send({ conversation_id: conversationId });
  const listed = await agent
    .get(`/api/v3/reports?conversation_id=${conversationId}`)
    .send();
  return JSON.parse(listed.text)[0].report_id;
}

async function jobsFor(zid: number): Promise<unknown[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: JOB_QUEUE_TABLE,
      IndexName: "ConversationIndex",
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: { ":cid": String(zid) },
    })
  );
  return result.Items || [];
}

function statementRequest(reportId: string) {
  return {
    report_id: reportId,
    topic_key: "0000c5a1-0000-0000-0000-0000000000b2#0#1",
    topic_name: "Generated topic",
    qualifying_tids: [0, 1, 2],
    group_consensus: { 0: 0.9, 1: 0.9, 2: 0.9 },
  };
}

describe("Delphi generation routes and the conversation owner", () => {
  let ownerAgent: Agent; // owns the conversation, has no claim
  let claimAgent: Agent; // has the claim, owns only its own conversation
  let reportId: string;
  let zid: number;
  let ownReportId: string;
  let ownZid: number;

  beforeAll(async () => {
    await ensureJobQueueTableExists();
    await ensureJobGuardTableExists();

    const setup = await setupAuthAndConvo({ commentCount: 1 });
    ({ agent: ownerAgent } = await getJwtAuthenticatedAgent(setup.testUser));
    reportId = await reportFor(ownerAgent, setup.conversationId);
    zid = await zidOf(setup.conversationId);

    ({ agent: claimAgent } = await getJwtAuthenticatedAgent({
      email: "admin@polis.test",
      password: "Te$tP@ssw0rd*",
      hname: "Admin",
    }));
    const own = await createConversation(claimAgent);
    ownReportId = await reportFor(claimAgent, own);
    ownZid = await zidOf(own);
  });

  afterAll(async () => {
    await cleanupDelphiJobs(String(zid));
    await cleanupDelphiJobs(String(ownZid));
  });

  test("a claim holder who does not own the conversation is refused on all four routes", async () => {
    const byReport = await claimAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: reportId, job_type: "FULL_PIPELINE" });
    expect(byReport.status).toBe(403);
    expect(byReport.body).toEqual(refused);

    const byNumber = await claimAgent
      .post("/api/v3/delphi/jobs")
      .send({ conversation_id: zid, job_type: "FULL_PIPELINE" });
    expect(byNumber.status).toBe(403);
    expect(byNumber.body).toEqual(refused);

    const batch = await claimAgent
      .post("/api/v3/delphi/batchReports")
      .send({ report_id: reportId, model: "generated-model" });
    expect(batch.status).toBe(403);
    expect(batch.body).toEqual(refused);

    const statement = await claimAgent
      .post("/api/v3/collectiveStatement")
      .send(statementRequest(reportId));
    expect(statement.status).toBe(403);
    expect(statement.body).toEqual(refused);

    const narrative = await claimAgent
      .get(`/api/v3/reportNarrative?report_id=${reportId}`)
      .send();
    expect(narrative.status).toBe(403);
    expect(narrative.body).toEqual(refused);

    expect(await jobsFor(zid)).toEqual([]);
  });

  test("the owner without the claim gets the replies it got before", async () => {
    const jobs = await ownerAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: reportId, job_type: "FULL_PIPELINE" });
    expect(jobs.status).toBe(403);
    expect(jobs.body).toEqual({
      error: "polis_err_delphi_jobs_delphi_disabled",
      message: "polis_err_delphi_jobs_delphi_disabled",
      status: 403,
    });

    const batch = await ownerAgent
      .post("/api/v3/delphi/batchReports")
      .send({ report_id: reportId, model: "generated-model" });
    expect(batch.status).toBe(200);
    expect(batch.body).toEqual({
      status: "error",
      message: "Error processing request",
      error: "Unauthorized",
      report_id: reportId,
    });

    const statement = await ownerAgent
      .post("/api/v3/collectiveStatement")
      .send(statementRequest(reportId));
    expect(statement.status).toBe(500);
    expect(statement.body).toEqual({
      status: "error",
      message: "Error generating collective statement",
      error: "Unauthorized",
    });

    const narrative = await ownerAgent
      .get(`/api/v3/reportNarrative?report_id=${reportId}`)
      .send();
    expect(narrative.status).toBe(503);
    expect(narrative.body).toEqual({
      error: "polis_err_report_storage",
      message: "polis_err_report_storage",
      status: 503,
    });

    expect(await jobsFor(zid)).toEqual([]);
  });

  test("a claim holder who owns the conversation is admitted, as before", async () => {
    const jobs = await claimAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: ownReportId, job_type: "FULL_PIPELINE" });
    expect(jobs.status).toBe(200);
    expect(jobs.body.status).toBe("success");

    const batch = await claimAgent
      .post("/api/v3/delphi/batchReports")
      .send({ report_id: ownReportId, model: "generated-model" });
    expect(batch.status).toBe(200);
    expect(batch.body.status).toBe("success");

    expect((await jobsFor(ownZid)).length).toBe(2);

    // No topic has been computed for this conversation, so the statement
    // route answers that it found no comments: past authorization, before
    // any model call.
    const statement = await claimAgent
      .post("/api/v3/collectiveStatement")
      .send(statementRequest(ownReportId));
    expect(statement.status).toBe(200);
    expect(statement.body).toEqual({
      status: "error",
      message: "No comments found for this topic",
    });
  });
});
