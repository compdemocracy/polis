import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  getTestAgent,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import type { Agent } from "supertest";

interface ConversationPreloadResponse {
  conversation_id: string;
  topic: string;
  description: string;
  created: number;
  vis_type: number;
  write_type: number;
  help_type: number;
  bgcolor: string;
  help_color: string;
  help_bgcolor: string;
  style_btn: string;
  auth_needed_to_vote: boolean;
  auth_needed_to_write: boolean;
  auth_opt_allow_3rdparty: boolean;
  [key: string]: any;
}

describe("Conversation Preload API", () => {
  let agent: Agent;
  let testAgent: Agent;
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
    testAgent = await getTestAgent();

    // Create a conversation for testing
    conversationId = await createConversation(agent);
  });

  test("GET /api/v3/conversations/preload - should return preload info for a conversation", async () => {
    const response: Response = await agent.get(
      `/api/v3/conversations/preload?conversation_id=${conversationId}`
    );
    const { body, status } = response;

    // Should return successful response
    expect(status).toBe(200);

    const preloadInfo = body as ConversationPreloadResponse;
    expect(preloadInfo).toHaveProperty("conversation_id", conversationId);
    expect(preloadInfo).toHaveProperty("topic");
    expect(preloadInfo).toHaveProperty("description");
    expect(preloadInfo).toHaveProperty("created");
    expect(preloadInfo).toHaveProperty("vis_type");
    expect(preloadInfo).toHaveProperty("write_type");
    expect(preloadInfo).toHaveProperty("help_type");
    expect(preloadInfo).toHaveProperty("bgcolor");
    expect(preloadInfo).toHaveProperty("help_color");
    expect(preloadInfo).toHaveProperty("help_bgcolor");
    expect(preloadInfo).toHaveProperty("style_btn");
    expect(preloadInfo).toHaveProperty("auth_needed_to_vote", false);
    expect(preloadInfo).toHaveProperty("auth_needed_to_write", false);
    expect(preloadInfo).toHaveProperty("auth_opt_allow_3rdparty", true);
  });

  test("GET /api/v3/conversations/preload - should return 500 with invalid conversation_id", async () => {
    const response: Response = await testAgent.get(
      "/api/v3/conversations/preload?conversation_id=invalid_id"
    );

    // Should return error response
    expect(response.status).toBe(500);
    expect(response.text).toContain("polis_err_get_conversation_preload_info");
  });

  test("GET /api/v3/conversations/preload - should return 500 with non-existent conversation_id", async () => {
    const response: Response = await testAgent.get(
      "/api/v3/conversations/preload?conversation_id=99999999"
    );

    // Should return error response
    expect(response.status).toBe(500);
    expect(response.text).toContain("polis_err_get_conversation_preload_info");
  });

  test("GET /api/v3/conversations/preload - should require conversation_id parameter", async () => {
    const response: Response = await testAgent.get(
      "/api/v3/conversations/preload"
    );

    // Should return error response
    expect(response.status).toBe(400);
    expect(response.text).toContain("polis_err_param_missing_conversation_id");
  });
});
