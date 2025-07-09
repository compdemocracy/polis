import { beforeEach, describe, expect, test } from "@jest/globals";
import type { Response } from "supertest";
import {
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

describe("Participation API", () => {
  let conversationId: string;

  beforeEach(async () => {
    // Use setupAuthAndConvo which properly handles JWT authentication
    const { conversationId: cid } = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 1,
    });
    conversationId = cid;
  });

  test("should initialize anonymous participation", async () => {
    const { body, status, agent } = await initializeParticipant(conversationId);

    expect(status).toBe(200);
    expect(body).toHaveProperty("conversation");
    expect(body).toHaveProperty("nextComment");
    expect(body.conversation.conversation_id).toBe(conversationId);
    expect(agent).toBeDefined();
  });

  test("should initialize XID participation", async () => {
    const testXid = generateRandomXid();
    const { body, status, agent } = await initializeParticipantWithXid(
      conversationId,
      testXid
    );

    expect(status).toBe(200);
    expect(body).toHaveProperty("conversation");
    expect(body).toHaveProperty("nextComment");
    expect(body.conversation.conversation_id).toBe(conversationId);
    expect(agent).toBeDefined();
  });

  test("anonymous participant should not see already voted comments after refresh", async () => {
    // Step 1: Initialize anonymous participant (no auth)
    const { body: initialBody, agent } = await initializeParticipant(
      conversationId
    );

    expect(initialBody.nextComment).toBeDefined();
    expect(initialBody.nextComment.tid).toBeDefined();

    // Step 2: Vote on ALL available comments to test proper filtering
    let currentResponse = initialBody;
    const votedComments: number[] = [];

    while (currentResponse.nextComment) {
      const commentId = currentResponse.nextComment.tid;
      votedComments.push(commentId);

      // Vote on the current comment
      const voteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 1, // Agree
      });

      expect(voteResponse.status).toBe(200);

      // Get the next comment after voting
      const nextResponse: Response = await agent.get(
        `/api/v3/participationInit?conversation_id=${conversationId}&pid=-1&lang=en`
      );

      expect(nextResponse.status).toBe(200);
      currentResponse = JSON.parse(nextResponse.text);
    }

    // Step 3: Final check - after voting on all comments, nextComment should be null
    // The key assertion: after voting on all available comments, nextComment should be null
    expect(currentResponse.nextComment).toBeNull();

    // Verify we have votes recorded for all the comments we voted on
    expect(currentResponse.votes).toBeDefined();
    expect(currentResponse.votes.length).toBe(votedComments.length);

    // Verify each vote is recorded
    for (const commentId of votedComments) {
      const hasVote = currentResponse.votes.some(
        (vote: any) => vote.tid === commentId
      );
      expect(hasVote).toBe(true);
    }
  });

  test("Participation validation", async () => {
    // Get a JWT authenticated agent for testing validation
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };
    const { agent } = await getJwtAuthenticatedAgent(testUser);

    // Test missing conversation ID in participation
    const missingConvResponse: Response = await agent.get(
      "/api/v3/participation"
    );
    expect(missingConvResponse.status).toBe(400);

    // Test missing conversation ID in participationInit
    const missingConvInitResponse: Response = await agent.get(
      "/api/v3/participationInit"
    );
    expect(missingConvInitResponse.status).toBe(200);
    const responseBody = JSON.parse(missingConvInitResponse.text);
    expect(responseBody).toBeDefined();
    expect(responseBody.conversation).toBeNull();
  });
});
