import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  submitVote,
  updateConversation,
} from "../setup/api-test-helpers";
import type { ParticipantData } from "../../types/test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../setup/vote-wire";

// POST /api/v3/convSubscriptions stores the subscriber's e-mail address in
// participants_extended.subscribe_email. A conversation whose subscriptions
// are turned off (subscribe_type 0) offers no subscription, so the route
// refuses the request and stores nothing; a conversation with subscriptions
// on (the default, subscribe_type 1) keeps working.
describe("POST /api/v3/convSubscriptions - conversation with subscriptions off", () => {
  let ownerAgent: Agent;
  let offConversationId: string;
  let onConversationId: string;
  let offZid: number;
  let onZid: number;
  let offParticipant: ParticipantData;
  let onParticipant: ParticipantData;

  async function zidOf(conversationId: string): Promise<number> {
    const { rows } = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    return rows[0].zid;
  }

  // A participant who has voted, so participants and participants_extended
  // both hold a row for them.
  async function joinedParticipant(
    conversationId: string
  ): Promise<ParticipantData> {
    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the subscription test",
      });
    expect(commentResponse.status).toBe(200);

    const participant = await initializeParticipant(conversationId);
    const vote = await submitVote(participant.agent, {
      conversation_id: conversationId,
      tid: commentResponse.body.tid,
      vote: WIRE_AGREE,
    });
    expect(vote.status).toBe(200);
    return participant;
  }

  beforeAll(async () => {
    const ownerUser = getPooledTestUser(1);
    const { agent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    });
    ownerAgent = agent;

    offConversationId = await createConversation(ownerAgent, {
      topic: "Subscriptions off",
    });
    const update = await updateConversation(ownerAgent, {
      conversation_id: offConversationId,
      subscribe_type: 0,
    });
    expect(update.status).toBe(200);
    offZid = await zidOf(offConversationId);
    const { rows } = await pool.query(
      "SELECT subscribe_type FROM conversations WHERE zid = $1",
      [offZid]
    );
    expect(rows[0].subscribe_type).toBe(0);

    onConversationId = await createConversation(ownerAgent, {
      topic: "Subscriptions on (the default)",
    });
    onZid = await zidOf(onConversationId);

    offParticipant = await joinedParticipant(offConversationId);
    onParticipant = await joinedParticipant(onConversationId);
  });

  test("a participant's subscription is refused with 403 and no address is stored", async () => {
    const email = `participant-${Date.now()}-off@example.com`;
    const response: Response = await offParticipant.agent
      .post("/api/v3/convSubscriptions")
      .send({ conversation_id: offConversationId, email, type: 1 });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_subscriptions_disabled");

    const stored = await pool.query(
      `SELECT pe.subscribe_email, p.subscribed
         FROM participants_extended pe
         JOIN participants p ON p.zid = pe.zid AND p.uid = pe.uid
        WHERE pe.zid = $1`,
      [offZid]
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.subscribe_email).toBeNull();
      expect(row.subscribed).toBe(0);
    }
  });

  test("unsubscribing is still accepted when subscriptions are off", async () => {
    const response: Response = await offParticipant.agent
      .post("/api/v3/convSubscriptions")
      .send({
        conversation_id: offConversationId,
        email: `participant-${Date.now()}-unsub@example.com`,
        type: 0,
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ subscribed: 0 });
  });

  test("with subscriptions on, the same request is accepted and the address is stored", async () => {
    const email = `participant-${Date.now()}-on@example.com`;
    const response: Response = await onParticipant.agent
      .post("/api/v3/convSubscriptions")
      .send({ conversation_id: onConversationId, email, type: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ subscribed: 1 });

    const stored = await pool.query(
      "SELECT subscribe_email FROM participants_extended WHERE zid = $1 AND subscribe_email = $2",
      [onZid, email]
    );
    expect(stored.rows.length).toBe(1);
  });
});
