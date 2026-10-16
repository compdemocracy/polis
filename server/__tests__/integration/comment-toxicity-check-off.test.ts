import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  submitComment,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import { polisTypes } from "../../src/utils/common";

/**
 * The toxicity check is off on the comment path.
 *
 * POST /api/v3/comments used to ask the identity provider whether the
 * conversation's owner carries the delphi-enabled role and, when so, send
 * every participant statement to Gemini for a toxicity verdict that could
 * reject it. By decision that check no longer runs: a statement takes the
 * conversation's own moderation setting, whoever owns the conversation.
 *
 * The identity provider's management client and the Gemini client are
 * stubbed so that this owner carries the role and any verdict would reject
 * the statement. Neither is reached.
 */
const mockGetByEmail = jest.fn();
const mockGetRoles = jest.fn();
const mockGenerateContent = jest.fn();

jest.mock("auth0", () => ({
  ManagementClient: jest.fn().mockImplementation(() => ({
    usersByEmail: { getByEmail: mockGetByEmail },
    users: { getRoles: mockGetRoles },
  })),
}));

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
}));

describe("the toxicity check is off on the comment path", () => {
  let owner: Agent;
  let ownerUid: number;
  let conversationId: string;
  let zid: number;
  let tid: number;
  const stamp = Date.now();

  beforeAll(async () => {
    // @ts-expect-error the stub answers with the shape the handler reads
    mockGetByEmail.mockResolvedValue({ data: [{ user_id: "owner-oidc-id" }] });
    // @ts-expect-error the stub answers with the shape the handler reads
    mockGetRoles.mockResolvedValue({ data: [{ name: "delphi-enabled" }] });
    // A verdict at the rejection threshold.
    // @ts-expect-error the stub answers with the shape the handler reads
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ output: { final_score: "100" } }),
    });

    const user = getPooledTestUser(1);
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: user.email,
      hname: user.name,
      password: user.password,
    }));
    conversationId = await createConversation(owner, {
      topic: `Toxicity check off ${stamp}`,
    });
    const { rows } = await pool.query(
      "select c.zid, c.owner from conversations c join zinvites z on z.zid = c.zid where z.zinvite = $1",
      [conversationId]
    );
    zid = Number(rows[0].zid);
    ownerUid = Number(rows[0].owner);
  });

  test("the owner carries the delphi-enabled role under the stubbed identity provider", async () => {
    // Loaded here, after the stubs above exist, because the module builds its
    // management client when it loads.
    const { isProConvo } = await import("../../src/routes/comments");
    await expect(isProConvo(ownerUid)).resolves.toBe(true);
    expect(mockGetByEmail).toHaveBeenCalledTimes(1);
    expect(mockGetRoles).toHaveBeenCalledTimes(1);
    mockGetByEmail.mockClear();
    mockGetRoles.mockClear();
  });

  test("a participant's statement makes no identity-provider call and no Gemini call, and is stored active and unmoderated", async () => {
    const res = await submitComment(null, {
      conversation_id: conversationId,
      txt: `Participant statement ${stamp}`,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.tid).toBe("number");
    tid = res.body.tid;

    expect(mockGetByEmail).not.toHaveBeenCalled();
    expect(mockGetRoles).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      "select mod, active, is_seed from comments where zid = $1 and tid = $2",
      [zid, tid]
    );
    expect(rows).toEqual([
      { mod: polisTypes.mod.unmoderated, active: true, is_seed: false },
    ]);
  });

  test("the statement is served to participants, as any unmoderated statement is in this conversation", async () => {
    const list = await (
      await newAgent()
    ).get(`/api/v3/comments?conversation_id=${conversationId}`);
    expect(list.status).toBe(200);
    expect(list.body.map((c: { tid: number }) => c.tid)).toContain(tid);
  });
});
