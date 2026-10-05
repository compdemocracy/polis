// Drive the real comment handler and the real moderation module for a
// participant comment in a conversation whose owner has moderation enabled.
// Stubbed at the boundary: the Gemini client, the HTTP client the moderation
// module used for IP geolocation, global fetch, the identity provider, the
// database and the translation provider. Nothing leaves the process.
const mockGenerateContent = jest.fn();
const mockHttpGet = jest.fn();
const mockQuery = jest.fn();

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
}));
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
    geminiApiKey: "public-fixture-key",
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

const { moderationReady } = require("../../src/utils/moderation");
const { handle_POST_comments } = require("../../src/routes/comments");

const NEUTRAL_DEFAULT = "US or Europe (EU)";
const COMMENTER_IP = "203.0.113.7"; // documentation range (RFC 5737)
const fetchSpy = jest.fn();
const realFetch = (global as any).fetch;

async function postComment(headers: Record<string, string>) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments(
    {
      p: {
        zid: 7,
        uid: 11,
        pid: 5,
        txt: "A public-fixture comment",
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

function sentPrompt(): string {
  expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  return mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
}

function geographicalContext(prompt: string): string | undefined {
  // The rubric's examples quote their values; the filled-in input does not.
  const values = [
    ...prompt.matchAll(
      /<geographical_context>([^"<][^<]*)<\/geographical_context>/g
    ),
  ].map((m) => m[1]);
  expect(values).toHaveLength(1);
  return values[0];
}

function geolocationRequests(): unknown[] {
  return [...mockHttpGet.mock.calls, ...fetchSpy.mock.calls].filter((args) =>
    /ip-api\.com/.test(JSON.stringify(args))
  );
}

beforeAll(async () => {
  await moderationReady;
});

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
  mockGenerateContent.mockResolvedValue({
    text: JSON.stringify({ output: { final_score: "5" } }),
  });
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
  test("a comment sent through a proxy with the commenter's IP makes no geolocation request and uses the neutral default", async () => {
    const res = await postComment({ "x-forwarded-for": COMMENTER_IP });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
    expect(geolocationRequests()).toEqual([]);
    expect(mockHttpGet).not.toHaveBeenCalled();
    const prompt = sentPrompt();
    expect(geographicalContext(prompt)).toBe(NEUTRAL_DEFAULT);
    expect(prompt).not.toContain(COMMENTER_IP);
    expect(prompt).not.toContain("Fixture City");
  });

  test("a comment with only a socket address makes no geolocation request and uses the neutral default", async () => {
    const res = await postComment({});

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tid: 3 }));
    expect(geolocationRequests()).toEqual([]);
    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(geographicalContext(sentPrompt())).toBe(NEUTRAL_DEFAULT);
  });
});
