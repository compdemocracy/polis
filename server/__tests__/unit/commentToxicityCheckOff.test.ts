// Drive the real comment handler for a participant comment in a conversation
// whose owner carries the delphi-enabled role. The toxicity check that once
// ran for such owners has been removed: the handler reaches no identity
// provider and no language model, and stores the statement under the
// conversation's own moderation. Stubbed at the boundary: global fetch, the
// identity provider, the database and the translation provider. Nothing
// leaves the process.
const mockQuery = jest.fn();
const mockGetByEmail = jest.fn();
const mockGetRoles = jest.fn();

jest.mock("@google-cloud/translate", () => ({
  v2: { Translate: jest.fn().mockImplementation(() => ({})) },
}));
jest.mock("auth0", () => ({
  ManagementClient: jest.fn().mockImplementation(() => ({
    usersByEmail: { getByEmail: mockGetByEmail },
    users: { getRoles: mockGetRoles },
  })),
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    shouldUseTranslationAPI: false,
  },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: mockQuery, queryP_readOnly: mockQuery },
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
}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/utils/metered", () => ({}));
jest.mock("../../src/nextComment", () => ({}));

const {
  handle_POST_comments,
  isProConvo,
} = require("../../src/routes/comments");

const OWNER_UID = 11;
const fetchSpy = jest.fn();
const realFetch = (global as any).fetch;

async function postComment() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments(
    {
      p: {
        zid: 7,
        uid: OWNER_UID,
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
  jest.clearAllMocks();
  (global as any).fetch = fetchSpy;
  fetchSpy.mockRejectedValue(new Error("no network in this test"));
  // The owner carries the role.
  mockGetByEmail.mockResolvedValue({ data: [{ user_id: "owner-oidc-id" }] });
  mockGetRoles.mockResolvedValue({ data: [{ name: "delphi-enabled" }] });
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
  test("the owner would pass the Pro check under the stubbed identity provider", async () => {
    await expect(isProConvo(OWNER_UID)).resolves.toBe(true);
    expect(mockGetByEmail).toHaveBeenCalledTimes(1);
    expect(mockGetRoles).toHaveBeenCalledTimes(1);
  });

  test("a participant comment makes no identity-provider call and no network request, and is stored active and unmoderated", async () => {
    const res = await postComment();

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
    expect(mockGetByEmail).not.toHaveBeenCalled();
    expect(mockGetRoles).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const params = insertedCommentParams();
    expect(params[4]).toBe(true); // active
    expect(params[5]).toBe(0); // mod: unmoderated
    expect(params[8]).toBe(false); // is_seed
  });
});
