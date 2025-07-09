import { describe, expect, test, beforeAll } from "@jest/globals";
import { getJwtAuthenticatedAgent, newAgent } from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import type { TestUser } from "../../types/test-helpers";
import { Agent } from "supertest";

interface Context {
  name: string;
  [key: string]: any;
}

describe("GET /contexts", () => {
  let agent: Agent;

  // Initialize the agent before tests run
  beforeAll(async () => {
    agent = await newAgent();
  });

  test("Returns available contexts to anonymous users", async () => {
    // Call the contexts endpoint
    const response: Response = await agent.get("/api/v3/contexts");

    // Verify response status is 200
    expect(response.status).toBe(200);

    // Verify response contains expected keys
    expect(response.body).toBeDefined();
    expect(Array.isArray(response.body)).toBe(true);

    // Each context should have basic properties
    if (response.body.length > 0) {
      const context = response.body[0] as Context;
      expect(context).toHaveProperty("name");
    }
  });

  test("Returns available contexts to authenticated users", async () => {
    // Use a pooled test user for authentication
    const pooledUser = getPooledTestUser(1);
    const testUser: TestUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT authenticated agent
    const { agent: authAgent } = await getJwtAuthenticatedAgent(testUser);

    // Call the contexts endpoint with authentication
    const response: Response = await authAgent.get("/api/v3/contexts");

    // Verify response status is 200
    expect(response.status).toBe(200);

    // Verify response contains an array of contexts
    expect(Array.isArray(response.body)).toBe(true);

    // Each context should have basic properties
    if (response.body.length > 0) {
      const context = response.body[0] as Context;
      expect(context).toHaveProperty("name");
    }
  });
});
