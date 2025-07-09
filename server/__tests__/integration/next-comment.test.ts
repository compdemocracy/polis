import { beforeAll, describe, expect, test, jest } from "@jest/globals";
import type { Response } from "supertest";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";

import { getPooledTestUser } from "../setup/test-user-helpers";
import type { TestUser } from "../../types/test-helpers";

jest.mock("fs/promises", () => ({
  readFile: jest.fn().mockImplementation((path) => {
    if ((path as string).endsWith("script.xml")) {
      return Promise.resolve(`
        <polis_moderation_rubric>
          <children></children> 
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children> 
          <children>
            <task>
              <children></children> 
              <children>
                 
              </children>
            </task>
          </children>
        </polis_moderation_rubric>
      `);
    }
    if ((path as string).endsWith("system.xml")) {
      return Promise.resolve("<system_lore>System lore content</system_lore>");
    }
    return Promise.reject(new Error(`File not found in mock: ${path}`));
  }),
}));

// @ts-expect-error mock
const mockGenerateContent = jest.fn().mockResolvedValue({
  text: JSON.stringify({
    output: {
      base_score: "0.9",
      substance_level: "High",
      multiplier: "1.2",
      final_score: "1.08",
      decision: "APPROVE",
    },
  }),
});

jest.mock("@google/genai", () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => {
      return {
        models: {
          generateContent: mockGenerateContent,
        },
      };
    }),
  };
});

describe("Next Comment Endpoint", () => {
  // Declare agent variables
  let agent: Agent;
  let testAgent: Agent;
  let conversationId: string | null = null;
  let commentIds: number[] = [];
  let testUser: TestUser;
  let token: string;

  beforeAll(async () => {
    const pooledUser = getPooledTestUser(1);
    testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT token and agent
    const authResult = await getJwtAuthenticatedAgent(testUser);
    agent = authResult.agent;
    token = authResult.token;

    // Create agent for handling responses
    testAgent = await newAgent();
    setAgentJwt(testAgent, token);

    // Create test conversation
    conversationId = await createConversation(agent, {
      topic: "Next Comment Test Conversation",
    });

    // Create multiple comments directly to avoid duplicates
    const timestamp = Date.now();
    commentIds = [];

    for (let i = 1; i <= 5; i++) {
      const createResponse: Response = await agent
        .post("/api/v3/comments")
        .send({
          conversation_id: conversationId,
          txt: `Test comment ${i} ${timestamp}`,
        });
      expect(createResponse.status).toBe(200);
      const commentId = JSON.parse(createResponse.text).tid;
      commentIds.push(commentId);
    }

    // Ensure we have comments to work with
    expect(commentIds.length).toBe(5);
  });

  test("GET /nextComment - Get next comment for voting", async () => {
    // Request the next comment for voting
    const response: Response = await agent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}`
    );

    // Validate response
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // The response should have a tid (comment ID) and txt (comment text)
    expect(response.body.tid).toBeDefined();
    expect(response.body.txt).toBeDefined();

    // The returned comment should be one of our test comments
    expect(commentIds).toContain(response.body.tid);
  });

  test("GET /nextComment - Anonymous users can get next comment", async () => {
    // Initialize anonymous participant
    const { agent: anonAgent } = await initializeParticipant(conversationId!);

    // Request next comment as anonymous user
    const response: Response = await anonAgent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}`
    );

    // Validate response
    expect(response.status).toBe(200);

    // Response data is automatically parsed into response.body
    const responseData = response.body;
    expect(responseData).toBeDefined();
    expect(responseData.tid).toBeDefined();
    expect(responseData.txt).toBeDefined();
  });

  test("GET /nextComment - Respect not_voted_by_pid parameter", async () => {
    // Initialize a new participant
    const { agent: firstAgent, body: initBody } = await initializeParticipant(
      conversationId!
    );
    expect(initBody.nextComment).toBeDefined();
    const { nextComment: firstComment } = initBody;

    // Submit vote to get auth token
    const firstVoteResponse = await submitVote(firstAgent, {
      tid: firstComment.tid,
      conversation_id: conversationId!,
      vote: 0,
    });

    expect(firstVoteResponse.status).toBe(200);
    expect(firstVoteResponse.body).toHaveProperty("currentPid");
    expect(firstVoteResponse.body).toHaveProperty("nextComment");

    const { currentPid: firstVoterPid, nextComment: secondComment } =
      firstVoteResponse.body;

    // Vote on 3 more comments
    const secondVoteResponse = await submitVote(firstAgent, {
      pid: Number(firstVoterPid),
      tid: secondComment.tid,
      conversation_id: conversationId!,
      vote: 0,
    });

    const thirdVoteResponse = await submitVote(firstAgent, {
      pid: Number(firstVoterPid),
      tid: secondVoteResponse.body.nextComment.tid,
      conversation_id: conversationId!,
      vote: 0,
    });

    const fourthVoteResponse = await submitVote(firstAgent, {
      pid: Number(firstVoterPid),
      tid: thirdVoteResponse.body.nextComment.tid,
      conversation_id: conversationId!,
      vote: 0,
    });

    const lastComment = fourthVoteResponse.body.nextComment;

    // Initialize a new participant
    const { agent: secondAgent } = await initializeParticipant(conversationId!);

    // Get next comment
    const nextResponse: Response = await secondAgent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}&not_voted_by_pid=${firstVoterPid}`
    );

    // Validate response - should return the comment not voted on by the first participant
    expect(nextResponse.status).toBe(200);
    const nextResponseData = nextResponse.body;
    expect(nextResponseData).toBeDefined();
    expect(nextResponseData.tid).toBe(lastComment.tid);
  });

  test("GET /nextComment - 400 for missing conversation_id", async () => {
    // Request without required conversation_id
    const response: Response = await testAgent.get("/api/v3/nextComment");

    // Validate response
    expect(response.status).toBe(400);
    expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
  });

  test("GET /nextComment - Handles `without` parameter", async () => {
    const withoutCommentIds = commentIds.slice(0, 4);

    // Request next comment without comments 0-3
    const response: Response = await agent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}&without=${withoutCommentIds}`
    );

    // Validate response is the last comment
    expect(response.status).toBe(200);
    expect(response.body.tid).toBe(commentIds[4]);
    expect(withoutCommentIds).not.toContain(response.body.tid);
  });
});
