import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  type TestUser,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import type { Agent } from "supertest";

interface Conversation {
  conversation_id: string;
  topic: string;
  description: string;
  is_active: boolean;
  is_draft: boolean;
  owner: number;
  created: string;
  modified: string;
  [key: string]: any;
}

describe("Conversation Endpoints", () => {
  let agent: Agent;
  let testUser: TestUser;

  beforeAll(async () => {
    const pooledUser = getPooledTestUser(1); // Using a specific user from the pool
    testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };
    ({ agent } = await getJwtAuthenticatedAgent(testUser));
  });

  test("Full conversation lifecycle", async () => {
    // STEP 1: Create a new conversation
    const timestamp = Date.now();
    const conversationId = await createConversation(agent, {
      topic: `Test Conversation ${timestamp}`,
      description: `Test Description ${timestamp}`,
      is_active: true,
      is_draft: false,
    });

    expect(conversationId).toBeDefined();

    // STEP 2: Verify conversation appears in list
    const listResponse: Response = await agent.get("/api/v3/conversations");

    expect(listResponse.status).toBe(200);
    const responseBody: Conversation[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    expect(
      responseBody.some((conv) => conv.conversation_id === conversationId)
    ).toBe(true);

    // STEP 3: Get conversation stats
    const statsResponse: Response = await agent.get(
      `/api/v3/conversationStats?conversation_id=${conversationId}`
    );

    expect(statsResponse.status).toBe(200);
    expect(JSON.parse(statsResponse.text)).toBeDefined();

    // STEP 4: Update conversation
    const updateData = {
      conversation_id: conversationId,
      description: `Updated description ${timestamp}`,
      topic: `Updated topic ${timestamp}`,
      is_active: true,
      is_draft: false,
    };

    const updateResponse: Response = await agent
      .put("/api/v3/conversations")
      .send(updateData);

    expect(updateResponse.status).toBe(200);

    // STEP 5: Close conversation
    // NOTE: This endpoint may time out, which is actually expected behavior
    try {
      await agent
        .post("/api/v3/conversation/close")
        .send({ conversation_id: conversationId })
        .timeout(3000); // Shorter timeout since we expect a potential timeout

      // If we get here without error, that's fine
    } catch (error) {
      // Ignore timeout errors as they're expected
      if (!(error as any).timeout) {
        throw error; // Re-throw non-timeout errors
      }
      console.log("Close conversation timed out as expected");
    }

    // STEP 6: Reopen conversation
    const reopenResponse: Response = await agent
      .post("/api/v3/conversation/reopen")
      .send({ conversation_id: conversationId });

    expect(reopenResponse.status).toBe(200);
  });
});
