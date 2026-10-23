import { randomUUID } from "crypto";
import http from "http";
import request from "supertest";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
import {
  processImportJob,
  refreshVotesLatestUnique,
  s3Client,
} from "../../src/workers/import-processor";
import { sqsClient } from "../../src/utils/sqs";
import {
  IMPORT_TARGET_MESSAGE,
  IMPORT_TARGET_NOT_EMPTY,
} from "../../src/utils/import-target";
import {
  EXPORT_AGREE,
  EXPORT_DISAGREE,
  EXPORT_PASS,
  semanticToWire,
  storageToSemantic,
} from "../../src/votes/convention";
import { createAppInstance, getOidcToken } from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";

type Agent = ReturnType<typeof request.agent>;
async function post(agent: Agent, route: string, body: object) {
  const response = await agent.post(route).send(body).timeout(15000);
  if (response.body?.auth?.token)
    agent.set("Authorization", `Bearer ${response.body.auth.token}`);
  expect(response.status).toBe(200);
  return response;
}
async function snapshot(zid: number) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "comments",
    "votes",
    "votes_latest_unique",
    "participants",
    "participants_extended",
    "conversations",
    "math_ticks",
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
function votesCsv(originalId: string, username = randomUUID()) {
  return [
    `# vote-convention: agree=+${EXPORT_AGREE};disagree=${EXPORT_DISAGREE};pass=${EXPORT_PASS};format=polis-export/1`,
    "vote_id,user_id,vote_value,timestamp,comment_id",
    `1,${username},${EXPORT_AGREE},2023-11-14T22:13:20Z,${originalId}`,
  ].join("\n");
}
async function job(zid: number, csv: string) {
  const s3Key = `imports/votes/${zid}/${randomUUID()}.csv`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
      Key: s3Key,
      Body: csv,
    })
  );
  const jobId = (
    await pool.query(
      "INSERT INTO byod_import_jobs (zid,s3_key,status,stage) VALUES ($1,$2,'pending','mapping') RETURNING id",
      [zid, s3Key]
    )
  ).rows[0].id;
  return { zid, jobId, s3Key, email: "" };
}

