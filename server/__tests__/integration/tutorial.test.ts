import { describe, expect, test, beforeAll } from "@jest/globals";
import { getJwtAuthenticatedAgent, newAgent } from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import { Agent } from "supertest";

describe("POST /tutorial", () => {
  let agent: Agent;

  // Initialize authenticated agent before running tests
  beforeAll(async () => {
    // Use JWT authentication with pooled user
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT authenticated agent
    const authResult = await getJwtAuthenticatedAgent(testUser);
    agent = authResult.agent;
  });

  test("should update tutorial step for authenticated user", async () => {
    // Update tutorial step with authenticated agent
    const response: Response = await agent
      .post("/api/v3/tutorial")
      .send({ step: 1 });

    // Check response
    expect(response.status).toBe(200);
  });

  test("should require authentication", async () => {
    const testAgent = await newAgent();
    // Try to update tutorial step without authentication
    const response: Response = await testAgent
      .post("/api/v3/tutorial")
      .send({ step: 1 });

    // Expect authentication error
    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty(
      "error",
      "No authentication token found"
    );
  });

  test("should require valid step parameter", async () => {
    // Try to update with invalid step using authenticated agent
    const response: Response = await agent
      .post("/api/v3/tutorial")
      .send({ step: "invalid" });

    // Expect validation error
    expect(response.status).toBe(400);
    expect(response.text).toContain("polis_err_param_parse_failed_step");
    expect(response.text).toContain("polis_fail_parse_int invalid");
  });
});
