/**
 * A refused bulk upload leaves no participant behind.
 *
 * POST /api/v3/comments-bulk is for moderators only, but it created the
 * caller's participant row before checking. A refused, signed-in caller then
 * counted as an existing member, and an invite-only conversation admits
 * existing members, so their next vote was accepted. The moderator check now
 * runs first; this file pins that the refusal writes nothing and that the
 * invite-only gate still refuses the caller afterwards.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../../src/votes/convention";

function pooled(index: number) {
  const u = getPooledTestUser(index);
  return { email: u.email, hname: u.name, password: u.password };
}

describe("POST /api/v3/comments-bulk from a signed-in non-moderator", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let owner: Agent;
  let stranger: Agent;
  let inviteOnlyConv: string;
  let inviteOnlyZid: number;
  let inviteOnlyTid: number;
  const stamp = Date.now();

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
    ({ agent: stranger } = await getJwtAuthenticatedAgent(pooled(5)));
    inviteOnlyConv = await createConversation(owner, {
      topic: `Bulk upload refusal: invite-only ${stamp}`,
      treevite_enabled: true,
    });
    inviteOnlyZid = (
      await pool.query("select zid from zinvites where zinvite = $1", [
        inviteOnlyConv,
      ])
    ).rows[0].zid;
    const seed = await owner
      .post("/api/v3/comments")
      .send({ conversation_id: inviteOnlyConv, txt: `Seed ${stamp}`, is_seed: true });
    expect(seed.status).toBe(200);
    inviteOnlyTid = seed.body.tid;
  });

  test("is refused and writes no participant", async () => {
    const before = await participantCount(inviteOnlyZid);
    const r = await stranger.post("/api/v3/comments-bulk").send({
      conversation_id: inviteOnlyConv,
      csv: `comment_text\nUploaded by a stranger ${stamp}`,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("polis_err_post_comment_auth");
    expect(await participantCount(inviteOnlyZid)).toBe(before);
  });

  test("so the invite-only gate still refuses that caller's vote", async () => {
    const refusedUpload = await stranger.post("/api/v3/comments-bulk").send({
      conversation_id: inviteOnlyConv,
      csv: `comment_text\nUploaded by a stranger again ${stamp}`,
    });
    expect(refusedUpload.status).toBe(403);
    const vote = await submitVote(stranger, {
      conversation_id: inviteOnlyConv,
      tid: inviteOnlyTid,
      vote: WIRE_AGREE,
    });
    expect(vote.status).toBe(401);
    expect(JSON.stringify(vote.body)).toContain("polis_err_treevite_auth_required");
  });
});
