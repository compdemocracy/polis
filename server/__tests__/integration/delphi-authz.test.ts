/**
 * Authorization tests for the two Delphi/topic-moderation routes that
 * previously had no route-level authentication:
 *
 *   POST /api/v3/topicMod/moderate  - trusted a caller-supplied `moderator`
 *                                     string and applied moderation to any
 *                                     conversation named in the request.
 *   GET  /api/v3/delphi/logs        - returned pipeline logs for any job_id.
 *
 * Both now require a JWT and conversation ownership, derived from the
 * authenticated user rather than from any request field.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
  setupAuthAndConvo,
  type TestUser,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import {
  ensureJobQueueTableExists,
  createCompletedDelphiJob,
  cleanupDelphiJobs,
} from "../setup/dynamodb-test-helpers";

describe("Delphi route authorization", () => {
  let conversationId: string;
  let commentIds: number[];
  let ownerAgent: any;
  let strangerAgent: any;
  let anonAgent: any;
  let jobId: string;

  // Two batch jobs, one per owner, whose ids share the first eight characters
  // ("batch_re") — the prefix the route used to filter CloudWatch on.
  let strangerConversationId: string;
  let ownerBatchJobId: string;
  let strangerBatchJobId: string;
  const ownerMarker = "OWNER-ONLY-SECRET-a3f91c";
  const strangerMarker = "STRANGER-ONLY-SECRET-7d20be";

  beforeAll(async () => {
    await ensureJobQueueTableExists();

    // Owner: pooled user 1 creates the conversation and its comments.
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 2,
    });
    conversationId = convo.conversationId;
    commentIds = convo.commentIds;

    const { agent } = await getJwtAuthenticatedAgent(convo.testUser);
    ownerAgent = agent;

    // Stranger: pooled user 2, authenticated but unrelated to the conversation.
    const pooled = getPooledTestUser(2);
    const strangerUser: TestUser = {
      email: pooled.email,
      hname: pooled.name,
      password: pooled.password,
    } as TestUser;
    const { agent: strangerJwtAgent, token: strangerToken } =
      await getJwtAuthenticatedAgent(strangerUser);
    strangerAgent = await newAgent();
    setAgentJwt(strangerAgent, strangerToken);

    // Unauthenticated caller: no Authorization header at all.
    anonAgent = await newAgent();

    // A Delphi job belonging to the owner's conversation.
    jobId = await createCompletedDelphiJob(conversationId);

    // The stranger owns a conversation of their own, so they can hold a job
    // they are legitimately authorized for.
    strangerConversationId = await createConversation(strangerJwtAgent, {
      topic: "Stranger's own conversation",
      description: "Owns a batch job sharing the prefix of the owner's job",
    });

    // Batch job ids are `batch_report_<report_id>_<ts>_<suffix>`, so every one
    // of them starts with the same eight characters. Each row carries a
    // distinct marker in its own log entries.
    const stamp = Date.now();
    ownerBatchJobId = `batch_report_${conversationId}_${stamp}_owner`;
    strangerBatchJobId = `batch_report_${strangerConversationId}_${stamp}_str`;

    await createCompletedDelphiJob(conversationId, ownerBatchJobId, [
      `[stdout] ${ownerMarker} processing conversation ${conversationId}`,
      "[stdout] Results stored in DynamoDB for conversation",
    ]);
    await createCompletedDelphiJob(strangerConversationId, strangerBatchJobId, [
      `[stdout] ${strangerMarker} processing the stranger's conversation`,
    ]);
  });

  afterAll(async () => {
    if (conversationId) {
      await cleanupDelphiJobs(conversationId);
    }
    if (strangerConversationId) {
      await cleanupDelphiJobs(strangerConversationId);
    }
  });

  describe("POST /api/v3/topicMod/moderate", () => {
    test("unauthenticated caller is rejected with 401", async () => {
      const response = await anonAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: commentIds,
        action: "reject",
      });

      expect(response.status).toBe(401);
    });

    test("a supplied `moderator` field does not authenticate the caller", async () => {
      // This is the exact shape of the pre-fix exploit: no token, but a
      // moderator identity asserted in the request body.
      const response = await anonAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: commentIds,
        action: "reject",
        moderator: "admin",
      });

      expect(response.status).toBe(401);
    });

    test("authenticated non-owner is rejected with 403", async () => {
      const response = await strangerAgent
        .post("/api/v3/topicMod/moderate")
        .send({
          conversation_id: conversationId,
          comment_ids: commentIds,
          action: "reject",
        });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_topicMod_moderate_auth"
      );
    });

    test("a supplied `moderator` field does not authorize a non-owner", async () => {
      const response = await strangerAgent
        .post("/api/v3/topicMod/moderate")
        .send({
          conversation_id: conversationId,
          comment_ids: commentIds,
          action: "reject",
          moderator: "admin",
        });

      expect(response.status).toBe(403);
    });

    test("non-owner attempt leaves comment moderation state unchanged", async () => {
      const response = await ownerAgent.get(
        `/api/v3/comments?conversation_id=${conversationId}&moderation=true`
      );

      expect(response.status).toBe(200);
      const rejected = response.body.filter(
        (c: { tid: number; mod: number }) =>
          commentIds.includes(c.tid) && c.mod === -1
      );
      expect(rejected).toHaveLength(0);
    });

    test("owner succeeds with 200 without supplying a `moderator` field", async () => {
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: commentIds,
        action: "reject",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "success");
      expect(response.body).toHaveProperty("moderated_at");
    });

    test("owner's moderation actually applied to the comments", async () => {
      const response = await ownerAgent.get(
        `/api/v3/comments?conversation_id=${conversationId}&moderation=true`
      );

      expect(response.status).toBe(200);
      const touched = response.body.filter((c: { tid: number }) =>
        commentIds.includes(c.tid)
      );
      expect(touched.length).toBeGreaterThan(0);
      for (const comment of touched) {
        expect(comment.mod).toBe(-1);
      }
    });
  });

  describe("GET /api/v3/delphi/logs", () => {
    test("unauthenticated caller is rejected with 401", async () => {
      const response = await anonAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(jobId)}`
      );

      expect(response.status).toBe(401);
    });

    test("authenticated non-owner is rejected with 403", async () => {
      const response = await strangerAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(jobId)}`
      );

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty(
        "message",
        "polis_err_delphi_logs_auth"
      );
    });

    test("owner receives the log events with 200", async () => {
      const response = await ownerAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(jobId)}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test("an unknown job_id is a 404, not a log read", async () => {
      const response = await ownerAgent.get(
        "/api/v3/delphi/logs?job_id=no-such-delphi-job-id"
      );

      expect(response.status).toBe(404);
    });

    test("a missing job_id is a 400", async () => {
      const response = await ownerAgent.get("/api/v3/delphi/logs");

      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/v3/delphi/logs is bound to the authorized job", () => {
    // The route used to authorize one job and then return every CloudWatch
    // event matching the first eight characters of its id. All batch job ids
    // begin `batch_report_`, so that prefix is the constant "batch_re" and one
    // owner's authorized request returned other owners' log lines. Logs now
    // come from the authorized job's own Delphi_JobQueue row.
    test("the two fixture jobs really do share the eight-character prefix", () => {
      expect(ownerBatchJobId.slice(0, 8)).toBe("batch_re");
      expect(strangerBatchJobId.slice(0, 8)).toBe("batch_re");
      expect(ownerBatchJobId).not.toBe(strangerBatchJobId);
    });

    test("the owner sees only their own job's log lines", async () => {
      const response = await ownerAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(ownerBatchJobId)}`
      );

      expect(response.status).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).toContain(ownerMarker);
      expect(text).not.toContain(strangerMarker);
      // Every line names the full job id, never a truncated prefix.
      for (const event of response.body) {
        expect(event.message).toContain(ownerBatchJobId);
      }
    });

    test("the stranger sees only their own job's log lines", async () => {
      const response = await strangerAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(strangerBatchJobId)}`
      );

      expect(response.status).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).toContain(strangerMarker);
      expect(text).not.toContain(ownerMarker);
    });

    test("the completion sentinel the report client watches for survives", async () => {
      const response = await ownerAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(ownerBatchJobId)}`
      );

      expect(response.status).toBe(200);
      expect(
        response.body.find((m: { message: string }) =>
          m.message.includes("Results stored in DynamoDB for conversation")
        )
      ).toBeDefined();
    });

    test("a same-prefix job belonging to another owner is still a 403", async () => {
      const response = await strangerAgent.get(
        `/api/v3/delphi/logs?job_id=${encodeURIComponent(ownerBatchJobId)}`
      );

      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain(ownerMarker);
    });
  });
});
