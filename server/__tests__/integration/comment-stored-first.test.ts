import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
  submitComment,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import Config from "../../src/config";
import { polisTypes } from "../../src/utils/common";
import { WIRE_AGREE } from "../../src/votes/convention";

/**
 * A participant's statement is stored first; moderation comes after it.
 *
 * POST /api/v3/comments makes no moderation call. It sets `mod` and `active`
 * locally (a moderator's statement is approved on arrival; anyone else's is
 * stored unmoderated, `mod` 0, `active` true), stores the statement and
 * answers. The one outside call before the INSERT is language detection, which
 * is bounded and optional. Moderation is a moderator's later
 * PUT /api/v3/comments.
 *
 * Whether a stored statement is shown is decided when it is read, by the
 * conversation's setting:
 *   - strict moderation (the owner approves statements in): only `mod` 1 is
 *     shown, so a new statement stays hidden from every participant, its
 *     author included, until a moderator approves it;
 *   - otherwise: anything but `mod` -1 is shown, so a new statement is shown
 *     as soon as it is stored and a moderator can hide it afterwards.
 *
 * These tests pin that ordering:
 *   (a) the statement answers within a bound while the language provider
 *       hangs, and the hung wait holds no database connection that a vote or
 *       nextComment from another participant needs;
 *   (b) under strict moderation it is stored pending, even with the provider
 *       down, and no participant read returns it until a moderator approves it;
 *   (c) otherwise it is shown at once, and a moderator can hide it later;
 *   (d) a moderator's decision made after the response is what readers then
 *       get (the approval in (b), the rejection in (c)).
 */

const mockDetect = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("@google-cloud/translate", () => ({
  v2: {
    Translate: jest.fn().mockImplementation(() => ({ detect: mockDetect })),
  },
}));
// Turn language detection on against the stub above, with no credential file
// and no Google identity.
jest.mock("../../src/config", () => {
  const actual =
    jest.requireActual<typeof import("../../src/config")>("../../src/config");
  return {
    __esModule: true,
    ...actual,
    default: { ...actual.default, shouldUseTranslationAPI: true },
  };
});

// The read-write pool's size, computed as server/src/db/pg-query.ts computes
// it. The guard sends more waiting statements than the pool has connections, so
// if any statement held a connection across the provider wait, the vote and
// nextComment below would have none.
const POOL_SIZE = Config.isDevMode
  ? 2
  : Config.databaseURL !== Config.readOnlyDatabaseURL
  ? 3
  : 12;
const WAITING_STATEMENTS = POOL_SIZE + 2;
// A statement must answer within this while the provider hangs: the detection
// cap plus room for a loaded machine, and under the 10 s a browser waits.
const ANSWER_BUDGET_MS = 8000;
// A vote and nextComment must answer within this while statements wait on the
// provider. A connection held across that wait would make them take nearly the
// whole detection cap.
const PROMPT_MS = 3000;

type Timed<T> = { ms: number; at: number; value: T };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed<T>(work: Promise<T>): Promise<Timed<T>> {
  const started = Date.now();
  const value = await work;
  const at = Date.now();
  return { ms: at - started, at, value };
}

/** The work's result if it settles within capMs, else "waiting". */
async function within<T>(
  work: Promise<T>,
  capMs: number
): Promise<T | "waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), capMs);
  });
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check: () => boolean, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

const tidsOf = (rows: Array<{ tid: number }>) => rows.map((c) => c.tid);

