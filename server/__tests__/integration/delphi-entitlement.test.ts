/**
 * Whether an account may use Polis 2, against the real stack (the server,
 * Postgres, DynamoDB Local and the OIDC simulator), under each value of
 * POLIS_DELPHI_ENTITLEMENT (Config.delphiEntitlement, set per test here):
 * GET /api/v3/delphi/me, and the pipeline-run route that asks the same
 * question before its owner check.
 *
 * admin@polis.test carries the delphi_enabled claim in the simulator
 * (oidc-simulator/rules/add-custom-claims.js); the pooled test users do not.
 * test.env leaves the setting unset (claim) and lists no site administrators.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";
import request from "supertest";
import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import {
  cleanupDelphiJobs,
  ensureJobGuardTableExists,
  ensureJobQueueTableExists,
} from "../setup/dynamodb-test-helpers";
import { getApp } from "../app-loader";
import { pool } from "../setup/db-test-helpers";
import Config from "../../src/config";

const DEFAULT_SOURCE = Config.delphiEntitlement;
const setSource = (source: string) => {
  (Config as { delphiEntitlement: string }).delphiEntitlement = source;
};

async function uidOf(agent: Agent): Promise<number> {
  const reply = await agent.get("/api/v3/users");
  expect(reply.status).toBe(200);
  return reply.body.uid;
}

async function zidOf(conversationId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  return rows[0].zid;
}

async function reportFor(
  agent: Agent,
  conversationId: string
): Promise<string> {
  await agent.post("/api/v3/reports").send({ conversation_id: conversationId });
  const listed = await agent
    .get(`/api/v3/reports?conversation_id=${conversationId}`)
    .send();
  return JSON.parse(listed.text)[0].report_id;
}

const delphiDisabled = {
  error: "polis_err_delphi_jobs_delphi_disabled",
  message: "polis_err_delphi_jobs_delphi_disabled",
  status: 403,
};

describe("Polis 2 entitlement: GET /api/v3/delphi/me and the setting", () => {
  let claimAgent: Agent; // admin@polis.test: the claim, no row
  let rowAgent: Agent; // a pooled user: a row, no claim
  let rowUid: number;
  let rowZid: number;
  let rowReportId: string;

  beforeAll(async () => {
    await ensureJobQueueTableExists();
    await ensureJobGuardTableExists();
    ({ agent: claimAgent } = await getJwtAuthenticatedAgent({
      email: "admin@polis.test",
      password: "Te$tP@ssw0rd*",
      hname: "Admin",
    }));
    // A pooled user no other test file signs in as.
    const pooled = getPooledTestUser(31);
    const setup = await setupAuthAndConvo({
      commentCount: 1,
      userData: {
        email: pooled.email,
        hname: pooled.name,
        password: pooled.password,
      },
    });
    ({ agent: rowAgent } = await getJwtAuthenticatedAgent({
      email: pooled.email,
      hname: pooled.name,
      password: pooled.password,
    }));
    rowUid = await uidOf(rowAgent);
    rowZid = await zidOf(setup.conversationId);
    rowReportId = await reportFor(rowAgent, setup.conversationId);
    expect(rowUid).toBe(setup.userId);
    await pool.query(
      "INSERT INTO delphi_entitlements (uid, source) VALUES ($1, 'site_admin') ON CONFLICT (uid) DO NOTHING",
      [rowUid]
    );
    // The claim holder has no row.
    await pool.query("DELETE FROM delphi_entitlements WHERE uid = $1", [
      await uidOf(claimAgent),
    ]);
  });

  afterEach(() => setSource(DEFAULT_SOURCE));

  afterAll(async () => {
    await pool.query("DELETE FROM delphi_entitlements WHERE uid = $1", [
      rowUid,
    ]);
    await cleanupDelphiJobs(String(rowZid));
  });

  test("the test stack runs with the default, claim", () => {
    expect(DEFAULT_SOURCE).toBe("claim");
  });

  test("without a token the route answers 401, as every signed-in route does", async () => {
    const reply = await request(await getApp()).get("/api/v3/delphi/me");
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "No authentication token found" });
  });

  test("claim: the claim decides and the row is not consulted", async () => {
    const claim = await claimAgent.get("/api/v3/delphi/me");
    expect(claim.status).toBe(200);
    expect(claim.body).toEqual({ delphi_entitled: true });

    const row = await rowAgent.get("/api/v3/delphi/me");
    expect(row.status).toBe(200);
    expect(row.body).toEqual({ delphi_entitled: false });

    const jobs = await rowAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: rowReportId, job_type: "FULL_PIPELINE" });
    expect(jobs.status).toBe(403);
    expect(jobs.body).toEqual(delphiDisabled);
  });

  test("claim_or_db: either one", async () => {
    setSource("claim_or_db");
    expect((await claimAgent.get("/api/v3/delphi/me")).body).toEqual({
      delphi_entitled: true,
    });
    expect((await rowAgent.get("/api/v3/delphi/me")).body).toEqual({
      delphi_entitled: true,
    });
  });

  test("db: the row decides; the claim alone is not enough", async () => {
    setSource("db");
    expect((await claimAgent.get("/api/v3/delphi/me")).body).toEqual({
      delphi_entitled: false,
    });
    expect((await rowAgent.get("/api/v3/delphi/me")).body).toEqual({
      delphi_entitled: true,
    });
  });

  test("db: an owner with a row starts a pipeline run on its own conversation; without the row it gets today's refusal", async () => {
    setSource("db");
    const admitted = await rowAgent
      .post("/api/v3/delphi/jobs")
      .send({ report_id: rowReportId, job_type: "FULL_PIPELINE" });
    expect(admitted.status).toBe(200);
    expect(admitted.body.status).toBe("success");

    await pool.query("DELETE FROM delphi_entitlements WHERE uid = $1", [
      rowUid,
    ]);
    try {
      const refused = await rowAgent
        .post("/api/v3/delphi/jobs")
        .send({ report_id: rowReportId, job_type: "FULL_PIPELINE" });
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(delphiDisabled);
      expect((await rowAgent.get("/api/v3/delphi/me")).body).toEqual({
        delphi_entitled: false,
      });
    } finally {
      await pool.query(
        "INSERT INTO delphi_entitlements (uid, source) VALUES ($1, 'site_admin') ON CONFLICT (uid) DO NOTHING",
        [rowUid]
      );
    }
  });
});
