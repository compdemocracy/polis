// Real selection/translation helpers; only provider, storage and math are stubs.
const mockTranslate = jest.fn();
const mockQuery = jest.fn();
const mockComments = jest.fn();
const mockConfig = {
  shouldUseTranslationAPI: true,
  getValidTopicalRatio: () => 0,
};
jest.mock("@google-cloud/translate", () => ({
  v2: {
    Translate: jest
      .fn()
      .mockImplementation(() => ({ translate: mockTranslate })),
  },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: mockConfig,
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
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../src/utils/pca", () => ({
  getLatestExistingPca: async () => null,
}));
jest.mock("../../src/utils/commentClusters", () => ({
  getCommentIdsForClusters: async () => [3],
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: jest.fn() }));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async () => ({ Items: [{ layer_id: 0, cluster_id: 0 }] }),
    }),
  },
  QueryCommand: jest.fn(),
}));
jest.mock("../../src/conversation", () => ({}));
jest.mock("../../src/routes/comments", () => ({}));
jest.mock("../../src/comment", () => ({
  ...jest.requireActual("../../src/comment"),
  getComments: mockComments,
  getNumberOfCommentsRemaining: async () => [{ total: 1, remaining: 1 }],
}));

let getNextComment: typeof import("../../src/nextComment").getNextComment;
let rows: any[];
let comment: any;
beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  jest.clearAllMocks();
  rows = [];
  comment = { zid: 7, tid: 3, txt: "Generated fixture", lang: "en" };
  mockConfig.getValidTopicalRatio = () => 0;
  mockTranslate.mockReset().mockResolvedValue(["Texte traduit"]);
  mockComments.mockReset().mockImplementation(async () => [{ ...comment }]);
  mockQuery
    .mockReset()
    .mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes("insert into comment_translations")) {
        const [zid, tid, txt, lang, src] = params;
        rows.push({ zid, tid, txt, lang, src });
        return [rows[rows.length - 1]];
      }
      if (sql.includes("topic_agenda_selections")) {
        return [
          {
            archetypal_selections: [{ topic_key: "fixture" }],
            delphi_job_id: "fixture",
          },
        ];
      }
      return rows.slice();
    });
  getNextComment = require("../../src/nextComment").getNextComment;
});
afterEach(async () => {
  await jest.advanceTimersByTimeAsync(5001);
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function responseAtBudget(zid = 7, lang = "fr") {
  let response: any;
  const done = getNextComment(zid, 0, [], lang).then((value) => {
    response = value;
  });
  await jest.advanceTimersByTimeAsync(300);
  expect(response).toEqual(expect.objectContaining({ tid: 3 }));
  await done;
  return response;
}

test.each(["en", "en-US", "EN-gb"])(
  "same language %s never calls provider",
  async (lang) => {
    const result = await getNextComment(7, 0, [], lang);
    expect(result!.translations).toEqual([]);
    expect(mockTranslate).not.toHaveBeenCalled();
  }
);
test("topical selection retains source language without adding response fields", async () => {
  mockConfig.getValidTopicalRatio = () => 1;
  const result = await getNextComment(7, 0, [], "en-US");
  expect(mockTranslate).not.toHaveBeenCalled();
  expect(JSON.parse(JSON.stringify(result))).toEqual({
    zid: 7,
    tid: 3,
    txt: comment.txt,
    translations: [],
  });
});
test("hung provider releases statement at 300 ms, not the five-second provider timeout", async () => {
  mockTranslate.mockReturnValue(new Promise(() => {}));
  let response: any;
  const done = getNextComment(7, 0, [], "fr").then((value) => {
    response = value;
  });
  await jest.advanceTimersByTimeAsync(299);
  expect(response).toBeUndefined();
  await jest.advanceTimersByTimeAsync(1);
  expect(response).toEqual(
    expect.objectContaining({ tid: 3, translations: [] })
  );
  await done;
  expect(mockTranslate).toHaveBeenCalledTimes(1);
  expect(rows).toEqual([]);
});
test("background success is stored for the next request without mutating the returned response", async () => {
  let finish: (value: string[]) => void;
  mockTranslate.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const first = await responseAtBudget();
  finish!(["Texte traduit"]);
  await jest.advanceTimersByTimeAsync(1);
  expect(rows).toHaveLength(1);
  expect(first.translations).toEqual([]);
  const next = await getNextComment(7, 0, [], "fr");
  expect(next!.translations).toEqual(rows);
  expect(mockTranslate).toHaveBeenCalledTimes(1);
});
test("concurrent requests share the pending provider call", async () => {
  mockTranslate.mockReturnValue(new Promise(() => {}));
  const requests = Array.from({ length: 4 }, () =>
    getNextComment(7, 0, [], "fr")
  );
  await jest.advanceTimersByTimeAsync(300);
  await Promise.all(requests);
  expect(mockTranslate).toHaveBeenCalledTimes(1);
});
test.each(["rejection", "timeout", "invalid", "storage"])(
  "%s suppresses retries for ten minutes",
  async (failure) => {
    if (failure === "rejection")
      mockTranslate.mockRejectedValue(new Error("fixture"));
    if (failure === "timeout")
      mockTranslate.mockReturnValue(new Promise(() => {}));
    if (failure === "invalid") mockTranslate.mockResolvedValue([]);
    if (failure === "storage")
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("insert into"))
          throw new Error("fixture storage failure");
        return [];
      });
    await responseAtBudget();
    await jest.advanceTimersByTimeAsync(4700);
    const calls = mockTranslate.mock.calls.length;
    await getNextComment(7, 0, [], "fr");
    expect(mockTranslate).toHaveBeenCalledTimes(calls);
    await jest.advanceTimersByTimeAsync(600001);
    mockTranslate.mockResolvedValue(["retry"]);
    await getNextComment(7, 0, [], "fr");
    expect(mockTranslate).toHaveBeenCalledTimes(calls + 1);
  }
);
test("failure key isolates conversation, statement and language", async () => {
  mockTranslate.mockRejectedValue(new Error("fixture"));
  await getNextComment(7, 0, [], "fr");
  await getNextComment(7, 0, [], "fr");
  await getNextComment(8, 0, [], "fr");
  await getNextComment(7, 0, [], "de");
  comment.tid = 4;
  await getNextComment(7, 0, [], "fr");
  expect(mockTranslate).toHaveBeenCalledTimes(4);
});
test("fast success remains in the current response and clears timers", async () => {
  const result = await getNextComment(7, 0, [], "fr");
  expect(result!.translations).toEqual(rows);
  expect(rows).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});
test("unknown source language still translates", async () => {
  comment.lang = null;
  await getNextComment(7, 0, [], "fr");
  expect(mockTranslate).toHaveBeenCalledTimes(1);
});
test("no language does not read translations or call provider", async () => {
  const result = await getNextComment(7, 0);
  expect(result!.translations).toEqual([]);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockTranslate).not.toHaveBeenCalled();
});
test("stored translations are served without provider work", async () => {
  rows = [{ zid: 7, tid: 3, txt: "stored", lang: "fr-FR", src: -1 }];
  const result = await getNextComment(7, 0, [], "fr");
  expect(result!.translations).toEqual(rows);
  expect(mockTranslate).not.toHaveBeenCalled();
});
test("translation read outage also respects the response budget", async () => {
  mockQuery.mockReturnValue(new Promise(() => {}));
  await responseAtBudget();
  expect(mockTranslate).not.toHaveBeenCalled();
});
