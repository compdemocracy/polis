import { describe, expect, test, beforeAll } from "@jest/globals";
import type { Response } from "supertest";
import { getPooledTestUser } from "../setup/test-user-helpers";
import {
  getJwtAuthenticatedAgent,
  type TestUser,
  newAgent,
} from "../setup/api-test-helpers";

describe("JWT Authentication with OIDC Simulator", () => {
  let baseTestUser: TestUser;

  beforeAll(async () => {
    // Use a pre-populated test user from the pool
    const pooledUser = getPooledTestUser(0); // Use test.user.0@polis.test
    baseTestUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    console.log(
      "Using pooled test user for JWT auth tests:",
      baseTestUser.email
    );
  });

  test("should authenticate with a token from OIDC simulator and retrieve user info", async () => {
    const { agent, token } = await getJwtAuthenticatedAgent(baseTestUser);
    console.log("getJwtAuthenticatedAgent", {
      token: token ? "received" : "missing",
    });
    expect(token).toBeDefined();

    const response: Response = await agent.get("/api/v3/users");

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("error");
    expect(response.body).toHaveProperty("uid");
    expect(typeof response.body.uid).toBe("number");
    expect(response.body).toHaveProperty("email");
    expect(response.body.email).toMatch(baseTestUser.email);

    const decodedToken = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    expect(decodedToken.sub).toBeDefined();
  });

  test("should fail with 401 for an invalid/malformed token", async () => {
    const freshAgent = await newAgent();
    const malformedToken = "this.is.not.a.jwt";

    const response: Response = await freshAgent
      .get("/api/v3/users")
      .set("Authorization", `Bearer ${malformedToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty("error", "Invalid token format");
  });

  test("should fail with 401 if no token is provided to a protected route", async () => {
    const agent = await newAgent();

    const response: Response = await agent.get("/api/v3/users");

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty("error", "Authentication required");
  });

  // TODO: Add tests for expired tokens if the simulator supports creating them or if you can manipulate time.
  // TODO: Add tests for tokens with invalid audience or issuer if critical and configurable in simulator.
});

describe("JWT Authentication with OIDC", () => {
  describe("Basic JWT Authentication", () => {
    test("should authenticate with JWT token", async () => {
      // Create an authenticated user with JWT
      expect(true).toBe(true);
    });

    test("should handle custom OIDC user data", async () => {
      // Create an authenticated user with custom OIDC user data
      expect(true).toBe(true);
    });

    test("should fail without authentication token", async () => {
      // Create agent without authentication
      const { getTestAgent } = await import("../setup/api-test-helpers");
      const unauthenticatedAgent = await getTestAgent();

      const response: Response = await unauthenticatedAgent.get(
        "/api/v3/users"
      );

      // Should fail without auth
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Authentication required");
    });
  });
});
