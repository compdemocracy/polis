// What POST /api/v3/comments-bulk answers when the uploaded seed CSV has a row
// the parser cannot read, and when something other than the CSV fails. A row
// that cannot be read is the uploader's to fix: 400 polis_err_csv_row, before
// a participant is resolved or a comment is written. A failure that is not
// about the CSV and happens before the rows are stored (the database not
// answering the moderator check, say) is still the server's: 500
// polis_err_post_comments_bulk, as before. Drives the real handler; the
// database, the identity provider and the translation provider are stubbed,
// because an integration database cannot be made to fail on cue. The CSV
// parser is the real one unless a test sets mockParserError.
const mockQuery = jest.fn();
let mockParserError: (() => unknown) | null = null;

jest.mock("csv-parse/sync", () => {
  const actual = jest.requireActual("csv-parse/sync");
  return {
    ...actual,
    parse: (...args: unknown[]) => {
      if (mockParserError) throw mockParserError();
      return actual.parse(...args);
    },
  };
});

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
  mockParserError = null;
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

  // Ten million blank lines above the header: a JSON body of about 20 MB,
  // under the route's 50 MB limit.
  test("ten million blank lines above the header answer 400 naming row 2", async () => {
    const res = await postBulk(
      "\n".repeat(10_000_000) + "comment_text\nbad,extra"
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_csv_row",
      message:
        "Row 2 (the header is row 1) has 2 columns; the header has 1. This usually means a comment contains a comma: wrap that comment in double quotes.",
      status: 400,
    });
    expect(getPidPromise).not.toHaveBeenCalled();
    expect(addParticipant).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  }, 120_000);

  test("a non-moderator is refused 403 before the CSV is read", async () => {
    isModerator.mockResolvedValue(false);
    const res = await postBulk(malformed);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "polis_err_post_comment_auth" })
    );
  });
});

// If the message for one of the parser's shape refusals cannot be built, for
// any reason, the upload is still refused 400 with a message about the file's
// shape, never 500. Parser errors that are not about the file's shape keep
// their 500.
describe("POST /comments-bulk: a shape refusal whose message cannot be built", () => {
  const { CsvError } = jest.requireActual("csv-parse/sync");
  const shapeMessage =
    "This file has a row that cannot be read as CSV. A comment that contains a comma or a double quote must be wrapped in double quotes, and a double quote inside it must be written as two double quotes.";

  function unreadable(code: string, property: string) {
    const err = new CsvError(code, "refused");
    Object.defineProperty(err, property, {
      get() {
        throw new RangeError("Maximum call stack size exceeded");
      },
    });
    return err;
  }

  test.each([
    ["CSV_RECORD_INCONSISTENT_COLUMNS", "records"],
    ["CSV_RECORD_INCONSISTENT_COLUMNS", "empty_lines"],
    ["CSV_RECORD_INCONSISTENT_COLUMNS", "columns"],
    ["CSV_RECORD_INCONSISTENT_COLUMNS", "record"],
    ["CSV_QUOTE_NOT_CLOSED", "header"],
    ["INVALID_OPENING_QUOTE", "field"],
    ["CSV_INVALID_CLOSING_QUOTE", "records"],
  ])(
    "%s with an unreadable %s answers 400 with the shape message",
    async (code, property) => {
      mockParserError = () => unreadable(code, property);
      const res = await postBulk(malformed);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "polis_err_csv_row",
        message: shapeMessage,
        status: 400,
      });
      expect(getPidPromise).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      const [event, detail] = logger.error.mock.calls[0];
      expect(event).toBe("polis_err_csv_row");
      expect(detail).toMatchObject({ row: null, parserCode: code });
    }
  );

  test("a column-count refusal without its column list answers 400 with the shape message", async () => {
    mockParserError = () =>
      new CsvError("CSV_RECORD_INCONSISTENT_COLUMNS", "refused");
    const res = await postBulk(malformed);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_csv_row",
      message: shapeMessage,
      status: 400,
    });
  });

  test.each([
    [
      "a parser code this route cannot produce",
      () => new CsvError("CSV_MAX_RECORD_SIZE", "too big"),
    ],
    [
      "an error that is not the parser's",
      () => new RangeError("Maximum call stack size exceeded"),
    ],
  ])("%s still answers 500", async (_label, error) => {
    mockParserError = error;
    const res = await postBulk(malformed);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_post_comments_bulk",
      message: "polis_err_post_comments_bulk",
      status: 500,
    });
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
