/**
 * Regression tests for the two routes that never answered at all.
 *
 * POST /api/v3/votes-bulk threw `new Error("Unauthorized")` at the top of an
 * async handler, outside its own try/catch. Express 3.21.2 invokes a route
 * callback and moves on (express/lib/router/index.js:164) — it neither awaits
 * the returned promise nor attaches a catch — so nothing was ever written to
 * the response and the rejection surfaced on the process instead.
 *
 * POST /api/v3/conversation/close fired the UPDATE and returned without
 * touching `res` on its only success path, so the owner's request hung.
 * Its sibling handle_POST_conversation_reopen answers 200 {}.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";

describe("routes that used to hang", () => {
  let ownerAgent: any;
  let conversationId: string;

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    const { agent } = await getJwtAuthenticatedAgent(setup.testUser);
    ownerAgent = agent;
  });

  test("POST /api/v3/votes-bulk answers when delphi is not enabled", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      // The pooled test users are not in the simulator's delphi_enabled list
      // (oidc-simulator/rules/add-custom-claims.js), so req.p.delphiEnabled is
      // falsy — the branch that used to throw outside the try.
      const response = await ownerAgent
        .post("/api/v3/votes-bulk")
        .timeout({ response: 10000, deadline: 15000 })
        .send({
          conversation_id: conversationId,
          csv: "comment-id,participant-id,vote\n1,1,1\n",
        });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_votes_bulk_delphi_disabled"
      );

      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("POST /api/v3/conversation/close answers 200 and really closes", async () => {
    const response = await ownerAgent
      .post("/api/v3/conversation/close")
      .timeout({ response: 10000, deadline: 15000 })
      .send({ conversation_id: conversationId });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    const after = await ownerAgent.get(
      `/api/v3/conversations?conversation_id=${conversationId}`
    );
    expect(after.status).toBe(200);
    const conversation = Array.isArray(after.body) ? after.body[0] : after.body;
    expect(conversation.is_active).toBe(false);
  });

  test("POST /api/v3/conversation/close answers for an unknown conversation too", async () => {
    const response = await ownerAgent
      .post("/api/v3/conversation/close")
      .timeout({ response: 10000, deadline: 15000 })
      .send({ conversation_id: "p029nosuchconvo" });

    // A conversation the caller does not own resolves to no rows; the route
    // already answered on that path and must keep doing so.
    expect([400, 500]).toContain(response.status);
  });
});
