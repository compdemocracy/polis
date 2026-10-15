import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  submitVote,
} from "../setup/api-test-helpers";
import {
  getPooledTestUser,
  RESERVED_POOLED_USER_INDEXES,
} from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";

// The invite-administration routes hand out the keys that let a stranger past an
// invite-only conversation's participation gate, or send join mail recorded
// against its owner. They must therefore be restricted to the conversation's
// owner, or a moderator on the owner's site — the same ownership gate the other
// conversation-admin routes use (the data export, the conversation UUID).
//
// These tests cover, for each route:
//   - a signed-in account that is neither owner nor moderator (a distinct site)
//     is refused with 403;
//   - an anonymous participant authenticated in a DIFFERENT conversation is
//     refused with 403 (a valid token for another conversation is not authority
//     here);
//   - the owner succeeds;
//   - a moderator on the owner's site succeeds.
//
// They also cover acceptInvite's participant scoping: a token carrying a pid
// from another conversation must never mark the invite used by that pid; the
// accept creates (or reuses) a participant for the requested conversation, and a
// legitimate first-time accept is never rejected.
describe("Invite administration owner/moderator gate", () => {
  let ownerAgent: Agent;
  let strangerAgent: Agent;
  let moderatorAgent: Agent;
  // An anonymous participant authenticated in a different conversation (A).
  let foreignParticipantAgent: Agent;
  let foreignParticipantUid: number;

  let treeviteConversationId: string; // the invite-only conversation under test
  let treeviteZid: number;
  let otherConversationId: string; // an ordinary conversation, source of a token
  let otherZid: number;
  let unusedInviteCode: string;

  // Direct DB access (the same pool the other owner-gate suites use), for
  // aligning the moderator's site and for asserting the acceptInvite effects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;

  beforeAll(async () => {
    ({ pool } = await import("../setup/db-test-helpers"));

    const ownerUser = getPooledTestUser(
      RESERVED_POOLED_USER_INDEXES.inviteAdminAuthOwner
    );
    ({ agent: ownerAgent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    }));

    // A distinct, fully signed-in account => a distinct site_id, so neither
    // owner nor moderator of the conversation.
    const strangerUser = getPooledTestUser(3);
    ({ agent: strangerAgent } = await getJwtAuthenticatedAgent({
      email: strangerUser.email,
      hname: strangerUser.name,
      password: strangerUser.password,
    }));

    const moderatorUser = getPooledTestUser(
      RESERVED_POOLED_USER_INDEXES.inviteAdminAuthModerator
    );
    ({ agent: moderatorAgent } = await getJwtAuthenticatedAgent({
      email: moderatorUser.email,
      hname: moderatorUser.name,
      password: moderatorUser.password,
    }));
    // Force the moderator's user row to exist so its site can be aligned below.
    await moderatorAgent.get("/api/v3/users");

    treeviteConversationId = await createConversation(ownerAgent, {
      topic: "Invite admin auth (invite-only)",
      description: "Owner/moderator gate on the invite admin routes",
      treevite_enabled: true,
    });

    otherConversationId = await createConversation(ownerAgent, {
      topic: "Invite admin auth (other conversation)",
      description: "Source of a participant token from another conversation",
    });

    const zidRows = await pool.query(
      "SELECT zinvite, zid FROM zinvites WHERE zinvite = ANY($1::text[])",
      [[treeviteConversationId, otherConversationId]]
    );
    const zidByCode: Record<string, number> = {};
    for (const r of zidRows.rows) zidByCode[r.zinvite] = r.zid;
    treeviteZid = zidByCode[treeviteConversationId];
    otherZid = zidByCode[otherConversationId];

    // Make the moderator an actual moderator by placing them on the owner's
    // site; isModerator() then resolves the conversation's owner as a user on
    // this moderator's site.
    const ownerRow = await pool.query(
      "SELECT uid, site_id FROM users WHERE email = $1",
      [ownerUser.email]
    );
    const modRow = await pool.query(
      "SELECT uid FROM users WHERE email = $1",
      [moderatorUser.email]
    );
    await pool.query("UPDATE users SET site_id = $1 WHERE uid = $2", [
      ownerRow.rows[0].site_id,
      modRow.rows[0].uid,
    ]);

    // A seed comment in the ordinary conversation so participants can vote,
    // which is what issues them an anonymous participant JWT.
    const seedResp: Response = await ownerAgent.post("/api/v3/comments").send({
      conversation_id: otherConversationId,
      txt: "Seed comment for the foreign conversation",
      is_seed: true,
    });
    expect(seedResp.status).toBe(200);
    const tidA: number = seedResp.body.tid;

    // One throwaway participant, then the participant the tests use; because pid
    // is assigned per conversation (0-based), the second participant gets a pid
    // greater than zero — the cross-conversation pid the acceptInvite test needs.
    const throwaway = await newAgent();
    await submitVote(throwaway, {
      conversation_id: otherConversationId,
      tid: tidA,
      vote: 1,
    });

    foreignParticipantAgent = await newAgent();
    const foreignVote = await submitVote(foreignParticipantAgent, {
      conversation_id: otherConversationId,
      tid: tidA,
      vote: 1,
    });
    expect(foreignVote.status).toBe(200);

    const foreignRow = await pool.query(
      "SELECT uid, pid FROM participants WHERE zid = $1 ORDER BY pid DESC LIMIT 1",
      [otherZid]
    );
    foreignParticipantUid = foreignRow.rows[0].uid;
    expect(foreignRow.rows[0].pid).toBeGreaterThan(0);

    // A wave of owner invite codes on the invite-only conversation.
    const waveResp: Response = await ownerAgent
      .post("/api/v3/treevite/waves")
      .send({
        conversation_id: treeviteConversationId,
        owner_invites: 5,
        invites_per_user: 0,
      });
    expect(waveResp.status).toBe(201);

    const codeRow = await pool.query(
      "SELECT invite_code FROM treevite_invites WHERE zid = $1 AND invite_owner_pid IS NULL AND status = 0 ORDER BY id ASC LIMIT 1",
      [treeviteZid]
    );
    unusedInviteCode = codeRow.rows[0].invite_code;
  });

  describe("POST /api/v3/treevite/waves", () => {
    const body = () => ({
      conversation_id: treeviteConversationId,
      owner_invites: 1,
      invites_per_user: 0,
    });

    test("a signed-in non-owner is refused with 403", async () => {
      const r: Response = await strangerAgent
        .post("/api/v3/treevite/waves")
        .send(body());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("a participant token from another conversation is refused with 403", async () => {
      const r: Response = await foreignParticipantAgent
        .post("/api/v3/treevite/waves")
        .send(body());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("the owner succeeds", async () => {
      const r: Response = await ownerAgent
        .post("/api/v3/treevite/waves")
        .send(body());
      expect(r.status).toBe(201);
      expect(r.body).toHaveProperty("wave");
    });

    test("a moderator on the owner's site succeeds", async () => {
      const r: Response = await moderatorAgent
        .post("/api/v3/treevite/waves")
        .send(body());
      expect(r.status).toBe(201);
      expect(r.body).toHaveProperty("wave");
    });
  });

  describe("GET /api/v3/treevite/waves", () => {
    const url = () =>
      `/api/v3/treevite/waves?conversation_id=${treeviteConversationId}`;

    test("a signed-in non-owner is refused with 403", async () => {
      const r: Response = await strangerAgent.get(url());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("a participant token from another conversation is refused with 403", async () => {
      const r: Response = await foreignParticipantAgent.get(url());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("the owner succeeds", async () => {
      const r: Response = await ownerAgent.get(url());
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    test("a moderator on the owner's site succeeds", async () => {
      const r: Response = await moderatorAgent.get(url());
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });
  });

  describe("GET /api/v3/treevite/invites", () => {
    const url = () =>
      `/api/v3/treevite/invites?conversation_id=${treeviteConversationId}`;

    test("a signed-in non-owner is refused with 403", async () => {
      const r: Response = await strangerAgent.get(url());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("a participant token from another conversation is refused with 403", async () => {
      const r: Response = await foreignParticipantAgent.get(url());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("the owner succeeds", async () => {
      const r: Response = await ownerAgent.get(url());
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty("invites");
      expect(r.body).toHaveProperty("pagination");
    });

    test("a moderator on the owner's site succeeds", async () => {
      const r: Response = await moderatorAgent.get(url());
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty("invites");
    });
  });

  describe("GET /api/v3/treevite/invites/csv", () => {
    const url = () =>
      `/api/v3/treevite/invites/csv?conversation_id=${treeviteConversationId}`;

    test("a signed-in non-owner is refused with 403", async () => {
      const r: Response = await strangerAgent.get(url());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("a participant token from another conversation is refused with 403", async () => {
      const r: Response = await foreignParticipantAgent.get(url());
      expect(r.status).toBe(403);
      expect(r.text).toContain("polis_err_treevite_not_conversation_owner");
    });

    test("the owner succeeds", async () => {
      const r: Response = await ownerAgent.get(url());
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("text/csv");
    });

    test("a moderator on the owner's site succeeds", async () => {
      const r: Response = await moderatorAgent.get(url());
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("text/csv");
    });
  });

  describe("POST /api/v3/users/invite", () => {
    test("a signed-in non-owner is refused with 403", async () => {
      const r: Response = await strangerAgent.post("/api/v3/users/invite").send({
        conversation_id: treeviteConversationId,
        emails: `nope_${Date.now()}@ex.com`,
      });
      expect(r.status).toBe(403);
      expect(r.text).toContain(
        "polis_err_sending_invite_not_conversation_owner"
      );
    });

    test("a participant token from another conversation is refused with 403", async () => {
      const r: Response = await foreignParticipantAgent
        .post("/api/v3/users/invite")
        .send({
          conversation_id: treeviteConversationId,
          emails: `nope2_${Date.now()}@ex.com`,
        });
      expect(r.status).toBe(403);
      expect(r.text).toContain(
        "polis_err_sending_invite_not_conversation_owner"
      );
    });

    test("the owner can invite; the parameterised insert stores each email", async () => {
      const stamp = Date.now();
      const emailA = `inva_${stamp}@ex.com`;
      const emailB = `invb_${stamp}@ex.com`;
      const r: Response = await ownerAgent.post("/api/v3/users/invite").send({
        conversation_id: treeviteConversationId,
        emails: `${emailA},${emailB}`,
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: "success" });

      const rows = await pool.query(
        "SELECT xid FROM suzinvites WHERE zid = $1 AND xid = ANY($2::text[])",
        [treeviteZid, [emailA, emailB]]
      );
      const storedXids = rows.rows.map((x: { xid: string }) => x.xid).sort();
      expect(storedXids).toEqual([emailA, emailB].sort());
    });
  });

  describe("POST /api/v3/treevite/acceptInvite - participant scoping (S4)", () => {
    test("a token from another conversation is scoped to the requested conversation and is not rejected", async () => {
      const r: Response = await foreignParticipantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: treeviteConversationId,
          invite_code: unusedInviteCode,
        });

      // A legitimate first-time accept is never rejected.
      expect(r.status).toBe(201);
      expect(r.body.status).toBe("ok");

      // The invite is marked used by a participant that belongs to THIS
      // conversation, not by the pid the foreign token carried.
      const inviteRow = await pool.query(
        "SELECT status, invite_used_by_pid FROM treevite_invites WHERE zid = $1 AND invite_code = $2",
        [treeviteZid, unusedInviteCode]
      );
      expect(inviteRow.rows[0].status).toBe(1);
      const usedPid: number = inviteRow.rows[0].invite_used_by_pid;

      // Exactly one participant with that pid exists in this conversation, and it
      // belongs to the foreign token's user: the identity was reused but scoped
      // to the requested conversation.
      const partRow = await pool.query(
        "SELECT uid FROM participants WHERE zid = $1 AND pid = $2",
        [treeviteZid, usedPid]
      );
      expect(partRow.rows.length).toBe(1);
      expect(partRow.rows[0].uid).toBe(foreignParticipantUid);

      // The login code was written for (this conversation, that scoped pid).
      const loginRow = await pool.query(
        "SELECT COUNT(*)::int AS n FROM treevite_login_codes WHERE zid = $1 AND pid = $2",
        [treeviteZid, usedPid]
      );
      expect(loginRow.rows[0].n).toBe(1);
    });
  });
});
