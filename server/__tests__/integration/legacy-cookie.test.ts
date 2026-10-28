import { describe, test, expect } from "@jest/globals";
import { newAgent, setupAuthAndConvo } from "../setup/api-test-helpers";
import { createAnonUser } from "../../src/auth/create-user";
import { joinConversation } from "../../src/participant";
import { verifyParticipantJWT } from "../../src/auth/jwt-utils";
import { pool } from "../setup/db-test-helpers";
import { randomUUID } from "node:crypto";

describe("Retired permanent cookies", () => {
  test("joins fresh when only an old participant's pc cookie is presented", async () => {
    const { conversationId, commentIds } = await setupAuthAndConvo({
      commentCount: 1,
    });
    const { rows } = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    const zid = rows[0].zid;
    const uid = await createAnonUser();
    const { pid } = await joinConversation(zid, uid);
    const cookie = randomUUID().replace(/-/g, "");
    await pool.query(
      `INSERT INTO participants_extended (zid, uid, permanent_cookie)
       VALUES ($1, $2, $3)
       ON CONFLICT (zid, uid) DO UPDATE SET permanent_cookie = $3`,
      [zid, uid, cookie]
    );

    const agent = await newAgent();
    const response = await agent
      .post("/api/v3/votes")
      .set("Cookie", `pc=${cookie}`)
      .send({ conversation_id: conversationId, tid: commentIds[0], vote: 1 });

    expect(response.status).toBe(200);
    expect(response.body.currentPid).toEqual(expect.any(Number));
    expect(response.body.currentPid).not.toBe(pid);
    expect(response.body.auth.token_type).toBe("Bearer");
    const token = verifyParticipantJWT(response.body.auth.token, "anonymous");
    expect(token).toMatchObject({
      conversation_id: conversationId,
      pid: response.body.currentPid,
    });
    expect(token.uid).not.toBe(uid);
    const participants = await pool.query(
      "SELECT uid, pid FROM participants WHERE zid = $1 ORDER BY pid",
      [zid]
    );
    expect(participants.rows).toHaveLength(3);
    expect(participants.rows).toEqual(
      expect.arrayContaining([
        { uid, pid },
        { uid: token.uid, pid: response.body.currentPid },
      ])
    );
  });
});
