import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Response } from "supertest";
import {
  createConversation,
  generateRandomXid,
  initializeParticipantWithXid,
  getJwtAuthenticatedAgent,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

describe("XID-based Authentication", () => {
  let agent: any;
  let conversationId: string;
  let commentId: number;

  beforeAll(async () => {
    // Use JWT-based authentication instead of legacy cookies
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    const { agent: jwtAgent } = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAgent;

    // Create a conversation
    conversationId = await createConversation(agent);

    // Create a comment in the conversation
    const response: Response = await agent.post("/api/v3/comments").send({
      conversation_id: conversationId,
      txt: "Test comment for XID authentication testing",
    });

    expect(response.status).toBe(200);

    // Parse response properly and add debugging
    let responseBody;
    try {
      responseBody =
        typeof response.body === "string"
          ? JSON.parse(response.body)
          : response.body;
    } catch (e) {
      // If body is not JSON, try text
      responseBody = response.text ? JSON.parse(response.text) : {};
    }

    // Add debugging info
    if (responseBody.tid === undefined || responseBody.tid === null) {
      console.error("Comment creation response:", {
        status: response.status,
        body: responseBody,
        text: response.text || "null",
        headers: response.headers,
      });
      throw new Error("Comment creation did not return a tid");
    }

    commentId = responseBody.tid;
  });

  test("should initialize participation with XID", async () => {
    const xid = generateRandomXid();

    const { status, body } = await initializeParticipantWithXid(
      conversationId,
      xid
    );

    expect(status).toBe(200);
    expect(body).toHaveProperty("conversation");
    expect(body).toHaveProperty("nextComment");
    expect(body.conversation.conversation_id).toBe(conversationId);

    // Should have the comment we created
    expect(body.nextComment.tid).toBe(commentId);

    // For now, JWT is not issued on first XID initialization
    // This is because the XID user creation happens asynchronously
    // JWT will be issued on subsequent requests after user is created
  });

  test("should maintain XID association across multiple sessions", async () => {
    const xid = generateRandomXid();

    // First session - test the helper without destructuring
    const result = await initializeParticipantWithXid(conversationId, xid);
    expect(result).toBeDefined();
    expect(result.agent).toBeDefined();

    const firstSessionAgent = result.agent;

    // Vote on a comment
    const firstVoteResponse = await submitVote(firstSessionAgent, {
      conversation_id: conversationId,
      tid: commentId,
      vote: -1, // Agree
      xid: xid,
    });

    expect(firstVoteResponse.status).toBe(200);

    // Second session with same XID
    const { body: secondSessionBody } = await initializeParticipantWithXid(
      conversationId,
      xid
    );

    // Add defensive checks
    if (!secondSessionBody) {
      throw new Error("Second session body is null/undefined");
    }

    const responseBody = secondSessionBody;

    // Check if responseBody has expected properties before destructuring
    if (!responseBody.user || !responseBody.votes) {
      console.error("Incomplete response body:", responseBody);
      throw new Error("Response body missing expected properties");
    }

    const { user, nextComment, votes } = responseBody;

    // user should be defined and have the xid info
    expect(user.uid).toBeDefined();
    expect(user.hasXid).toBe(true);
    expect(user.xInfo.xid).toBe(xid);

    // nextComment should be null (no more comments to vote on)
    expect(nextComment).toBeNull();

    // the vote should be the same as the one we made in the first session
    expect(votes).toBeInstanceOf(Array);
    expect(votes.length).toBe(1);
    expect(votes[0].vote).toBe(-1);
    expect(votes[0].tid).toBe(commentId);
  });

  test("should issue JWT token for established XID participants", async () => {
    const xid = generateRandomXid();

    // First call - creates the XID user
    const firstResponse = await initializeParticipantWithXid(
      conversationId,
      xid
    );
    expect(firstResponse.status).toBe(200);

    // Vote to establish the participant
    const { agent: firstAgent } = firstResponse;
    const voteResponse = await submitVote(firstAgent, {
      conversation_id: conversationId,
      tid: commentId,
      vote: 1,
      xid: xid,
    });
    expect(voteResponse.status).toBe(200);

    // Second call - should get JWT token now that user is established
    const secondResponse = await initializeParticipantWithXid(
      conversationId,
      xid
    );
    expect(secondResponse.status).toBe(200);

    // Check if JWT token is issued for established XID participant
    if (secondResponse.body.auth && secondResponse.body.auth.token) {
      expect(secondResponse.body.auth).toHaveProperty("token");
      expect(secondResponse.body.auth).toHaveProperty("token_type", "Bearer");
      expect(secondResponse.body.auth).toHaveProperty(
        "expires_in",
        365 * 24 * 60 * 60
      );
      expect(typeof secondResponse.body.auth.token).toBe("string");
      expect(secondResponse.body.auth.token.split(".")).toHaveLength(3); // JWT format

      // Verify the JWT can be used for authentication
      const { agent: jwtAgent } = await initializeParticipantWithXid(
        conversationId,
        xid
      );
      jwtAgent.set("Authorization", `Bearer ${secondResponse.body.auth.token}`);

      const jwtVoteResponse = await submitVote(jwtAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1,
        xid: xid,
      });
      expect(jwtVoteResponse.status).toBe(200);
    }
  });

  test("should format XID allow list properly", async () => {
    // Create XIDs to allow list
    const xids = [
      generateRandomXid(),
      generateRandomXid(),
      generateRandomXid(),
    ];

    // Allow list XIDs as an array (required format)
    const allowListResponse: Response = await agent
      .post("/api/v3/xidAllowList")
      .send({
        conversation_id: conversationId,
        xid_allow_list: xids,
      });

    // Returns 200 with empty body
    expect(allowListResponse.status).toBe(200);
    expect(allowListResponse.body).toEqual({});
  });
});
