import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipantWithXid,
  newAgent,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";

// Migration 000039_clear_zinvites_uuid.sql runs, at the deploy that adds the
// owner/moderator gate on GET /api/v3/conversationUuid,
//
//   UPDATE public.zinvites SET uuid = NULL WHERE uuid IS NOT NULL
//
// clearing every existing conversation download key (zinvites.uuid). The key is
// the capability for the participant-XID export (GET /api/v3/xid/<uuid>-xid.csv),
// so clearing it forces each owner to re-copy any saved download link once: the
// owner re-mints a fresh key through the now-gated conversationUuid route.
//
// These tests exercise that transition end to end on one conversation. The real
// migration has no zid clause; this suite reproduces its per-row effect scoped
// to its own conversation so a run beside other suites never clears their keys.
describe("migration 000039 clears conversation download keys; owners re-mint under the owner gate", () => {
  let ownerAgent: Agent;
  let strangerAgent: Agent;
  let conversationId: string;
  let commentTid: number;
  let participantXid: string;
  let clearedUuid: string;

  beforeAll(async () => {
    const { pool } = await import("../setup/db-test-helpers");

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
      topic: "Download-key clear migration test",
      description: "Verifies owners re-mint after migration 000039 clears keys",
    });

    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the download-key clear migration test",
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

    // A conversation is created with a download key already (create-user.ts), so
    // capture it before the clear; it is the key an owner may have saved.
    const before = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    expect(before.rows.length).toBe(1);
    expect(before.rows[0].uuid).not.toBeNull();
    clearedUuid = before.rows[0].uuid;

    // Apply migration 000039's statement, scoped to this conversation's row.
    await pool.query(
      "UPDATE public.zinvites SET uuid = NULL WHERE uuid IS NOT NULL AND zid = (SELECT zid FROM zinvites WHERE zinvite = $1)",
      [conversationId]
    );
    const after = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    expect(after.rows[0].uuid).toBeNull();
  });

  test("a saved download link stops resolving once the key is cleared", async () => {
    // The key the owner may have copied before the deploy no longer maps to a
    // conversation, so the saved link returns not-found rather than the export.
    const anonymousAgent = await newAgent();
    const staleResponse: Response = await anonymousAgent.get(
      `/api/v3/xid/${clearedUuid}-xid.csv`
    );
    expect(staleResponse.status).toBe(404);
  });

  test("a non-owner is still refused with 403 and no key is minted", async () => {
    const { pool } = await import("../setup/db-test-helpers");

    const response: Response = await strangerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(403);
    expect(response.text).toContain("polis_err_conversation_uuid_auth");
    expect(response.body.conversation_uuid).toBeUndefined();

    // The refused request must not have minted a key for the conversation.
    const after = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    expect(after.rows[0].uuid).toBeNull();
  });

  test("the owner is minted a fresh key, different from the cleared one", async () => {
    const response: Response = await ownerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(200);
    const newUuid = response.body.conversation_uuid;
    expect(typeof newUuid).toBe("string");
    expect(newUuid.length).toBeGreaterThan(0);
    expect(newUuid).not.toBe(clearedUuid);
  });

  test("the owner's new download link works", async () => {
    const uuidResponse: Response = await ownerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(uuidResponse.status).toBe(200);
    const newUuid = uuidResponse.body.conversation_uuid;
    expect(newUuid).not.toBe(clearedUuid);

    // The admin XID page builds "<uuid>-xid.csv" and fetches it to download the
    // participant export; the freshly minted key must make that work again.
    const anonymousAgent = await newAgent();
    const xidResponse: Response = await anonymousAgent.get(
      `/api/v3/xid/${newUuid}-xid.csv`
    );
    expect(xidResponse.status).toBe(200);
    expect(xidResponse.headers["content-type"]).toContain("text/csv");
    expect(xidResponse.text).toContain("participant,xid");
    expect(xidResponse.text).toContain(participantXid);
  });
});
