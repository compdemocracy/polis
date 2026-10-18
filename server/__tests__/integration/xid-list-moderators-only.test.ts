/**
 * A conversation's participant XID list is for its owner and moderators only.
 *
 * Five reads hand out the xids of a conversation: the xids in use
 * (GET /api/v3/xids and /api/v3/xids/csv), the allow-list that admits
 * participants (GET /api/v3/xidAllowList and /api/v3/xidAllowList/csv), and
 * the participant-to-xid download (GET /api/v3/xid/<uuid>-xid.csv). An xid
 * is what an integrator uses to identify a participant, so the list is
 * readable by the conversation's owner and by a moderator on the owner's site,
 * and by nobody else. For every one of the five reads this file pins that:
 *   - a request without a login is refused with 401 and sees no xid;
 *   - a signed-in account that neither owns nor moderates the conversation is
 *     refused with 403 and the route's own refusal code, sees no xid, and the
 *     refusal writes nothing (no participant, no allow-list row, no xid, no
 *     new conversation key);
 *   - a participant's token is refused the same way;
 *   - the owner receives the list it has always received, read back here
 *     independently from the database;
 *   - a moderator receives exactly the owner's bytes.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  submitVote,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import {
  getPooledTestUser,
  RESERVED_POOLED_USER_INDEXES,
} from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../setup/vote-wire";

function pooled(index: number) {
  const u = getPooledTestUser(index);
  return { email: u.email, hname: u.name, password: u.password };
}

interface ListRoute {
  name: string;
  path: () => string;
  refusal: string;
  expected: () => Promise<{ contentType: string; body: string }>;
}

describe("the participant XID list: owner and moderators only", () => {
  let owner: Agent;
  let moderator: Agent;
  let stranger: Agent;
  let participantToken: Agent;
  let conversationId: string;
  let zid: number;
  let ownerUid: number;
  let participantXid: string;
  let participantPid: number;
  let allowedOnlyXid: string;
  let conversationUuid: string;

  // Everything a refused read could leave behind for this conversation.
  const snapshot = async () =>
    (
      await pool.query(
        `SELECT
           (SELECT count(*)::int FROM participants WHERE zid = $1) AS participants,
           (SELECT count(*)::int FROM xid_whitelist WHERE owner = $2) AS allowed,
           (SELECT count(*)::int FROM xids WHERE owner = $2) AS xids,
           (SELECT array_agg(uuid::text ORDER BY zinvite) FROM zinvites WHERE zid = $1) AS uuids`,
        [zid, ownerUid]
      )
    ).rows[0];

  // The rows the owner has always been sent, read back from the database.
  const inUseRows = async () =>
    (
      await pool.query(
        `SELECT p.pid, x.xid, COALESCE(p.vote_count, 0) AS vote_count
           FROM xids x JOIN participants p ON p.uid = x.uid
          WHERE p.zid = $1 AND x.owner = $2
          ORDER BY p.pid`,
        [zid, ownerUid]
      )
    ).rows as { pid: number; xid: string; vote_count: number }[];

  const allowListRows = async () =>
    (
      await pool.query(
        `SELECT wl.xid, p.pid
           FROM xid_whitelist wl
           LEFT JOIN xids x ON x.xid = wl.xid AND x.owner = $2
           LEFT JOIN participants p ON p.uid = x.uid AND p.zid = $1
          WHERE wl.owner = $2
          ORDER BY wl.xid`,
        [zid, ownerUid]
      )
    ).rows as { xid: string; pid: number | null }[];

  const routes: ListRoute[] = [
    {
      name: "GET /api/v3/xids",
      path: () => `/api/v3/xids?conversation_id=${conversationId}`,
      refusal: "polis_err_get_xids_not_authorized",
      expected: async () => {
        const rows = await inUseRows();
        return {
          contentType: "application/json",
          body: JSON.stringify({
            xids: rows,
            pagination: {
              limit: 50,
              offset: 0,
              total: rows.length,
              hasMore: false,
            },
          }),
        };
      },
    },
    {
      name: "GET /api/v3/xids/csv",
      path: () => `/api/v3/xids/csv?conversation_id=${conversationId}`,
      refusal: "polis_err_get_xids_csv_not_authorized",
      expected: async () => ({
        contentType: "text/csv",
        body: [
          "pid,xid,vote_count",
          ...(await inUseRows()).map(
            (r) => `${r.pid},${r.xid},${r.vote_count}`
          ),
        ].join("\n"),
      }),
    },
    {
      name: "GET /api/v3/xidAllowList",
      path: () => `/api/v3/xidAllowList?conversation_id=${conversationId}`,
      refusal: "polis_err_get_xidAllowList_not_authorized",
      expected: async () => {
        const rows = await allowListRows();
        return {
          contentType: "application/json",
          body: JSON.stringify({
            xids: rows,
            pagination: {
              limit: 50,
              offset: 0,
              total: rows.length,
              hasMore: false,
            },
          }),
        };
      },
    },
    {
      name: "GET /api/v3/xidAllowList/csv",
      path: () => `/api/v3/xidAllowList/csv?conversation_id=${conversationId}`,
      refusal: "polis_err_get_xidAllowList_csv_not_authorized",
      expected: async () => ({
        contentType: "text/csv",
        body: [
          "pid,xid",
          ...(await allowListRows()).map((r) => `${r.pid ?? ""},${r.xid}`),
        ].join("\n"),
      }),
    },
    {
      name: "GET /api/v3/xid/:xid_report",
      path: () => `/api/v3/xid/${conversationUuid}-xid.csv`,
      refusal: "polis_err_xid_report_auth",
      expected: async () => ({
        contentType: "text/csv",
        body:
          [
            "participant,xid",
            ...(await inUseRows()).map((r) => `${r.pid},"${r.xid}"`),
          ].join("\n") + "\n",
      }),
    },
  ];

  beforeAll(async () => {
    const ownerUser = pooled(RESERVED_POOLED_USER_INDEXES.xidListOwner);
    const moderatorUser = pooled(RESERVED_POOLED_USER_INDEXES.xidListModerator);
    ({ agent: owner } = await getJwtAuthenticatedAgent(ownerUser));
    ({ agent: moderator } = await getJwtAuthenticatedAgent(moderatorUser));
    // A distinct, fully signed-in account => a distinct site_id, so neither
    // owner nor moderator of the conversation.
    ({ agent: stranger } = await getJwtAuthenticatedAgent(pooled(3)));

    // Force the moderator's user row to exist so its site can be aligned.
    await moderator.get("/api/v3/users");

    conversationId = await createConversation(owner, {
      topic: "Participant XID list: owner and moderators only",
      description: "Who may read a conversation's xids",
    });
    zid = (
      await pool.query("SELECT zid FROM zinvites WHERE zinvite = $1", [
        conversationId,
      ])
    ).rows[0].zid;

    // Make the moderator an actual moderator: put them on the owner's site.
    const ownerRow = await pool.query(
      "SELECT uid, site_id FROM users WHERE email = $1",
      [ownerUser.email]
    );
    ownerUid = ownerRow.rows[0].uid;
    await pool.query("UPDATE users SET site_id = $1 WHERE email = $2", [
      ownerRow.rows[0].site_id,
      moderatorUser.email,
    ]);

    const seed: Response = await owner.post("/api/v3/comments").send({
      conversation_id: conversationId,
      txt: "Seed statement for the XID list test",
      is_seed: true,
    });
    expect(seed.status).toBe(200);
    const tid: number = seed.body.tid;

    // One participant with an xid, so every list has a row to leak.
    participantXid = generateRandomXid();
    const xidParticipant = await initializeParticipantWithXid(
      conversationId,
      participantXid
    );
    const vote = await submitVote(xidParticipant.agent, {
      conversation_id: conversationId,
      tid,
      vote: WIRE_AGREE,
    });
    expect(vote.status).toBe(200);
    const pidRows = await pool.query(
      `SELECT p.pid FROM participants p JOIN xids x ON x.uid = p.uid
        WHERE p.zid = $1 AND x.xid = $2`,
      [zid, participantXid]
    );
    expect(pidRows.rows.length).toBe(1);
    participantPid = pidRows.rows[0].pid;

    // The allow-list: the participant's xid and one that has not joined.
    allowedOnlyXid = `${generateRandomXid()}-allowed`;
    const allow: Response = await owner.post("/api/v3/xidAllowList").send({
      conversation_id: conversationId,
      xid_allow_list: [participantXid, allowedOnlyXid],
    });
    expect(allow.status).toBe(200);

    // A participant without an xid, holding the token its vote issued.
    const plain = await initializeParticipant(conversationId);
    const plainVote = await submitVote(plain.agent, {
      conversation_id: conversationId,
      tid,
      vote: WIRE_AGREE,
    });
    expect(plainVote.status).toBe(200);
    participantToken = plain.agent;

    const uuid: Response = await owner.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(uuid.status).toBe(200);
    conversationUuid = uuid.body.conversation_uuid;
  });

  describe.each(routes)("$name", (route) => {
    test("a request without a login is refused with 401 and sees no xid", async () => {
      const anonymous = await newAgent();
      const r: Response = await anonymous.get(route.path());
      expect(r.status).toBe(401);
      expect(r.text).not.toContain(participantXid);
      expect(r.text).not.toContain(allowedOnlyXid);
    });

    test("a signed-in non-moderator is refused with 403, sees no xid and writes nothing", async () => {
      const before = await snapshot();
      const r: Response = await stranger.get(route.path());
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(route.refusal);
      expect(r.text).not.toContain(participantXid);
      expect(r.text).not.toContain(allowedOnlyXid);
      expect(await snapshot()).toEqual(before);
    });

    test("a participant's token is refused with 403 and sees no xid", async () => {
      const before = await snapshot();
      const r: Response = await participantToken.get(route.path());
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(route.refusal);
      expect(r.text).not.toContain(participantXid);
      expect(r.text).not.toContain(allowedOnlyXid);
      expect(await snapshot()).toEqual(before);
    });

    test("the owner receives the list as before", async () => {
      const r: Response = await owner.get(route.path());
      expect(r.status).toBe(200);
      const expected = await route.expected();
      expect(r.headers["content-type"]).toContain(expected.contentType);
      expect(r.text).toBe(expected.body);
      expect(r.text).toContain(participantXid);
      expect(r.text).toContain(String(participantPid));
    });

    test("a moderator receives exactly the owner's bytes", async () => {
      const asOwner: Response = await owner.get(route.path());
      const asModerator: Response = await moderator.get(route.path());
      expect(asModerator.status).toBe(200);
      expect(asModerator.headers["content-type"]).toBe(
        asOwner.headers["content-type"]
      );
      expect(asModerator.text).toBe(asOwner.text);
    });
  });
});
