import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  createHmacSignature,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";
import type { TestUser } from "../../types/test-helpers";

describe("Notification Subscription API", () => {
  let conversationId: string;
  let agent: Agent;
  let testAgent: Agent;
  let testUser: TestUser;
  let token: string;

  beforeAll(async () => {
    // Use pooled user for OIDC compatibility
    const pooledUser = getPooledTestUser(1);
    testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };
    // Authenticate with JWT
    const jwtAuth = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAuth.agent;
    token = jwtAuth.token;
    // Create a conversation for testing
    conversationId = await createConversation(agent);
    // Set up an agent with JWT for endpoints
    testAgent = await newAgent();
    setAgentJwt(testAgent, token);
  });

  test("GET /notifications/subscribe - should handle signature validation", async () => {
    const email = testUser.email;
    const signature = createHmacSignature(email, conversationId);

    // Using testAgent to handle text response properly
    const response: Response = await testAgent
      .get("/api/v3/notifications/subscribe")
      .query({
        signature,
        conversation_id: conversationId,
        email,
      });

    // We now expect success since we're using the correct HMAC generation
    expect(response.status).toBe(200);
    expect(response.text).toContain("Subscribed!");
  });

  test("GET /notifications/unsubscribe - should handle signature validation", async () => {
    const email = testUser.email;
    const signature = createHmacSignature(
      email,
      conversationId,
      "api/v3/notifications/unsubscribe"
    );

    // Using testAgent to handle text response properly
    const response: Response = await testAgent
      .get("/api/v3/notifications/unsubscribe")
      .query({
        signature,
        conversation_id: conversationId,
        email,
      });

    // We now expect success since we're using the correct path and key
    expect(response.status).toBe(200);
    expect(response.text).toContain("Unsubscribed");
  });

  test("POST /convSubscriptions - should allow subscribing to conversation updates", async () => {
    const response: Response = await agent
      .post("/api/v3/convSubscriptions")
      .send({
        conversation_id: conversationId,
        email: testUser.email,
        type: 1, // Subscription type (1 = updates)
      });

    expect(response.status).toBe(200);

    // Subscription confirmation should be returned
    expect(response.body).toEqual({ subscribed: 1 });
  });

  test("POST /convSubscriptions - authentication behavior (currently not enforced)", async () => {
    // Create unauthenticated agent
    const unauthAgent = await newAgent();

    const response: Response = await unauthAgent
      .post("/api/v3/convSubscriptions")
      .send({
        conversation_id: conversationId,
        email: testUser.email,
        type: 1,
      });

    // The API gives a 401 error when the user is not authenticated
    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty(
      "error",
      "No authentication token found"
    );
  });

  test("POST /convSubscriptions - should validate required parameters", async () => {
    // Test missing email
    const missingEmailResponse: Response = await agent
      .post("/api/v3/convSubscriptions")
      .send({
        conversation_id: conversationId,
        type: 1,
      });

    expect(missingEmailResponse.status).toBe(400);
    expect(missingEmailResponse.text).toMatch(/polis_err_param_missing_email/);

    // Test missing conversation_id
    const missingConvoResponse: Response = await agent
      .post("/api/v3/convSubscriptions")
      .send({
        email: testUser.email,
        type: 1,
      });

    expect(missingConvoResponse.status).toBe(400);
    expect(missingConvoResponse.text).toMatch(
      /polis_err_param_missing_conversation_id/
    );

    // Test missing type
    const missingTypeResponse: Response = await agent
      .post("/api/v3/convSubscriptions")
      .send({
        conversation_id: conversationId,
        email: testUser.email,
      });

    expect(missingTypeResponse.status).toBe(400);
    expect(missingTypeResponse.text).toMatch(/polis_err_param_missing_type/);
  });
});
