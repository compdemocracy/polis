import { randomUUID } from "crypto";
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { fromWire, toWire } from "../setup/vote-wire";
import { pool } from "../setup/db-test-helpers";

/**
 * A seed statement never gets an automatic vote from its author: not when it
 * is uploaded in a CSV (POST /api/v3/comments-bulk), not when it is created
 * one at a time (POST /api/v3/comments with `is_seed`), in any conversation,
 * whatever its number. A seed records a vote for its author only when the
 * request carries one.
 *
 * Every conversation here is made through the API alone in the test database,
 * which numbers conversations from 1, as a fresh self-hosted installation
 * does. The same rule for a conversation with a very high number is pinned by
 * seed-no-automatic-pass.test.ts.
 */
async function ownerAgent(): Promise<Agent> {
  const { agent } = await getJwtAuthenticatedAgent({
    email: getPooledTestUser(1).email,
    hname: getPooledTestUser(1).name,
    password: getPooledTestUser(1).password,
  });
  return agent;
}

async function zidOf(conversationId: string): Promise<number> {
  const { rows } = await pool.query(
    "select zid from zinvites where zinvite = $1",
    [conversationId]
  );
  return Number(rows[0].zid);
}

async function storedVoteTids(
  table: string,
  zid: number,
  pid: number
): Promise<number[]> {
  const { rows } = await pool.query(
    `select tid from ${table} where zid = $1 and pid = $2 order by tid`,
    [zid, pid]
  );
  return rows.map((r: { tid: number }) => Number(r.tid));
}

async function ownerPids(zid: number): Promise<number[]> {
  const { rows } = await pool.query(
    "select p.pid from participants p join conversations c on c.zid = p.zid and c.owner = p.uid where p.zid = $1",
    [zid]
  );
  return rows.map((r: { pid: number }) => Number(r.pid));
}

async function nextFor(agent: Agent, conversationId: string) {
  const res: Response = await agent.get(
    `/api/v3/nextComment?conversation_id=${conversationId}`
  );
  expect(res.status).toBe(200);
  return res;
}

