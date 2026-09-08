/**
 * Authorization tests for the data-export routes.
 *
 * GET /api/v3/dataExport/results signs a 7-day S3 URL for a conversation's full
 * data dump. It used to build the object key by concatenating the caller's
 * `filename` onto the math-env prefix and never looked at the conversation the
 * request had resolved, so any caller holding any valid token could exchange
 * another conversation's export filename for a signed URL to that
 * conversation's data. It now requires ownership of the resolved conversation,
 * and derives the key from that conversation's zinvite plus the validated
 * pieces of the filename.
 *
 * GET /api/v3/dataExport is the trigger for that same export. It likewise had
 * authentication but no owner check, so any token holder could enqueue a
 * generate_export_data task against any conversation — choosing the
 * `unixTimestamp` that becomes part of the resulting object's name — and have
 * the completion email sent to their own address. It now takes the same
 * ownership gate.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
  setupAuthAndConvo,
  type TestUser,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

describe("data export authorization", () => {
  let ownerConversationId: string;
  let strangerConversationId: string;
  let ownerAgent: any;
  let strangerAgent: any;
  let anonAgent: any;

  // The export worker names dumps polis-export-<conversation_id>-<millis>.zip
  const exportTimestamp = 1758000000000;
  let ownerFilename: string;

  beforeAll(async () => {
    // Owner: pooled user 1, owns the conversation whose export is at stake.
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 1,
    });
    ownerConversationId = convo.conversationId;
    ownerFilename = `polis-export-${ownerConversationId}-${exportTimestamp}.zip`;

    const { agent } = await getJwtAuthenticatedAgent(convo.testUser);
    ownerAgent = agent;

    // Stranger: pooled user 2, authenticated, with a conversation of their own
    // so they can pass a conversation_id they legitimately own.
    const pooled = getPooledTestUser(2);
    const strangerUser: TestUser = {
      email: pooled.email,
      hname: pooled.name,
      password: pooled.password,
    } as TestUser;
    const { agent: strangerJwtAgent, token: strangerToken } =
      await getJwtAuthenticatedAgent(strangerUser);
    strangerConversationId = await createConversation(strangerJwtAgent, {
      topic: "Stranger's own conversation",
      description: "Used to supply a conversation_id the stranger owns",
    });
    strangerAgent = await newAgent();
    setAgentJwt(strangerAgent, strangerToken);

    // Unauthenticated caller: no Authorization header at all.
    anonAgent = await newAgent();
  });

  describe("GET /api/v3/dataExport/results", () => {
    test("unauthenticated caller is rejected with 401", async () => {
      const response = await anonAgent.get(
        `/api/v3/dataExport/results?conversation_id=${ownerConversationId}&filename=${ownerFilename}`
      );

      expect(response.status).toBe(401);
    });

    test("authenticated non-owner is rejected with 403", async () => {
      const response = await strangerAgent.get(
        `/api/v3/dataExport/results?conversation_id=${ownerConversationId}&filename=${ownerFilename}`
      );

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_data_export_results_auth"
      );
    });

    test("a filename for another conversation does not yield a signed URL", async () => {
      // The exact pre-fix exploit: the caller passes a conversation_id they do
      // own, so any ownership check on that parameter alone passes, and asks
      // for a different conversation's export by name.
      const response = await strangerAgent.get(
        `/api/v3/dataExport/results?conversation_id=${strangerConversationId}&filename=${ownerFilename}`
      );

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_data_export_results_conversation"
      );
      expect(response.headers.location).toBeUndefined();
    });

    test("path traversal in the filename is rejected with 400", async () => {
      const response = await ownerAgent.get(
        `/api/v3/dataExport/results?conversation_id=${ownerConversationId}&filename=${encodeURIComponent(
          "../../../etc/passwd"
        )}`
      );

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_data_export_results_filename_invalid"
      );
      expect(response.headers.location).toBeUndefined();
    });

    test("a traversal suffix on an otherwise valid name is rejected with 400", async () => {
      const response = await ownerAgent.get(
        `/api/v3/dataExport/results?conversation_id=${ownerConversationId}&filename=${encodeURIComponent(
          `${ownerFilename}/../../prod/secrets`
        )}`
      );

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_data_export_results_filename_invalid"
      );
    });

    test("a missing filename is rejected with 400 rather than signing a key", async () => {
      const response = await ownerAgent.get(
        `/api/v3/dataExport/results?conversation_id=${ownerConversationId}`
      );

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_data_export_results_filename_missing"
      );
    });

    test("the owner gets a signed URL for their own conversation's export", async () => {
      const response = await ownerAgent
        .get(
          `/api/v3/dataExport/results?conversation_id=${ownerConversationId}&filename=${ownerFilename}`
        )
        .redirects(0);

      expect(response.status).toBe(302);

      const location = response.headers.location as string;
      expect(location).toBeDefined();
      expect(location).toContain("polis-datadump");
      // The key is the one the export worker would have written for THIS
      // conversation, and the URL is signed.
      expect(location).toContain(
        `polis-export-${ownerConversationId}-${exportTimestamp}.zip`
      );
      expect(location).toMatch(/Signature|X-Amz-Signature/);
    });
  });

  describe("GET /api/v3/dataExport (export trigger)", () => {
    const unixTimestamp = 1758000000;

    test("unauthenticated caller is rejected with 401", async () => {
      const response = await anonAgent.get(
        `/api/v3/dataExport?conversation_id=${ownerConversationId}&unixTimestamp=${unixTimestamp}&format=csv`
      );

      expect(response.status).toBe(401);
    });

    test("authenticated non-owner is rejected with 403 and enqueues nothing", async () => {
      // Pre-fix, this enqueued a generate_export_data task for the owner's
      // conversation, named by a timestamp of the caller's choosing, and mailed
      // the download link to the caller.
      const response = await strangerAgent.get(
        `/api/v3/dataExport?conversation_id=${ownerConversationId}&unixTimestamp=${unixTimestamp}&format=csv`
      );

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_data_export_auth"
      );
    });

    test("the owner can still trigger an export of their own conversation", async () => {
      const response = await ownerAgent.get(
        `/api/v3/dataExport?conversation_id=${ownerConversationId}&unixTimestamp=${unixTimestamp}&format=csv`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });
  });
});
