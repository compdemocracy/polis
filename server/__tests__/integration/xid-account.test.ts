import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipantWithXid,
  newAgent,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import * as xids from "../../src/xids";

describe("XIDs cannot authenticate privileged accounts", () => {
  let conversationId: string;

  beforeAll(async () => {
    const user = getPooledTestUser(1);
    const { agent } = await getJwtAuthenticatedAgent({
      email: user.email,
      hname: user.name,
      password: user.password,
    });
    conversationId = await createConversation(agent);
  });

  test("first contact creates a plain account and fresh sessions retain it", async () => {
    const xid = generateRandomXid();
    const first = await initializeParticipantWithXid(conversationId, xid);
    expect(first.status).toBe(200);
    expect(first.body.auth.token).toBeTruthy();
    const resumed = await initializeParticipantWithXid(conversationId, xid);
    expect(resumed.status).toBe(200);
    expect(resumed.body.user.uid).toBe(first.body.user.uid);
    expect(resumed.body.ptpt.pid).toBe(first.body.ptpt.pid);
    const agent = await newAgent();
    const authenticated = await agent
      .get("/api/v3/participationInit")
      .set("Authorization", `Bearer ${first.body.auth.token}`)
      .query({ conversation_id: conversationId });
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.user.uid).toBe(first.body.user.uid);
  });

  test("refuses bare XIDs, existing tokens and cookie conversion after an owner upgrade", async () => {
    const xid = generateRandomXid();
    const first = await initializeParticipantWithXid(conversationId, xid);
    expect(first.status).toBe(200);
    const uid = first.body.user.uid;
    const cookie = randomUUID().replace(/-/g, "");
    await pool.query(
      `INSERT INTO participants_extended (zid, uid, permanent_cookie)
       SELECT zid, uid, $1 FROM participants WHERE uid = $2
       ON CONFLICT (zid, uid) DO UPDATE SET permanent_cookie = $1`,
      [cookie, uid]
    );
    await pool.query("UPDATE users SET is_owner = true WHERE uid = $1", [uid]);
    try {
      const agent = await newAgent();
      const bare = await agent
        .get("/api/v3/participationInit")
        .query({ conversation_id: conversationId, xid });
      const token = first.body.auth.token;
      const withToken = await agent
        .get("/api/v3/participationInit")
        .set("Authorization", `Bearer ${token}`)
        .query({ conversation_id: conversationId });
      const accountRoute = await agent
        .get("/api/v3/users")
        .set("Authorization", `Bearer ${token}`);
      const withCookie = await agent
        .get("/api/v3/participationInit")
        .set("Cookie", `pc=${cookie}`)
        .query({ conversation_id: conversationId, xid });
      // Optional middleware can fall through after a failed lookup. The
      // handler's second resolution must enforce the same refusal.
      const lookup = jest
        .spyOn(xids, "getXidRecord")
        .mockRejectedValueOnce(new Error("temporary lookup failure"));
      let fallback;
      try {
        fallback = await agent
          .get("/api/v3/participationInit")
          .query({ conversation_id: conversationId, xid });
      } finally {
        lookup.mockRestore();
      }
      const write = await agent.post("/api/v3/comments").send({
        conversation_id: conversationId,
        xid,
        txt: "This XID must not be allowed to submit a statement",
      });
      for (const response of [
        bare,
        withToken,
        accountRoute,
        withCookie,
        fallback,
        write,
      ]) {
        expect(response.status).toBe(403);
        expect(response.body.error).toBe("polis_err_xid_owner_account");
        expect(response.body.auth).toBeUndefined();
      }
      const binding = await pool.query("SELECT uid FROM xids WHERE xid = $1", [
        xid,
      ]);
      expect(binding.rows).toEqual([{ uid }]);
      const comments = await pool.query(
        "SELECT tid FROM comments WHERE uid = $1",
        [uid]
      );
      expect(comments.rows).toEqual([]);
    } finally {
      await pool.query("UPDATE users SET is_owner = false WHERE uid = $1", [
        uid,
      ]);
    }
  });

  test.each(["conversation owner", "site moderator", "OIDC mapping"])(
    "refuses a participant who acquires a %s relationship",
    async (kind) => {
      const xid = generateRandomXid();
      const first = await initializeParticipantWithXid(conversationId, xid);
      const uid = first.body.user.uid;
      const original = await pool.query(
        "SELECT site_id FROM users WHERE uid = $1",
        [uid]
      );
      let ownedZid: number | undefined;
      if (kind === "conversation owner") {
        const owned = await pool.query(
          "INSERT INTO conversations (owner) VALUES ($1) RETURNING zid",
          [uid]
        );
        ownedZid = owned.rows[0].zid;
      } else if (kind === "site moderator") {
        await pool.query(
          `UPDATE users SET site_id = (SELECT u.site_id FROM users u
            JOIN conversations c ON c.owner = u.uid
            JOIN zinvites z ON z.zid = c.zid WHERE z.zinvite = $1)
           WHERE uid = $2`,
          [conversationId, uid]
        );
      } else {
        await pool.query(
          "INSERT INTO oidc_user_mappings (oidc_sub, uid) VALUES ($1, $2)",
          [`test-xid-account-${uid}`, uid]
        );
      }
      try {
        const agent = await newAgent();
        const response = await agent
          .get("/api/v3/participationInit")
          .query({ conversation_id: conversationId, xid });
        expect(response.status).toBe(403);
        expect(response.body.error).toBe("polis_err_xid_owner_account");
        expect(response.body.auth).toBeUndefined();
      } finally {
        if (ownedZid !== undefined) {
          await pool.query("DELETE FROM conversations WHERE zid = $1", [
            ownedZid,
          ]);
        }
        await pool.query("UPDATE users SET site_id = $1 WHERE uid = $2", [
          original.rows[0].site_id,
          uid,
        ]);
        await pool.query("DELETE FROM oidc_user_mappings WHERE uid = $1", [
          uid,
        ]);
      }
    }
  );
});
