/**
 * POST /api/v3/participants is no longer routed.
 *
 * The route wrote a participant row for any bearer token ahead of the gates
 * that ensureParticipant applies on the participation path: the invite-only
 * tree, xid_required, the XID allowlist and the closed state. A signed-in
 * user could join an invite-only conversation through it and then vote. No
 * client called it. Joining stays on the participation path (votes,
 * comments, nextComment, participationInit) and keeps its gates; this file
 * pins that the old route answers 404 and writes nothing, and that
 * GET /api/v3/participants is still served.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  newAgent,
  submitVote,
  updateConversation,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../../src/votes/convention";

function pooled(index: number) {
  const u = getPooledTestUser(index);
  return { email: u.email, hname: u.name, password: u.password };
}

describe("POST /api/v3/participants", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let owner: Agent;

  let openConv: string;
  let openTid: number;

  let inviteOnlyConv: string;
  let inviteOnlyZid: number;
  let inviteOnlyTid: number;

  let closedConv: string;
  let closedZid: number;

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

  const seedStatement = async (code: string, txt: string): Promise<number> => {
    const seed = await owner
      .post("/api/v3/comments")
      .send({ conversation_id: code, txt, is_seed: true });
    expect(seed.status).toBe(200);
    return seed.body.tid;
  };

  beforeAll(async () => {
    ({ pool } = await import("../setup/db-test-helpers"));
    ({ agent: owner } = await getJwtAuthenticatedAgent(pooled(1)));

    openConv = await createConversation(owner, {
      topic: "POST participants removed: open",
    });
    openTid = await seedStatement(openConv, "Seed statement (open)");

    inviteOnlyConv = await createConversation(owner, {
      topic: "POST participants removed: invite-only",
      treevite_enabled: true,
    });
    inviteOnlyZid = await zidOf(inviteOnlyConv);
    inviteOnlyTid = await seedStatement(
      inviteOnlyConv,
      "Seed statement (invite-only)"
    );

    closedConv = await createConversation(owner, {
      topic: "POST participants removed: closed",
    });
    closedZid = await zidOf(closedConv);
    const closed = await updateConversation(owner, {
      conversation_id: closedConv,
      is_active: false,
    });
    expect(closed.status).toBe(200);
  });

  test("is not routed for a caller with no credential and creates no participant", async () => {
    const before = await participantCount(inviteOnlyZid);
    const r = await (await newAgent())
      .post("/api/v3/participants")
      .send({ conversation_id: inviteOnlyConv });

    expect(r.status).toBe(404);
    expect(await participantCount(inviteOnlyZid)).toBe(before);
  });

  test("is not routed for a participant of another conversation and creates no participant", async () => {
    const visitor = await initializeParticipant(openConv);
    const joined = await submitVote(visitor.agent, {
      conversation_id: openConv,
      tid: openTid,
      vote: WIRE_AGREE,
    });
    expect(joined.status).toBe(200);

    const before = await participantCount(inviteOnlyZid);
    const r = await visitor.agent
      .post("/api/v3/participants")
      .send({ conversation_id: inviteOnlyConv });

    expect(r.status).toBe(404);
    expect(await participantCount(inviteOnlyZid)).toBe(before);
  });

  test("is not routed for a signed-in user, who stays refused by the invite-only gate on /votes", async () => {
    const { agent: stranger } = await getJwtAuthenticatedAgent(pooled(3));

    const refused = await submitVote(stranger, {
      conversation_id: inviteOnlyConv,
      tid: inviteOnlyTid,
      vote: WIRE_AGREE,
    });
    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.body)).toContain(
      "polis_err_treevite_auth_required"
    );

    const before = await participantCount(inviteOnlyZid);
    const r = await stranger
      .post("/api/v3/participants")
      .send({ conversation_id: inviteOnlyConv });
    expect(r.status).toBe(404);
    expect(await participantCount(inviteOnlyZid)).toBe(before);

    const stillRefused = await submitVote(stranger, {
      conversation_id: inviteOnlyConv,
      tid: inviteOnlyTid,
      vote: WIRE_AGREE,
    });
    expect(stillRefused.status).toBe(401);
    expect(JSON.stringify(stillRefused.body)).toContain(
      "polis_err_treevite_auth_required"
    );
  });

  test("is not routed on a closed conversation and creates no participant", async () => {
    const { agent: stranger } = await getJwtAuthenticatedAgent(pooled(3));

    const before = await participantCount(closedZid);
    const r = await stranger
      .post("/api/v3/participants")
      .send({ conversation_id: closedConv });

    expect(r.status).toBe(404);
    expect(await participantCount(closedZid)).toBe(before);
  });

  test("GET /api/v3/participants is still served", async () => {
    const r = await owner.get(
      `/api/v3/participants?conversation_id=${inviteOnlyConv}`
    );

    expect(r.status).toBe(200);
  });
});
