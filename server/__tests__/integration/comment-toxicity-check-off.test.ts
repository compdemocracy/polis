import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  submitComment,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import { polisTypes } from "../../src/utils/common";

/**
 * The toxicity check is gone from the comment path.
 *
 * POST /api/v3/comments used to ask the identity provider whether the
 * conversation's owner carries the delphi-enabled role and, when so, send
 * every participant statement to a language model for a toxicity verdict
 * that could reject it. That check was switched off and has since been
 * removed: a statement takes the conversation's own moderation setting,
 * whoever owns the conversation.
 *
 * Loading the routes must not construct an identity-provider management client.
 */
const mockManagementClient = jest.fn(() => {
  throw new Error("Comment routes must not construct a management client");
});
jest.mock(
  "auth0",
  () => ({
    ManagementClient: mockManagementClient,
  }),
  { virtual: true }
);

describe("the toxicity check is gone from the comment path", () => {
  let owner: Agent;
  let conversationId: string;
  let zid: number;
  let tid: number;
  const stamp = Date.now();

  beforeAll(async () => {
    const user = getPooledTestUser(1);
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: user.email,
      hname: user.name,
      password: user.password,
    }));
    conversationId = await createConversation(owner, {
      topic: `Toxicity check off ${stamp}`,
    });
    const { rows } = await pool.query(
      "select c.zid from conversations c join zinvites z on z.zid = c.zid where z.zinvite = $1",
      [conversationId]
    );
    zid = Number(rows[0].zid);
  });

  test("a participant's statement makes no identity-provider call and is stored active and unmoderated", async () => {
    const res = await submitComment(null, {
      conversation_id: conversationId,
      txt: `Participant statement ${stamp}`,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    tid = res.body.tid;

    expect(mockManagementClient).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      "select mod, active, is_seed from comments where zid = $1 and tid = $2",
      [zid, tid]
    );
    expect(rows).toEqual([
      { mod: polisTypes.mod.unmoderated, active: true, is_seed: false },
    ]);
  });

  test("the moderation level filter applies without any owner-role lookup", async () => {
    // mod_gt narrows the moderation list for every conversation now; it used
    // to apply only when the owner's account carried a paid role, looked up
    // at the identity provider on each read.
    const narrowed = await owner.get(
      `/api/v3/comments?conversation_id=${conversationId}&moderation=true&mod_gt=1`
    );
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.map((c: { tid: number }) => c.tid)).not.toContain(tid);
    const all = await owner.get(
      `/api/v3/comments?conversation_id=${conversationId}&moderation=true&mod_gt=-2`
    );
    expect(all.status).toBe(200);
    expect(all.body.map((c: { tid: number }) => c.tid)).toContain(tid);
    expect(mockManagementClient).not.toHaveBeenCalled();
  });

  test("the statement is served to participants, as any unmoderated statement is in this conversation", async () => {
    const list = await (
      await newAgent()
    ).get(`/api/v3/comments?conversation_id=${conversationId}`);
    expect(list.status).toBe(200);
    expect(list.body.map((c: { tid: number }) => c.tid)).toContain(tid);
  });
});
