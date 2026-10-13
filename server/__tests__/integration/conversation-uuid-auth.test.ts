import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";

// GET /api/v3/conversationUuid returns the conversation's zinvites.uuid (minting
// one if the row somehow has none). That UUID is the capability key for the
// participant-XID export at GET /api/v3/xid/<uuid>-xid.csv, so the endpoint is
// gated to the owner or a moderator on the owner's site. These tests cover the
// outcomes: a signed-in non-owner (and a participant) is refused with 403 and is
// not handed the UUID, a non-owner request against a conversation with no UUID
// yet does not mint one, the owner receives the UUID, and the owner's XID
// capability link still works.
describe("GET /api/v3/conversationUuid - owner/moderator gate", () => {
  let ownerAgent: Agent;
  let strangerAgent: Agent;
  let conversationId: string;
  // A second conversation used only by the non-owner tests; the owner never
  // requests its UUID, so the "no UUID is minted for a non-owner" check is
  // independent of the owner's own tests against the shared conversation.
  let untouchedConversationId: string;
  let commentTid: number;
  let participantXid: string;

  beforeAll(async () => {
    // The conversation owner.
    const ownerUser = getPooledTestUser(1);
    const { agent: ownerJwtAgent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    });
    ownerAgent = ownerJwtAgent;

    // A different, fully signed-in account that neither owns nor moderates the
    // conversation (a distinct user => a distinct site_id).
    const strangerUser = getPooledTestUser(3);
    const { agent: strangerJwtAgent } = await getJwtAuthenticatedAgent({
      email: strangerUser.email,
      hname: strangerUser.name,
      password: strangerUser.password,
    });
    strangerAgent = strangerJwtAgent;

    conversationId = await createConversation(ownerAgent, {
      topic: "Conversation UUID auth test",
      description: "Verifies the owner/moderator gate on conversationUuid",
    });

    untouchedConversationId = await createConversation(ownerAgent, {
      topic: "Conversation UUID auth test (untouched)",
      description: "The owner never mints this conversation's UUID",
    });

    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the conversationUuid auth test",
      });
    expect(commentResponse.status).toBe(200);
    commentTid = commentResponse.body.tid;

    // Give the conversation a participant XID so the XID export has real content.
    participantXid = generateRandomXid();
    const xidParticipant = await initializeParticipantWithXid(
      conversationId,
      participantXid
    );
    await submitVote(xidParticipant.agent, {
      conversation_id: conversationId,
      tid: commentTid,
      vote: 1,
    });
  });

  test("a signed-in non-owner is refused with 403 and is not handed the UUID", async () => {
    const response: Response = await strangerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(403);
    expect(response.text).toContain("polis_err_conversation_uuid_auth");
    expect(response.body.conversation_uuid).toBeUndefined();
  });

  test("a refused non-owner request does not mint a UUID", async () => {
    const { pool } = await import("../setup/db-test-helpers");

    // Simulate a conversation whose UUID has not been minted yet (the handler's
    // only write path). New conversations are created with a UUID already, so we
    // clear it first to exercise the mint branch under the gate.
    await pool.query(
      "UPDATE zinvites SET uuid = NULL WHERE zid = (SELECT zid FROM zinvites WHERE zinvite = $1)",
      [untouchedConversationId]
    );
    const before = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [untouchedConversationId]
    );
    expect(before.rows.length).toBe(1);
    expect(before.rows[0].uuid).toBeNull();

    const response: Response = await strangerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${untouchedConversationId}`
    );
    expect(response.status).toBe(403);

    // The refused request must not have created a UUID for the conversation.
    const after = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [untouchedConversationId]
    );
    expect(after.rows[0].uuid).toBeNull();
  });

  test("an anonymous participant token is also refused with 403", async () => {
    // hybridAuth accepts participant (anonymous/XID) tokens, so prove a real
    // participant session cannot obtain the UUID either.
    const participant = await initializeParticipant(conversationId);
    await submitVote(participant.agent, {
      conversation_id: conversationId,
      tid: commentTid,
      vote: 0,
    });

    const response: Response = await participant.agent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(403);
  });

  test("the owner receives the conversation UUID", async () => {
    const response: Response = await ownerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(200);
    expect(typeof response.body.conversation_uuid).toBe("string");
    expect(response.body.conversation_uuid.length).toBeGreaterThan(0);
  });

  test("the owner's participant-XID capability link still works", async () => {
    const uuidResponse: Response = await ownerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(uuidResponse.status).toBe(200);
    const uuid = uuidResponse.body.conversation_uuid;

    // The admin XID page builds "<uuid>-xid.csv" and fetches the capability
    // route, which carries no auth of its own (it is used with curl). It must
    // keep returning the participant-XID CSV. A fresh, unauthenticated agent
    // stands in for curl.
    const anonymousAgent = await newAgent();
    const xidResponse: Response = await anonymousAgent.get(
      `/api/v3/xid/${uuid}-xid.csv`
    );
    expect(xidResponse.status).toBe(200);
    expect(xidResponse.headers["content-type"]).toContain("text/csv");
    expect(xidResponse.text).toContain("participant,xid");
    expect(xidResponse.text).toContain(participantXid);
  });
});
