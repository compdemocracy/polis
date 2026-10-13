import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";

// The /api/v3/zinvites/:zid routes read and create a conversation's zinvite
// rows. Both require the conversation's owner. These tests cover the outcomes:
// a signed-in non-owner is refused with 403, an anonymous participant token is
// refused with 403, the owner reads the codes with no uuid field in the
// response, and the owner can create a code.
describe("/api/v3/zinvites/:zid - owner-only", () => {
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
      description: "Verifies the owner requirement on the zinvites routes",
    });

    // A comment for the participant to vote on. Voting is what issues a
    // participant its JWT, so the participant-token tests reach the handler
    // rather than failing as unauthenticated.
    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the zinvites auth test",
      });
    expect(commentResponse.status).toBe(200);
    commentTid = commentResponse.body.tid;
  });

  describe("GET", () => {
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
      // The conversation's zinvites row carries a uuid; confirm the route's
      // response does not include it.
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

      for (const code of response.body.codes) {
        expect(typeof code.zinvite).toBe("string");
        expect(code.zinvite.length).toBeGreaterThan(0);
        expect(Object.prototype.hasOwnProperty.call(code, "uuid")).toBe(false);
      }
      expect(JSON.stringify(response.body)).not.toContain(row.rows[0].uuid);
    });
  });

  describe("POST", () => {
    test("a signed-in non-owner is refused with 403 and creates no code", async () => {
      const { pool } = await import("../setup/db-test-helpers");
      const zidRow = await pool.query(
        "SELECT zid FROM zinvites WHERE zinvite = $1",
        [conversationId]
      );
      const zid = zidRow.rows[0].zid;
      const before = await pool.query(
        "SELECT count(*)::int AS n FROM zinvites WHERE zid = $1",
        [zid]
      );

      const response: Response = await strangerAgent
        .post(`/api/v3/zinvites/${conversationId}`)
        .send({ conversation_id: conversationId });
      expect(response.status).toBe(403);
      expect(response.text).toContain(
        "polis_err_creating_zinvite_not_conversation_owner"
      );
      expect(response.body.zinvite).toBeUndefined();

      // The refused request must not have created a new zinvites row.
      const after = await pool.query(
        "SELECT count(*)::int AS n FROM zinvites WHERE zid = $1",
        [zid]
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    test("an anonymous participant token is also refused with 403", async () => {
      const participant = await initializeParticipant(conversationId);
      await submitVote(participant.agent, {
        conversation_id: conversationId,
        tid: commentTid,
        vote: 1,
      });

      const response: Response = await participant.agent
        .post(`/api/v3/zinvites/${conversationId}`)
        .send({ conversation_id: conversationId });
      expect(response.status).toBe(403);
      expect(response.body.zinvite).toBeUndefined();
    });

    test("the owner can create a code", async () => {
      const response: Response = await ownerAgent
        .post(`/api/v3/zinvites/${conversationId}`)
        .send({ conversation_id: conversationId });
      expect(response.status).toBe(200);
      expect(typeof response.body.zinvite).toBe("string");
      expect(response.body.zinvite.length).toBeGreaterThan(0);
    });
  });
});
