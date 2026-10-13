import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";

// GET /api/v3/zinvites/:zid returns a conversation's zinvite rows as { codes: [...] }.
// Those rows live in the zinvites table, which also holds the conversation's
// uuid -- the capability key for the participant-XID export at
// GET /api/v3/xid/<uuid>-xid.csv. The route runs under hybridAuth, which also
// accepts participant (anonymous/XID) tokens, so the owner check is the only
// thing standing between any caller and that uuid. These tests cover the
// outcomes: a signed-in non-owner is refused with 403, an anonymous participant
// token is refused with 403, and the owner receives the codes with no uuid field
// in the response.
describe("GET /api/v3/zinvites/:zid - owner gate and uuid omission", () => {
  let ownerAgent: Agent;
  let strangerAgent: Agent;
  let conversationId: string;
  let commentTid: number;

  beforeAll(async () => {
    // The conversation owner.
    const ownerUser = getPooledTestUser(5);
    const { agent: ownerJwtAgent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    });
    ownerAgent = ownerJwtAgent;

    // A different, fully signed-in account that neither owns nor moderates the
    // conversation (a distinct user => a distinct site_id).
    const strangerUser = getPooledTestUser(7);
    const { agent: strangerJwtAgent } = await getJwtAuthenticatedAgent({
      email: strangerUser.email,
      hname: strangerUser.name,
      password: strangerUser.password,
    });
    strangerAgent = strangerJwtAgent;

    conversationId = await createConversation(ownerAgent, {
      topic: "Zinvites auth test",
      description: "Verifies the owner gate and uuid omission on zinvites",
    });

    // A comment the anonymous participant can vote on; voting is what issues the
    // participant its JWT, so the "participant token is still refused" test
    // exercises the owner check rather than the missing-token path.
    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the zinvites auth test",
      });
    expect(commentResponse.status).toBe(200);
    commentTid = commentResponse.body.tid;
  });

  test("a signed-in non-owner is refused with 403 and is handed no codes", async () => {
    const response: Response = await strangerAgent.get(
      `/api/v3/zinvites/${conversationId}?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(403);
    expect(response.text).toContain(
      "polis_err_fetching_zinvite_not_conversation_owner"
    );
    expect(response.body.codes).toBeUndefined();
  });

  test("an anonymous participant token is also refused with 403", async () => {
    // hybridAuth accepts participant (anonymous/XID) tokens, so prove a real
    // participant session cannot read the zinvites either. Voting first issues
    // the participant a JWT that hybridAuth accepts; without it the request
    // would fail as unauthenticated rather than exercise the owner check.
    const participant = await initializeParticipant(conversationId);
    await submitVote(participant.agent, {
      conversation_id: conversationId,
      tid: commentTid,
      vote: 0,
    });

    const response: Response = await participant.agent.get(
      `/api/v3/zinvites/${conversationId}?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(403);
    expect(response.body.codes).toBeUndefined();
  });

  test("the owner receives the codes with no uuid field", async () => {
    // A conversation is created with its zinvites uuid already minted, so a
    // SELECT * would have leaked it. Confirm the row really has a uuid, then
    // confirm the route's response does not carry it.
    const { pool } = await import("../setup/db-test-helpers");
    const row = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].uuid).toBeTruthy();

    const response: Response = await ownerAgent.get(
      `/api/v3/zinvites/${conversationId}?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.codes)).toBe(true);
    expect(response.body.codes.length).toBeGreaterThan(0);

    // The codes clients read are the zinvite rows; the uuid column must not be
    // present anywhere in the response.
    for (const code of response.body.codes) {
      expect(typeof code.zinvite).toBe("string");
      expect(code.zinvite.length).toBeGreaterThan(0);
      expect(Object.prototype.hasOwnProperty.call(code, "uuid")).toBe(false);
    }
    expect(JSON.stringify(response.body)).not.toContain(row.rows[0].uuid);
  });
});
