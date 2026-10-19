/**
 * GET /api/v3/participation: the owner's per-participant vote and comment
 * counts.
 *
 * The two group-by counts run on the bounded report/export pool
 * (db/pg-query.ts), which holds one connection per process by default and
 * rejects a request that waits longer than REPORT_EXPORT_ACQUIRE_TIMEOUT_MS.
 * An export, a report or conversationStats holding that connection made this
 * route answer 500 polis_err_get_participation_misc, the code for an
 * unexpected failure. The last case pins the answer for that state: a 503 with
 * its own code, and the route answering normally again once the connection is
 * free.
 */

// Read by src/config.ts when the app is first loaded (lazily, in the first
// request below), so it must be set before then. Short, so the busy case
// does not wait the 30 s default.
process.env.REPORT_EXPORT_ACQUIRE_TIMEOUT_MS = "500";

import { describe, expect, test } from "@jest/globals";
import {
  getJwtAuthenticatedAgent,
  initializeParticipant,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";
import { toWire } from "../setup/vote-wire";

// A new conversation and an agent signed in as its owner.
async function ownedConversation(commentCount: number) {
  const { conversationId, testUser } = await setupAuthAndConvo({
    createConvo: true,
    commentCount,
  });
  const { agent } = await getJwtAuthenticatedAgent(testUser);
  return { agent, conversationId };
}

describe("GET /api/v3/participation", () => {
  test("a conversation with no participants answers 200 {}", async () => {
    const { agent, conversationId } = await ownedConversation(0);

    const res = await agent.get(
      `/api/v3/participation?conversation_id=${conversationId}`
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  test("a participant who voted but never commented is counted", async () => {
    const { agent, conversationId } = await ownedConversation(1);
    const { body: init, agent: participant } = await initializeParticipant(
      conversationId
    );
    const vote = await submitVote(participant, {
      conversation_id: conversationId,
      tid: init.nextComment.tid,
      vote: toWire("agree"),
    });
    expect(vote.status).toBe(200);

    const res = await agent.get(
      `/api/v3/participation?conversation_id=${conversationId}`
    );

    expect(res.status).toBe(200);
    expect(Object.values(res.body)).toContainEqual({ votes: 1, comments: 0 });
  });

  test("strict with no xids answers its 409 code", async () => {
    const { agent, conversationId } = await ownedConversation(0);

    const res = await agent.get(
      `/api/v3/participation?conversation_id=${conversationId}&strict=true`
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^polis_err_get_participation_missing_xids/);
  });

  test("a busy report/export pool answers 503 with a code, then recovers", async () => {
    const { agent, conversationId } = await ownedConversation(1);
    const { default: pg, REPORT_EXPORT_POOL_MAX } = await import(
      "../../src/db/pg-query"
    );

    // Hold every report/export connection, as a long export would.
    const held = Array.from({ length: REPORT_EXPORT_POOL_MAX }, () =>
      pg.queryP_reportExport("SELECT pg_sleep(3)", [])
    );
    try {
      const busy = await agent.get(
        `/api/v3/participation?conversation_id=${conversationId}`
      );
      expect(busy.status).toBe(503);
      expect(busy.body.error).toBe("polis_err_get_participation_busy");
    } finally {
      await Promise.all(held);
    }

    const after = await agent.get(
      `/api/v3/participation?conversation_id=${conversationId}`
    );
    expect(after.status).toBe(200);
  });
});
