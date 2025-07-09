import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Response } from "supertest";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setupAuthAndConvo,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

const NUM_COMMENTS = 5;

interface PCAResponse {
  pca: {
    center: number[];
    comps: number[][];
    "comment-extremity": number[];
    "comment-projection": number[][];
    [key: string]: any;
  };
  consensus: any;
  lastModTimestamp: number;
  lastVoteTimestamp: number;
  math_tick: number;
  n: number;
  repness: any;
  tids: number[];
  "base-clusters": any;
  "comment-priorities": any;
  "group-aware-consensus": any;
  "group-clusters": any;
  "group-votes": any;
  "in-conv": any;
  "meta-tids": any;
  "mod-in": any;
  "mod-out": any;
  "n-cmts": number;
  "user-vote-counts": any;
  "votes-base": any;
  [key: string]: any;
}

interface CorrelationResponse {
  matrix?: number[][];
  correlations?: any;
  [key: string]: any;
}

describe("Math and Analysis Endpoints", () => {
  let agent: Agent;
  let testAgent: Agent;
  let conversationId: string | null = null;

  beforeAll(async () => {
    // Use pooled user for JWT authentication
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT authenticated agent
    const { agent: jwtAgent } = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAgent;

    // Get agent for endpoints
    testAgent = await newAgent();

    // Setup conversation with comments and votes to have data for analysis
    const setup = await setupAuthAndConvo();
    conversationId = setup.conversationId;

    // Create comments directly for testing without complex participant setup
    // This avoids domain whitelist issues while still providing data for math endpoints
    const comments: number[] = [];
    for (let i = 1; i <= NUM_COMMENTS; i++) {
      const response = await agent.post("/api/v3/comments").send({
        conversation_id: conversationId,
        txt: `Test comment ${i} for math analysis`,
      });
      if (response.status === 200) {
        comments.push(response.body.tid);
      }
    }

    // Create participants and have them vote to generate data for PCA
    const numParticipants = 3;
    for (let i = 0; i < numParticipants; i++) {
      const participantData = await initializeParticipant(conversationId);

      for (const commentId of comments) {
        const vote = [-1, 1, 0][Math.floor(Math.random() * 3)] as -1 | 0 | 1;
        await submitVote(participantData.agent, {
          conversation_id: conversationId,
          tid: commentId,
          vote,
        });
      }
    }

    // Trigger math computation for the conversation
    await agent.post("/api/v3/mathUpdate").send({
      conversation_id: conversationId,
      math_update_type: "update",
    });

    // Wait for math computation to complete by polling the PCA endpoint
    let pcaAvailable = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const pcaResponse = await agent.get(
          `/api/v3/math/pca2?conversation_id=${conversationId}`
        );
        if (
          pcaResponse.status === 200 &&
          pcaResponse.body &&
          pcaResponse.body.pca
        ) {
          pcaAvailable = true;
          break;
        }
      } catch (error) {
        console.log(`Attempt ${attempt + 1}: Error -`, error);
        // Continue trying
      }
    }

    if (!pcaAvailable) {
      throw new Error("PCA data not available after waiting 10 seconds");
    }
  });

  test("GET /math/pca2 - Get Principal Component Analysis", async () => {
    // Request PCA results for the conversation
    // The response will be automatically decompressed by our supertest agent
    const { body, status } = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}`
    );

    // Validate response
    expect(status).toBe(200);
    expect(body).toBeDefined();

    // The response has been decompressed and parsed from gzip
    if (body) {
      const pcaResponse = body as PCAResponse;
      expect(pcaResponse.pca).toBeDefined();
      const { pca } = pcaResponse;

      // Check that the body has the expected fields
      expect(pcaResponse.consensus).toBeDefined();
      expect(pcaResponse.lastModTimestamp).toBeDefined();
      expect(pcaResponse.lastVoteTimestamp).toBeDefined();
      expect(pcaResponse.math_tick).toBeDefined();
      expect(pcaResponse.n).toBeDefined();
      expect(pcaResponse.repness).toBeDefined();
      expect(pcaResponse.tids).toBeDefined();
      expect(pcaResponse["base-clusters"]).toBeDefined();
      expect(pcaResponse["comment-priorities"]).toBeDefined();
      expect(pcaResponse["group-aware-consensus"]).toBeDefined();
      expect(pcaResponse["group-clusters"]).toBeDefined();
      expect(pcaResponse["group-votes"]).toBeDefined();
      expect(pcaResponse["in-conv"]).toBeDefined();
      expect(pcaResponse["meta-tids"]).toBeDefined();
      expect(pcaResponse["mod-in"]).toBeDefined();
      expect(pcaResponse["mod-out"]).toBeDefined();
      expect(pcaResponse["n-cmts"]).toBeDefined();
      expect(pcaResponse["user-vote-counts"]).toBeDefined();
      expect(pcaResponse["votes-base"]).toBeDefined();

      // Check that the PCA results are defined
      expect(pca.center).toBeDefined();
      expect(pca.comps).toBeDefined();
      expect(pca["comment-extremity"]).toBeDefined();
      expect(pca["comment-projection"]).toBeDefined();
    }
  });

  // Requires Report ID to exist first.
  // TODO: Revisit this after Reports have been covered in tests.
  test.skip("GET /api/v3/math/correlationMatrix - Get correlation matrix", async () => {
    // Request correlation matrix for the conversation
    const response: Response = await agent.get(
      `/api/v3/math/correlationMatrix?conversation_id=${conversationId}`
    );

    // Validate response
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // Correlation matrix should be an array or object with correlation data
    if (response.body) {
      const correlationResponse = response.body as CorrelationResponse;

      // Check for structure - could be:
      // 1. A 2D array/matrix
      // 2. An object with correlation data
      // 3. An object with a matrix property

      const hasCorrelationData =
        Array.isArray(correlationResponse) ||
        correlationResponse.matrix ||
        correlationResponse.correlations;

      expect(hasCorrelationData).toBeTruthy();
    }
  });

  test("Math endpoints - Return 400 for missing conversation_id", async () => {
    // Request PCA without conversation_id
    const pcaResponse: Response = await testAgent.get("/api/v3/math/pca2");

    expect(pcaResponse.status).toBe(400);
    expect(pcaResponse.text).toMatch(/polis_err_param_missing_conversation_id/);

    // Request correlation matrix without report_id
    const corrResponse: Response = await testAgent.get(
      `/api/v3/math/correlationMatrix?conversation_id=${conversationId}`
    );

    expect(corrResponse.status).toBe(400);
    expect(corrResponse.text).toMatch(/polis_err_param_missing_report_id/);
  });

  test("Math endpoints - Return appropriate error for invalid conversation_id", async () => {
    const invalidId = "nonexistent-conversation-id";

    // Request PCA with invalid conversation_id
    const pcaResponse: Response = await testAgent.get(
      `/api/v3/math/pca2?conversation_id=${invalidId}`
    );

    // Should return an error status
    expect(pcaResponse.status).toBe(400);
    expect(pcaResponse.text).toMatch(
      /polis_err_param_parse_failed_conversation_id/
    );
    expect(pcaResponse.text).toMatch(
      /polis_err_fetching_zid_for_conversation_id/
    );

    // Request correlation matrix with invalid report_id
    const corrResponse: Response = await testAgent.get(
      `/api/v3/math/correlationMatrix?report_id=${invalidId}`
    );

    // Should return an error status
    expect(corrResponse.status).toBe(400);
    expect(corrResponse.text).toMatch(/polis_err_param_parse_failed_report_id/);
    expect(corrResponse.text).toMatch(/polis_err_fetching_rid_for_report_id/);
  });

  test("Math endpoints - Require sufficient data for meaningful analysis", async () => {
    // Create a new empty conversation
    const emptyConvoId = await createConversation(agent);

    // Request PCA for empty conversation
    const { body, status } = await agent.get(
      `/api/v3/math/pca2?conversation_id=${emptyConvoId}`
    );

    expect(status).toBe(304);
    expect(body).toBe("");

    // TODO: Request correlation matrix for empty conversation
  });

  test("Math endpoints - Support math_tick parameter", async () => {
    // First, get the current PCA data to see the math_tick
    const initialResponse: Response = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}`
    );
    expect(initialResponse.status).toBe(200);

    const initialMathTick = initialResponse.body.math_tick;
    expect(typeof initialMathTick).toBe("number");

    // Test requesting data with the current math_tick (should get 304 - no new data)
    const sameTickResponse: Response = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}&math_tick=${initialMathTick}`
    );
    expect(sameTickResponse.status).toBe(304);

    // Test requesting data from an earlier math_tick (should get 200 with current data)
    const earlierTick = Math.max(0, initialMathTick - 1);
    const earlierTickResponse: Response = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}&math_tick=${earlierTick}`
    );
    expect(earlierTickResponse.status).toBe(200);
    expect(earlierTickResponse.body.math_tick).toBe(initialMathTick);

    // Test requesting data from a future math_tick (should get 304 - no such data)
    const futureTickResponse: Response = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}&math_tick=${
        initialMathTick + 100
      }`
    );
    expect(futureTickResponse.status).toBe(304);

    // Test with -1 (get latest)
    const latestResponse: Response = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}&math_tick=-1`
    );
    expect(latestResponse.status).toBe(200);
    expect(latestResponse.body.math_tick).toBe(initialMathTick);

    // Test ETag header functionality (related to math_tick)
    const etag = initialResponse.headers.etag;
    expect(etag).toBeDefined();
    expect(etag).toBe(`"${initialMathTick}"`);
  });
});
