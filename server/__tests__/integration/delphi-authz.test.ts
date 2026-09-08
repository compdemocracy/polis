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
    const { token: strangerToken } = await getJwtAuthenticatedAgent(
      strangerUser
    );
    strangerAgent = await newAgent();
    setAgentJwt(strangerAgent, strangerToken);

    // Unauthenticated caller: no Authorization header at all.
    anonAgent = await newAgent();

    // A Delphi job belonging to the owner's conversation.
    jobId = await createCompletedDelphiJob(conversationId);
  });

  afterAll(async () => {
    if (conversationId) {
      await cleanupDelphiJobs(conversationId);
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
});