describe("a statement is stored first and moderated after", () => {
  let owner: Agent;
  let guardId: string;
  let strictId: string;
  let openId: string;
  const zids: Record<string, number> = {};
  const seeds: Record<string, number> = {};
  const stamp = Date.now();

  async function storedRow(conversationId: string, tid: number) {
    const { rows } = await pool.query(
      "select mod, active, lang, lang_confidence from comments where zid = $1 and tid = $2",
      [zids[conversationId], tid]
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /** A fresh participant who has voted on the owner's seed, so the seed is
   * the only statement nextComment would otherwise have left to offer. */
  async function readerWhoVotedOnTheSeed(
    conversationId: string
  ): Promise<Agent> {
    const reader = await newAgent();
    const voted = await submitVote(reader, {
      conversation_id: conversationId,
      tid: seeds[conversationId],
      vote: WIRE_AGREE,
    });
    expect(voted.status).toBe(200);
    return reader;
  }

  async function participantReads(
    reader: Agent,
    conversationId: string,
    tid: number
  ) {
    const list = await reader.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );
    expect(list.status).toBe(200);
    const paged = await reader.get(
      `/api/v3/comments?conversation_id=${conversationId}&limit=50`
    );
    expect(paged.status).toBe(200);
    // The paginated total counts the same statements the page returns.
    expect(paged.body.pagination.total).toBe(paged.body.comments.length);
    const next = await reader.get(
      `/api/v3/nextComment?conversation_id=${conversationId}`
    );
    expect(next.status).toBe(200);
    return {
      inList: tidsOf(list.body).includes(tid),
      inPage: tidsOf(paged.body.comments).includes(tid),
      offeredNext: next.body.tid === tid,
      nextTid: next.body.tid,
    };
  }

  const moderate = (conversationId: string, tid: number, mod: number) =>
    owner.put("/api/v3/comments").send({
      conversation_id: conversationId,
      tid,
      active: true,
      mod,
      is_meta: false,
      velocity: 1,
    });

  async function moderationQueue(conversationId: string): Promise<number[]> {
    const queue = await owner.get(
      `/api/v3/comments?conversation_id=${conversationId}&moderation=true&mod=${polisTypes.mod.unmoderated}`
    );
    expect(queue.status).toBe(200);
    return tidsOf(queue.body);
  }

  /** A conversation with one approved seed from its owner. */
  async function conversationWithSeed(
    name: string,
    strict_moderation = false
  ): Promise<string> {
    const conversationId = await createConversation(owner, {
      topic: `Stored first, ${name} ${stamp}`,
      strict_moderation,
    });
    const { rows } = await pool.query(
      "select zid from zinvites where zinvite = $1",
      [conversationId]
    );
    zids[conversationId] = Number(rows[0].zid);
    const seed = await submitComment(owner, {
      conversation_id: conversationId,
      txt: `Owner seed ${name} ${stamp}`,
      is_seed: true,
    });
    expect(seed.status).toBe(200);
    seeds[conversationId] = seed.body.tid;
    return conversationId;
  }

  beforeAll(async () => {
    mockDetect.mockResolvedValue([{ language: "en", confidence: 0.75 }]);
    const user = getPooledTestUser(1);
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: user.email,
      hname: user.name,
      password: user.password,
    }));
    guardId = await conversationWithSeed("guard");
    strictId = await conversationWithSeed("strict", true);
    openId = await conversationWithSeed("open");
  });

  beforeEach(() => {
    mockDetect.mockReset();
  });

  test("(a) statements answer while the language provider hangs, and the wait holds no connection a vote or nextComment needs", async () => {
    // Each waiting statement goes to a conversation of its own, and its author
    // joins first, so what is timed below is the statement alone. (Statements
    // inserted at the same instant into one conversation can collide on the
    // per-conversation statement number; that is not what this guards.)
    mockDetect.mockResolvedValue([{ language: "en", confidence: 0.75 }]);
    const waiting: Array<{ conversationId: string; author: Agent }> = [];
    for (let i = 0; i < WAITING_STATEMENTS; i++) {
      const conversationId = await conversationWithSeed(`waiting ${i}`);
      waiting.push({
        conversationId,
        author: await readerWhoVotedOnTheSeed(conversationId),
      });
    }

    // The provider never answers from here on.
    mockDetect.mockReset();
    mockDetect.mockImplementation(() => new Promise(() => undefined));

    const posts = waiting.map(({ conversationId, author }) =>
      timed(
        submitComment(author, {
          conversation_id: conversationId,
          txt: `Waiting on the language provider ${stamp}`,
        }).then((response) => ({ conversationId, response }))
      )
    );

    // At least a pool's worth of statements is now waiting on the provider.
    expect(
      await until(() => mockDetect.mock.calls.length >= POOL_SIZE, 5000)
    ).toBe(true);

    const voter = await newAgent();
    const vote = await within(
      timed(
        submitVote(voter, {
          conversation_id: guardId,
          tid: seeds[guardId],
          vote: WIRE_AGREE,
        })
      ),
      PROMPT_MS
    );
    expect(vote).not.toBe("waiting");
    const next = await within(
      timed(voter.get(`/api/v3/nextComment?conversation_id=${guardId}`)),
      PROMPT_MS
    );
    expect(next).not.toBe("waiting");

    const answered = await within(Promise.all(posts), ANSWER_BUDGET_MS);
    expect(answered).not.toBe("waiting");
    if (vote === "waiting" || next === "waiting" || answered === "waiting")
      return;

    expect(vote.value.status).toBe(200);
    expect(next.value.status).toBe(200);
    // Both answered while every statement was still waiting on the provider.
    const firstAnswer = Math.min(...answered.map((p) => p.at));
    expect(vote.at).toBeLessThan(firstAnswer);
    expect(next.at).toBeLessThan(firstAnswer);

    expect(mockDetect).toHaveBeenCalledTimes(WAITING_STATEMENTS);
    for (const post of answered) {
      const { conversationId, response } = post.value;
      expect(response.status).toBe(200);
      expect(typeof response.body.tid).toBe("number");
      expect(post.ms).toBeLessThan(ANSWER_BUDGET_MS);
      // Stored, unmoderated, without language metadata.
      expect(await storedRow(conversationId, response.body.tid)).toEqual({
        mod: polisTypes.mod.unmoderated,
        active: true,
        lang: null,
        lang_confidence: null,
      });
    }
  }, 60000);

  test("(b) strict moderation: stored pending even with the provider down, and no participant read returns it until a moderator approves it", async () => {
    mockDetect.mockRejectedValue(new Error("language provider unavailable"));

    const posted = await submitComment(null, {
      conversation_id: strictId,
      txt: `Waiting for approval ${stamp}`,
    });
    expect(posted.status).toBe(200);
    const tid: number = posted.body.tid;
    expect(typeof tid).toBe("number");
    expect(await storedRow(strictId, tid)).toEqual({
      mod: polisTypes.mod.unmoderated,
      active: true,
      lang: null,
      lang_confidence: null,
    });

    // Hidden from another participant: the list, the paginated list and
    // nextComment.
    const reader = await readerWhoVotedOnTheSeed(strictId);
    expect(await participantReads(reader, strictId, tid)).toEqual({
      inList: false,
      inPage: false,
      offeredNext: false,
      nextTid: undefined,
    });

    // A link straight to the statement does not reveal it either.
    const direct = await reader.get(
      `/api/v3/nextComment?conversation_id=${strictId}&initial_tid=${tid}`
    );
    expect(direct.status).toBe(200);
    expect(direct.body.initialStatus).toBe("unavailable");
    expect(direct.body.tid).toBeUndefined();

    // Nor is it offered to its author.
    const author = await newAgent();
    setAgentJwt(author, posted.body.auth.token);
    const authorNext = await author.get(
      `/api/v3/nextComment?conversation_id=${strictId}`
    );
    expect(authorNext.status).toBe(200);
    expect(authorNext.body.tid).not.toBe(tid);

    // The owner sees it waiting in the moderation queue.
    expect(await moderationQueue(strictId)).toContain(tid);

    // (d) The approval, made after the response, is what readers then get.
    expect((await moderate(strictId, tid, polisTypes.mod.ok)).status).toBe(200);
    expect(await participantReads(reader, strictId, tid)).toEqual({
      inList: true,
      inPage: true,
      offeredNext: true,
      nextTid: tid,
    });
    expect(await moderationQueue(strictId)).not.toContain(tid);
  }, 20000);

  test("(c) without strict moderation: shown as soon as it is stored, and a moderator can hide it afterwards", async () => {
    mockDetect.mockResolvedValue([{ language: "en", confidence: 0.75 }]);

    const posted = await submitComment(null, {
      conversation_id: openId,
      txt: `Shown on arrival ${stamp}`,
    });
    expect(posted.status).toBe(200);
    const tid: number = posted.body.tid;
    expect(typeof tid).toBe("number");
    expect(await storedRow(openId, tid)).toEqual({
      mod: polisTypes.mod.unmoderated,
      active: true,
      lang: "en",
      lang_confidence: 0.75,
    });

    const reader = await readerWhoVotedOnTheSeed(openId);
    expect(await participantReads(reader, openId, tid)).toEqual({
      inList: true,
      inPage: true,
      offeredNext: true,
      nextTid: tid,
    });
    // Shown, and also waiting in the owner's moderation queue.
    expect(await moderationQueue(openId)).toContain(tid);

    // (d) The rejection, made after the response, is what readers then get.
    expect((await moderate(openId, tid, polisTypes.mod.ban)).status).toBe(200);
    expect(await participantReads(reader, openId, tid)).toEqual({
      inList: false,
      inPage: false,
      offeredNext: false,
      nextTid: undefined,
    });
  }, 20000);
});
