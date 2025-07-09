import { beforeEach, describe, expect, test } from "@jest/globals";
import { newAgent, getJwtAuthenticatedAgent } from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import { Agent } from "supertest";

interface DomainWhitelistResponse {
  domain_whitelist: string;
}

describe("Domain Whitelist API", () => {
  let agent: Agent;

  // Setup with a registered and authenticated user
  beforeEach(async () => {
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

    // Clear domain whitelist to ensure clean state for each test
    await agent.post("/api/v3/domainWhitelist").send({
      domain_whitelist: "",
    });
  });

  test("GET /domainWhitelist - should retrieve domain whitelist settings for auth user", async () => {
    const response: Response = await agent.get("/api/v3/domainWhitelist");

    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // Domain whitelist is returned as a list of domains or an empty string
    expect(response.body).toHaveProperty("domain_whitelist");
    expect((response.body as DomainWhitelistResponse).domain_whitelist).toEqual(
      ""
    );
  });

  test("GET /domainWhitelist - authentication behavior", async () => {
    // Create an unauthenticated agent
    const unauthAgent = await newAgent();

    const response: Response = await unauthAgent.get("/api/v3/domainWhitelist");

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty(
      "error",
      "No authentication token found"
    );
  });

  test("POST /domainWhitelist - should update domain whitelist settings", async () => {
    const testDomains = "example.com,test.org";

    // Update whitelist
    const updateResponse: Response = await agent
      .post("/api/v3/domainWhitelist")
      .send({
        domain_whitelist: testDomains,
      });

    expect(updateResponse.status).toBe(200);

    // Verify update was successful by getting the whitelist
    const getResponse: Response = await agent.get("/api/v3/domainWhitelist");

    expect(getResponse.status).toBe(200);
    expect(getResponse.body as DomainWhitelistResponse).toHaveProperty(
      "domain_whitelist",
      testDomains
    );
  });

  test("POST /domainWhitelist - should accept empty domain whitelist", async () => {
    // Update with empty whitelist
    const updateResponse: Response = await agent
      .post("/api/v3/domainWhitelist")
      .send({
        domain_whitelist: "",
      });

    expect(updateResponse.status).toBe(200);

    // Verify update
    const getResponse: Response = await agent.get("/api/v3/domainWhitelist");

    expect(getResponse.status).toBe(200);
    expect(getResponse.body as DomainWhitelistResponse).toHaveProperty(
      "domain_whitelist",
      ""
    );
  });

  // Note: The API doesn't validate domain format
  // This test documents the current behavior rather than the expected behavior
  test("POST /domainWhitelist - domain format validation behavior", async () => {
    // Test with invalid domain format
    const invalidResponse: Response = await agent
      .post("/api/v3/domainWhitelist")
      .send({
        domain_whitelist: "invalid domain with spaces",
      });

    // Current behavior: The API accepts invalid domain formats
    expect(invalidResponse.status).toBe(200);

    const getResponse: Response = await agent.get("/api/v3/domainWhitelist");

    expect(getResponse.status).toBe(200);
    expect(getResponse.body as DomainWhitelistResponse).toHaveProperty(
      "domain_whitelist",
      "invalid domain with spaces"
    );
  });

  test("POST /domainWhitelist - authentication behavior", async () => {
    const unauthAgent = await newAgent();

    const response: Response = await unauthAgent
      .post("/api/v3/domainWhitelist")
      .send({
        domain_whitelist: "example.com",
      });

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty(
      "error",
      "No authentication token found"
    );
  });
});