describe("seeds uploaded as a CSV record no vote for the uploader", () => {
  let owner: Agent;
  let conversationId: string;
  let zid: number;
  let seeds: number[];
  let upload: Response;
  const stamp = Date.now();
  const texts = ["A", "B", "C"].map((n) => `Uploaded seed ${n} ${stamp}`);
  const originalIds = texts.map(() => randomUUID());

  beforeAll(async () => {
    owner = await ownerAgent();
    conversationId = await createConversation(owner, {
      topic: `CSV seeds carry no automatic vote ${stamp}`,
    });
    zid = await zidOf(conversationId);
    upload = await owner.post("/api/v3/comments-bulk").send({
      conversation_id: conversationId,
      is_seed: true,
      csv: [
        "comment_text,original_id",
        ...texts.map((txt, i) => `${txt},${originalIds[i]}`),
      ].join("\n"),
    });
    seeds = (upload.body.results ?? []).map((r: { tid: number }) => r.tid);
  });

  test("the upload creates three seeds written by the owner, pid 0", async () => {
    expect(upload.status).toBe(200);
    expect(upload.body).toEqual({
      results: texts.map((txt, i) => ({
        txt,
        status: "success",
        tid: seeds[i],
        original_id: originalIds[i],
      })),
      currentPid: 0,
    });
    expect(await ownerPids(zid)).toEqual([0]);
    const comments = await pool.query(
      "select tid, is_seed, pid, mod, active from comments where zid = $1 order by tid",
      [zid]
    );
    expect(comments.rows).toEqual(
      seeds.map((tid) => ({
        tid,
        is_seed: true,
        pid: 0,
        mod: 1,
        active: true,
      }))
    );
  });

  test("no vote row exists for the owner, or for anyone", async () => {
    expect(await storedVoteTids("votes", zid, 0)).toEqual([]);
    expect(await storedVoteTids("votes_latest_unique", zid, 0)).toEqual([]);
    const all = await pool.query(
      "select count(*)::int as n from votes where zid = $1",
      [zid]
    );
    expect(all.rows[0].n).toBe(0);

    const res: Response = await owner.get(
      `/api/v3/votes?conversation_id=${conversationId}&pid=0`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("the seeds' vote counts are zero in the moderation list", async () => {
    const res: Response = await owner.get(
      `/api/v3/comments?conversation_id=${conversationId}&moderation=true&include_voting_patterns=true`
    );
    expect(res.status).toBe(200);
    const counts = (
      res.body as Array<{
        tid: number;
        agree_count: number;
        disagree_count: number;
        pass_count: number;
        count: number;
      }>
    )
      .map(({ tid, agree_count, disagree_count, pass_count, count }) => ({
        tid,
        agree_count,
        disagree_count,
        pass_count,
        count,
      }))
      .sort((a, b) => a.tid - b.tid);
    expect(counts).toEqual(
      seeds.map((tid) => ({
        tid,
        agree_count: 0,
        disagree_count: 0,
        pass_count: 0,
        count: 0,
      }))
    );
  });

  test("the owner is offered one of the uploaded seeds, with all three remaining", async () => {
    // Several draws: selection is random.
    for (let i = 0; i < 5; i++) {
      const res = await nextFor(owner, conversationId);
      expect(seeds).toContain(res.body.tid);
      expect(res.body.is_seed).toBe(true);
      expect(res.body.remaining).toBe(3);
      expect(res.body.total).toBe(3);
      expect(Number(res.body.currentPid)).toBe(0);
    }
  });

  test("a second participant is offered the same three seeds and can vote", async () => {
    const { agent: participant } = await initializeParticipant(conversationId);
    const vote = await submitVote(participant, {
      conversation_id: conversationId,
      tid: seeds[0],
      vote: toWire("agree"),
    });
    expect(vote.status).toBe(200);
    expect(Number(vote.body.currentPid)).toBe(1);
    expect([seeds[1], seeds[2]]).toContain(vote.body.nextComment?.tid);
    expect(await storedVoteTids("votes_latest_unique", zid, 1)).toEqual([
      seeds[0],
    ]);
    // The participant's vote did not create one for the owner.
    expect(await storedVoteTids("votes_latest_unique", zid, 0)).toEqual([]);
  });

  test("the owner can vote on each uploaded seed and is then offered nothing", async () => {
    const voted: number[] = [];
    for (let left = 3; left >= 1; left--) {
      const offered = await nextFor(owner, conversationId);
      expect(seeds).toContain(offered.body.tid);
      expect(voted).not.toContain(offered.body.tid);
      expect(offered.body.remaining).toBe(left);
      expect(offered.body.total).toBe(3);

      const vote = await submitVote(owner, {
        conversation_id: conversationId,
        tid: offered.body.tid,
        vote: toWire("agree"),
      });
      expect(vote.status).toBe(200);
      expect(Number(vote.body.currentPid)).toBe(0);
      voted.push(offered.body.tid);
    }
    expect([...voted].sort((a, b) => a - b)).toEqual(seeds);
    expect(await storedVoteTids("votes_latest_unique", zid, 0)).toEqual(seeds);

    const res = await nextFor(owner, conversationId);
    expect(res.body.tid).toBeUndefined();
    expect(res.body.remaining).toBeUndefined();
    expect(Number(res.body.currentPid)).toBe(0);
  });
});

describe("a single seed in a conversation made through the API records no vote", () => {
  let owner: Agent;
  let conversationId: string;
  let zid: number;
  let seeds: number[];
  const stamp = Date.now();

  async function postSeed(body: Record<string, unknown>): Promise<number> {
    const res: Response = await owner
      .post("/api/v3/comments")
      .send({ conversation_id: conversationId, is_seed: true, ...body });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    expect(Number(res.body.currentPid)).toBe(0);
    return res.body.tid;
  }

  beforeAll(async () => {
    owner = await ownerAgent();
    conversationId = await createConversation(owner, {
      topic: `Single seeds carry no automatic vote ${stamp}`,
    });
    zid = await zidOf(conversationId);
    seeds = [];
    for (const name of ["A", "B"])
      seeds.push(await postSeed({ txt: `Single seed ${name} ${stamp}` }));
  });

  test("two seeds created with no vote leave no vote row for the owner", async () => {
    expect(await ownerPids(zid)).toEqual([0]);
    expect(await storedVoteTids("votes", zid, 0)).toEqual([]);
    expect(await storedVoteTids("votes_latest_unique", zid, 0)).toEqual([]);

    const res: Response = await owner.get(
      `/api/v3/votes?conversation_id=${conversationId}&pid=0`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("the owner is offered one of the seeds, with both remaining", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await nextFor(owner, conversationId);
      expect(seeds).toContain(res.body.tid);
      expect(res.body.is_seed).toBe(true);
      expect(res.body.remaining).toBe(2);
      expect(res.body.total).toBe(2);
      expect(Number(res.body.currentPid)).toBe(0);
    }
  });

  test("a seed created with an explicit vote records exactly that vote", async () => {
    const explicit: number[] = [];
    for (const vote of ["agree", "disagree", "pass"] as const)
      explicit.push(
        await postSeed({
          txt: `Single seed with ${vote} ${stamp}`,
          vote: toWire(vote),
        })
      );

    const res: Response = await owner.get(
      `/api/v3/votes?conversation_id=${conversationId}&pid=0`
    );
    expect(res.status).toBe(200);
    const byTid = new Map<number, unknown>(
      (res.body as Array<{ tid: number; vote: number }>).map((v) => [
        v.tid,
        fromWire(v.vote),
      ])
    );
    expect(explicit.map((tid) => byTid.get(tid))).toEqual([
      "agree",
      "disagree",
      "pass",
    ]);
    // Only the three explicit votes are stored; the first two seeds have none.
    expect(await storedVoteTids("votes_latest_unique", zid, 0)).toEqual(
      explicit
    );
  });
});
