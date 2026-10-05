import { randomInt } from "crypto";
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
 * A seed statement created with no vote records no vote for its author.
 *
 * Until 2025-08-08 the server cast an automatic pass for a seed's author only
 * in conversations numbered at or below a legacy cutoff (zid <= 17037). From
 * that day it did so in every conversation, so an owner who wrote every
 * statement had "passed" on all of them and was offered nothing to vote on
 * (issue #2952, follow-up of 2026-10-05). #2964 restored the cutoff; its
 * follow-up removed the automatic pass altogether, so the conversation number
 * no longer matters.
 *
 * A test database numbers its conversations from 1. This suite keeps the case
 * of a conversation with a very high number: the owner creates a conversation
 * through the API and the suite copies that row, column for column, to a
 * number above the old cutoff with an invite code of its own. Everything after
 * that goes through the API. Conversations made through the API alone (low
 * numbers) and seeds uploaded as a CSV are pinned by
 * seed-never-auto-votes.test.ts, and the handler itself, without a database,
 * by __tests__/unit/seedAutomaticPass.test.ts.
 */
const LEGACY_CUTOFF_ZID = 17037;

describe("seed statements in a conversation above the legacy cutoff", () => {
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

  async function storedVoteTids(table: string, pid: number): Promise<number[]> {
    const { rows } = await pool.query(
      `select tid from ${table} where zid = $1 and pid = $2 order by tid`,
      [zid, pid]
    );
    return rows.map((r: { tid: number }) => Number(r.tid));
  }

  async function nextFor(agent: Agent): Promise<Response> {
    const res: Response = await agent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}`
    );
    expect(res.status).toBe(200);
    return res;
  }

  beforeAll(async () => {
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: getPooledTestUser(1).email,
      hname: getPooledTestUser(1).name,
      password: getPooledTestUser(1).password,
    }));
    const madeByApi = await createConversation(owner, {
      topic: `Seeds carry no automatic pass ${stamp}`,
    });

    // Copy the API-made conversation to a number above the cutoff.
    zid = LEGACY_CUTOFF_ZID + randomInt(1_000_000, 2_000_000_000);
    conversationId = `seednopass${stamp.toString(36)}${randomInt(1e6)}`;
    await pool.query(
      `insert into conversations
         select (jsonb_populate_record(
                   null::conversations,
                   to_jsonb(c) || jsonb_build_object('zid', $2::int))).*
           from conversations c
           join zinvites z on z.zid = c.zid
          where z.zinvite = $1`,
      [madeByApi, zid]
    );
    await pool.query(
      "insert into zinvites (zid, zinvite, created, uuid) values ($1, $2, default, gen_random_uuid())",
      [zid, conversationId]
    );

    seeds = [];
    for (const name of ["A", "B", "C"])
      seeds.push(await postSeed({ txt: `Seed ${name} ${stamp}` }));
  });

  test("the conversation is above the legacy cutoff and its owner is pid 0", async () => {
    expect(zid).toBeGreaterThan(LEGACY_CUTOFF_ZID);
    const { rows } = await pool.query(
      "select p.pid from participants p join conversations c on c.zid = p.zid and c.owner = p.uid where p.zid = $1",
      [zid]
    );
    expect(rows.map((r: { pid: number }) => Number(r.pid))).toEqual([0]);
    const comments = await pool.query(
      "select tid, is_seed, pid from comments where zid = $1 order by tid",
      [zid]
    );
    expect(comments.rows).toEqual(
      seeds.map((tid) => ({ tid, is_seed: true, pid: 0 }))
    );
  });

  test("three seeds created with no vote leave no vote row for the owner", async () => {
    expect(await storedVoteTids("votes", 0)).toEqual([]);
    expect(await storedVoteTids("votes_latest_unique", 0)).toEqual([]);

    const res: Response = await owner.get(
      `/api/v3/votes?conversation_id=${conversationId}&pid=0`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("the owner is offered one of the seeds, with all three remaining", async () => {
    // Several draws: selection is random.
    for (let i = 0; i < 5; i++) {
      const res = await nextFor(owner);
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

    for (let i = 0; i < 5; i++) {
      const res = await nextFor(participant);
      expect(Number(res.body.currentPid)).toBe(1);
      expect([seeds[1], seeds[2]]).toContain(res.body.tid);
      expect(res.body.remaining).toBe(2);
      expect(res.body.total).toBe(3);
    }
    expect(await storedVoteTids("votes_latest_unique", 1)).toEqual([seeds[0]]);
    // The participant's vote did not create one for the owner.
    expect(await storedVoteTids("votes_latest_unique", 0)).toEqual([]);
  });

  test("the owner can vote on each seed and is then offered nothing", async () => {
    const voted: number[] = [];
    for (let left = 3; left >= 1; left--) {
      const offered = await nextFor(owner);
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
      if (left > 1) expect(seeds).toContain(vote.body.nextComment?.tid);
      else expect(vote.body.nextComment).toBeUndefined();
    }
    expect([...voted].sort((a, b) => a - b)).toEqual(seeds);
    expect(await storedVoteTids("votes_latest_unique", 0)).toEqual(seeds);

    const res = await nextFor(owner);
    expect(res.body.tid).toBeUndefined();
    expect(res.body.remaining).toBeUndefined();
    expect(Number(res.body.currentPid)).toBe(0);
  });

  test("a seed created with an explicit vote still records that vote", async () => {
    const explicit: number[] = [];
    for (const vote of ["agree", "disagree", "pass"] as const)
      explicit.push(
        await postSeed({
          txt: `Seed with ${vote} ${stamp}`,
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
    expect(await storedVoteTids("votes_latest_unique", 0)).toEqual([
      ...seeds,
      ...explicit,
    ]);

    // The owner has voted on everything, so nothing is offered.
    const next = await nextFor(owner);
    expect(next.body.tid).toBeUndefined();
  });
});
