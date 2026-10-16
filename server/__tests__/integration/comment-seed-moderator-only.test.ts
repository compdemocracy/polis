import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  submitComment,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import { polisTypes } from "../../src/utils/common";
import { WIRE_AGREE } from "../../src/votes/convention";

/**
 * Only a moderator can contribute a seed statement.
 *
 * POST /api/v3/comments takes `is_seed` from any caller, and the handler used
 * to approve a statement on that flag alone, so a participant with no
 * credential could publish a statement past strict moderation. The flag now
 * counts only for a moderator: from anyone else it is ignored, the statement
 * is stored as an ordinary one and moderated like any other.
 */
interface CommentRow {
  mod: number;
  active: boolean;
  is_seed: boolean;
  uid: number;
}

describe("a seed statement can only come from a moderator", () => {
  let owner: Agent;
  let ownerUid: number;
  let conversationId: string;
  let zid: number;
  let ownerSeedTid: number;
  let participantToken: string;
  let flaggedTid: number;
  let plainTid: number;
  const stamp = Date.now();

  async function commentRow(tid: number): Promise<CommentRow> {
    const { rows } = await pool.query(
      "select mod, active, is_seed, uid from comments where zid = $1 and tid = $2",
      [zid, tid]
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function participantAgent(): Promise<Agent> {
    const agent = await newAgent();
    agent.set("Authorization", `Bearer ${participantToken}`);
    return agent;
  }

  beforeAll(async () => {
    const user = getPooledTestUser(1);
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: user.email,
      hname: user.name,
      password: user.password,
    }));
    conversationId = await createConversation(owner, {
      topic: `Seeds come from moderators only ${stamp}`,
      strict_moderation: true,
    });
    const { rows } = await pool.query(
      "select c.zid, c.owner from conversations c join zinvites z on z.zid = c.zid where z.zinvite = $1",
      [conversationId]
    );
    zid = Number(rows[0].zid);
    ownerUid = Number(rows[0].owner);
  });

  test("the owner's seed is approved on arrival and stored as a seed", async () => {
    const res = await submitComment(owner, {
      conversation_id: conversationId,
      txt: `Owner seed ${stamp}`,
      is_seed: true,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    ownerSeedTid = res.body.tid;
    expect(await commentRow(ownerSeedTid)).toEqual({
      mod: polisTypes.mod.ok,
      active: true,
      is_seed: true,
      uid: ownerUid,
    });
  });

  test("an anonymous participant's is_seed is ignored: the statement waits for moderation and is not a seed", async () => {
    const res = await submitComment(null, {
      conversation_id: conversationId,
      txt: `Flagged as a seed by a participant ${stamp}`,
      is_seed: true,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    expect(typeof res.body.auth?.token).toBe("string");
    flaggedTid = res.body.tid;
    participantToken = res.body.auth.token;

    const row = await commentRow(flaggedTid);

    // The author is a plain anonymous user: not the owner, no email, its own
    // site_id, so not a moderator of this conversation.
    expect(row.uid).not.toBe(ownerUid);
    const users = await pool.query(
      "select uid, email, site_id from users where uid = any($1::int[]) order by uid",
      [[ownerUid, row.uid]]
    );
    expect(users.rows).toHaveLength(2);
    const author = users.rows.find((u: { uid: number }) => u.uid === row.uid);
    const ownerRow = users.rows.find(
      (u: { uid: number }) => u.uid === ownerUid
    );
    expect(author.email).toBeNull();
    expect(author.site_id).not.toBe(ownerRow.site_id);

    expect(row.mod).toBe(polisTypes.mod.unmoderated);
    expect(row.active).toBe(true);
    expect(row.is_seed).toBe(false);
  });

  test("the same participant without the flag gets the same result", async () => {
    const res = await submitComment(await participantAgent(), {
      conversation_id: conversationId,
      txt: `Plain statement by the same participant ${stamp}`,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    plainTid = res.body.tid;

    const flagged = await commentRow(flaggedTid);
    const plain = await commentRow(plainTid);
    expect(plain.uid).toBe(flagged.uid);
    expect(plain).toEqual(flagged);
    expect(plain.mod).toBe(polisTypes.mod.unmoderated);
    expect(plain.is_seed).toBe(false);
  });

  test("neither participant statement is served to others under strict moderation", async () => {
    // The participant list: only the owner's seed.
    const list = await (
      await newAgent()
    ).get(`/api/v3/comments?conversation_id=${conversationId}`);
    expect(list.status).toBe(200);
    const tids = list.body.map((c: { tid: number }) => c.tid);
    expect(tids).toContain(ownerSeedTid);
    expect(tids).not.toContain(flaggedTid);
    expect(tids).not.toContain(plainTid);

    // A fresh participant who has voted on the owner's seed has nothing left
    // to vote on: neither participant statement is offered.
    const voter = await newAgent();
    const voted = await submitVote(voter, {
      conversation_id: conversationId,
      tid: ownerSeedTid,
      vote: WIRE_AGREE,
    });
    expect(voted.status).toBe(200);
    const next = await voter.get(
      `/api/v3/nextComment?conversation_id=${conversationId}`
    );
    expect(next.status).toBe(200);
    expect(next.body.tid).toBeUndefined();
  });

  test("the owner's statement without the flag is still approved on arrival, and is not a seed", async () => {
    const res = await submitComment(owner, {
      conversation_id: conversationId,
      txt: `Owner statement without the flag ${stamp}`,
    });
    expect(res.status).toBe(200);
    expect(await commentRow(res.body.tid)).toEqual({
      mod: polisTypes.mod.ok,
      active: true,
      is_seed: false,
      uid: ownerUid,
    });
  });

  test("control: the CSV seed upload refuses a participant outright", async () => {
    const res = await (await participantAgent())
      .post("/api/v3/comments-bulk")
      .send({
        conversation_id: conversationId,
        is_seed: true,
        csv: `comment_text\nUploaded by a participant ${stamp}`,
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("polis_err_post_comment_auth");
    const { rows } = await pool.query(
      "select count(*)::int as n from comments where zid = $1 and txt = $2",
      [zid, `Uploaded by a participant ${stamp}`]
    );
    expect(rows[0].n).toBe(0);
  });
});
