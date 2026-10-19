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
    "%s preserves a durable seed comment, which records no vote",
    async (scenario) => {
      let resolveDetection: (value: unknown) => void;
      if (scenario === "rejection")
        mockDetect.mockRejectedValue(
          new Error("public-fixture provider unavailable")
        );
      else if (scenario === "malformed") mockDetect.mockResolvedValue([]);
      else if (scenario === "timeout")
        mockDetect.mockReturnValue(new Promise(() => undefined));
      else
        mockDetect.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveDetection = resolve;
            })
        );

      const conversationId = await createConversation(agent, {
        is_active: true,
      });
      const txt = `Public-fixture translation ${scenario}`;
      const started = Date.now();
      const response = await agent
        .post("/api/v3/comments")
        .send({ conversation_id: conversationId, txt, is_seed: true });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(response.status).toBe(200);
      expect(response.body.tid).toEqual(expect.any(Number));
      expect(mockDetect).toHaveBeenCalledWith(txt);

      const read = async () =>
        (
          await pool.query(
            `SELECT c.txt, c.lang, c.lang_confidence, c.is_seed, v.vote
       FROM comments c JOIN zinvites z ON z.zid = c.zid
       LEFT JOIN votes v ON v.zid = c.zid AND v.tid = c.tid AND v.pid = c.pid
       WHERE z.zinvite = $1 AND c.tid = $2`,
            [conversationId, response.body.tid]
          )
        ).rows;
      const rows = await read();
      expect(rows).toEqual([
        {
          txt,
          lang: null,
          lang_confidence: null,
          is_seed: true,
          // The LEFT JOIN finds no vote row: a seed gets no automatic vote.
          vote: null,
        },
      ]);
      if (scenario === "success") {
        resolveDetection!([{ language: "en", confidence: 0.75 }, {}]);
        const deadline = Date.now() + 3000;
        let enriched = await read();
        while (enriched[0].lang === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          enriched = await read();
        }
        expect(enriched).toEqual([
          { ...rows[0], lang: "en", lang_confidence: 0.75 },
        ]);
      }
    }
  );
});
