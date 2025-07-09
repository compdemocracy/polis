import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Response } from "supertest";
import type { Agent } from "supertest";

interface Report {
  report_id: string;
  conversation_id: string;
  report_name?: string;
  label_x_pos?: string;
  label_x_neg?: string;
  label_y_pos?: string;
  label_y_neg?: string;
  label_group_0?: string;
  label_group_1?: string;
  [key: string]: any;
}

describe("Reports API", () => {
  let agent: Agent;
  let testAgent: Agent;
  let conversationId: string;
  let token: string;

  beforeAll(async () => {
    // Use JWT authentication instead of legacy cookie auth
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    // Get JWT authenticated agent
    const authResult = await getJwtAuthenticatedAgent(testUser);
    agent = authResult.agent;
    token = authResult.token;

    // Create agent and set JWT token
    testAgent = await newAgent();
    setAgentJwt(testAgent, token);

    // Create a conversation
    conversationId = await createConversation(agent);
  });

  test("POST /api/v3/reports - should create a new report", async () => {
    const response: Response = await testAgent.post("/api/v3/reports").send({
      conversation_id: conversationId,
    });

    // Should return successful response
    expect(response.status).toBe(200);
    expect(response.text).toBe("{}");

    // Verify report was created by checking conversation reports
    const getResponse: Response = await testAgent.get(
      `/api/v3/reports?conversation_id=${conversationId}`
    );
    const reports: Report[] = JSON.parse(getResponse.text);
    expect(Array.isArray(reports)).toBe(true);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toHaveProperty("conversation_id", conversationId);
  });

  test("GET /api/v3/reports - should return reports for the conversation", async () => {
    // First create a report to ensure there's something to fetch
    await testAgent.post("/api/v3/reports").send({
      conversation_id: conversationId,
    });

    const response: Response = await testAgent.get(
      `/api/v3/reports?conversation_id=${conversationId}`
    );

    // Should return successful response
    expect(response.status).toBe(200);

    // Response should contain at least one report
    const reports: Report[] = JSON.parse(response.text);
    expect(Array.isArray(reports)).toBe(true);
    expect(reports.length).toBeGreaterThan(0);

    // Each report should have conversation_id field
    expect(reports[0]).toHaveProperty("conversation_id", conversationId);
  });

  describe("with existing report", () => {
    let reportId: string;

    beforeAll(async () => {
      // Create a report for these tests
      await testAgent.post("/api/v3/reports").send({
        conversation_id: conversationId,
      });

      // Get the report ID
      const response: Response = await testAgent.get(
        `/api/v3/reports?conversation_id=${conversationId}`
      );
      const reports: Report[] = JSON.parse(response.text);
      reportId = reports[0].report_id;
    });

    test("PUT /api/v3/reports - should update report details", async () => {
      const testReportName = "Test Report Name";

      const response: Response = await testAgent.put("/api/v3/reports").send({
        conversation_id: conversationId,
        report_id: reportId,
        report_name: testReportName,
        label_x_pos: "X Positive",
        label_x_neg: "X Negative",
        label_y_pos: "Y Positive",
        label_y_neg: "Y Negative",
        label_group_0: "Group 0",
        label_group_1: "Group 1",
      });

      // Should return successful response
      expect(response.status).toBe(200);
      expect(response.text).toBe("{}");

      // Verify the update worked by fetching the report again
      const getResponse: Response = await testAgent.get(
        `/api/v3/reports?conversation_id=${conversationId}`
      );
      const reports: Report[] = JSON.parse(getResponse.text);

      // Find our report
      const updatedReport = reports.find((r) => r.report_id === reportId);
      expect(updatedReport).toHaveProperty("report_name", testReportName);
      expect(updatedReport).toHaveProperty("label_x_pos", "X Positive");
      expect(updatedReport).toHaveProperty("label_x_neg", "X Negative");
      expect(updatedReport).toHaveProperty("label_y_pos", "Y Positive");
      expect(updatedReport).toHaveProperty("label_y_neg", "Y Negative");
      expect(updatedReport).toHaveProperty("label_group_0", "Group 0");
      expect(updatedReport).toHaveProperty("label_group_1", "Group 1");
    });

    test("GET /api/v3/reports - should get all reports for user", async () => {
      const response: Response = await testAgent.get("/api/v3/reports");

      // Should return successful response
      expect(response.status).toBe(200);

      // Response should contain an array of reports
      const reports: Report[] = JSON.parse(response.text);
      expect(Array.isArray(reports)).toBe(true);

      // Our report should be included
      const hasReport = reports.some((r) => r.report_id === reportId);
      expect(hasReport).toBe(true);
    });

    test("GET /api/v3/reports?report_id - should get a specific report", async () => {
      const response: Response = await testAgent.get(
        `/api/v3/reports?report_id=${reportId}`
      );

      // Should return successful response
      expect(response.status).toBe(200);

      // Response should contain an array with one report
      const reports: Report[] = JSON.parse(response.text);
      expect(Array.isArray(reports)).toBe(true);
      expect(reports.length).toBe(1);

      // The report should have the correct ID
      expect(reports[0]).toHaveProperty("report_id", reportId);
    });
  });
});
