import { beforeAll, describe, expect, test } from "@jest/globals";
import { getPooledTestUser } from "../setup/test-user-helpers";
import {
  getJwtAuthenticatedAgent,
  initializeParticipantWithXid,
  setupAuthAndConvo,
  newAgent,
} from "../setup/api-test-helpers";
import type { Response } from "supertest";
import type { TestUser } from "../../types/test-helpers";

interface UserInfo {
  uid: number;
  email: string;
  hname: string;
  hasXid?: boolean;
  xInfo?: any;
  finishedTutorial?: boolean;
  site_ids?: number[];
  created?: number;
}

describe("User Management Endpoints", () => {
  let jwtTestUser1: TestUser;
  let conversationId: string;

  beforeAll(async () => {
    // Use pooled test users for JWT testing
    const pooledUser1 = getPooledTestUser(1);

    jwtTestUser1 = {
      email: pooledUser1.email,
      password: pooledUser1.password,
      hname: pooledUser1.name,
    };

    // Set up conversation with JWT authentication
    const convoData = await setupAuthAndConvo({
      createConvo: true,
      userData: jwtTestUser1,
    });
    conversationId = convoData.conversationId;
  });

  describe("GET /users", () => {
    test("should get the current user info when authenticated (JWT)", async () => {
      const { agent: jwtAgent } = await getJwtAuthenticatedAgent(jwtTestUser1);

      const response: Response = await jwtAgent.get("/api/v3/users");
      expect(response.status).toBe(200);

      const userInfo = response.body as UserInfo;
      expect(userInfo).toHaveProperty("uid");
      expect(typeof userInfo.uid).toBe("number");
      expect(userInfo).toHaveProperty("email");
      expect(userInfo).toHaveProperty("hname");
    });

    test("should require authentication", async () => {
      const unauthAgent = await newAgent();
      const response: Response = await unauthAgent.get("/api/v3/users");
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error");
    });

    test("should handle user lookup by XID", async () => {
      const { agent: ownerAgent } = await getJwtAuthenticatedAgent(
        jwtTestUser1
      );
      const testXid = "test-user-xid-123";

      // Initialize XID participant
      const { agent: xidAgent } = await initializeParticipantWithXid(
        conversationId,
        testXid
      );

      // XID users need to take an action (vote/comment) before they become lookup-able
      // Get the first comment to vote on
      const commentsResponse = await ownerAgent.get(
        `/api/v3/comments?conversation_id=${conversationId}&modIn=true`
      );
      expect(commentsResponse.status).toBe(200);
      const comments = commentsResponse.body;
      expect(comments.length).toBeGreaterThan(0);

      // Have the XID participant vote on the comment
      const voteResponse = await xidAgent.post("/api/v3/votes").send({
        conversation_id: conversationId,
        tid: comments[0].tid,
        vote: 1, // agree
        xid: testXid, // Include XID parameter for XID record creation
      });
      expect(voteResponse.status).toBe(200);

      // Get conversation details to find the org_id
      const conversationResponse = await ownerAgent.get(
        `/api/v3/conversations?conversation_id=${conversationId}`
      );
      expect(conversationResponse.status).toBe(200);

      // Handle different response formats
      let conversation;
      if (Array.isArray(conversationResponse.body)) {
        conversation = conversationResponse.body[0];
      } else {
        conversation = conversationResponse.body;
      }

      expect(conversation).toBeDefined();

      // The org_id should be the same as owner for test conversations
      const orgId = conversation.org_id || conversation.owner;
      expect(orgId).toBeDefined();

      // Now the XID user should be lookup-able using the conversation's org_id
      const lookupResponse: Response = await ownerAgent.get(
        `/api/v3/users?owner_uid=${orgId}&xid=${testXid}`
      );
      expect(lookupResponse.status).toBe(200);

      const userLookup = lookupResponse.body as UserInfo;
      expect(userLookup).toHaveProperty("hasXid", true);
      expect(userLookup).toHaveProperty("xInfo");
      expect(userLookup.xInfo).toHaveProperty("xid", testXid);
    });
  });

  describe("POST /users/invite", () => {
    test("should send invites to a conversation with JWT authentication", async () => {
      const { agent: jwtAgent } = await getJwtAuthenticatedAgent(jwtTestUser1);

      // Create a new conversation for this test
      const convResponse = await jwtAgent.post("/api/v3/conversations").send({
        topic: "JWT Invite Test Conversation",
        description: "Test conversation for JWT invites",
        is_active: true,
        is_anon: true,
        is_draft: false,
        strict_moderation: false,
        profanity_filter: false,
      });

      expect(convResponse.status).toBe(200);
      const testConversationId = convResponse.body.conversation_id;

      const emails = "jwt-test1@example.com,jwt-test2@example.com";

      const response: Response = await jwtAgent
        .post("/api/v3/users/invite")
        .send({
          conversation_id: testConversationId,
          emails,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "success");
    });

    test("should require authentication", async () => {
      const unauthAgent = await newAgent();
      const emails = "test@example.com";

      const response: Response = await unauthAgent
        .post("/api/v3/users/invite")
        .send({
          conversation_id: conversationId,
          emails,
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error");
    });

    test("should require valid conversation ID", async () => {
      const { agent: jwtAgent } = await getJwtAuthenticatedAgent(jwtTestUser1);
      const emails = "test@example.com";

      const response: Response = await jwtAgent
        .post("/api/v3/users/invite")
        .send({
          conversation_id: "invalid-conversation-id",
          emails,
        });

      expect(response.status).toBe(400);
      expect(response.text).toContain(
        "polis_err_param_parse_failed_conversation_id"
      );
    });

    test("should require email addresses", async () => {
      const { agent: jwtAgent } = await getJwtAuthenticatedAgent(jwtTestUser1);

      const response: Response = await jwtAgent
        .post("/api/v3/users/invite")
        .send({
          conversation_id: conversationId,
          // Missing emails field
        });

      expect(response.status).toBe(400);
      expect(response.text.trim()).toBe("polis_err_param_missing_emails");
    });
  });
});
