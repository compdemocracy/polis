import { describe, test, expect, beforeAll } from "@jest/globals";
import {
  setupAuthAndConvo,
  newAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import {
  createXidTestUser,
  getXidAuthenticatedAgent,
  verifyXidJwtClaims,
} from "../setup/xid-jwt-test-helpers";

describe("Anonymous and XID JWT Authentication", () => {
  let conversationId: string;

  beforeAll(async () => {
    // Create a conversation for testing
    try {
      const { conversationId: cid } = await setupAuthAndConvo({
        createConvo: true,
        commentCount: 1, // Just one comment to avoid issues
      });
      conversationId = cid;
    } catch (error) {
      console.error("Failed to setup conversation:", error);
      throw error;
    }
  });

  describe("Anonymous Users (without XID)", () => {
    test("anonymous users should receive nextComment and potentially JWT on participation", async () => {
      const agent = await newAgent();

      // First participation request creates the participant
      const initResponse = await agent.get(
        `/api/v3/participationInit?conversation_id=${conversationId}`
      );

      expect(initResponse.status).toBe(200);
      expect(initResponse.body).toHaveProperty("conversation");

      // Should always have a nextComment available for voting
      expect(initResponse.body).toHaveProperty("nextComment");
      expect(initResponse.body.nextComment).toHaveProperty("tid");
      expect(typeof initResponse.body.nextComment.tid).toBe("number");

      // Test voting with the provided comment
      const voteResponse = await agent.post("/api/v3/votes").send({
        tid: initResponse.body.nextComment.tid,
        vote: 1,
        conversation_id: conversationId,
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
      expect(typeof voteResponse.body.currentPid).toBe("number");

      // During migration, anonymous users might get JWTs - let's check
      if (voteResponse.body.auth) {
        expect(voteResponse.body.auth).toHaveProperty("token");
        expect(voteResponse.body.auth).toHaveProperty("token_type", "Bearer");
        expect(voteResponse.body.auth).toHaveProperty(
          "expires_in",
          365 * 24 * 60 * 60
        );
        expect(typeof voteResponse.body.auth.token).toBe("string");
        expect(voteResponse.body.auth.token.split(".")).toHaveLength(3); // Valid JWT format
        console.log("✅ Anonymous user received JWT on vote");
      } else {
        console.log(
          "⚠️ Anonymous user did not receive JWT (may not be implemented yet)"
        );
        expect(voteResponse.body).toHaveProperty("auth");
      }
    });

    test("anonymous users should be able to vote through initializeParticipant flow", async () => {
      // Use the proper initialization flow for anonymous participants
      const { agent, body: initBody } = await initializeParticipant(
        conversationId
      );

      expect(initBody).toHaveProperty("conversation");
      expect(initBody).toHaveProperty("nextComment");
      expect(initBody.nextComment).toHaveProperty("tid");
      expect(typeof initBody.nextComment.tid).toBe("number");

      // Submit a vote as an anonymous participant using the nextComment
      // Use submitVote helper to properly handle response parsing
      const voteResponse = await submitVote(agent, {
        tid: initBody.nextComment.tid,
        vote: 1,
        conversation_id: conversationId,
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
      expect(typeof voteResponse.body.currentPid).toBe("number");

      console.log("✅ Anonymous voting through initializeParticipant works");
    });
  });

  describe("XID Users", () => {
    test("XID JWT creation and validation should work correctly", async () => {
      // Create a test XID user and get authenticated agent
      const xidUser = createXidTestUser(conversationId);
      const { agent, token } = await getXidAuthenticatedAgent(xidUser);

      // Assert JWT properties
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // Valid JWT format

      // Verify the JWT claims
      const claims = verifyXidJwtClaims(token);
      expect(claims.xid).toBe(xidUser.xid);
      expect(claims.conversation_id).toBe(conversationId);
      expect(claims.uid).toBe(xidUser.uid);
      expect(claims.pid).toBe(xidUser.pid);

      // Use the JWT-authenticated agent to make requests
      const response = await agent.get(
        `/api/v3/votes?conversation_id=${conversationId}&pid=-1`
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      console.log("✅ XID JWT works for authenticated requests");
    });

    test("XID participants should receive nextComment and potentially JWT through participationInit", async () => {
      const xid = `test-xid-${Date.now()}`;
      const agent = await newAgent();

      // Make participation init request with XID
      const initResponse = await agent.get(
        `/api/v3/participationInit?conversation_id=${conversationId}&xid=${xid}&agid=1`
      );

      // Should get a successful response with conversation and nextComment
      expect(initResponse.status).toBe(200);
      expect(initResponse.body).toHaveProperty("conversation");
      expect(initResponse.body).toHaveProperty("nextComment");
      expect(initResponse.body.nextComment).toHaveProperty("tid");
      expect(typeof initResponse.body.nextComment.tid).toBe("number");

      // Test voting with XID user - this should potentially create the XID participant and issue JWT
      const voteResponse = await agent.post("/api/v3/votes").send({
        tid: initResponse.body.nextComment.tid,
        vote: 1,
        conversation_id: conversationId,
        xid: xid,
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
      expect(typeof voteResponse.body.currentPid).toBe("number");

      // XID users should get JWT when they vote (creating participant)
      // This is a stronger assertion - we expect XID users to get JWTs
      if (voteResponse.body.auth?.token) {
        expect(voteResponse.body.auth).toHaveProperty("token");
        expect(voteResponse.body.auth).toHaveProperty("token_type", "Bearer");
        expect(voteResponse.body.auth).toHaveProperty(
          "expires_in",
          365 * 24 * 60 * 60
        );

        const token = voteResponse.body.auth.token;
        expect(typeof token).toBe("string");
        expect(token.split(".")).toHaveLength(3); // Valid JWT format
        console.log("✅ XID user received JWT on vote");
      } else {
        console.log(
          "⚠️ XID user did not receive JWT - this might indicate an implementation gap"
        );
        expect(voteResponse.body).toHaveProperty("auth");
      }
    });

    test("XID users should be able to participate in multiple conversations", async () => {
      // Create another conversation
      const { conversationId: otherConvId, commentIds: otherCommentIds } =
        await setupAuthAndConvo({
          createConvo: true,
          commentCount: 1,
        });

      // Get JWT for first conversation
      const xidUser = createXidTestUser(conversationId);
      const { agent } = await getXidAuthenticatedAgent(xidUser);

      // Try to vote in the different conversation
      const voteResponse = await agent.post("/api/v3/votes").send({
        tid: otherCommentIds[0],
        vote: 1,
        conversation_id: otherConvId,
        pid: -1,
      });

      // Should succeed with 200
      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
      expect(typeof voteResponse.body.currentPid).toBe("number");
    });
  });

  describe("Hybrid Authentication", () => {
    test("endpoints should work correctly with XID JWTs", async () => {
      const xidUser = createXidTestUser(conversationId);
      const { agent, token } = await getXidAuthenticatedAgent(xidUser);

      // Verify we have a valid token
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");

      // Test with votes endpoint that should work with XID JWT
      const response = await agent.get(
        `/api/v3/votes?conversation_id=${conversationId}&pid=-1`
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      console.log(
        "✅ Hybrid authentication middleware correctly handles XID JWT"
      );
    });

    test("votes endpoint should work with both authenticated and unauthenticated requests", async () => {
      // Test unauthenticated request
      const unauthAgent = await newAgent();
      const unauthResponse = await unauthAgent.get(
        `/api/v3/votes?conversation_id=${conversationId}&pid=-1`
      );

      expect(unauthResponse.status).toBe(200);
      expect(unauthResponse.body).toBeInstanceOf(Array);

      // Test XID authenticated request
      const xidUser = createXidTestUser(conversationId);
      const { agent: authAgent } = await getXidAuthenticatedAgent(xidUser);

      const authResponse = await authAgent.get(
        `/api/v3/votes?conversation_id=${conversationId}&pid=-1`
      );

      expect(authResponse.status).toBe(200);
      expect(authResponse.body).toBeInstanceOf(Array);

      console.log(
        "✅ Votes endpoint works for both authenticated and unauthenticated requests"
      );
    });
  });
});
