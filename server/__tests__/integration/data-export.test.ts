import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  getTestAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import type { Agent } from "supertest";

interface TestData {
  comments: number[];
  stats: {
    totalVotes: number;
    [key: string]: any;
  };
  [key: string]: any;
}

describe("Data Export API", () => {
  let agent: Agent;
  let testAgent: Agent;
  let conversationId: string;
  let testData: TestData;
  let reportId: string;

  const numParticipants = 3;
  const numComments = 3;
  const testTopic = "Test Data Export Conversation";
  const testDescription =
    "This is a test conversation created for data export testing";

  beforeAll(async () => {
    // Use pooled user for JWT authentication
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT authenticated agent
    const { agent: jwtAgent, token } = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAgent;

    // Get agent for endpoints and authenticate it
    testAgent = await getTestAgent();
    testAgent.set("Authorization", `Bearer ${token}`);

    // Set x-forwarded-proto header for proper URL generation in tests
    testAgent.set("x-forwarded-proto", "http");

    // Create a conversation
    conversationId = await createConversation(agent, {
      topic: testTopic,
      description: testDescription,
    });

    // Create comments directly - simpler approach like math.test.ts
    const comments: number[] = [];
    for (let i = 1; i <= numComments; i++) {
      const response = await agent.post("/api/v3/comments").send({
        conversation_id: conversationId,
        txt: `Test comment ${i} for data export`,
      });
      if (response.status === 200) {
        comments.push(response.body.tid);
      }
    }

    // Create participants and have them vote
    const participants: Awaited<ReturnType<typeof initializeParticipant>>[] =
      [];
    for (let i = 0; i < numParticipants; i++) {
      const participantData = await initializeParticipant(conversationId);
      participants.push(participantData);
    }

    // Submit votes from each participant
    let totalVotes = 0;
    for (const participantData of participants) {
      for (const commentId of comments) {
        const vote = [-1, 1, 0][Math.floor(Math.random() * 3)] as -1 | 0 | 1;
        const voteResponse = await submitVote(participantData.agent, {
          conversation_id: conversationId,
          tid: commentId,
          vote,
        });

        if (voteResponse.status === 200) {
          totalVotes++;
        }
      }
    }

    testData = {
      comments,
      stats: {
        totalVotes,
      },
    };

    // Trigger math computation for the conversation
    // This is required before data export functionality will work
    await agent.post("/api/v3/mathUpdate").send({
      conversation_id: conversationId,
      math_update_type: "update",
    });

    // Wait for math computation to complete by polling the PCA endpoint
    // We'll try up to 10 times with 1 second intervals
    let pcaAvailable = false;
    let pcaData = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const pcaResponse = await agent.get(
          `/api/v3/math/pca2?conversation_id=${conversationId}`
        );
        if (pcaResponse.status === 200 && pcaResponse.body) {
          pcaAvailable = true;
          pcaData = pcaResponse.body;
          console.log(`PCA data available after ${attempt + 1} attempts`);
          console.log("PCA data keys:", Object.keys(pcaData || {}));
          break;
        }
      } catch (error) {
        // Continue trying
      }
    }

    if (!pcaAvailable) {
      throw new Error("PCA data not available after waiting 10 seconds");
    }

    // Create a report for this conversation
    await agent.post("/api/v3/reports").send({
      conversation_id: conversationId,
    });

    // Get the report ID
    const getReportsResponse: Response = await agent.get(
      `/api/v3/reports?conversation_id=${conversationId}`
    );
    reportId = getReportsResponse.body[0].report_id;
  });

  test("GET /api/v3/dataExport - should initiate a data export task", async () => {
    const currentTimeInSeconds: number = Math.floor(Date.now() / 1000);

    const response: Response = await agent.get(
      `/api/v3/dataExport?conversation_id=${conversationId}&unixTimestamp=${currentTimeInSeconds}&format=csv`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  test("GET /api/v3/reportExport/:report_id/summary.csv - should export report summary", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/summary.csv`
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    console.log("Summary CSV Response:", response.text);

    expect(response.text).toContain(`topic,"${testTopic}"`);
    expect(response.text).toContain("url");
    expect(response.text).toContain("voters,"); // May be 0 if PCA data is incomplete
    expect(response.text).toContain("voters-in-conv,");
    expect(response.text).toContain("commenters,1"); // owner is the only commenter
    expect(response.text).toContain("comments,"); // May be 0 if PCA data is incomplete
    expect(response.text).toContain("groups,");
    expect(response.text).toContain(
      `conversation-description,"${testDescription}"`
    );

    // Check that the protocol is properly set (no longer undefined)
    expect(response.text).toContain("http://");
    expect(response.text).not.toContain("undefined://");
  });

  test("GET /api/v3/reportExport/:report_id/comments.csv - should export comments", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/comments.csv`
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    // Should contain expected headers
    expect(response.text).toContain("timestamp");
    expect(response.text).toContain("datetime");
    expect(response.text).toContain("comment-id");
    expect(response.text).toContain("author-id");
    expect(response.text).toContain("agrees");
    expect(response.text).toContain("disagrees");
    expect(response.text).toContain("moderated");
    expect(response.text).toContain("comment-body");

    // Should contain all our test comments
    testData.comments.forEach((commentId) => {
      expect(response.text).toContain(commentId.toString());
    });
  });

  test("GET /api/v3/reportExport/:report_id/votes.csv - should export votes", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/votes.csv`
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    // Should contain expected headers
    expect(response.text).toContain("timestamp");
    expect(response.text).toContain("datetime");
    expect(response.text).toContain("comment-id");
    expect(response.text).toContain("voter-id");
    expect(response.text).toContain("vote");

    // Verify we have the expected number of votes
    const voteLines = response.text
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(voteLines.length - 1).toBe(testData.stats.totalVotes); // -1 for header row
  });

  test("GET /api/v3/reportExport/:report_id/unknown.csv - should handle unknown report type", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/unknown.csv`
    );

    expect(response.status).toBe(404);
    expect(response.text).toContain("polis_error_data_unknown_report");
  });

  test("GET /api/v3/reportExport/nonexistent/comments.csv - should handle nonexistent report ID", async () => {
    const response: Response = await testAgent.get(
      "/api/v3/reportExport/nonexistent/comments.csv"
    );

    expect(response.status).toBe(400);
    expect(response.text).toContain("polis_err_param_parse_failed_report_id");
  });
});
