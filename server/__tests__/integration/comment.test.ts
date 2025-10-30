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
    const responseBody = JSON.parse(listResponse.text);
    const comments: Comment[] = Array.isArray(responseBody)
      ? responseBody
      : responseBody.comments;
    expect(Array.isArray(comments)).toBe(true);
    const foundComment = comments.find(
      (comment: Comment) => comment.tid === commentId
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
    const responseBody = JSON.parse(listResponse.text);
    const comments: Comment[] = Array.isArray(responseBody)
      ? responseBody
      : responseBody.comments;
    expect(Array.isArray(comments)).toBe(true);
    const foundComment = comments.find(
      (comment: Comment) => comment.tid === commentId
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
    const responseBody = JSON.parse(listResponse.text);
    const comments: Comment[] = Array.isArray(responseBody)
      ? responseBody
      : responseBody.comments;
    expect(Array.isArray(comments)).toBe(true);
    const foundComment = comments.find(
      (comment: Comment) => comment.tid === commentId
    );
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });

  test("GET comments returns all comments in conversation, not just current participant's comments", async () => {
    // This test verifies the fix for the issue where GET comments was incorrectly
    // filtering to only show comments created by the current participant (pid),
    // instead of showing all comments in the conversation.

    const timestamp = Date.now();

    // STEP 1: Create multiple comments by different participants
    // Admin/owner creates a seed comment
    const adminCommentText = `Admin seed comment ${timestamp}`;
    const adminCommentId = await createComment(agent, conversationId, {
      txt: adminCommentText,
    });

    // Initialize a participant and create a comment
    const { agent: participantAgent } = await initializeParticipant(
      conversationId
    );
    const participantCommentText = `Participant comment ${timestamp}`;
    const participantCommentResponse = await submitComment(participantAgent, {
      conversation_id: conversationId,
      txt: participantCommentText,
      agid: 1, // Required for anonymous participant authentication
    });

    expect(participantCommentResponse.status).toBe(200);
    const participantCommentId = participantCommentResponse.body.tid;

    // If JWT was issued after comment creation, use it for subsequent requests
    if (
      participantCommentResponse.body.auth &&
      participantCommentResponse.body.auth.token
    ) {
      participantAgent.set(
        "Authorization",
        `Bearer ${participantCommentResponse.body.auth.token}`
      );
    }

    // STEP 2: Verify that the participant can see ALL comments, not just their own
    const allCommentsResponse: Response = await participantAgent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );

    expect(allCommentsResponse.status).toBe(200);
    const allCommentsBody = JSON.parse(allCommentsResponse.text);
    const allComments: Comment[] = Array.isArray(allCommentsBody)
      ? allCommentsBody
      : allCommentsBody.comments;
    expect(Array.isArray(allComments)).toBe(true);
    expect(allComments.length).toBeGreaterThanOrEqual(2);

    // Verify both comments are present
    const foundAdminComment = allComments.find(
      (comment: Comment) => comment.tid === adminCommentId
    );
    const foundParticipantComment = allComments.find(
      (comment: Comment) => comment.tid === participantCommentId
    );

    expect(foundAdminComment).toBeDefined();
    expect(foundAdminComment!.txt).toBe(adminCommentText);
    expect(foundParticipantComment).toBeDefined();
    expect(foundParticipantComment!.txt).toBe(participantCommentText);

    // STEP 3: Verify that admin also sees all comments
    const adminViewResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );

    expect(adminViewResponse.status).toBe(200);
    const adminViewBody = JSON.parse(adminViewResponse.text);
    const adminComments: Comment[] = Array.isArray(adminViewBody)
      ? adminViewBody
      : adminViewBody.comments;
    expect(Array.isArray(adminComments)).toBe(true);
    expect(adminComments.length).toBeGreaterThanOrEqual(2);

    // Verify admin sees both comments too
    const adminFoundAdminComment = adminComments.find(
      (comment: Comment) => comment.tid === adminCommentId
    );
    const adminFoundParticipantComment = adminComments.find(
      (comment: Comment) => comment.tid === participantCommentId
    );

    expect(adminFoundAdminComment).toBeDefined();
    expect(adminFoundParticipantComment).toBeDefined();
  });

  test("Comment pagination works correctly", async () => {
    // Create multiple comments for pagination testing
    const commentCount = 10;
    const createdCommentIds: number[] = [];

    for (let i = 0; i < commentCount; i++) {
      const commentId = await createComment(agent, conversationId, {
        txt: `Pagination test comment ${i}`,
      });
      createdCommentIds.push(commentId);
    }

    // Test 1: Get first page with limit 3
    const page1Response: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&limit=3&offset=0`
    );
    expect(page1Response.status).toBe(200);
    const page1Body = JSON.parse(page1Response.text);
    expect(page1Body).toHaveProperty("comments");
    expect(page1Body).toHaveProperty("pagination");
    expect(page1Body.comments.length).toBe(3);
    expect(page1Body.pagination.limit).toBe(3);
    expect(page1Body.pagination.offset).toBe(0);
    expect(page1Body.pagination.total).toBeGreaterThanOrEqual(commentCount);
    expect(page1Body.pagination.hasMore).toBe(true);

    // Test 2: Get second page with limit 3, offset 3
    const page2Response: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&limit=3&offset=3`
    );
    expect(page2Response.status).toBe(200);
    const page2Body = JSON.parse(page2Response.text);
    expect(page2Body.comments.length).toBe(3);
    expect(page2Body.pagination.limit).toBe(3);
    expect(page2Body.pagination.offset).toBe(3);
    expect(page2Body.pagination.hasMore).toBe(true);

    // Test 3: Verify no duplicate comments between pages
    const page1Tids = page1Body.comments.map((c: Comment) => c.tid);
    const page2Tids = page2Body.comments.map((c: Comment) => c.tid);
    const intersection = page1Tids.filter((tid: number) =>
      page2Tids.includes(tid)
    );
    expect(intersection.length).toBe(0);

    // Test 4: Request with no limit/offset should use defaults
    const defaultResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );
    expect(defaultResponse.status).toBe(200);
    const defaultBody = JSON.parse(defaultResponse.text);
    const defaultComments: Comment[] = Array.isArray(defaultBody)
      ? defaultBody
      : defaultBody.comments;
    expect(Array.isArray(defaultComments)).toBe(true);
    expect(defaultComments.length).toBeGreaterThan(0);
  });
});
