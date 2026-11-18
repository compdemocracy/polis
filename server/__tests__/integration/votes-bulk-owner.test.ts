/**
 * The vote CSV import (POST /api/v3/votes-bulk) and the conversation owner,
 * against the real stack: the server (an instance of this file's own), Postgres,
 * MinIO and the OIDC simulator. The queue send is replaced (no SQS runs here).
 *
 * The delphi_enabled claim is still checked first and answered as before. A
 * caller with the claim must also own the conversation, or be a site
 * administrator (ADMIN_UIDS); anyone else gets HTTP 403 with one code, and
 * nothing is stored, written or queued.
 *
 * admin@polis.test carries the claim in the simulator; the pooled test users
 * do not. test.env lists no site administrators; the administrator cases set
 * the server's ADMIN_UIDS value in this process and put it back.
 */
import { randomUUID } from "crypto";
import http from "http";
import { Pool } from "pg";
import request from "supertest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import Config from "../../src/config";
import { sqsClient } from "../../src/utils/sqs";
import { EXPORT_AGREE } from "../../src/votes/convention";
import { createAppInstance, getOidcToken } from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

type Agent = ReturnType<typeof request.agent>;

const NOT_OWNER = "polis_err_votes_bulk_not_conversation_owner";
const REFUSED = { error: NOT_OWNER, message: NOT_OWNER, status: 403 };
const NO_CLAIM = {
  error: "polis_err_votes_bulk_delphi_disabled",
  message: "polis_err_votes_bulk_delphi_disabled",
  status: 403,
};
const PROCESSING = {
  status: "processing",
  message: "Vote import started. This may take a few minutes.",
};

async function post(agent: Agent, route: string, body: object) {
  const response = await agent.post(route).send(body).timeout(15000);
  expect(response.status).toBe(200);
  return response;
}

/** Every row the import could write for the conversation. */
async function snapshot(zid: number) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "votes",
    "votes_latest_unique",
    "participants",
    "comments",
    "byod_import_jobs",
  ]) {
    result[table] = (
      await pool.query(
        `SELECT row_to_json(t) AS row FROM ${table} t WHERE zid=$1 ORDER BY row_to_json(t)::text`,
        [zid]
      )
    ).rows;
  }
  return result;
}

async function jobsFor(zid: number) {
  return (
    await pool.query(
      "SELECT zid, status, stage, s3_key FROM byod_import_jobs WHERE zid=$1 ORDER BY id",
      [zid]
    )
  ).rows;
}

