import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  submitComment,
} from "../setup/api-test-helpers";
import {
  RESERVED_POOLED_USER_INDEXES,
  getPooledTestUser,
} from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import { polisTypes } from "../../src/utils/common";

/**
 * Seeding through the API with an OIDC access token.
 *
 * The admin console's seed form and the end-to-end helpers seed a
 * conversation the same way: POST /api/v3/comments with `is_seed`, carrying
 * the caller's OIDC access token as the Bearer credential, moments after the
 * conversation was created with that same token. A seed is approved on
 * arrival only from a moderator, so the identity the comment route resolves
 * from that token must be the one that owns the conversation.
 *
 * Three identities can stand behind such a request, and this suite pins each:
 * - the owner's own token: approved on arrival and stored as a seed;
 * - another signed-in account's token: a fresh account is on a site of its
 *   own, so it moderates nothing of the owner's; the flag is ignored and the
 *   statement waits for moderation like any other;
 * - that same account once it is on the owner's site (a site moderator):
 *   approved on arrival.
 */
interface CommentRow {
  mod: number;
  active: boolean;
  is_seed: boolean;
  uid: number;
}

const SEEDS = [
  "First seed through the API",
  "Second seed through the API",
  "Third seed through the API",
];

describe("seeds posted with the conversation owner's OIDC access token", () => {
  let owner: Agent;
  let other: Agent;
  let ownerUid: number;
  let otherUid: number;
  let conversationId: string;
  let zid: number;
  const ownerTids: number[] = [];
  let otherTid: number;
  const stamp = Date.now();

  async function commentRow(tid: number): Promise<CommentRow> {
    const { rows } = await pool.query(
      "select mod, active, is_seed, uid from comments where zid = $1 and tid = $2",
      [zid, tid]
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  // The moderation page's own request, as the owner: the statements in one
  // moderation state.
  async function moderationList(mod: number): Promise<number[]> {
    const res = await owner.get(
      `/api/v3/comments?moderation=true&include_voting_patterns=false&mod=${mod}&conversation_id=${conversationId}`
    );
    expect(res.status).toBe(200);
    return res.body.map((c: { tid: number }) => c.tid);
  }

  async function siteOf(uid: number): Promise<string> {
    const { rows } = await pool.query(
      "select site_id from users where uid = $1",
      [uid]
    );
    return rows[0].site_id;
  }

  beforeAll(async () => {
    const ownerUser = getPooledTestUser(
      RESERVED_POOLED_USER_INDEXES.seedOwnerBearerOwner
    );
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    }));

    const otherUser = getPooledTestUser(
      RESERVED_POOLED_USER_INDEXES.seedOwnerBearerOther
    );
    ({ agent: other } = await getJwtAuthenticatedAgent({
      email: otherUser.email,
      hname: otherUser.name,
      password: otherUser.password,
    }));
    // The account's row must exist before its site can be set.
    const otherInfo = await other.get("/api/v3/users");
    expect(otherInfo.status).toBe(200);
    otherUid = Number(otherInfo.body.uid);
    // Every run starts with the second account on a site of its own, as a
    // fresh account is (an earlier run of this suite moves it to the owner's).
    await pool.query(
      "update users set site_id = random_polis_site_id() where uid = $1",
      [otherUid]
    );

    // The conversation is created with the owner's access token, and seeded
    // with the same token right after, as the end-to-end helpers do.
    conversationId = await createConversation(owner, {
      topic: `Seeds by OIDC access token ${stamp}`,
      description: "Created and seeded through the API with one token",
    });
    const { rows } = await pool.query(
      "select c.zid, c.owner from conversations c join zinvites z on z.zid = c.zid where z.zinvite = $1",
      [conversationId]
    );
    zid = Number(rows[0].zid);
    ownerUid = Number(rows[0].owner);
  });

  test("the owner's seeds, posted with the token that created the conversation, are approved on arrival", async () => {
    for (const txt of SEEDS) {
      const res = await submitComment(owner, {
        conversation_id: conversationId,
        txt: `${txt} ${stamp}`,
        is_seed: true,
      });
      expect(res.status).toBe(200);
      expect(typeof res.body.tid).toBe("number");
      ownerTids.push(res.body.tid);
      expect(await commentRow(res.body.tid)).toEqual({
        mod: polisTypes.mod.ok,
        active: true,
        is_seed: true,
        uid: ownerUid,
      });
    }
    // The moderation page lists all three as accepted and none as waiting.
    expect(await moderationList(polisTypes.mod.ok)).toEqual(ownerTids);
    expect(await moderationList(polisTypes.mod.unmoderated)).toEqual([]);
  });

  test("another signed-in account's is_seed on the owner's conversation is ignored: the statement waits for moderation", async () => {
    // A distinct account is on a distinct site, so it is not a moderator here.
    expect(otherUid).not.toBe(ownerUid);
    expect(await siteOf(otherUid)).not.toBe(await siteOf(ownerUid));

    const res = await submitComment(other, {
      conversation_id: conversationId,
      txt: `Flagged as a seed by another account ${stamp}`,
      is_seed: true,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    otherTid = res.body.tid;
    expect(await commentRow(otherTid)).toEqual({
      mod: polisTypes.mod.unmoderated,
      active: true,
      is_seed: false,
      uid: otherUid,
    });
    expect(await moderationList(polisTypes.mod.unmoderated)).toEqual([
      otherTid,
    ]);
    expect(await moderationList(polisTypes.mod.ok)).toEqual(ownerTids);
  });

  test("the same account on the owner's site is a moderator: its seed is approved on arrival", async () => {
    await pool.query(
      "update users set site_id = (select site_id from users where uid = $1) where uid = $2",
      [ownerUid, otherUid]
    );
    expect(await siteOf(otherUid)).toBe(await siteOf(ownerUid));

    const res = await submitComment(other, {
      conversation_id: conversationId,
      txt: `Seed by a moderator on the owner's site ${stamp}`,
      is_seed: true,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    expect(await commentRow(res.body.tid)).toEqual({
      mod: polisTypes.mod.ok,
      active: true,
      is_seed: true,
      uid: otherUid,
    });
    expect(await moderationList(polisTypes.mod.ok)).toEqual([
      ...ownerTids,
      res.body.tid,
    ]);
    // Moderation is decided on arrival: the earlier statement still waits.
    expect(await moderationList(polisTypes.mod.unmoderated)).toEqual([
      otherTid,
    ]);
  });
});
