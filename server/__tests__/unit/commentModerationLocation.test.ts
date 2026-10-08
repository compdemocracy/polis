// Drive the real comment handler and the real moderation module for a
// participant comment in a conversation whose owner has moderation enabled.
// Stubbed at the boundary: the HTTP client, global fetch, identity provider, the
// database and the translation provider. Nothing leaves the process.
const mockHttpGet = jest.fn();
const mockQuery = jest.fn();

jest.mock("request-promise", () => ({
  __esModule: true,
  default: { get: mockHttpGet },
  get: mockHttpGet,
}));
jest.mock("@google-cloud/translate", () => ({
  v2: { Translate: jest.fn().mockImplementation(() => ({})) },
}));
jest.mock("auth0", () => ({
  ManagementClient: jest.fn().mockImplementation(() => ({
    usersByEmail: {
      getByEmail: jest
        .fn()
        .mockResolvedValue({ data: [{ user_id: "owner-oidc-id" }] }),
    },
    users: {
      getRoles: jest
        .fn()
        .mockResolvedValue({ data: [{ name: "delphi-enabled" }] }),
    },
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

const { handle_POST_comments } = require("../../src/routes/comments");

const COMMENTER_IP = "203.0.113.7"; // documentation range (RFC 5737)
const fetchSpy = jest.fn();
const realFetch = (global as any).fetch;

async function postComment(headers: Record<string, string>, txt = "A public-fixture comment") {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments(
    {
      p: {
        zid: 7,
        uid: 11,
        pid: 5,
        txt,
        is_seed: false,
      },
      headers,
      socket: { remoteAddress: "198.51.100.9" },
      connection: { remoteAddress: "198.51.100.9" },
    },
    res
  );
  return res;
}

function geolocationRequests(): unknown[] {
  return [...mockHttpGet.mock.calls, ...fetchSpy.mock.calls].filter((args) =>
    /ip-api\.com/.test(JSON.stringify(args))
  );
}


beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (global as any).fetch = fetchSpy;
  fetchSpy.mockRejectedValue(new Error("no network in this test"));
  // If a geolocation lookup happens, it answers with a real-looking location.
  mockHttpGet.mockResolvedValue(
    JSON.stringify({
      status: "success",
      city: "Fixture City",
      regionName: "Fixture Region",
      country: "Fixture Country",
    })
  );
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

describe("comment moderation location context", () => {
  test("a comment sent through a proxy with the commenter's IP makes no geolocation request and performs no model call", async () => {
    const res = await postComment({ "x-forwarded-for": COMMENTER_IP });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
    expect(geolocationRequests()).toEqual([]);
    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a comment with only a socket address makes no geolocation request and performs no model call", async () => {
    const res = await postComment({});

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
    expect(geolocationRequests()).toEqual([]);
    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});


test("local profanity filtering still deactivates comments without a provider", async () => {
  await postComment({}, "shit");
  const insert = mockQuery.mock.calls.find(([sql]) => /INSERT INTO COMMENTS/.test(sql));
  expect(insert).toBeDefined();
  expect(insert![1][4]).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockHttpGet).not.toHaveBeenCalled();
});
