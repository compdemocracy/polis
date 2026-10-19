// Exercise the real language helpers and POST handlers with a stubbed provider.
// No provider, database, auth service or app startup is involved.
const mockDetect = jest.fn();
const mockTranslate = jest.fn();
const mockQuery = jest.fn();
const mockWarn = jest.fn();
const mockVote = jest.fn();
import {
  onParticipationPath,
  onParticipationPools,
} from "../../src/db/participation-scope";

jest.mock("@google-cloud/translate", () => ({
  v2: {
    Translate: jest.fn().mockImplementation(() => ({
      detect: mockDetect,
      translate: mockTranslate,
    })),
  },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { shouldUseTranslationAPI: true },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: mockQuery },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: mockWarn,
  },
}));
jest.mock("../../src/conversation", () => ({
  getConversationInfo: jest.fn().mockResolvedValue({
    owner: 11,
    is_active: true,
    strict_moderation: false,
  }),
}));
jest.mock("../../src/user", () => ({
  getPidPromise: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../src/participant", () => ({ addParticipant: jest.fn() }));
jest.mock("../../src/utils/common", () => ({
  isModerator: jest.fn().mockResolvedValue(true),
  polisTypes: { mod: { ok: 1 } },
}));
jest.mock("../../src/routes/votes", () => ({ votesPost: mockVote }));
jest.mock("../../src/server-helpers", () => ({
  safeTimestampToMillis: (n: number) => n,
  updateConversationModifiedTime: jest.fn(),
  updateLastInteractionTimeForConversation: jest.fn(),
  updateVoteCount: jest.fn(),
}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/utils/metered", () => ({}));
jest.mock("../../src/nextComment", () => ({}));
jest.mock("auth0", () => ({ ManagementClient: jest.fn() }));

const {
  detectLanguage,
  translateAndStoreComment,
} = require("../../src/comment");
const {
  handle_POST_comments,
  handle_POST_comments_bulk,
} = require("../../src/routes/comments");
const nullDetection = [{ confidence: null, language: null }];

function post(seed = true) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  let done: Promise<void>;
  onParticipationPools({}, {}, () => {
    done = handle_POST_comments(
      {
        p: {
          zid: 7,
          uid: 11,
          pid: 0,
          txt: "A public-fixture comment",
          is_seed: seed,
        },
        headers: {},
      },
      res
    );
  });
  return { res, done: done! };
}

function expectCreated(
  res: ReturnType<typeof post>["res"],
  language: string | null = null,
  confidence: number | null = null
) {
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
  const insert = mockQuery.mock.calls.find(([sql]) =>
    /INSERT INTO COMMENTS/.test(sql)
  );
  expect(insert).toBeDefined();
  expect(insert![1].slice(9, 11)).toEqual([language, confidence]);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockDetect
    .mockReset()
    .mockResolvedValue([{ language: "en", confidence: 0.9 }, {}]);
  mockTranslate.mockReset().mockResolvedValue(["A translation", {}]);
  mockVote.mockReset().mockResolvedValue(undefined);
  mockQuery.mockReset().mockImplementation(async (sql: string) => {
    if (/INSERT INTO COMMENTS/.test(sql))
      return [{ tid: 3, created: 10000000000000 }];
    return [];
  });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("comment creation during translation failures", () => {
  test.each([true, false])(
    "provider rejection preserves comment creation (seed=%s)",
    async (seed) => {
      const err = new Error("public-fixture provider authentication failure");
      mockDetect.mockRejectedValue(err);
      const { res, done } = post(seed);
      await done;
      await jest.advanceTimersByTimeAsync(0);
      expectCreated(res);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        "polis_warn_language_detection_failed",
        expect.objectContaining({ message: err.message })
      );
    }
  );

  test.each(
    [
      null,
      undefined,
      [],
      [null],
      [{}],
      ["en"],
      [{ language: "", confidence: 0.9 }],
      [{ language: " ", confidence: 0.9 }],
      [{ language: "too-long-language", confidence: 0.9 }],
      [{ language: "en\0", confidence: 0.9 }],
      [{ language: 1, confidence: 0.9 }],
      [{ language: "en", confidence: "0.9" }],
      [{ language: "en", confidence: NaN }],
      [{ language: "en", confidence: Infinity }],
      [{ language: "en", confidence: -0.1 }],
      [{ language: "en", confidence: 1.1 }],
    ].map((value) => [value])
  )("malformed detection %p preserves creation", async (value) => {
    mockDetect.mockResolvedValue(value);
    const { res, done } = post();
    await done;
    await jest.advanceTimersByTimeAsync(0);
    expectCreated(res);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test.each([403, 429])(
    "quota error %s creates the comment without retrying or logging response headers",
    async (code) => {
      const err = Object.assign(new Error("User Rate Limit Exceeded"), {
        name: "ApiError",
        code,
        errors: [
          {
            domain: "usageLimits",
            reason: "userRateLimitExceeded",
            message: "User Rate Limit Exceeded",
          },
        ],
        response: {
          headers: { "x-public-fixture-private-header": "must not be logged" },
        },
      });
      mockDetect.mockRejectedValue(err);
      const { res, done } = post();
      await done;
      await jest.advanceTimersByTimeAsync(0);
      expectCreated(res);
      expect(mockDetect).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        "polis_warn_language_detection_failed",
        {
          name: "ApiError",
          message: "User Rate Limit Exceeded",
          code,
          reason: "userRateLimitExceeded",
        }
      );
      expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(
        "must not be logged"
      );
    }
  );

  test("hung detection cannot delay storing or accepting the comment", async () => {
    let rejectProvider: (e: Error) => void;
    mockDetect.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectProvider = reject;
      })
    );
    const { res, done } = post();
    await jest.advanceTimersByTimeAsync(0);
    expectCreated(res);
    await done;
    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(
      mockQuery.mock.calls.some(([sql]) => /UPDATE comments SET lang/.test(sql))
    ).toBe(false);
    // The existing provider timeout still bounds background detection.
    await jest.advanceTimersByTimeAsync(5000);
    rejectProvider!(new Error("late provider failure"));
    await jest.advanceTimersByTimeAsync(0);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test("language arrives after storage on non-participation connections", async () => {
    let resolveProvider: (value: unknown) => void;
    const scopes: Array<[string, boolean]> = [];
    let providerInParticipation: boolean | undefined;
    let providerStartedAfterInsert = false;
    mockDetect.mockImplementation(() => {
      providerInParticipation = onParticipationPath();
      providerStartedAfterInsert = mockQuery.mock.calls.some(([sql]) =>
        /INSERT INTO COMMENTS/.test(sql)
      );
      return new Promise((resolve) => {
        resolveProvider = resolve;
      });
    });
    mockQuery.mockImplementation(async (sql: string) => {
      scopes.push([sql, onParticipationPath()]);
      return /INSERT INTO COMMENTS/.test(sql)
        ? [{ tid: 3, created: 10000000000000 }]
        : [];
    });
    const { res, done } = post();
    await jest.advanceTimersByTimeAsync(0);
    expectCreated(res);
    await done;
    expect(scopes.find(([sql]) => /INSERT INTO COMMENTS/.test(sql))![1]).toBe(
      true
    );
    expect(providerInParticipation).toBe(false);
    expect(providerStartedAfterInsert).toBe(true);
    resolveProvider!([{ language: "ja", confidence: 0.95 }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE comments SET lang"),
      [7, 3, "ja", 0.95, "A public-fixture comment"]
    );
    expect(
      scopes.find(([sql]) => /UPDATE comments SET lang/.test(sql))![1]
    ).toBe(false);
    const update = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE comments SET lang/.test(sql)
    )![0];
    expect(update).toContain("txt = $5 AND lang IS NULL");
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  test("metadata write failure cannot change an accepted comment", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/UPDATE comments SET lang/.test(sql))
        throw new Error("metadata unavailable");
      return /INSERT INTO COMMENTS/.test(sql)
        ? [{ tid: 3, created: 10000000000000 }]
        : [];
    });
    const { res, done } = post();
    await done;
    await jest.advanceTimersByTimeAsync(0);
    expectCreated(res);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      "polis_warn_language_metadata_store_failed",
      expect.any(Object)
    );
  });

  test("successful detection preserves metadata and clears its timer", async () => {
    const result = [
      { language: "ja", confidence: 1 },
      { provider: "response" },
    ];
    mockDetect.mockResolvedValue(result);
    expect(await detectLanguage("public-fixture")).toBe(result);
    expect(jest.getTimerCount()).toBe(0);
    const { res, done } = post();
    await done;
    await jest.advanceTimersByTimeAsync(0);
    expectCreated(res);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE comments SET lang"),
      [7, 3, "ja", 1, "A public-fixture comment"]
    );
    expect(mockWarn).not.toHaveBeenCalled();
    // A seed gets no automatic vote, and this request carries none.
    expect(mockVote).not.toHaveBeenCalled();
  });

  test("a synchronous provider throw also falls back", async () => {
    mockDetect.mockImplementation(() => {
      throw new Error("sync provider failure");
    });
    expect(await detectLanguage("public-fixture")).toEqual(nullDetection);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test("database insertion failure still fails the POST", async () => {
    mockDetect.mockRejectedValue(new Error("provider failure"));
    mockQuery.mockImplementation(async (sql: string) => {
      if (/INSERT INTO COMMENTS/.test(sql)) throw new Error("database failure");
      return [];
    });
    const { res, done } = post();
    await done;
    await jest.advanceTimersByTimeAsync(0);
    expect(mockDetect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "polis_err_post_comment" })
    );
  });

  test("concurrent uploads and single comments share four detection slots", async () => {
    let active = 0;
    let maximum = 0;
    const scopes: boolean[] = [];
    const pending: Array<(fail?: boolean) => void> = [];
    mockDetect.mockImplementation(() => {
      active += 1;
      maximum = Math.max(maximum, active);
      scopes.push(onParticipationPath());
      return new Promise((resolve, reject) => {
        pending.push((fail = false) => {
          active -= 1;
          if (fail) reject(new Error("public-fixture failure"));
          else resolve([{ language: "en", confidence: 0.9 }]);
        });
      });
    });
    const upload = (offset: number) => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const rows = Array.from(
        { length: 5 },
        (_, i) =>
          `Public fixture ${offset + i},00000000-0000-4000-8000-${String(
            offset + i
          ).padStart(12, "0")}`
      );
      let done: Promise<void>;
      onParticipationPools({}, {}, () => {
        done = handle_POST_comments_bulk(
          {
            p: { zid: 7, uid: 11, pid: 0, is_seed: true },
            body: { csv: "comment_text,original_id\n" + rows.join("\n") },
          },
          res
        );
      });
      return { res, done: done! };
    };
    const a = upload(1),
      b = upload(6),
      single = post();
    await Promise.all([a.done, b.done, single.done]);
    await jest.advanceTimersByTimeAsync(0);
    for (const { res } of [a, b, single]) {
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);
    }
    expect(
      mockQuery.mock.calls.filter(([sql]) => /INSERT INTO COMMENTS/.test(sql))
    ).toHaveLength(11);
    expect(mockDetect).toHaveBeenCalledTimes(4);
    expect(active).toBe(4);
    pending.shift()!(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockDetect).toHaveBeenCalledTimes(5);
    expect(active).toBe(4);
    while (pending.length) {
      pending.shift()!();
      await jest.advanceTimersByTimeAsync(0);
      expect(active).toBeLessThanOrEqual(4);
    }
    expect(mockDetect).toHaveBeenCalledTimes(11);
    expect(maximum).toBe(4);
    expect(scopes).toEqual(Array(11).fill(false));
    expect(
      mockQuery.mock.calls.filter(([sql]) =>
        /UPDATE comments SET lang/.test(sql)
      )
    ).toHaveLength(10);
    // Let the handlers' existing 100ms conversation-update timers run too.
    await jest.advanceTimersByTimeAsync(100);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("timed-out provider calls retain slots until they actually settle", async () => {
    const pending: Array<() => void> = [];
    mockDetect.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve([{ language: "en", confidence: 0.9 }]));
        })
    );
    const requests = Array.from({ length: 6 }, () => post());
    await Promise.all(requests.map(({ done }) => done));
    await jest.advanceTimersByTimeAsync(0);
    requests.forEach(({ res }) => expectCreated(res));
    expect(mockDetect).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(10000);
    expect(mockDetect).toHaveBeenCalledTimes(4);
    expect(
      mockQuery.mock.calls.some(([sql]) => /UPDATE comments SET lang/.test(sql))
    ).toBe(false);
    pending.shift()!();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockDetect).toHaveBeenCalledTimes(5);
    // The first queued request still receives its own complete provider budget.
    pending.pop()!();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockDetect).toHaveBeenCalledTimes(6);
    while (pending.length) {
      pending.shift()!();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(
      mockQuery.mock.calls.filter(([sql]) =>
        /UPDATE comments SET lang/.test(sql)
      )
    ).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("bulk upload stores every statement while detection remains pending", async () => {
    let releaseProvider: (value: unknown) => void;
    mockDetect.mockReturnValue(
      new Promise((resolve) => {
        releaseProvider = resolve;
      })
    );
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const done = handle_POST_comments_bulk(
      {
        p: { zid: 7, uid: 11, pid: 0, is_seed: true },
        body: {
          csv: "comment_text,original_id\nFirst public fixture,00000000-0000-4000-8000-000000000001\nSecond public fixture,00000000-0000-4000-8000-000000000002",
        },
      },
      res
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(res.json).toHaveBeenCalled();
    await done;
    expect(
      mockQuery.mock.calls.filter(([sql]) => /INSERT INTO COMMENTS/.test(sql))
    ).toHaveLength(2);
    expect(mockDetect).toHaveBeenCalledTimes(2);
    expect(
      mockQuery.mock.calls.some(([sql]) => /UPDATE comments SET lang/.test(sql))
    ).toBe(false);
    releaseProvider!([{ language: "en", confidence: 0.9 }]);
    await jest.advanceTimersByTimeAsync(0);
  });

  test("bulk seed upload also survives provider rejection", async () => {
    mockDetect.mockRejectedValue(new Error("provider failure"));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handle_POST_comments_bulk(
      {
        p: { zid: 7, uid: 11, pid: 0, is_seed: true },
        body: {
          csv: "comment_text,original_id\nA public-fixture seed,00000000-0000-4000-8000-000000000001",
        },
      },
      res
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(mockDetect).toHaveBeenCalled();
    const insert = mockQuery.mock.calls.find(([sql]) =>
      /INSERT INTO COMMENTS/.test(sql)
    );
    expect(insert).toBeDefined();
    expect(insert![1].slice(9, 11)).toEqual([null, null]);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      currentPid: 0,
      results: [
        {
          txt: "A public-fixture seed",
          status: "success",
          tid: 3,
          original_id: "00000000-0000-4000-8000-000000000001",
        },
      ],
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe("optional stored translations", () => {
  test("provider rejection logs once and does not write a translation", async () => {
    const err = new Error("public-fixture translation failure");
    mockTranslate.mockRejectedValue(err);
    expect(
      await translateAndStoreComment(7, 3, "public-fixture", "fr")
    ).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      "polis_warn_translation_failed",
      expect.objectContaining({ message: err.message })
    );
  });
  test.each(
    [null, [], [null], [{}], [""], [["nested"]]].map((value) => [value])
  )("invalid translation %p is not stored", async (value) => {
    mockTranslate.mockResolvedValue(value);
    expect(
      await translateAndStoreComment(7, 3, "public-fixture", "fr")
    ).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
  test("timeout does not permit a late success to write", async () => {
    let resolveProvider: (value: unknown) => void;
    mockTranslate.mockReturnValue(
      new Promise((resolve) => {
        resolveProvider = resolve;
      })
    );
    const done = translateAndStoreComment(7, 3, "public-fixture", "fr");
    await jest.advanceTimersByTimeAsync(5000);
    expect(await done).toBeNull();
    resolveProvider!(["late translation"]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("success stores the original translation and returns the database row", async () => {
    const row = { zid: 7, tid: 3, txt: "A translation", lang: "fr", src: -1 };
    mockQuery.mockResolvedValue([row]);
    expect(await translateAndStoreComment(7, 3, "public-fixture", "fr")).toBe(
      row
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("insert into comment_translations"),
      [7, 3, "A translation", "fr", -1]
    );
    expect(mockWarn).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  test("database failures remain failures", async () => {
    const err = new Error("database write failure");
    mockQuery.mockRejectedValue(err);
    await expect(
      translateAndStoreComment(7, 3, "public-fixture", "fr")
    ).rejects.toBe(err);
    expect(mockWarn).not.toHaveBeenCalled();
  });
  test("disabled translation keeps null sentinels without calling the provider", async () => {
    const config = require("../../src/config").default;
    config.shouldUseTranslationAPI = false;
    let detectionResult: Promise<unknown>;
    let translationResult: Promise<unknown>;
    try {
      jest.isolateModules(() => {
        const helpers = require("../../src/comment");
        detectionResult = helpers.detectLanguage("public-fixture");
        translationResult = helpers.translateAndStoreComment(
          7,
          3,
          "public-fixture",
          "fr"
        );
      });
      expect(await detectionResult).toEqual(nullDetection);
      expect(await translationResult).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockDetect).not.toHaveBeenCalled();
      expect(mockTranslate).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      config.shouldUseTranslationAPI = true;
    }
  });
});
