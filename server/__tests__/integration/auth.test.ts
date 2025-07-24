import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  getTestAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  setupAuthAndConvo,
  submitVote,
  getJwtAuthenticatedAgent,
  newAgent,
} from "../setup/api-test-helpers";
import type { Response } from "supertest";
import type {
  VoteResponse as ActualVoteResponse,
  ParticipantData,
} from "../../types/test-helpers";
import { Agent } from "supertest";

describe("Authentication with Supertest", () => {
  // Define agents
  let agent: Agent;

  // Initialize agents before tests
  beforeAll(async () => {
    agent = await getTestAgent();
  });

  describe("Deregister (Logout) Endpoint", () => {
    test("Login, logout, try to access endpoint that requires auth", async () => {
      const noShowPageResponse: Response = await agent
        .post("/api/v3/auth/deregister")
        .send({});
      expect(noShowPageResponse.status).toBe(200);
      expect(noShowPageResponse.body).toEqual({
        status: "success",
        message: "Logout successful. Please remove your JWT token.",
      });

      const nullShowPageResponse: Response = await agent
        .post("/api/v3/auth/deregister")
        .send({
          showPage: null,
        });
      expect(nullShowPageResponse.status).toBe(200);
      expect(nullShowPageResponse.body).toEqual({
        status: "success",
        message: "Logout successful. Please remove your JWT token.",
      });

      const showPageResponse: Response = await agent
        .post("/api/v3/auth/deregister")
        .send({
          showPage: true,
        });
      expect(showPageResponse.status).toBe(200);
      expect(showPageResponse.body).toEqual({
        status: "success",
        message: "Logout successful. Please remove your JWT token.",
      });
    });

    test("JWT logout returns 200 without any server-side action", async () => {
      // Use a pooled test user that exists in the OIDC simulator
      const pooledUser = {
        email: "test.user.0@polis.test",
        hname: "Test User 0",
        password: "Te$tP@ssw0rd*",
      };
      const { agent } = await getJwtAuthenticatedAgent(pooledUser);

      // Call deregister with JWT auth
      const response = await agent.post("/api/v3/auth/deregister").send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: "success",
        message: "Logout successful. Please remove your JWT token.",
      });

      // Verify the JWT still works (server doesn't invalidate JWTs)
      const testResponse = await agent.get("/api/v3/users");
      expect(testResponse.status).toBe(200);
    });
  });

  describe("JWT Authentication", () => {
    test("should authenticate with OIDC JWT token", async () => {
      // Create a pooled test user that exists in the OIDC simulator
      const pooledUser = {
        email: "test.user.0@polis.test",
        hname: "Test User 0",
        password: "Te$tP@ssw0rd*",
      };

      // Get JWT authenticated agent
      const { agent: jwtAgent, token } = await getJwtAuthenticatedAgent(
        pooledUser
      );

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // Valid JWT format

      // Test authenticated request
      const response: Response = await jwtAgent.get("/api/v3/users");
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("uid");
      expect(typeof response.body.uid).toBe("number");
      expect(response.body).toHaveProperty("email");
    });

    test("should fail without valid JWT token", async () => {
      const unauthenticatedAgent = await newAgent();

      const response: Response = await unauthenticatedAgent.get(
        "/api/v3/users"
      );
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Authentication required");
    });
  });

  describe("Participant Authentication", () => {
    let conversationId: string;
    let commentId: number;

    beforeAll(async () => {
      // Create owner and conversation using the agent helper function
      const setup = await setupAuthAndConvo();

      conversationId = setup.conversationId;
      commentId = setup.commentIds[0];
    });

    test("should initialize participant session", async () => {
      // Initialize participant
      const { body, status, token }: ParticipantData =
        await initializeParticipant(conversationId);

      expect(status).toBe(200);
      expect(body).toHaveProperty("conversation");
      expect(body).toHaveProperty("nextComment");
      expect(body.conversation.conversation_id).toBe(conversationId);

      // The nextComment should exist, but may be either the seed comment (tid=0) or actual comment (tid=1)
      if (body.nextComment) {
        expect(body.nextComment).toHaveProperty("tid");
        expect(typeof body.nextComment.tid).toBe("number");
        expect(body.nextComment.tid).toBeGreaterThanOrEqual(0);
      }

      // In JWT-based auth, token might be provided in the auth response
      if (token) {
        expect(token).toBeDefined();
        expect(typeof token).toBe("string");
      }
    });

    test("should authenticate participant upon voting", async () => {
      // STEP 1: Initialize participant
      const { agent, status }: ParticipantData = await initializeParticipant(
        conversationId
      );

      expect(status).toBe(200);

      // STEP 2: Submit vote
      const voteResponse: ActualVoteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1,
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");

      // In JWT-based auth, check for auth token in response body instead of cookies
      if (voteResponse.body.auth && voteResponse.body.auth.token) {
        expect(voteResponse.body.auth.token).toBeDefined();
        expect(typeof voteResponse.body.auth.token).toBe("string");
        expect(voteResponse.body.auth.token_type).toBe("Bearer");
        expect(voteResponse.body.auth.expires_in).toBe(365 * 24 * 60 * 60); // 1 year
      }
    });

    test("should initialize participant with XID", async () => {
      const xid = `test-xid-${Date.now()}`;
      const { agent, body, status }: ParticipantData =
        await initializeParticipantWithXid(conversationId, xid);

      expect(status).toBe(200);
      expect(body).toHaveProperty("conversation");
      expect(body).toHaveProperty("nextComment");

      // Submit a vote to verify XID association works
      const voteResponse: ActualVoteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 1,
      });

      expect(voteResponse.status).toBe(200);

      // Check for XID JWT token in response
      if (voteResponse.body.auth && voteResponse.body.auth.token) {
        expect(voteResponse.body.auth.token).toBeDefined();
        expect(typeof voteResponse.body.auth.token).toBe("string");
        expect(voteResponse.body.auth.token_type).toBe("Bearer");
        expect(voteResponse.body.auth.expires_in).toBe(365 * 24 * 60 * 60); // 1 year
      }
    });
  });
});
