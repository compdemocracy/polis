// What POST /api/v3/comments-bulk answers when the uploaded seed CSV has a row
// the parser cannot read, and when something other than the CSV fails. A row
// that cannot be read is the uploader's to fix: 400 polis_err_csv_row, before
// a participant is resolved or a comment is written. A failure that is not
// about the CSV (the database not answering) is still the server's: 500
// polis_err_post_comments_bulk, as before. Drives the real handler; the
// database, the identity provider and the translation provider are stubbed,
// because an integration database cannot be made to fail on cue.
const mockQuery = jest.fn();

jest.mock("@google-cloud/translate", () => ({
  v2: { Translate: jest.fn().mockImplementation(() => ({})) },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { shouldUseTranslationAPI: false },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP: mockQuery,
    queryP_readOnly: mockQuery,
    queryP_notification: jest.fn(async () => []),
  },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("../../src/conversation", () => ({
  getConversationInfo: jest.fn(),
}));
jest.mock("../../src/user", () => ({
  getPidPromise: jest.fn(),
  getUserInfoForUid2: jest.fn(),
}));
jest.mock("../../src/participant", () => ({ addParticipant: jest.fn() }));
jest.mock("../../src/utils/common", () => ({
  isModerator: jest.fn(),
  polisTypes: { mod: { ok: 1, unmoderated: 0 } },
}));
jest.mock("../../src/routes/votes", () => ({ votesPost: jest.fn() }));
jest.mock("../../src/server-helpers", () => ({
  safeTimestampToMillis: (n: number) => n,
  addConversationIds: jest.fn(),
  finishArray: jest.fn(),
  finishOne: jest.fn(),
  sendEmailByUid: jest.fn(),
  updateConversationModifiedTime: jest.fn(),
  updateLastInteractionTimeForConversation: jest.fn(),
  updateVoteCount: jest.fn(),
}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/utils/metered", () => ({}));
jest.mock("../../src/nextComment", () => ({}));

const { handle_POST_comments_bulk } = require("../../src/routes/comments");
const { getConversationInfo } = require("../../src/conversation");
const { getPidPromise } = require("../../src/user");
const { addParticipant } = require("../../src/participant");
const { isModerator } = require("../../src/utils/common");
const logger = require("../../src/utils/logger").default;

// Eight lines: the header, then seven comments, the fourth of which (row 5)
// has two commas and no double quotes.
const malformed = [
  "comment_text",
  "The library should open on Sundays",
  "More benches along the river path",
  "Bus shelters need better lighting",
  "Plant trees on the main street, near the school, and by the market",
  "Keep the pool open later in summer",
  "Add a crossing near the playground",
  "Weekly farmers market downtown",
].join("\n");
const wellFormed = "comment_text\nThe library should open on Sundays\n";

/** A node-postgres error for a server that stopped answering. */
function databaseDown() {
  return Object.assign(
    new Error("terminating connection due to administrator command"),
    { code: "57P01" }
  );
}

async function postBulk(csv: string) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments_bulk(
    {
      p: { zid: 7, uid: 21, pid: undefined, is_seed: true },
      body: { csv },
      headers: {},
    },
    res
  );
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async (sql: string) => {
    if (/INSERT INTO COMMENTS/.test(sql)) {
      return [{ tid: 0, created: 10000000000000 }];
    }
    return [];
  });
  getConversationInfo.mockResolvedValue({
    owner: 21,
    is_active: true,
    strict_moderation: false,
  });
  isModerator.mockResolvedValue(true);
  getPidPromise.mockResolvedValue(-1);
  addParticipant.mockResolvedValue([{ pid: 0 }]);
});

describe("POST /comments-bulk: a row the CSV parser cannot read", () => {
  test("answers 400 with the row and the counts, and writes nothing", async () => {
    const res = await postBulk(malformed);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_csv_row",
      message:
        "Row 5 (the header is row 1) has 3 columns; the header has 1. This usually means a comment contains a comma: wrap that comment in double quotes.",
      status: 400,
    });
    expect(getPidPromise).not.toHaveBeenCalled();
    expect(addParticipant).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("logs the row and the parser's code, never the row's text", async () => {
    await postBulk(malformed);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [event, detail] = logger.error.mock.calls[0];
    expect(event).toBe("polis_err_csv_row");
    expect(detail).toMatchObject({
      row: 5,
      parserCode: "CSV_RECORD_INCONSISTENT_COLUMNS",
    });
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toMatch(/main street|school|market/);
  });

  test("a non-moderator is refused 403 before the CSV is read", async () => {
    isModerator.mockResolvedValue(false);
    const res = await postBulk(malformed);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "polis_err_post_comment_auth" })
    );
  });
});

describe("POST /comments-bulk: a failure that is not about the CSV", () => {
  test.each([
    [
      "the moderator check",
      () => isModerator.mockRejectedValue(databaseDown()),
    ],
    [
      "the conversation read",
      () => getConversationInfo.mockRejectedValue(databaseDown()),
    ],
  ])("%s failing answers 500, whatever the CSV", async (_label, fail) => {
    for (const csv of [malformed, wellFormed]) {
      jest.clearAllMocks();
      fail();
      const res = await postBulk(csv);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "polis_err_post_comments_bulk",
        message: "polis_err_post_comments_bulk",
        status: 500,
      });
    }
  });

  test("the participant lookup failing after a well-formed CSV answers 500", async () => {
    getPidPromise.mockRejectedValue(databaseDown());
    const res = await postBulk(wellFormed);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_post_comments_bulk",
      message: "polis_err_post_comments_bulk",
      status: 500,
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("a well-formed CSV is stored as before", async () => {
    const res = await postBulk(wellFormed);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      results: [
        {
          txt: "The library should open on Sundays",
          status: "success",
          tid: 0,
          original_id: undefined,
        },
      ],
      currentPid: 0,
    });
  });
});
