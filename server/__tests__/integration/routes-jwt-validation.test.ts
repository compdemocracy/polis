import { describe, expect, test, beforeAll } from "@jest/globals";
import type { Response } from "supertest";
import { getPooledTestUser } from "../setup/test-user-helpers";
import {
  getJwtAuthenticatedAgent,
  createConversation,
  createComment,
} from "../setup/api-test-helpers";
import type { TestUser } from "../../types/test-helpers";

/**
 * Comprehensive test suite to validate all routes work with JWT authentication
 */
describe("JWT Route Validation Matrix", () => {
  let testUser: TestUser;
  let baseConversationId: string;
  let baseCommentId: number;

  beforeAll(async () => {
    // Use a pre-populated test user from the pool
    const pooledUser = getPooledTestUser(2); // Use test.user.2@polis.test
    testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    console.log("Using pooled test user for route validation:", testUser.email);

    // Setup test data for basic tests
    const { agent } = await getJwtAuthenticatedAgent(testUser);
    baseConversationId = await createConversation(agent, {
      topic: "JWT Route Test Base Conversation",
      description: "Base conversation for JWT tests",
    });
    baseCommentId = await createComment(agent, baseConversationId, {
      txt: "Base comment for JWT validation",
    });
  });

  describe("User Management Routes", () => {
    test("GET /api/v3/users - Get current user info", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get("/api/v3/users");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("uid");
      expect(response.body).toHaveProperty("email");
    });
  });

  describe("Conversation Management Routes", () => {
    test("GET /api/v3/conversations - List conversations", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get("/api/v3/conversations");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test("POST /api/v3/conversations - Create conversation", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent
        .post("/api/v3/conversations")
        .send({
          topic: "JWT Test Conversation",
          description: "Created via JWT auth",
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("conversation_id");
    });

    test("PUT /api/v3/conversations - Update conversation", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.put("/api/v3/conversations").send({
        conversation_id: baseConversationId,
        topic: "Updated JWT Test Conversation",
      });

      expect(response.status).toBe(200);
    });
  });

  describe("Comment Routes", () => {
    test("GET /api/v3/comments - Get comments (auth optional)", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/comments?conversation_id=${baseConversationId}`
      );

      expect(response.status).toBe(200);
      const comments = Array.isArray(response.body)
        ? response.body
        : response.body.comments;
      expect(Array.isArray(comments)).toBe(true);
    });

    test("POST /api/v3/comments - Create comment", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.post("/api/v3/comments").send({
        conversation_id: baseConversationId,
        txt: "Comment created with JWT auth",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("tid");
    });

    test("PUT /api/v3/comments - Moderate comment", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.put("/api/v3/comments").send({
        conversation_id: baseConversationId,
        tid: baseCommentId,
        active: true,
        mod: 1,
        is_meta: false,
        velocity: 1,
      });

      expect(response.status).toBe(200);
    });
  });

  describe("Voting Routes", () => {
    let voteConversationId: string;
    let voteCommentId: number;

    beforeAll(async () => {
      // Create a fresh conversation for voting tests to avoid duplicate participant errors
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      voteConversationId = await createConversation(agent, {
        topic: "JWT Vote Test Conversation",
        description: "Separate conversation for vote tests",
      });
      voteCommentId = await createComment(agent, voteConversationId, {
        txt: "Comment to vote on",
      });
    });

    test("POST /api/v3/votes - Submit vote", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.post("/api/v3/votes").send({
        conversation_id: voteConversationId,
        tid: voteCommentId,
        vote: -1,
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("currentPid");
    });

    test("GET /api/v3/votes - Get votes (auth optional)", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/votes?conversation_id=${voteConversationId}`
      );

      expect(response.status).toBe(200);
    });

    test("GET /api/v3/votes/me - Get my votes", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/votes/me?conversation_id=${voteConversationId}`
      );

      expect(response.status).toBe(200);
    });
  });

  describe("Participant Routes", () => {
    test("GET /api/v3/participants - Get participants", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/participants?conversation_id=${baseConversationId}`
      );

      expect(response.status).toBe(200);
      // The response might be a single participant object or an array
      // depending on the implementation
      expect(response.body).toBeDefined();
    });

    test("POST /api/v3/participants - Join conversation", async () => {
      // Create a new conversation to join
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const newConvId = await createConversation(agent, {
        topic: "JWT Participant Test",
        description: "Fresh conversation to join",
      });

      const response: Response = await agent.post("/api/v3/participants").send({
        conversation_id: newConvId,
      });

      expect(response.status).toBe(200);
    });

    test("GET /api/v3/participationInit - Initialize participation (auth optional)", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/participationInit?conversation_id=${baseConversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("conversation");
      expect(response.body).toHaveProperty("user");
    });
  });

  describe("Report Routes", () => {
    test("POST /api/v3/reports - Create report", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.post("/api/v3/reports").send({
        conversation_id: baseConversationId,
      });

      expect(response.status).toBe(200);
      // The response might be empty or contain report data
      // depending on the implementation
    });

    test("GET /api/v3/reports - Get reports", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/reports?conversation_id=${baseConversationId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test("PUT /api/v3/reports - Update report", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);

      // First get reports to find a report_id
      const getResponse: Response = await agent.get(
        `/api/v3/reports?conversation_id=${baseConversationId}`
      );
      const reports = getResponse.body;

      if (reports && reports.length > 0) {
        const reportId = reports[0].report_id;
        const response: Response = await agent.put("/api/v3/reports").send({
          conversation_id: baseConversationId,
          report_id: reportId,
          report_name: "Updated Report Name",
        });

        expect(response.status).toBe(200);
      } else {
        // If no reports exist, test that we get appropriate error
        const response: Response = await agent.put("/api/v3/reports").send({
          conversation_id: baseConversationId,
          report_name: "Updated Report Name",
        });

        // Should fail without report_id
        expect(response.status).toBe(400);
      }
    });
  });

  describe("Data Export Routes", () => {
    test("GET /api/v3/dataExport - Request data export", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/dataExport?conversation_id=${baseConversationId}`
      );

      expect(response.status).toBe(200);
    });
  });

  describe("Math/Analysis Routes", () => {
    test("GET /api/v3/math/pca2 - Get PCA data (auth optional)", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/math/pca2?conversation_id=${baseConversationId}`
      );

      // May return 304 if no new data
      expect([200, 304]).toContain(response.status);
    });

    test("POST /api/v3/math/update - Trigger math update", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.post("/api/v3/mathUpdate").send({
        conversation_id: baseConversationId,
        math_update_type: "update",
      });

      expect(response.status).toBe(200);
    });
  });

  describe("Metadata Routes", () => {
    test("POST /api/v3/metadata/questions - Create metadata question", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent
        .post("/api/v3/metadata/questions")
        .send({
          conversation_id: baseConversationId,
          key: "test_question",
        });

      expect(response.status).toBe(200);
    });

    test("GET /api/v3/metadata/questions - Get metadata questions (auth optional)", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.get(
        `/api/v3/metadata/questions?conversation_id=${baseConversationId}`
      );

      expect(response.status).toBe(200);
    });
  });

  describe("Invitation Routes", () => {
    test("POST /api/v3/users/invite - Send invitations", async () => {
      const { agent } = await getJwtAuthenticatedAgent(testUser);
      const response: Response = await agent.post("/api/v3/users/invite").send({
        conversation_id: baseConversationId,
        emails: `jwt.invite.${Date.now()}@test.com`,
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "success");
    });
  });

  describe("Error Cases", () => {
    test("Protected route without JWT returns 401", async () => {
      const { newAgent } = await import("../setup/api-test-helpers");
      const unauthAgent = await newAgent();

      const response: Response = await unauthAgent.get("/api/v3/users");

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Authentication required");
    });

    test("Invalid JWT returns 401", async () => {
      const { newAgent } = await import("../setup/api-test-helpers");
      const agent = await newAgent();
      agent.set("Authorization", "Bearer invalid.jwt.token");

      const response: Response = await agent.get("/api/v3/users");

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Invalid token format");
    });
  });
});

/**
 * Summary of route authentication status:
 *
 * ✅ Authenticated Routes (require JWT):
 * - User management: GET/PUT /api/v3/users
 * - Conversations: POST/PUT /api/v3/conversations
 * - Comments: POST/PUT /api/v3/comments
 * - Participants: GET/POST /api/v3/participants
 * - Reports: GET/POST/PUT /api/v3/reports
 * - Data export: GET /api/v3/dataExport
 * - Invitations: POST /api/v3/users/invite
 *
 * 🔄 Auth-Optional Routes (work with or without JWT):
 * - GET /api/v3/conversations
 * - GET /api/v3/comments
 * - GET /api/v3/votes
 * - GET /api/v3/participationInit
 * - GET /api/v3/math/pca2
 * - GET /api/v3/metadata/questions
 *
 * ⚠️ Special Cases (need participant auth design):
 * - POST /api/v3/votes
 * - GET /api/v3/participationInit (creates participant session)
 * - XID-based participation
 */
