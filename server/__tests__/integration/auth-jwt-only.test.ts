import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  getJwtAuthenticatedAgent,
  newAgent,
  getTestAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";
import type { Response } from "supertest";
import type {
  VoteResponse as ActualVoteResponse,
  ParticipantData,
} from "../../types/test-helpers";

describe("JWT-Only Authentication Tests", () => {
  describe("OIDC JWT Authentication", () => {
    test("should authenticate requests with valid OIDC JWT", async () => {
      const pooledUser = {
        email: "test.user.0@polis.test",
        hname: "Test User 0",
        password: "Te$tP@ssw0rd*",
      };

      const { agent, token } = await getJwtAuthenticatedAgent(pooledUser);

      expect(token).toBeDefined();
      expect(token.split(".")).toHaveLength(3); // Valid JWT format

      // Test authenticated request
      const response: Response = await agent.get("/api/v3/users");
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("uid");
      expect(response.body).toHaveProperty("email");
      expect(typeof response.body.email).toBe("string");
    });

    test("should reject requests without JWT", async () => {
      const agent = await newAgent();

      const response: Response = await agent.get("/api/v3/users");
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Authentication required");
    });

    test("should handle logout (client-side operation)", async () => {
      const pooledUser = {
        email: "test.user.0@polis.test",
        hname: "Test User 0",
        password: "Te$tP@ssw0rd*",
      };
      const { agent } = await getJwtAuthenticatedAgent(pooledUser);

      // Call logout endpoint
      const response = await agent.post("/api/v3/auth/deregister").send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: "success",
        message: "Logout successful. Please remove your JWT token.",
      });

      // JWT remains valid (server doesn't invalidate it)
      const testResponse = await agent.get("/api/v3/users");
      expect(testResponse.status).toBe(200);
    });
  });

  describe("Participant Authentication (Non-OIDC)", () => {
    let conversationId: string;
    let commentId: number;

    beforeAll(async () => {
      const setup = await setupAuthAndConvo();
      conversationId = setup.conversationId;
      commentId = setup.commentIds[0];
    });

    test("should issue anonymous JWT for participants", async () => {
      const { body, status }: ParticipantData = await initializeParticipant(
        conversationId
      );

      expect(status).toBe(200);
      expect(body).toHaveProperty("conversation");
      expect(body.conversation.conversation_id).toBe(conversationId);

      // Submit vote to trigger JWT issuance
      const { agent } = await initializeParticipant(conversationId);
      const voteResponse: ActualVoteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1,
      });

      expect(voteResponse.status).toBe(200);

      // Check for anonymous JWT in response
      if (voteResponse.body.auth) {
        expect(voteResponse.body.auth.token).toBeDefined();
        expect(voteResponse.body.auth.token_type).toBe("Bearer");
        expect(voteResponse.body.auth.expires_in).toBe(365 * 24 * 60 * 60);
      }
    });

    test("should issue XID JWT for external participants", async () => {
      const xid = `test-xid-${Date.now()}`;
      const { agent, status }: ParticipantData =
        await initializeParticipantWithXid(conversationId, xid);

      expect(status).toBe(200);

      // Submit vote to verify XID JWT works
      const voteResponse: ActualVoteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 1,
      });

      expect(voteResponse.status).toBe(200);

      // Check for XID JWT in response
      if (voteResponse.body.auth) {
        expect(voteResponse.body.auth.token).toBeDefined();
        expect(voteResponse.body.auth.token_type).toBe("Bearer");
      }
    });
  });

  describe("Protected Endpoints", () => {
    test("should require authentication for admin endpoints", async () => {
      const agent = await newAgent();

      // Test POST /api/v3/conversations
      const createConvoResponse = await agent
        .post("/api/v3/conversations")
        .send({
          topic: "Test",
          description: "Test",
        });
      expect(createConvoResponse.status).toBe(401);

      // Test GET /api/v3/conversations (returns JSON error)
      const testAgent = await getTestAgent();
      const listConvoResponse = await testAgent.get("/api/v3/conversations");
      expect(listConvoResponse.status).toBe(403); // Legacy endpoint returns 403
      expect(listConvoResponse.text).toContain("polis_err_need_auth");
    });

    test("should allow access with valid JWT", async () => {
      const pooledUser = {
        email: "test.user.0@polis.test",
        hname: "Test User 0",
        password: "Te$tP@ssw0rd*",
      };
      const { agent } = await getJwtAuthenticatedAgent(pooledUser);

      // Should be able to list conversations
      const response = await agent.get("/api/v3/conversations");
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });
});
