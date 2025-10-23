import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  getTestAgent,
  initializeParticipant,
  submitVote,
  wait,
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

    // Submit votes from each participant with deterministic pattern
    let totalVotes = 0;
    for (let i = 0; i < participants.length; i++) {
      const participantData = participants[i];
      for (let j = 0; j < comments.length; j++) {
        const commentId = comments[j];
        // Use deterministic vote pattern: alternate between -1, 1, 0
        const vote = [-1, 1, 0][j % 3] as -1 | 0 | 1;
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

    // Wait for the report to be created
    await wait(2000);

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

    // Should NOT contain importance column when importance_enabled is false
    expect(response.text).not.toContain("importance");

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

    // Should NOT contain important column when importance_enabled is false
    expect(response.text).not.toContain("important");

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

describe("Data Export API with Importance Enabled", () => {
  let agent: Agent;
  let testAgent: Agent;
  let conversationId: string;
  let testData: TestData & { highPriorityVotes: number };
  let reportId: string;

  const numParticipants = 3;
  const numComments = 3;
  const testTopic = "Test Importance-Enabled Conversation";
  const testDescription = "Testing importance feature in data exports";

  beforeAll(async () => {
    // Use pooled user for JWT authentication
    const pooledUser = getPooledTestUser(2); // Use a different user pool
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
    testAgent.set("x-forwarded-proto", "http");

    // Create a conversation (returns zinvite string, not zid)
    const zinvite = await createConversation(agent, {
      topic: testTopic,
      description: testDescription,
    });
    conversationId = zinvite; // Keep for API calls

    // Get the actual zid from the zinvite
    const { pool } = await import("../setup/db-test-helpers");
    const zidResult = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [zinvite]
    );
    const zid = zidResult.rows[0].zid;

    // Enable importance for this conversation using direct database access
    await pool.query(
      "UPDATE conversations SET importance_enabled = true WHERE zid = $1",
      [zid]
    );

    // Create comments
    const comments: number[] = [];
    for (let i = 1; i <= numComments; i++) {
      const response = await agent.post("/api/v3/comments").send({
        conversation_id: conversationId,
        txt: `Test comment ${i} with importance`,
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

    // Submit votes from each participant with deterministic pattern
    let totalVotes = 0;
    let highPriorityVotes = 0;
    for (let i = 0; i < participants.length; i++) {
      const participantData = participants[i];
      for (let j = 0; j < comments.length; j++) {
        const commentId = comments[j];
        // Use deterministic vote pattern: alternate between -1, 1, 0
        const vote = [-1, 1, 0][j % 3] as -1 | 0 | 1;
        // Mark votes as high priority in a pattern: first participant's first 2 votes,
        // second participant's first vote
        const isHighPriority = (i === 0 && j < 2) || (i === 1 && j === 0);

        const voteResponse = await submitVote(participantData.agent, {
          conversation_id: conversationId,
          tid: commentId,
          vote,
          high_priority: isHighPriority,
        });

        if (voteResponse.status === 200) {
          totalVotes++;
          if (isHighPriority) {
            highPriorityVotes++;
          }
        }
      }
    }

    testData = {
      comments,
      stats: {
        totalVotes,
      },
      highPriorityVotes,
    };

    // Trigger math computation
    await agent.post("/api/v3/mathUpdate").send({
      conversation_id: conversationId,
      math_update_type: "update",
    });

    // Wait for math computation
    let pcaAvailable = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const pcaResponse = await agent.get(
          `/api/v3/math/pca2?conversation_id=${conversationId}`
        );
        if (pcaResponse.status === 200 && pcaResponse.body) {
          pcaAvailable = true;
          break;
        }
      } catch (error) {
        // Continue trying
      }
    }

    if (!pcaAvailable) {
      throw new Error("PCA data not available after waiting 10 seconds");
    }

    // Create a report
    await agent.post("/api/v3/reports").send({
      conversation_id: conversationId,
    });

    await wait(2000);

    // Get the report ID
    const getReportsResponse: Response = await agent.get(
      `/api/v3/reports?conversation_id=${conversationId}`
    );
    reportId = getReportsResponse.body[0].report_id;
  });

  test("GET /api/v3/reportExport/:report_id/comments.csv - should include importance column", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/comments.csv`
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    // Should contain standard headers
    expect(response.text).toContain("timestamp");
    expect(response.text).toContain("comment-id");
    expect(response.text).toContain("agrees");
    expect(response.text).toContain("disagrees");

    // Should contain importance column when importance_enabled is true
    expect(response.text).toContain("importance");

    // Should contain comment-body at the end
    expect(response.text).toContain("comment-body");

    // Verify the header order has importance before comment-body
    const lines = response.text.split("\n");
    const headerLine = lines[0];
    const importanceIndex = headerLine.indexOf("importance");
    const commentBodyIndex = headerLine.indexOf("comment-body");
    expect(importanceIndex).toBeGreaterThan(-1);
    expect(commentBodyIndex).toBeGreaterThan(importanceIndex);
  });

  test("GET /api/v3/reportExport/:report_id/votes.csv - should include important column", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/votes.csv`
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    // Should contain standard headers
    expect(response.text).toContain("timestamp");
    expect(response.text).toContain("comment-id");
    expect(response.text).toContain("voter-id");
    expect(response.text).toContain("vote");

    // Should contain important column when importance_enabled is true
    expect(response.text).toContain("important");

    // Verify we have the expected number of votes
    const voteLines = response.text
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(voteLines.length - 1).toBe(testData.stats.totalVotes);

    // Count the number of high priority votes (lines with ",1" at the end before comment-body)
    const highPriorityCount = response.text
      .split("\n")
      .slice(1) // Skip header
      .filter((line) => line.trim().length > 0)
      .filter((line) => line.endsWith(",1")).length;

    expect(highPriorityCount).toBe(testData.highPriorityVotes);
  });

  test("GET /api/v3/reportExport/:report_id/participant-importance.csv - should export participant importance data", async () => {
    const response: Response = await testAgent.get(
      `/api/v3/reportExport/${reportId}/participant-importance.csv`
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    // Should contain expected headers
    expect(response.text).toContain("participant");
    expect(response.text).toContain("group-id");
    expect(response.text).toContain("n-comments");
    expect(response.text).toContain("n-votes");
    expect(response.text).toContain("n-important");

    // Should contain comment IDs as columns
    testData.comments.forEach((commentId) => {
      expect(response.text).toContain(commentId.toString());
    });

    // Verify we have the expected number of participant rows
    const dataLines = response.text
      .split("\n")
      .slice(1) // Skip header
      .filter((line) => line.trim().length > 0);

    // Should have one row per participant (3 participants in test setup)
    expect(dataLines.length).toBe(numParticipants);

    // Verify n-important values are correct
    // Pattern: first participant should have 2 important votes, second should have 1, third should have 0
    const expectedImportantCounts = ["2", "1", "0"];
    dataLines.forEach((line, index) => {
      const cols = line.split(",");
      const nImportant = cols[4]; // n-important is the 5th column (0-indexed)
      expect(nImportant).toBe(expectedImportantCounts[index]);
    });

    // Verify that comment columns contain 1 for high priority votes, 0 for regular votes, empty for no votes
    dataLines.forEach((line) => {
      const cols = line.split(",");
      // Skip metadata columns (first 5: participant, group-id, n-comments, n-votes, n-important)
      for (let i = 5; i < cols.length; i++) {
        const value = cols[i];
        expect(value === "" || value === "0" || value === "1").toBe(true); // Should be empty, "0", or "1"
      }
    });
  });
});
