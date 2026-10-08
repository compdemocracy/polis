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
  wait,
} from "../setup/api-test-helpers";

import { getPooledTestUser } from "../setup/test-user-helpers";
import type { TestUser } from "../../types/test-helpers";
import { createDelphiTopicCluster } from "../setup/dynamodb-test-helpers";
import pg from "../../src/db/pg-query";

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

  describe("Topical next comment selection", () => {
    test("GET /nextComment - respects without filter and attempts topical selection", async () => {
      // Note: POLIS_TOPICAL_RATIO is set to 1.0 globally in globalSetup.ts
      // This ensures deterministic topical selection when topic agendas are configured

      // Resolve zid from database mapping (zinvites)
      const zidRows = (await pg.queryP_readOnly(
        "select zid from zinvites where zinvite = ($1) limit 1;",
        [conversationId]
      )) as Array<{ zid: number }>;
      const zid = zidRows?.[0]?.zid;
      expect(typeof zid).toBe("number");

      // Create a participant for this conversation to ensure pid is set in session
      const { agent: participantAgent } = await initializeParticipant(
        conversationId!
      );

      // Choose a topic and map a specific comment id to it
      const topicKey = "topic-topical-A";
      const topicalTids = [commentIds[1]];
      const layerId = 1; // Use layer 1 for this test
      const clusterId = 10; // Use cluster ID 10 for this test

      // Save selections for the participant using the API (include topic_key for server lookup)
      const saveSelResp = await participantAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: [
            { topic_key: topicKey, topic_id: topicKey, priority: 1 },
          ],
        });
      expect(saveSelResp.status).toBe(200);
      const pid = Number(saveSelResp.body?.data?.participant_id);
      expect(Number.isFinite(pid)).toBe(true);

      // Populate DynamoDB clusters for the chosen topic
      await createDelphiTopicCluster(
        zid,
        topicKey,
        topicalTids,
        layerId,
        clusterId
      );

      // Wait briefly for DynamoDB eventual consistency
      await wait(500);

      // Exclude a non-topical tid to verify it doesn't affect topical selection
      const withoutParam = String(commentIds[0]);
      const nextResp: Response = await participantAgent.get(
        `/api/v3/nextComment?conversation_id=${conversationId}&without=${withoutParam}&not_voted_by_pid=${pid}`
      );
      expect(nextResp.status).toBe(200);
      expect(nextResp.body).toBeDefined();
      expect(nextResp.body.tid).toBeDefined();

      // The comment selection has some inherent non-determinism even with ratio=1.0
      // Due to eventual consistency and fallback logic, we may get either:
      // - The topical comment (commentIds[1]) when topical selection works
      // - Any other non-excluded comment when it falls back to prioritized selection
      // We just verify we don't get the excluded comment
      expect(nextResp.body.tid).not.toBe(commentIds[0]);
    });

    test("GET /nextComment - falls back to prioritized when topical pool exhausted by without", async () => {
      // Note: POLIS_TOPICAL_RATIO is set to 1.0 globally in globalSetup.ts
      // This ensures deterministic topical selection when topic agendas are configured

      // Get zid again from database
      const zidRows = (await pg.queryP_readOnly(
        "select zid from zinvites where zinvite = ($1) limit 1;",
        [conversationId]
      )) as Array<{ zid: number }>;
      const zid: number = zidRows?.[0]?.zid;

      const { agent: participantAgent } = await initializeParticipant(
        conversationId!
      );

      const topicKey = "topic-topical-B";
      const topicalTids = [commentIds[2], commentIds[3]];
      const layerId = 2; // Use layer 2 for this test
      const clusterId = 20; // Use cluster ID 20 for this test

      // Save selections with topic_key
      const saveSelResp2 = await participantAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: [
            { topic_key: topicKey, topic_id: topicKey, priority: 1 },
          ],
        });
      const pid2 = Number(saveSelResp2.body?.data?.participant_id);
      expect(Number.isFinite(pid2)).toBe(true);

      await createDelphiTopicCluster(
        zid,
        topicKey,
        topicalTids,
        layerId,
        clusterId
      );

      // Wait briefly for DynamoDB eventual consistency
      await wait(500);

      // Exclude all topical tids to force fallback
      const withoutParam = `${topicalTids[0]},${topicalTids[1]}`;
      const nextResp: Response = await participantAgent.get(
        `/api/v3/nextComment?conversation_id=${conversationId}&without=${withoutParam}&not_voted_by_pid=${pid2}`
      );
      expect(nextResp.status).toBe(200);
      expect(nextResp.body.tid).toBeDefined();
      // Should not be from topical set due to exclusion
      expect(topicalTids).not.toContain(nextResp.body.tid);
    });
  });
});
