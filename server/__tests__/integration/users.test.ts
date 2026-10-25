import { beforeAll, describe, expect, test } from "@jest/globals";
import { getPooledTestUser } from "../setup/test-user-helpers";
import {
  getJwtAuthenticatedAgent,
  initializeParticipantWithXid,
  setupAuthAndConvo,
  newAgent,
} from "../setup/api-test-helpers";
import type { Agent, Response } from "supertest";
import { toWire } from "../setup/vote-wire";
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

    describe("XID lookup authorization", () => {
      let ownerAgent: Agent;
      let xidAgent: Agent;
      let ownerUid: number;
      let xidUid: number;
      const testXid = "test-user-xid-123";

      beforeAll(async () => {
        ({ agent: ownerAgent } = await getJwtAuthenticatedAgent(jwtTestUser1));
        // Initialize XID participant
        ({ agent: xidAgent } = await initializeParticipantWithXid(
          conversationId,
          testXid
        ));

        // participationInit creates the XID record; retain the voting fixture.
        // Get the first comment to vote on.
        const commentsResponse = await ownerAgent.get(
          `/api/v3/comments?conversation_id=${conversationId}&modIn=true`
        );
        expect(commentsResponse.status).toBe(200);
        const comments = Array.isArray(commentsResponse.body)
          ? commentsResponse.body
          : commentsResponse.body.comments;
        expect(comments.length).toBeGreaterThan(0);

        // Have the XID participant vote on the comment
        const voteResponse = await xidAgent.post("/api/v3/votes").send({
          conversation_id: conversationId,
          tid: comments[0].tid,
          vote: toWire("agree"), // was a literal 1, which is disagree on the wire
          xid: testXid,
        });
        expect(voteResponse.status).toBe(200);

        // Get conversation details to find the owner uid
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

        // XID records are now scoped by conversation owner's uid
        ownerUid = conversation.owner;
        expect(ownerUid).toBeDefined();

        const selfResponse = await xidAgent.get("/api/v3/users");
        expect(selfResponse.status).toBe(200);
        xidUid = selfResponse.body.uid;
        expect(typeof xidUid).toBe("number");
        expect(xidUid).not.toBe(ownerUid);
      });

      test("should handle user lookup by XID for the owner", async () => {
        // Now the XID user should be lookup-able using the conversation owner's uid
        const lookupResponse: Response = await ownerAgent.get(
          `/api/v3/users?owner_uid=${ownerUid}&xid=${testXid}`
        );
        expect(lookupResponse.status).toBe(200);

        const userLookup = lookupResponse.body as UserInfo;
        expect(userLookup.uid).toBe(xidUid);
        expect(userLookup).toHaveProperty("hasXid", true);
        expect(userLookup).toHaveProperty("xInfo");
        expect(userLookup.xInfo).toHaveProperty("xid", testXid);
      });

      test("should allow the XID user to read its own record", async () => {
        const response = await xidAgent.get("/api/v3/users").query({
          owner_uid: ownerUid,
          xid: testXid,
        });

        expect(response.status).toBe(200);
        expect(response.body.uid).toBe(xidUid);
        expect(response.body.hasXid).toBe(true);
        expect(response.body.xInfo.xid).toBe(testXid);
      });

      test("should refuse the same XID token from another owner's conversation", async () => {
        const otherOwner = getPooledTestUser(4);
        const otherConvo = await setupAuthAndConvo({
          createConvo: true,
          userData: {
            email: otherOwner.email,
            password: otherOwner.password,
            hname: otherOwner.name,
          },
        });
        expect(otherConvo.userId).toBeGreaterThan(0);
        expect(otherConvo.userId).not.toBe(ownerUid);

        const { agent: otherXidAgent } = await initializeParticipantWithXid(
          otherConvo.conversationId,
          testXid
        );
        const selfResponse = await otherXidAgent.get("/api/v3/users");
        expect(selfResponse.status).toBe(200);
        expect(typeof selfResponse.body.uid).toBe("number");
        expect(selfResponse.body.uid).not.toBe(ownerUid);
        expect(selfResponse.body.uid).not.toBe(xidUid);

        // Participant tokens also supply xid when the query omits it.
        for (const query of [
          { owner_uid: ownerUid, xid: testXid },
          { owner_uid: ownerUid },
        ]) {
          const response = await otherXidAgent
            .get("/api/v3/users")
            .query(query);
          expect(response.status).toBe(403);
          expect(response.body.error).toBe("polis_err_get_user_not_authorized");
          for (const field of [
            "uid",
            "email",
            "hname",
            "site_ids",
            "xInfo",
            "hasXid",
          ]) {
            expect(response.body).not.toHaveProperty(field);
          }
        }
      });

      test.each([testXid, "nonexistent-user-xid"])(
        "should refuse an unrelated signed-in user for XID %s",
        async (requestedXid) => {
          const stranger = getPooledTestUser(3);
          const { agent: strangerAgent } = await getJwtAuthenticatedAgent({
            email: stranger.email,
            password: stranger.password,
            hname: stranger.name,
          });
          const selfResponse = await strangerAgent.get("/api/v3/users");
          expect(selfResponse.status).toBe(200);
          expect(selfResponse.body.uid).not.toBe(ownerUid);
          expect(selfResponse.body.uid).not.toBe(xidUid);

          const response = await strangerAgent.get("/api/v3/users").query({
            owner_uid: ownerUid,
            xid: requestedXid,
          });

          expect(response.status).toBe(403);
          expect(response.body.error).toBe("polis_err_get_user_not_authorized");
          for (const field of ["uid", "email", "hname", "site_ids", "xInfo"]) {
            expect(response.body).not.toHaveProperty(field);
          }
        }
      );
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
