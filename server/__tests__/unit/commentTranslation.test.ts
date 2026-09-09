// Exercise the real language helpers and POST handlers with a stubbed provider.
// No provider, database, auth service or app startup is involved.
const mockDetect = jest.fn();
const mockTranslate = jest.fn();
const mockQuery = jest.fn();
const mockWarn = jest.fn();
const mockVote = jest.fn();

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
}));
jest.mock("../../src/utils/moderation", () => ({}));
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
  const done = handle_POST_comments(
    {
      p: { zid: 7, uid: 11, pid: 0, txt: "A synthetic comment", is_seed: seed },
      headers: {},
    },
    res
  );
  return { res, done };
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
      const err = new Error("synthetic provider authentication failure");
      mockDetect.mockRejectedValue(err);
      const { res, done } = post(seed);
      await done;
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
          headers: { "x-synthetic-private-header": "must not be logged" },
        },
      });
      mockDetect.mockRejectedValue(err);
      const { res, done } = post();
      await done;
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

  test("hung detection stops waiting at five seconds and observes late rejection", async () => {
    let rejectProvider: (e: Error) => void;
    mockDetect.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectProvider = reject;
      })
    );
    const { res, done } = post();
    await jest.advanceTimersByTimeAsync(4999);
    expect(res.json).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await done;
    expectCreated(res);
    rejectProvider!(new Error("late provider failure"));
    await jest.advanceTimersByTimeAsync(0);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test("successful detection preserves metadata and clears its timer", async () => {
    const result = [
      { language: "ja", confidence: 1 },
      { provider: "response" },
    ];
    mockDetect.mockResolvedValue(result);
    expect(await detectLanguage("synthetic")).toBe(result);
    expect(jest.getTimerCount()).toBe(0);
    const { res, done } = post();
    await done;
    expectCreated(res, "ja", 1);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockVote).toHaveBeenCalledWith(11, 0, 7, 3, 0, 0, false);
  });

  test("a synchronous provider throw also falls back", async () => {
    mockDetect.mockImplementation(() => {
      throw new Error("sync provider failure");
    });
    expect(await detectLanguage("synthetic")).toEqual(nullDetection);
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
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "polis_err_post_comment" })
    );
  });

  test("bulk seed upload also survives provider rejection", async () => {
    mockDetect.mockRejectedValue(new Error("provider failure"));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handle_POST_comments_bulk(
      {
        p: { zid: 7, uid: 11, pid: 0, is_seed: true },
        body: {
          csv: "comment_text,original_id\nA synthetic seed,00000000-0000-4000-8000-000000000001",
        },
      },
      res
    );
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
          txt: "A synthetic seed",
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
    const err = new Error("synthetic translation failure");
    mockTranslate.mockRejectedValue(err);
    expect(await translateAndStoreComment(7, 3, "synthetic", "fr")).toBeNull();
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
    expect(await translateAndStoreComment(7, 3, "synthetic", "fr")).toBeNull();
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
    const done = translateAndStoreComment(7, 3, "synthetic", "fr");
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
    expect(await translateAndStoreComment(7, 3, "synthetic", "fr")).toBe(row);
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
      translateAndStoreComment(7, 3, "synthetic", "fr")
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
        detectionResult = helpers.detectLanguage("synthetic");
        translationResult = helpers.translateAndStoreComment(
          7,
          3,
          "synthetic",
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
