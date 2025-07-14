import { beforeEach, describe, expect, test } from "@jest/globals";
import type { Response } from "supertest";
import type { Agent } from "supertest";
import {
  createComment,
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

interface ConversationStats {
  voteTimes: number[];
  firstVoteTimes: number[];
  commentTimes: number[];
  firstCommentTimes: number[];
  votesHistogram: any;
  burstHistogram: any;
  [key: string]: any;
}

describe("Conversation Stats API", () => {
  let agent: Agent;
  let conversationId: string;

  beforeEach(async () => {
    // Use JWT-based authentication with pooled users (which exist in OIDC simulator)
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT authenticated agent
    const { agent: jwtAgent } = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAgent;

    // Create a conversation
    conversationId = await createConversation(agent);

    // Initialize a participant
    const participantResult = await initializeParticipant(conversationId);
    const participantAgent = participantResult.agent;

    // Create a comment as the owner
    const commentId = await createComment(agent, conversationId, {
      conversation_id: conversationId,
      txt: "This is a test comment",
    });

    // Cast a vote as a participant
    await submitVote(participantAgent, {
      conversation_id: conversationId,
      tid: commentId,
      vote: 1,
    });
  });

  test("GET /api/v3/conversationStats - should return stats for conversation owner", async () => {
    const response: Response = await agent.get(
      `/api/v3/conversationStats?conversation_id=${conversationId}`
    );

    // Should return successful response
    expect(response.status).toBe(200);

    // Response should be JSON and contain stats data
    const data: ConversationStats = JSON.parse(response.text);
    expect(data).toHaveProperty("voteTimes");
    expect(data).toHaveProperty("firstVoteTimes");
    expect(data).toHaveProperty("commentTimes");
    expect(data).toHaveProperty("firstCommentTimes");
    expect(data).toHaveProperty("votesHistogram");
    expect(data).toHaveProperty("burstHistogram");

    // Should have two comment times (seed comment + test comment)
    expect(data.commentTimes.length).toBe(2);

    // Should have three vote times (auth user votes on seed comment, auth user implicit vote on test comment creation, participant vote)
    expect(data.voteTimes.length).toBe(3);
  });

  test("GET /api/v3/conversationStats - should accept until parameter", async () => {
    // Get current time in milliseconds
    const currentTimeMs = Date.now();

    const response: Response = await agent.get(
      `/api/v3/conversationStats?conversation_id=${conversationId}&until=${currentTimeMs}`
    );

    // Should return successful response
    expect(response.status).toBe(200);

    // Response should be JSON and contain stats data
    const data: ConversationStats = JSON.parse(response.text);

    // All the data should be present because until is in the future
    expect(data.commentTimes.length).toBe(2);
    expect(data.voteTimes.length).toBe(3);
  });

  test("GET /api/v3/conversationStats - should filter data with until parameter", async () => {
    // Get time from yesterday (before our test data was created)
    const yesterdayMs = Date.now() - 24 * 60 * 60 * 1000;

    const response: Response = await agent.get(
      `/api/v3/conversationStats?conversation_id=${conversationId}&until=${yesterdayMs}`
    );

    // Should return successful response
    expect(response.status).toBe(200);

    // Response should be JSON and contain stats data with no entries
    const data: ConversationStats = JSON.parse(response.text);

    // No data should be present because until is in the past
    expect(data.commentTimes.length).toBe(0);
    expect(data.voteTimes.length).toBe(0);
  });
});
