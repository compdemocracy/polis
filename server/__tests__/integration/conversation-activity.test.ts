import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";

describe("Conversation Activity API", () => {
  let agent: any;

  beforeAll(async () => {
    // Use JWT-based authentication instead of legacy cookies
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT token
    const { token } = await getJwtAuthenticatedAgent(testUser);

    // Create agent for handling responses
    agent = await newAgent();
    setAgentJwt(agent, token);
  });

  test("GET /api/v3/conversations/recent_activity - should return 403 for non-admin users", async () => {
    const response: Response = await agent.get(
      "/api/v3/conversations/recent_activity"
    );
    expect(response.status).toBe(403);
    expect(response.text).toContain("polis_err_no_access_for_this_user");
  });

  test("GET /api/v3/conversations/recently_started with sinceUnixTimestamp - should return 403", async () => {
    // Get current time in seconds
    const currentTimeInSeconds: number = Math.floor(Date.now() / 1000);
    const timeOneWeekAgo: number = currentTimeInSeconds - 7 * 24 * 60 * 60;

    const response: Response = await agent.get(
      `/api/v3/conversations/recently_started?sinceUnixTimestamp=${timeOneWeekAgo}`
    );
    expect(response.status).toBe(403);
    expect(response.text).toContain("polis_err_no_access_for_this_user");
  });
});
