// What the comment routes answer when the comment INSERT fails with a unique
// violation (SQLSTATE 23505). Only a violation of the conversation's (zid, txt)
// index means the statement is a duplicate; it answers 409
// polis_err_post_comment_duplicate. Any other unique violation (the (zid, tid)
// statement-number index, a participant constraint) is a server error and
// answers 500, never "duplicate". Drives the real handlers; the database, the
// identity provider and the translation provider are stubbed.
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
  getConversationInfo: jest.fn().mockResolvedValue({
    owner: 11,
    is_active: true,
    strict_moderation: false,
    profanity_filter: true,
    topic: "Public fixture topic",
  }),
}));
jest.mock("../../src/user", () => ({
  getPidPromise: jest.fn().mockResolvedValue(5),
  getUserInfoForUid2: jest.fn(),
}));
jest.mock("../../src/participant", () => ({ addParticipant: jest.fn() }));
jest.mock("../../src/utils/common", () => ({
  isModerator: jest.fn().mockResolvedValue(true),
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

const {
  handle_POST_comments,
  handle_POST_comments_bulk,
} = require("../../src/routes/comments");

/** A pg DatabaseError as node-postgres raises it. */
function uniqueViolation(constraint: string) {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: "23505",
      constraint,
      table: constraint.startsWith("participants")
        ? "participants"
        : "comments",
    }
  );
}

/** Every query answers [] except the comment INSERT, which fails with err. */
function insertFailsWith(err: Error | null) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/INSERT INTO COMMENTS/.test(sql)) {
      if (err) throw err;
      return [{ tid: 3, created: 10000000000000 }];
    }
    return [];
  });
}

async function postComment() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments(
    {
      p: {
        zid: 7,
        uid: 21,
        pid: 5,
        txt: "A public-fixture statement",
        is_seed: false,
      },
      headers: {},
    },
    res
  );
  return res;
}

async function postBulk() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments_bulk(
    {
      p: { zid: 7, uid: 21, pid: 5, is_seed: false },
      body: { csv: "comment_text\nA public-fixture statement\n" },
      headers: {},
    },
    res
  );
  return res;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// The (zid, txt) index is named comments_zid_txt_key on a database built from
// the migrations, and comments_txt_unique_constraint on databases whose
// comments table predates them; the (zid, tid) index likewise.
describe("POST /comments: a unique violation on the comment INSERT", () => {
  test.each(["comments_zid_txt_key", "comments_txt_unique_constraint"])(
    "on the (zid, txt) index %s answers 409 duplicate",
    async (constraint) => {
      insertFailsWith(uniqueViolation(constraint));
      const res = await postComment();
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "polis_err_post_comment_duplicate",
          status: 409,
        })
      );
    }
  );

  test.each([
    "comments_zid_tid_key",
    "comments_tid_unique_constraint",
    "participants_zid_pid_key",
  ])("on %s answers 500, not duplicate", async (constraint) => {
    insertFailsWith(uniqueViolation(constraint));
    const res = await postComment();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "polis_err_post_comment", status: 500 })
    );
  });

  test("a text the conversation already has is refused 409 duplicate before any INSERT", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/select zid from comments where zid/.test(sql)) return [{ zid: 7 }];
      if (/INSERT INTO COMMENTS/.test(sql))
        throw new Error("no INSERT expected");
      return [];
    });
    const res = await postComment();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "polis_err_post_comment_duplicate" })
    );
  });

  test("an INSERT that succeeds answers its statement number", async () => {
    insertFailsWith(null);
    const res = await postComment();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
  });
});

describe("POST /comments-bulk: a unique violation on a row's INSERT", () => {
  test.each([
    ["comments_zid_txt_key", "polis_err_post_comment_duplicate"],
    ["comments_txt_unique_constraint", "polis_err_post_comment_duplicate"],
    ["comments_zid_tid_key", "polis_err_post_comment"],
    ["comments_tid_unique_constraint", "polis_err_post_comment"],
  ])("on %s reports the row as %s", async (constraint, reason) => {
    insertFailsWith(uniqueViolation(constraint));
    const res = await postBulk();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [expect.objectContaining({ status: "error", reason })],
      })
    );
  });
});
