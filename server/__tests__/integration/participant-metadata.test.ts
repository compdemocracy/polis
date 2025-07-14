import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  newAgent,
  getJwtAuthenticatedAgent,
  setAgentJwt,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import type { Agent } from "supertest";

interface MetadataQuestion {
  pmqid: number;
  key: string;
  [key: string]: any;
}

interface MetadataAnswer {
  pmaid: number;
  pmqid: number;
  value: string;
  [key: string]: any;
}

interface MetadataResponse {
  keys: Record<string, any>;
  values: Record<string, any>;
  kvp: Record<string, any>;
}

describe("Participant Metadata API", () => {
  let agent: Agent;
  let testAgent: Agent;
  let conversationId: string;
  let token: string;

  beforeAll(async () => {
    // Use pooled user for OIDC compatibility
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };
    // Authenticate with JWT
    const jwtAuth = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAuth.agent;
    token = jwtAuth.token;
    // Set up an agent with JWT for endpoints
    testAgent = await newAgent();
    setAgentJwt(testAgent, token);

    // Create conversation
    conversationId = await createConversation(agent);

    // Note: We don't need to initialize a participant for metadata tests
    // The metadata API is for conversation owners to manage participant metadata
  });

  test("POST /api/v3/metadata/questions - should create metadata question", async () => {
    const questionKey = `test_question_${Date.now()}`;
    const response: Response = await agent
      .post("/api/v3/metadata/questions")
      .send({
        conversation_id: conversationId,
        key: questionKey,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("pmqid");

    // Verify the question was created by fetching it
    const getResponse: Response = await agent.get(
      `/api/v3/metadata/questions?conversation_id=${conversationId}`
    );
    const createdQuestion = (getResponse.body as MetadataQuestion[]).find(
      (q) => q.key === questionKey
    );
    expect(createdQuestion).toBeDefined();
    expect(createdQuestion!.pmqid).toBe(response.body.pmqid);
  });

  test("GET /api/v3/metadata/questions - should list metadata questions", async () => {
    // Create a question first to ensure there's data
    const questionKey = `test_question_${Date.now()}`;
    await agent.post("/api/v3/metadata/questions").send({
      conversation_id: conversationId,
      key: questionKey,
    });

    const response: Response = await agent.get(
      `/api/v3/metadata/questions?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    // Check structure of the first question
    expect(response.body[0]).toHaveProperty("pmqid");
    expect(response.body[0]).toHaveProperty("key");
  });

  describe("with existing question", () => {
    let pmqid: number;

    beforeAll(async () => {
      // Create a question for these tests
      const response: Response = await agent
        .post("/api/v3/metadata/questions")
        .send({
          conversation_id: conversationId,
          key: `test_question_${Date.now()}`,
        });
      pmqid = response.body.pmqid;
    });

    test("POST /api/v3/metadata/answers - should create metadata answer", async () => {
      const answerValue = `test_answer_${Date.now()}`;
      const response: Response = await agent
        .post("/api/v3/metadata/answers")
        .send({
          conversation_id: conversationId,
          pmqid: pmqid,
          value: answerValue,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("pmaid");

      // Verify the answer was created
      const getResponse: Response = await agent.get(
        `/api/v3/metadata/answers?conversation_id=${conversationId}`
      );
      const createdAnswer = (getResponse.body as MetadataAnswer[]).find(
        (a) => a.pmqid === pmqid && a.value === answerValue
      );
      expect(createdAnswer).toBeDefined();
      expect(createdAnswer!.pmaid).toBe(response.body.pmaid);
    });

    test("GET /api/v3/metadata/answers - should list metadata answers", async () => {
      // Create an answer first to ensure there's data
      const answerValue = `test_answer_${Date.now()}`;
      await agent.post("/api/v3/metadata/answers").send({
        conversation_id: conversationId,
        pmqid: pmqid,
        value: answerValue,
      });

      const response: Response = await agent.get(
        `/api/v3/metadata/answers?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);

      // Check structure of the first answer
      expect(response.body[0]).toHaveProperty("pmaid");
      expect(response.body[0]).toHaveProperty("pmqid");
      expect(response.body[0]).toHaveProperty("value");
    });

    describe("with existing answer", () => {
      let pmaid: number;

      beforeAll(async () => {
        // Create an answer for these tests
        const response: Response = await agent
          .post("/api/v3/metadata/answers")
          .send({
            conversation_id: conversationId,
            pmqid: pmqid,
            value: `test_answer_${Date.now()}`,
          });
        pmaid = response.body.pmaid;
      });

      test("GET /api/v3/metadata - should retrieve all metadata", async () => {
        const response: Response = await agent.get(
          `/api/v3/metadata?conversation_id=${conversationId}`
        );

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("keys");
        expect(response.body).toHaveProperty("values");
        expect(response.body).toHaveProperty("kvp");

        const metadata = response.body as MetadataResponse;
        expect(typeof metadata.keys).toBe("object");
        expect(typeof metadata.values).toBe("object");
      });

      test("POST /api/v3/query_participants_by_metadata - query participants by metadata", async () => {
        const queryResponse: Response = await agent
          .post("/api/v3/query_participants_by_metadata")
          .send({
            conversation_id: conversationId,
            pmaids: [pmaid],
          });

        expect(queryResponse.status).toBe(200);
        expect(queryResponse.body).toBeDefined();
        expect(Array.isArray(queryResponse.body)).toBe(true);
      });
    });
  });

  test("DELETE /api/v3/metadata/questions/:pmqid - should delete a metadata question", async () => {
    // Create a question to delete
    const createResponse: Response = await agent
      .post("/api/v3/metadata/questions")
      .send({
        conversation_id: conversationId,
        key: "question_to_delete",
      });

    expect(createResponse.status).toBe(200);
    const deleteId = createResponse.body.pmqid;

    const deleteResponse: Response = await testAgent.delete(
      `/api/v3/metadata/questions/${deleteId}`
    );

    // The API returns JSON with success flag
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);

    // Verify it was deleted (or marked as not alive)
    const getResponse: Response = await agent.get(
      `/api/v3/metadata/questions?conversation_id=${conversationId}`
    );
    const deletedQuestion = (getResponse.body as MetadataQuestion[]).find(
      (q) => q.pmqid === deleteId
    );
    expect(deletedQuestion).toBeUndefined();
  });

  test("DELETE /api/v3/metadata/answers/:pmaid - should delete a metadata answer", async () => {
    // Create a question first
    const questionResponse: Response = await agent
      .post("/api/v3/metadata/questions")
      .send({
        conversation_id: conversationId,
        key: `test_question_${Date.now()}`,
      });
    const pmqid = questionResponse.body.pmqid;

    // Add an answer to delete
    const createResponse: Response = await agent
      .post("/api/v3/metadata/answers")
      .send({
        conversation_id: conversationId,
        pmqid: pmqid,
        value: "answer_to_delete",
      });

    expect(createResponse.status).toBe(200);
    const deleteId = createResponse.body.pmaid;

    const deleteResponse: Response = await testAgent.delete(
      `/api/v3/metadata/answers/${deleteId}`
    );

    // The API returns JSON with success flag
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);

    // Verify it was deleted (or marked as not alive)
    const getResponse: Response = await agent.get(
      `/api/v3/metadata/answers?conversation_id=${conversationId}`
    );
    const deletedAnswer = (getResponse.body as MetadataAnswer[]).find(
      (a) => a.pmaid === deleteId
    );
    expect(deletedAnswer).toBeUndefined();
  });

  test("PUT /api/v3/participants_extended - should work for conversation owner", async () => {
    // Test with the owner agent
    const ownerResponse: Response = await agent
      .put("/api/v3/participants_extended")
      .send({
        conversation_id: conversationId,
        show_translation_activated: true,
      });

    // The owner should be able to update their own settings
    expect(ownerResponse.status).toBe(200);
  });

  test("PUT /api/v3/participants_extended - handles participant access correctly", async () => {
    // Test with a non-owner agent (create a new unauthenticated agent)
    const nonOwnerAgent = await newAgent();
    const participantResponse: Response = await nonOwnerAgent
      .put("/api/v3/participants_extended")
      .send({
        conversation_id: conversationId,
        show_translation_activated: false,
      });

    // Non-authenticated requests should get 401
    expect(participantResponse.status).toBe(401);
  });

  test("GET /api/v3/metadata/choices - should retrieve metadata choices", async () => {
    const response: Response = await agent.get(
      `/api/v3/metadata/choices?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);

    // Depending on whether choices have been made, this might be empty
    // but the endpoint should always return a valid response
    expect(Array.isArray(response.body)).toBe(true);
  });
});
