// A participant statement uses the conversation moderation settings without
// constructing an identity-provider management client or making external calls.
const mockQuery = jest.fn();
const mockManagementClient = jest.fn(() => {
  throw new Error("Comment routes must not construct a management client");
});

jest.mock("@google-cloud/translate", () => ({
  v2: { Translate: jest.fn().mockImplementation(() => ({})) },
}));
jest.mock(
  "auth0",
  () => ({
    ManagementClient: mockManagementClient,
  }),
  { virtual: true }
);
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    shouldUseTranslationAPI: false,
  },
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
  getUserInfoForUid2: jest
    .fn()
    .mockResolvedValue({ email: "owner@polis.test" }),
}));
jest.mock("../../src/participant", () => ({ addParticipant: jest.fn() }));
jest.mock("../../src/utils/common", () => ({
  isModerator: jest.fn().mockResolvedValue(false),
  polisTypes: { mod: { ok: 1, unmoderated: 0 } },
}));
jest.mock("../../src/routes/votes", () => ({ votesPost: jest.fn() }));
jest.mock("../../src/server-helpers", () => ({
  safeTimestampToMillis: (n: number) => n,
  updateLastInteractionTimeForConversation: jest.fn(async () => []),
}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/utils/metered", () => ({}));
jest.mock("../../src/nextComment", () => ({}));

const { handle_POST_comments } = require("../../src/routes/comments");

const PARTICIPANT_UID = 21;
const fetchSpy = jest.fn();
const realFetch = (global as any).fetch;

async function postComment() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments(
    {
      p: {
        zid: 7,
        uid: PARTICIPANT_UID,
        pid: 5,
        txt: "A public-fixture comment",
        is_seed: false,
      },
      headers: {},
      socket: { remoteAddress: "198.51.100.9" },
      connection: { remoteAddress: "198.51.100.9" },
    },
    res
  );
  return res;
}

function insertedCommentParams(): unknown[] {
  const insert = mockQuery.mock.calls.find(([sql]) =>
    /INSERT INTO COMMENTS/.test(String(sql))
  );
  expect(insert).toBeDefined();
  return insert[1];
}

beforeEach(() => {
  jest.useFakeTimers();
  mockQuery.mockClear();
  fetchSpy.mockClear();
  (global as any).fetch = fetchSpy;
  fetchSpy.mockRejectedValue(new Error("no network in this test"));
  mockQuery.mockImplementation(async (sql: string) => {
    if (/INSERT INTO COMMENTS/.test(sql))
      return [{ tid: 3, created: 10000000000000 }];
    return [];
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  (global as any).fetch = realFetch;
});

describe("comment path without the toxicity check", () => {
  test("loading the comment routes does not construct a management client", () => {
    expect(mockManagementClient).not.toHaveBeenCalled();
  });

  test("a participant comment makes no identity-provider call and no network request, and is stored active and unmoderated", async () => {
    const res = await postComment();

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
    expect(mockManagementClient).not.toHaveBeenCalled();
    expect(require("../../src/user").getUserInfoForUid2).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const params = insertedCommentParams();
    expect(params[4]).toBe(true); // active
    expect(params[5]).toBe(0); // mod: unmoderated
    expect(params[8]).toBe(false); // is_seed
  });
});
