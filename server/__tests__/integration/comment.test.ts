import { beforeEach, describe, expect, test } from "@jest/globals";
import type { Response } from "supertest";
import type { Agent } from "supertest";
import {
  createComment,
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  submitComment,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { TestUser } from "../../types/test-helpers";

interface Comment {
  tid: number;
  txt: string;
  conversation_id: string;
  created: number;
  [key: string]: any;
}

describe("Comment Endpoints", () => {
  let agent: Agent;
  let conversationId: string;
  let testUser: TestUser;

  beforeEach(async () => {
    const pooledUser = getPooledTestUser(1);
    testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get a JWT authenticated agent
    const authResult = await getJwtAuthenticatedAgent(testUser);
    agent = authResult.agent;

    // Create a test conversation for each test
    conversationId = await createConversation(agent, {
      is_active: true,
      topic: "Comment Test Conversation",
    });
  });

  test("Comment lifecycle", async () => {
    // STEP 1: Create a new comment
    const timestamp = Date.now();
    const commentText = `Test comment ${timestamp}`;
    const commentId = await createComment(agent, conversationId, {
      conversation_id: conversationId,
      txt: commentText,
    });

    expect(commentId).toBeDefined();

    // STEP 2: Verify comment appears in conversation
    const listResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );
    expect(listResponse.status).toBe(200);
    const responseBody: Comment[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    const foundComment = responseBody.find(
      (comment) => comment.tid === commentId
    );
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });

  test("Comment validation", async () => {
    // Test invalid conversation ID
    const invalidResponse = await agent.post("/api/v3/comments").send({
      conversation_id: "invalid-conversation-id",
      txt: "This comment should fail",
    });

    expect(invalidResponse.status).toBe(400);

    // Test missing conversation ID in comments list
    const missingConvResponse = await agent.get("/api/v3/comments");
    expect(missingConvResponse.status).toBe(400);
  });

  test("Anonymous participant can submit a comment", async () => {
    // First, create a seed comment with the authenticated agent to ensure the conversation is not empty.
    // This allows the anonymous participant to authenticate by voting.
    await createComment(agent, conversationId, {
      txt: "Initial comment to enable anonymous participation.",
    });

    // Initialize anonymous participant
    const { agent: anonAgent } = await initializeParticipant(conversationId);

    // Create a comment as anonymous participant
    // Note: Anonymous participants don't get JWT tokens from participationInit,
    // they get them after their first participation (vote or comment)
    const timestamp = Date.now();
    const commentText = `Anonymous participant comment ${timestamp}`;
    const commentResponse = await submitComment(anonAgent, {
      conversation_id: conversationId,
      txt: commentText,
      agid: 1, // Required for anonymous participant authentication
    });

    // Log the response if it's not 200
    if (commentResponse.status !== 200) {
      console.error("Anonymous comment failed:", {
        status: commentResponse.status,
        body: commentResponse.body,
        text: commentResponse.text,
      });
    }

    expect(commentResponse.status).toBe(200);
    console.log("commentResponse.body", commentResponse.body);
    expect(commentResponse.body).toHaveProperty("tid");
    const commentId = commentResponse.body.tid;

    // Check if JWT was issued after comment creation
    if (commentResponse.body.auth && commentResponse.body.auth.token) {
      // Use the JWT for subsequent requests
      anonAgent.set(
        "Authorization",
        `Bearer ${commentResponse.body.auth.token}`
      );
    }

    // Verify the comment appears in the conversation
    const listResponse: Response = await anonAgent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );

    expect(listResponse.status).toBe(200);
    const responseBody: Comment[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    const foundComment = responseBody.find(
      (comment) => comment.tid === commentId
    );
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });

  test("XID participant can submit a comment", async () => {
    // First, create a seed comment with the authenticated agent to ensure the conversation is not empty.
    // This allows the XID participant to authenticate by voting.
    await createComment(agent, conversationId, {
      txt: "Initial comment to enable XID participation.",
    });

    // Initialize participant with XID
    const xid = generateRandomXid();
    const { agent: xidAgent, token: xidToken } =
      await initializeParticipantWithXid(conversationId, xid);

    // Create a comment as XID participant using the helper
    const timestamp = Date.now();
    const commentText = `XID participant comment ${timestamp}`;

    // Set the XID JWT token on the agent before using submitComment
    if (xidToken) {
      xidAgent.set("Authorization", `Bearer ${xidToken}`);
    }

    const commentResponse = await submitComment(xidAgent, {
      conversation_id: conversationId,
      txt: commentText,
    });

    expect(commentResponse.status).toBe(200);
    expect(commentResponse.body).toHaveProperty("tid");
    const commentId = commentResponse.body.tid;
    expect(commentId).toBeDefined();

    // Verify the comment appears in the conversation
    const listResponse: Response = await xidAgent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );

    expect(listResponse.status).toBe(200);
    const responseBody: Comment[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    const foundComment = responseBody.find(
      (comment) => comment.tid === commentId
    );
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });
});