describe("the vote CSV import and the conversation owner", () => {
  let server: http.Server;
  let claimAgent: Agent; // admin@polis.test: the claim; owns only its own conversation
  let ownerAgent: Agent; // a pooled test user: owns the conversation, no claim
  let claimUid: number;
  let target: { conversationId: string; zid: number; originalId: string };
  let own: { conversationId: string; zid: number; originalId: string };
  const adminList = Config.adminUIDs;
  const openedPools = new Set<Pool>([pool]);
  const poolPrototype = Pool.prototype as unknown as {
    connect: (...args: unknown[]) => unknown;
  };
  const hadOwnConnect = Object.prototype.hasOwnProperty.call(
    poolPrototype,
    "connect"
  );
  const connect = poolPrototype.connect;

  async function conversation(agent: Agent) {
    const conversationId = (
      await post(agent, "/api/v3/conversations", {
        topic: `Vote import owner ${randomUUID()}`,
        is_active: true,
        is_draft: false,
        is_anon: false,
        strict_moderation: false,
        profanity_filter: false,
        spam_filter: false,
      })
    ).body.conversation_id;
    const zid = (
      await pool.query("SELECT zid FROM zinvites WHERE zinvite=$1", [
        conversationId,
      ])
    ).rows[0].zid;
    const originalId = randomUUID();
    await post(agent, "/api/v3/comments-bulk", {
      conversation_id: conversationId,
      is_seed: true,
      csv: `comment_text,original_id\nA statement for import ${originalId},${originalId}`,
    });
    return { conversationId, zid, originalId };
  }

  // No declaration line: the file is read in the export convention.
  function votesCsv(originalId: string) {
    return [
      "vote_id,user_id,vote_value,timestamp,comment_id",
      `1,${randomUUID()},${EXPORT_AGREE},2023-11-14T22:13:20Z,${originalId}`,
    ].join("\n");
  }

  /** The queue send, replaced: what the route would have queued. */
  function queued(): unknown[] {
    const messages: unknown[] = [];
    jest.spyOn(sqsClient, "send").mockImplementation((async (command: any) => {
      messages.push(JSON.parse(command.input.MessageBody));
      return {};
    }) as never);
    return messages;
  }

  beforeAll(async () => {
    // query() also takes connections through connect(). Track the
    // application's pools as well as the fixture pool, to end them all.
    poolPrototype.connect = function (this: Pool, ...args: unknown[]) {
      openedPools.add(this);
      return connect.apply(this, args);
    };
    server = (await createAppInstance()).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));

    claimAgent = request.agent(server);
    claimAgent.set(
      "Authorization",
      `Bearer ${await getOidcToken({
        email: "admin@polis.test",
        password: "Te$tP@ssw0rd*",
      })}`
    );
    const ownerUser = getPooledTestUser(2);
    ownerAgent = request.agent(server);
    ownerAgent.set(
      "Authorization",
      `Bearer ${await getOidcToken({
        email: ownerUser.email,
        password: ownerUser.password,
      })}`
    );

    target = await conversation(ownerAgent);
    own = await conversation(claimAgent);
    const rows = (
      await pool.query("SELECT uid FROM users WHERE email = $1", [
        "admin@polis.test",
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    claimUid = rows[0].uid;
  });

  afterEach(() => {
    (Config as { adminUIDs: string }).adminUIDs = adminList;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
    } finally {
      sqsClient.destroy();
      try {
        await Promise.all([...openedPools].map((opened) => opened.end()));
      } finally {
        if (hadOwnConnect) poolPrototype.connect = connect;
        else delete (poolPrototype as { connect?: unknown }).connect;
      }
    }
  });

  test("a claim holder who neither owns the conversation nor administers the site is refused, and nothing is stored, written or queued", async () => {
    const before = await snapshot(target.zid);
    const stored = jest.spyOn(S3Client.prototype, "send");
    const messages = queued();
    for (const body of [
      { csv: votesCsv(target.originalId) },
      // A declaration that would be refused as malformed: it is never read.
      {
        csv: `# vote-convention: agree=2;disagree=0;pass=0\n${votesCsv(
          target.originalId
        )}`,
      },
      {},
    ]) {
      const response = await claimAgent
        .post("/api/v3/votes-bulk")
        .send({ conversation_id: target.conversationId, ...body });
      expect(response.status).toBe(403);
      expect(response.body).toEqual(REFUSED);
    }
    expect(stored).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(await snapshot(target.zid)).toEqual(before);
    expect(await jobsFor(target.zid)).toEqual([]);
  });

  test("the owner without the claim gets today's reply, and nothing changes", async () => {
    const before = await snapshot(target.zid);
    const stored = jest.spyOn(S3Client.prototype, "send");
    const messages = queued();
    const response = await ownerAgent.post("/api/v3/votes-bulk").send({
      conversation_id: target.conversationId,
      csv: votesCsv(target.originalId),
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(NO_CLAIM);
    expect(stored).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(await snapshot(target.zid)).toEqual(before);
  });

  test.each([
    ["a JSON string", (uid: number) => JSON.stringify(String(uid))],
    ["an array of strings", (uid: number) => JSON.stringify([String(uid)])],
    ["invalid JSON", (uid: number) => `[${uid}`],
  ])("an administrator list that is %s names nobody", async (_label, list) => {
    (Config as { adminUIDs: string }).adminUIDs = list(claimUid);
    const before = await snapshot(target.zid);
    const stored = jest.spyOn(S3Client.prototype, "send");
    const messages = queued();
    const response = await claimAgent.post("/api/v3/votes-bulk").send({
      conversation_id: target.conversationId,
      csv: votesCsv(target.originalId),
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(REFUSED);
    expect(stored).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(await snapshot(target.zid)).toEqual(before);
  });

  test("the owner with the claim imports as before", async () => {
    const messages = queued();
    const csv = votesCsv(own.originalId);
    const response = await claimAgent
      .post("/api/v3/votes-bulk")
      .send({ conversation_id: own.conversationId, csv });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(PROCESSING);
    const jobs = await jobsFor(own.zid);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      zid: own.zid,
      status: "pending",
      stage: "mapping",
    });
    expect(jobs[0].s3_key).toMatch(
      new RegExp(`^imports/votes/${own.zid}/\\d+\\.csv$`)
    );
    expect(messages).toEqual([
      {
        jobId: expect.any(Number),
        zid: own.zid,
        s3Key: jobs[0].s3_key,
        email: "admin@polis.test",
      },
    ]);
  });

  test("a site administrator with the claim may import into a conversation it does not own", async () => {
    (Config as { adminUIDs: string }).adminUIDs = JSON.stringify([claimUid]);
    const messages = queued();
    const response = await claimAgent.post("/api/v3/votes-bulk").send({
      conversation_id: target.conversationId,
      csv: votesCsv(target.originalId),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(PROCESSING);
    const jobs = await jobsFor(target.zid);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ zid: target.zid, status: "pending" });
    expect(messages).toEqual([
      {
        jobId: expect.any(Number),
        zid: target.zid,
        s3Key: jobs[0].s3_key,
        email: "admin@polis.test",
      },
    ]);
  });
});
