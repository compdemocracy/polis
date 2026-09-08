/**
 * Availability regression test for POST /api/v3/trashes.
 *
 * The insert into `trashes` had no RETURNING clause, but its pg callback read
 * `result.rows[0].created`. pg invokes that callback from its own socket
 * handler — outside Express 3's dispatch and outside any promise — so the
 * TypeError became a process-level 'uncaughtException', and
 * setupGlobalProcessHandlers (server/src/server-middleware.ts) calls
 * process.exit(1) for anything that is not a 23505. Any authenticated
 * participant of any conversation could therefore terminate the web process
 * with one request.
 *
 * Before the fix this file does not merely fail: the Jest worker is killed
 * mid-run, because the exit path is the same one the server takes.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  initializeParticipant,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";

describe("POST /api/v3/trashes", () => {
  let conversationId: string;
  let commentId: number;
  let participantAgent: any;

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    commentId = setup.commentIds[0];

    const participant = await initializeParticipant(conversationId);
    participantAgent = participant.agent;

    // Voting materializes the participants row that getPidForParticipant
    // requires on the trashes route.
    const vote = await submitVote(participantAgent, {
      conversation_id: conversationId,
      tid: commentId,
      vote: 0,
    });
    expect(vote.status).toBe(200);
  });

  test("answers the request and leaves the process serving", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      const response = await participantAgent.post("/api/v3/trashes").send({
        conversation_id: conversationId,
        tid: commentId,
        trashed: 1,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});

      // The insert really happened and the request really completed; now show
      // the process is still answering requests afterwards.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const stillUp = await participantAgent.get("/api/v3/testConnection");
      expect(stillUp.status).toBe(200);
      expect(stillUp.body).toEqual({ status: "ok" });

      expect(uncaught).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("a second trash for the same comment is also answered", async () => {
    // trashes keeps complete history rather than enforcing uniqueness, so this
    // is another successful insert — and another trip through the callback
    // that used to throw.
    const response = await participantAgent.post("/api/v3/trashes").send({
      conversation_id: conversationId,
      tid: commentId,
      trashed: 0,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  test("a missing trashed parameter is a 400, not a crash", async () => {
    const response = await participantAgent.post("/api/v3/trashes").send({
      conversation_id: conversationId,
      tid: commentId,
    });

    expect(response.status).toBe(400);
  });
});
