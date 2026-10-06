import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { toWire } from "../setup/vote-wire";
import pg from "../../src/db/pg-query";

/**
 * Issue #2952: GET /nextComment for the conversation's first participant
 * (pid 0, normally the owner).
 *
 * The owner writes two seed statements and one ordinary statement. None of
 * them records a vote for the owner (a seed gets no automatic vote), so the
 * owner, pid 0, is first offered all three. The owner then passes on the two
 * seeds. GET /nextComment for the owner must from then on offer only the
 * statement the owner has not voted on, count `remaining` against the owner's
 * own votes, and offer nothing once the owner has voted on everything. A
 * second participant (pid 1) is checked the same way.
 *
 * The requests mirror the participation client: no `not_voted_by_pid`
 * parameter, the participant comes from the request's own auth.
 */
describe("GET /nextComment for the first participant (pid 0)", () => {
  let owner: Agent;
  let conversationId: string;
  let zid: number;
  let seedA: number;
  let seedB: number;
  let unvoted: number;

  async function postComment(body: Record<string, unknown>): Promise<number> {
    const res: Response = await owner
      .post("/api/v3/comments")
      .send({ conversation_id: conversationId, ...body });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    return res.body.tid;
  }

  beforeAll(async () => {
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: getPooledTestUser(1).email,
      hname: getPooledTestUser(1).name,
      password: getPooledTestUser(1).password,
    }));
    conversationId = await createConversation(owner, {
      topic: `Issue 2952 first participant ${Date.now()}`,
    });

    const stamp = Date.now();
    seedA = await postComment({ txt: `Seed A ${stamp}`, is_seed: true });
    seedB = await postComment({ txt: `Seed B ${stamp}`, is_seed: true });
    unvoted = await postComment({ txt: `Not voted by owner ${stamp}` });

    const zidRows = (await pg.queryP_readOnly(
      "select zid from zinvites where zinvite = ($1) limit 1;",
      [conversationId]
    )) as Array<{ zid: number }>;
    zid = Number(zidRows[0].zid);
  });

  async function ownerVotedTids(): Promise<number[]> {
    const voteRows = (await pg.queryP_readOnly(
      "select tid from votes_latest_unique where zid = ($1) and pid = 0 order by tid;",
      [zid]
    )) as Array<{ tid: number }>;
    return voteRows.map((r) => Number(r.tid));
  }

  test("the owner is pid 0, has no vote from writing the statements, and is offered all three", async () => {
    const ownerRows = (await pg.queryP_readOnly(
      "select p.pid from participants p join conversations c on c.zid = p.zid and c.owner = p.uid where p.zid = ($1);",
      [zid]
    )) as Array<{ pid: number }>;
    expect(ownerRows.map((r) => Number(r.pid))).toEqual([0]);

    expect(await ownerVotedTids()).toEqual([]);

    for (let i = 0; i < 5; i++) {
      const res: Response = await owner.get(
        `/api/v3/nextComment?conversation_id=${conversationId}`
      );
      expect(res.status).toBe(200);
      expect([seedA, seedB, unvoted]).toContain(res.body.tid);
      expect(res.body.remaining).toBe(3);
      expect(res.body.total).toBe(3);
      expect(Number(res.body.currentPid)).toBe(0);
    }
  });

  test("the owner passes on the two seeds and has then voted on exactly those", async () => {
    for (const tid of [seedA, seedB]) {
      const vote = await submitVote(owner, {
        conversation_id: conversationId,
        tid,
        vote: toWire("pass"),
      });
      expect(vote.status).toBe(200);
      expect(Number(vote.body.currentPid)).toBe(0);
    }
    expect(await ownerVotedTids()).toEqual(
      [seedA, seedB].sort((a, b) => a - b)
    );
  });

  test("the owner is offered only the statement they have not voted on", async () => {
    // Several draws: selection is random, so a single draw could hide the bug.
    for (let i = 0; i < 5; i++) {
      const res: Response = await owner.get(
        `/api/v3/nextComment?conversation_id=${conversationId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.tid).toBe(unvoted);
      expect(res.body.remaining).toBe(1);
      expect(res.body.total).toBe(3);
      expect(Number(res.body.currentPid)).toBe(0);
    }
  });

  test("after the owner votes on it, nothing is left for the owner", async () => {
    const vote = await submitVote(owner, {
      conversation_id: conversationId,
      tid: unvoted,
      vote: 0,
    });
    expect(vote.status).toBe(200);
    expect(Number(vote.body.currentPid)).toBe(0);
    expect(vote.body.nextComment).toBeUndefined();

    const res: Response = await owner.get(
      `/api/v3/nextComment?conversation_id=${conversationId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.tid).toBeUndefined();
    expect(res.body.remaining).toBeUndefined();
    expect(Number(res.body.currentPid)).toBe(0);
  });

  test("the second participant (pid 1) is offered only statements they have not voted on", async () => {
    const { agent: participant } = await initializeParticipant(conversationId);
    const vote = await submitVote(participant, {
      conversation_id: conversationId,
      tid: seedA,
      vote: 0,
    });
    expect(vote.status).toBe(200);
    expect(Number(vote.body.currentPid)).toBe(1);
    expect([seedB, unvoted]).toContain(vote.body.nextComment?.tid);

    for (let i = 0; i < 5; i++) {
      const res: Response = await participant.get(
        `/api/v3/nextComment?conversation_id=${conversationId}`
      );
      expect(res.status).toBe(200);
      expect(Number(res.body.currentPid)).toBe(1);
      expect([seedB, unvoted]).toContain(res.body.tid);
      expect(res.body.remaining).toBe(2);
    }
  });
});
