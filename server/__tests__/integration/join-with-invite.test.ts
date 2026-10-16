/**
 * POST /api/v3/joinWithInvite is no longer routed.
 *
 * The route made its caller a participant of any conversation with no invite
 * at all (a suzinvite that did not exist was ignored), ahead of the
 * invite-only gate and the XID allowlist that ensureParticipant applies on
 * the participation path, and it signed the participant token with the
 * numeric zid rather than the conversation id. No client called it. Joining
 * stays on the participation path (votes, comments, nextComment,
 * participationInit) and keeps its gates; this file pins that the old route
 * answers 404 and writes nothing.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  submitVote,
  updateConversation,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

function pooled(index: number) {
  const u = getPooledTestUser(index);
  return { email: u.email, hname: u.name, password: u.password };
}

describe("POST /api/v3/joinWithInvite", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let owner: Agent;

  let inviteOnlyConv: string;
  let inviteOnlyZid: number;
  let inviteOnlyTid: number;

  let allowlistConv: string;
  let allowlistZid: number;

  const zidOf = async (code: string): Promise<number> =>
    (await pool.query("select zid from zinvites where zinvite = $1", [code]))
      .rows[0].zid;

  const participantCount = async (zid: number): Promise<number> =>
    (
      await pool.query(
        "select count(*)::int as n from participants where zid = $1",
        [zid]
      )
    ).rows[0].n;

  beforeAll(async () => {
    ({ pool } = await import("../setup/db-test-helpers"));
    ({ agent: owner } = await getJwtAuthenticatedAgent(pooled(1)));

    inviteOnlyConv = await createConversation(owner, {
      topic: "joinWithInvite removed: invite-only",
      treevite_enabled: true,
    });
    inviteOnlyZid = await zidOf(inviteOnlyConv);
    const seed = await owner.post("/api/v3/comments").send({
      conversation_id: inviteOnlyConv,
      txt: "Seed statement (invite-only)",
      is_seed: true,
    });
    expect(seed.status).toBe(200);
    inviteOnlyTid = seed.body.tid;

    allowlistConv = await createConversation(owner, {
      topic: "joinWithInvite removed: xid allowlist",
    });
    allowlistZid = await zidOf(allowlistConv);
    const updated = await updateConversation(owner, {
      conversation_id: allowlistConv,
      use_xid_whitelist: true,
    });
    expect(updated.status).toBe(200);
  });

  test("is not routed for an anonymous caller and creates no participant", async () => {
    const before = await participantCount(inviteOnlyZid);
    const r = await (await newAgent()).post("/api/v3/joinWithInvite").send({
      conversation_id: inviteOnlyConv,
      suzinvite: "not-a-real-invite",
    });

    expect(r.status).toBe(404);
    expect(await participantCount(inviteOnlyZid)).toBe(before);
  });

  test("is not routed for a signed-in user, who stays refused by the invite-only gate on /votes", async () => {
    const { agent: stranger } = await getJwtAuthenticatedAgent(pooled(3));

    const r = await stranger
      .post("/api/v3/joinWithInvite")
      .send({ conversation_id: inviteOnlyConv });
    expect(r.status).toBe(404);

    const vote = await submitVote(stranger, {
      conversation_id: inviteOnlyConv,
      tid: inviteOnlyTid,
      vote: -1,
    });
    expect(vote.status).toBe(401);
    expect(JSON.stringify(vote.body)).toContain(
      "polis_err_treevite_auth_required"
    );
  });

  test("is not routed on an XID-allowlist conversation and creates no participant", async () => {
    const before = await participantCount(allowlistZid);
    const r = await (await newAgent())
      .post("/api/v3/joinWithInvite")
      .send({ conversation_id: allowlistConv });

    expect(r.status).toBe(404);
    expect(await participantCount(allowlistZid)).toBe(before);
  });
});
