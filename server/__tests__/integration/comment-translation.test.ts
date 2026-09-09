import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import request, { Agent } from "supertest";
import { getApp } from "../app-loader";
import { createConversation, getOidcToken } from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool, closePool } from "../setup/db-test-helpers";

const mockDetect = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("@google-cloud/translate", () => ({
  v2: {
    Translate: jest.fn().mockImplementation(() => ({ detect: mockDetect })),
  },
}));
// Enable the stub without creating a credential file or using a Google identity.
jest.mock("../../src/config", () => {
  const actual =
    jest.requireActual<typeof import("../../src/config")>("../../src/config");
  return {
    __esModule: true,
    ...actual,
    default: { ...actual.default, shouldUseTranslationAPI: true },
  };
});

describe("POST comments with unavailable language detection", () => {
  let agent: Agent;
  beforeAll(async () => {
    const app = await getApp();
    agent = request.agent(app);
    const token = await getOidcToken(getPooledTestUser(1));
    agent.set("Authorization", `Bearer ${token}`);
  });
  beforeEach(() => {
    mockDetect.mockReset();
  });
  afterAll(async () => {
    await closePool();
  });

  test.each(["rejection", "malformed", "timeout", "success"])(
    "%s preserves a durable seed comment and default vote",
    async (scenario) => {
      if (scenario === "rejection")
        mockDetect.mockRejectedValue(
          new Error("synthetic provider unavailable")
        );
      else if (scenario === "malformed") mockDetect.mockResolvedValue([]);
      else if (scenario === "timeout")
        mockDetect.mockReturnValue(new Promise(() => undefined));
      else
        mockDetect.mockResolvedValue([
          { language: "en", confidence: 0.75 },
          {},
        ]);

      const conversationId = await createConversation(agent, {
        is_active: true,
      });
      const txt = `Synthetic translation ${scenario}`;
      const response = await agent
        .post("/api/v3/comments")
        .send({ conversation_id: conversationId, txt, is_seed: true });
      expect(response.status).toBe(200);
      expect(response.body.tid).toEqual(expect.any(Number));
      expect(mockDetect).toHaveBeenCalledWith(txt);

      const { rows } = await pool.query(
        `SELECT c.txt, c.lang, c.lang_confidence, c.is_seed, v.vote
       FROM comments c JOIN zinvites z ON z.zid = c.zid
       LEFT JOIN votes v ON v.zid = c.zid AND v.tid = c.tid AND v.pid = c.pid
       WHERE z.zinvite = $1 AND c.tid = $2`,
        [conversationId, response.body.tid]
      );
      expect(rows).toEqual([
        {
          txt,
          lang: scenario === "success" ? "en" : null,
          lang_confidence: scenario === "success" ? 0.75 : null,
          is_seed: true,
          vote: 0,
        },
      ]);
    }
  );
});
