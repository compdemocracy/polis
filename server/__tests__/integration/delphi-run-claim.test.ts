/**
 * POST /api/v3/delphi/jobs (what `polis delphi run` calls) for a sign-in
 * that lacks the delphi_enabled claim.
 *
 * The handler threw `new Error("Unauthorized")` inside its own try, and the
 * catch answered every error with HTTP 500, so a plain permission refusal
 * looked like a server fault and a client could not tell whether a job had
 * been queued. It is a 403 with a stable code, as POST /api/v3/votes-bulk
 * answers for the same claim. Who may submit is unchanged: only the status
 * and body of the refusal are.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";

const REFUSAL = "polis_err_delphi_jobs_delphi_disabled";

describe("POST /api/v3/delphi/jobs and the delphi_enabled claim", () => {
  let ownerAgent: Agent;
  let claimAgent: Agent;
  let reportId: string;

  beforeAll(async () => {
    // The pooled test users are not in the simulator's delphi_enabled list
    // (oidc-simulator/rules/add-custom-claims.js); admin@polis.test is.
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    const { agent } = await getJwtAuthenticatedAgent(setup.testUser);
    ownerAgent = agent;

    await ownerAgent
      .post("/api/v3/reports")
      .send({ conversation_id: setup.conversationId });
    const listed = await ownerAgent
      .get(`/api/v3/reports?conversation_id=${setup.conversationId}`)
      .send();
    reportId = JSON.parse(listed.text)[0].report_id;

    ({ agent: claimAgent } = await getJwtAuthenticatedAgent({
      email: "admin@polis.test",
      password: "Te$tP@ssw0rd*",
      hname: "Admin",
    }));
  });

  test("a sign-in without the claim is refused with 403 and a stable code", async () => {
    const response = await ownerAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: reportId, job_type: "FULL_PIPELINE" });

    expect(response.status).toBe(403);
    expect(response.body).toHaveProperty("error", REFUSAL);
  });

  test("the claim is checked before the request is read", async () => {
    // An unknown job type would be a 400 for a sign-in with the claim.
    const response = await ownerAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: reportId, job_type: "NOT_A_JOB_TYPE" });

    expect(response.status).toBe(403);
    expect(response.body).toHaveProperty("error", REFUSAL);
  });

  test("a sign-in with the claim passes the claim check, as before", async () => {
    const unknownType = await claimAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: reportId, job_type: "NOT_A_JOB_TYPE" });
    expect(unknownType.status).toBe(400);
    expect(unknownType.body.status).toBe("error");
    expect(unknownType.body.error).toMatch(/^Unknown job_type/);

    const noTarget = await claimAgent
      .post("/api/v3/delphi/jobs")
      .send({ job_type: "FULL_PIPELINE" });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error).toBe(
      "Missing required parameter: either report_id or conversation_id must be provided"
    );
  });
});