describe("imports refuse existing data and preserve live votes", () => {
  let server: http.Server;
  let owner: Agent;
  beforeAll(async () => {
    server = (await createAppInstance()).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    owner = request.agent(server);
    owner.set(
      "Authorization",
      `Bearer ${await getOidcToken({
        email: "admin@polis.test",
        password: "Te$tP@ssw0rd*",
      })}`
    );
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });
  async function conversation(withComments = true) {
    const conversationId = (
      await post(owner, "/api/v3/conversations", {
        topic: `Import ${randomUUID()}`,
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
    if (withComments)
      await post(owner, "/api/v3/comments-bulk", {
        conversation_id: conversationId,
        is_seed: true,
        csv: `comment_text,original_id\nA statement for import,${originalId}`,
      });
    return { conversationId, zid, originalId };
  }
  async function refuseRoutes(c: Awaited<ReturnType<typeof conversation>>) {
    const before = await snapshot(c.zid);
    const send = jest.spyOn(S3Client.prototype, "send");
    const queue = jest.spyOn(sqsClient, "send").mockResolvedValue({} as never);
    for (const route of ["comments", "votes"]) {
      const response = await owner
        .post(`/api/v3/${route}-bulk`)
        .send({
          conversation_id: c.conversationId,
          csv:
            route === "votes"
              ? votesCsv(c.originalId)
              : `comment_text,original_id\nAnother statement,${randomUUID()}`,
        });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: IMPORT_TARGET_NOT_EMPTY,
        code: IMPORT_TARGET_NOT_EMPTY,
        message: IMPORT_TARGET_MESSAGE,
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(await snapshot(c.zid)).toEqual(before);
  }
  test.each(["owner vote", "other participant", "other comment"])(
    "refuses %s before upload/enqueue and changes no existing rows",
    async (kind) => {
      const c = await conversation();
      const participant = request.agent(server);
      if (kind === "owner vote")
        await post(owner, "/api/v3/votes", {
          conversation_id: c.conversationId,
          tid: 0,
          vote: semanticToWire("agree"),
        });
      else if (kind === "other comment")
        await post(participant, "/api/v3/comments", {
          conversation_id: c.conversationId,
          txt: "An existing live comment",
        });
      else {
        // The comment route resolves membership before rejecting missing text.
        expect(
          (
            await participant
              .post("/api/v3/comments")
              .send({ conversation_id: c.conversationId })
          ).status
        ).toBe(400);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM participants WHERE zid=$1",
              [c.zid]
            )
          ).rows[0].n
        ).toBe(2);
      }
      if (kind === "other comment") {
        // The live route updates this asynchronously after returning its receipt.
        // Wait on that observable write before taking the immutable baseline.
        const deadline = Date.now() + 5000;
        while (
          (
            await pool.query(
              "SELECT 1 FROM participants WHERE zid=$1 AND pid>0 AND last_interaction=0",
              [c.zid]
            )
          ).rows.length
        ) {
          if (Date.now() > deadline)
            throw new Error("Live comment interaction was not recorded");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      await refuseRoutes(c);
    }
  );
  test("comments-bulk refuses owner comments, including a repeated comments phase", async () => {
    const c = await conversation();
    const before = await snapshot(c.zid);
    const r = await owner
      .post("/api/v3/comments-bulk")
      .send({
        conversation_id: c.conversationId,
        csv: `comment_text,original_id\nAnother,${randomUUID()}`,
      });
    expect(r.status).toBe(409);
    expect(await snapshot(c.zid)).toEqual(before);
  });

  // The previous stale-snapshot diagnostic used these three live operations in
  // both orders. Admission now rejects its non-empty starting state, and the
  // real worker must reject too; the no-lost-history/latest assertions remain.
  test.each([
    ["ordinary vote", "live-first"],
    ["ordinary vote", "import-first"],
    ["own comment vote", "live-first"],
    ["own comment vote", "import-first"],
    ["own comment vote with earlier history", "live-first"],
    ["own comment vote with earlier history", "import-first"],
  ])("%s / %s", async (kind, order) => {
    const c = await conversation();
    const participant = request.agent(server);
    await post(participant, "/api/v3/votes", {
      conversation_id: c.conversationId,
      tid: 0,
      vote: semanticToWire("pass"),
    });
    if (kind.endsWith("earlier history"))
      await post(participant, "/api/v3/votes", {
        conversation_id: c.conversationId,
        tid: 1,
        vote: semanticToWire("pass"),
      });
    const payload = await job(c.zid, votesCsv(c.originalId));
    const live = () =>
      post(
        participant,
        kind === "ordinary vote" ? "/api/v3/votes" : "/api/v3/comments",
        {
          conversation_id: c.conversationId,
          tid: 0,
          txt: "My live statement",
          vote: semanticToWire("agree"),
          lang: "en",
        }
      );
    if (order === "live-first") await live();
    const before = await snapshot(c.zid);
    await expect(processImportJob(payload)).rejects.toMatchObject({
      code: IMPORT_TARGET_NOT_EMPTY,
      message: IMPORT_TARGET_MESSAGE,
    });
    expect(await snapshot(c.zid)).toEqual(before);
    if (order === "import-first") await live();
    const tid = kind === "ordinary vote" ? 0 : 1;
    const latest = (
      await pool.query(
        "SELECT vote FROM votes_latest_unique WHERE zid=$1 AND tid=$2",
        [c.zid, tid]
      )
    ).rows;
    expect(latest).toHaveLength(1);
    expect(storageToSemantic(latest[0].vote)).toBe("agree");
    expect(
      (
        await pool.query(
          "SELECT status,error_message FROM byod_import_jobs WHERE id=$1",
          [payload.jobId]
        )
      ).rows[0]
    ).toEqual({ status: "failed", error_message: IMPORT_TARGET_MESSAGE });
  });
  test("empty comments then votes succeeds; redelivery is refused unchanged", async () => {
    const c = await conversation();
    const queued: any[] = [];
    jest.spyOn(sqsClient, "send").mockImplementation(async (command: any) => {
      queued.push(JSON.parse(command.input.MessageBody));
      return {} as never;
    });
    await post(owner, "/api/v3/votes-bulk", {
      conversation_id: c.conversationId,
      csv: votesCsv(c.originalId),
    });
    expect(queued).toHaveLength(1);
    const payload = { ...queued[0], email: "" };
    await processImportJob(payload);
    const latest = (
      await pool.query(
        "SELECT pid,tid,vote FROM votes_latest_unique WHERE zid=$1",
        [c.zid]
      )
    ).rows;
    expect(latest).toHaveLength(1);
    expect(storageToSemantic(latest[0].vote)).toBe("agree");
    const before = await snapshot(c.zid);
    await expect(processImportJob(payload)).rejects.toMatchObject({
      code: IMPORT_TARGET_NOT_EMPTY,
    });
    expect(await snapshot(c.zid)).toEqual(before);
  });
  test("a vote arriving during object download is refused by the first write transaction", async () => {
    const c = await conversation();
    const payload = await job(c.zid, votesCsv(c.originalId));
    const original = s3Client.send.bind(s3Client);
    jest.spyOn(s3Client, "send").mockImplementation(async (command: any) => {
      const result = await original(command);
      if (command.constructor.name === "GetObjectCommand")
        await post(owner, "/api/v3/votes", {
          conversation_id: c.conversationId,
          tid: 0,
          vote: semanticToWire("agree"),
        });
      return result as never;
    });
    await expect(processImportJob(payload)).rejects.toMatchObject({
      code: IMPORT_TARGET_NOT_EMPTY,
    });
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM votes WHERE zid=$1", [
          c.zid,
        ])
      ).rows[0].n
    ).toBe(1);
    expect(
      storageToSemantic(
        (
          await pool.query(
            "SELECT vote FROM votes_latest_unique WHERE zid=$1",
            [c.zid]
          )
        ).rows[0].vote
      )
    ).toBe("agree");
  });
  test.each(["unknown-comment", "header-only"])(
    "zero-batch %s CSV refuses a vote arriving during download without completion side effects",
    async (kind) => {
      const c = await conversation();
      const csv = votesCsv(randomUUID());
      const payload = await job(
        c.zid,
        kind === "header-only" ? csv.split("\n").slice(0, 2).join("\n") : csv
      );
      const original = s3Client.send.bind(s3Client);
      let before: Awaited<ReturnType<typeof snapshot>> | undefined;
      const send = jest
        .spyOn(s3Client, "send")
        .mockImplementation(async (command: any) => {
          const result = await original(command);
          if (command instanceof GetObjectCommand) {
            await post(owner, "/api/v3/votes", {
              conversation_id: c.conversationId,
              tid: 0,
              vote: semanticToWire("agree"),
            });
            before = await snapshot(c.zid);
          }
          return result as never;
        });
      await expect(processImportJob(payload)).rejects.toMatchObject({
        code: IMPORT_TARGET_NOT_EMPTY,
      });
      expect(before).toBeDefined();
      expect(await snapshot(c.zid)).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT status, error_message FROM byod_import_jobs WHERE id=$1",
            [payload.jobId]
          )
        ).rows[0]
      ).toEqual({ status: "failed", error_message: IMPORT_TARGET_MESSAGE });
      expect(
        send.mock.calls.map(([command]) => command.constructor.name)
      ).toEqual(["GetObjectCommand"]);
      send.mockRestore();
      const retained = await s3Client.send(
        new GetObjectCommand({
          Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
          Key: payload.s3Key,
        })
      );
      expect(await retained.Body!.transformToString()).toBe(
        kind === "header-only" ? csv.split("\n").slice(0, 2).join("\n") : csv
      );
      expect(
        storageToSemantic(
          (
            await pool.query(
              "SELECT vote FROM votes_latest_unique WHERE zid=$1",
              [c.zid]
            )
          ).rows[0].vote
        )
      ).toBe("agree");
    }
  );
  test.each(["unknown-comment", "header-only"])(
    "zero-batch %s CSV still completes for an empty target",
    async (kind) => {
      const c = await conversation();
      const csv = votesCsv(randomUUID());
      const payload = await job(
        c.zid,
        kind === "header-only" ? csv.split("\n").slice(0, 2).join("\n") : csv
      );
      const before = await snapshot(c.zid);
      const send = jest.spyOn(s3Client, "send");
      await processImportJob(payload);
      expect(
        (
          await pool.query(
            "SELECT status, stage FROM byod_import_jobs WHERE id=$1",
            [payload.jobId]
          )
        ).rows[0]
      ).toEqual({ status: "completed", stage: "finished" });
      const after = await snapshot(c.zid);
      for (const table of [
        "comments",
        "votes",
        "votes_latest_unique",
        "participants",
        "participants_extended",
      ])
        expect(after[table]).toEqual(before[table]);
      expect(after.math_ticks).not.toEqual(before.math_ticks);
      expect(
        send.mock.calls.map(([command]) => command.constructor.name)
      ).toEqual(["GetObjectCommand", "DeleteObjectCommand"]);
    }
  );
  test("two competing vote jobs never merge", async () => {
    const c = await conversation();
    const jobs = await Promise.all([
      job(c.zid, votesCsv(c.originalId)),
      job(c.zid, votesCsv(c.originalId)),
    ]);
    const outcomes = await Promise.allSettled(
      jobs.map((payload) => processImportJob(payload))
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult;
    expect(refused.reason.code).toBe(IMPORT_TARGET_NOT_EMPTY);
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM votes WHERE zid=$1", [
          c.zid,
        ])
      ).rows[0].n
    ).toBe(1);
  });
  test("two competing comment uploads never merge", async () => {
    const c = await conversation(false);
    const outcomes = await Promise.all(
      ["First", "Second"].map((txt) =>
        owner
          .post("/api/v3/comments-bulk")
          .send({
            conversation_id: c.conversationId,
            csv: `comment_text,original_id\n${txt},${randomUUID()}`,
          })
      )
    );
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM comments WHERE zid=$1",
          [c.zid]
        )
      ).rows[0].n
    ).toBe(1);
  });
  test("older input in a later batch never moves latest backwards", async () => {
    const c = await conversation();
    const name = randomUUID();
    let csv = votesCsv(c.originalId, name).replace("2023-11-14", "2024-11-14");
    for (let i = 1; i < 1000; i++)
      csv += `\n${i + 1},${randomUUID()},${EXPORT_AGREE},2024-11-14T22:13:20Z,${
        c.originalId
      }`;
    csv += `\n1001,${name},${EXPORT_PASS},2023-11-14T22:13:20Z,${c.originalId}`;
    await processImportJob(await job(c.zid, csv));
    const rows = (
      await pool.query(
        "SELECT v.vote,v.modified FROM votes_latest_unique v JOIN participants p USING(zid,pid) JOIN users u USING(uid) WHERE v.zid=$1 AND u.username=$2",
        [c.zid, name]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(storageToSemantic(rows[0].vote)).toBe("agree");
    expect(Number(rows[0].modified)).toBe(Date.parse("2024-11-14T22:13:20Z"));
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM votes WHERE zid=$1", [
          c.zid,
        ])
      ).rows[0].n
    ).toBe(1001);
  });
  test("refresh is scoped to explicit keys and cannot replace newer or equal latest values", async () => {
    const c = await conversation();
    await post(owner, "/api/v3/votes", {
      conversation_id: c.conversationId,
      tid: 0,
      vote: semanticToWire("agree"),
    });
    await post(owner, "/api/v3/votes", {
      conversation_id: c.conversationId,
      tid: 1,
      vote: semanticToWire("disagree"),
    });
    // Change timestamps only; every vote value enters through the live route.
    // The unrelated key would advance if the refresh scanned the conversation.
    await pool.query(
      "UPDATE votes SET created=CASE WHEN tid=0 THEN 100 ELSE 300 END WHERE zid=$1",
      [c.zid]
    );
    await pool.query(
      "UPDATE votes_latest_unique SET modified=200 WHERE zid=$1",
      [c.zid]
    );
    const before = await snapshot(c.zid);
    await refreshVotesLatestUnique(c.zid, [{ pid: 0, tid: 99 }]);
    await refreshVotesLatestUnique(c.zid, [{ pid: 0, tid: 0 }]);
    expect(await snapshot(c.zid)).toEqual(before);
    await pool.query("UPDATE votes SET created=200 WHERE zid=$1 AND tid=0", [
      c.zid,
    ]);
    const equal = await snapshot(c.zid);
    const version = (
      await pool.query(
        "SELECT xmin::text FROM votes_latest_unique WHERE zid=$1 AND pid=0 AND tid=0",
        [c.zid]
      )
    ).rows;
    await refreshVotesLatestUnique(c.zid, [{ pid: 0, tid: 0 }]);
    expect(await snapshot(c.zid)).toEqual(equal);
    expect(
      (
        await pool.query(
          "SELECT xmin::text FROM votes_latest_unique WHERE zid=$1 AND pid=0 AND tid=0",
          [c.zid]
        )
      ).rows
    ).toEqual(version);
  });
});
