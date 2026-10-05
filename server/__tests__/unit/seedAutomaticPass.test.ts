// The legacy cutoff for a seed statement's automatic pass, pinned on the real
// comment handler with no database: a seed created with no vote takes an
// automatic pass from its author in a conversation numbered 17037 or below, and
// no vote at all from 17038 up. Stubbed at the boundary: the database, the vote
// writer (whose calls are what this test reads), the identity provider and the
// helpers the handler schedules afterwards.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { toWire, WIRE_PASS } from "../setup/vote-wire";

const mockQuery = jest.fn<(sql: string) => Promise<unknown[]>>();
const mockVotesPost = jest.fn();

jest.mock("auth0", () => ({ ManagementClient: jest.fn() }));
jest.mock("../../src/config", () => ({ __esModule: true, default: {} }));
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
  getConversationInfo: jest.fn(async () => ({
    owner: 11,
    is_active: true,
    strict_moderation: false,
  })),
}));
jest.mock("../../src/user", () => ({
  getPidPromise: jest.fn(async () => 0),
  getUserInfoForUid2: jest.fn(),
}));
jest.mock("../../src/participant", () => ({ addParticipant: jest.fn() }));
jest.mock("../../src/utils/common", () => ({
  isModerator: jest.fn(async () => true),
  polisTypes: { mod: { ok: 1, unmoderated: 0 } },
}));
jest.mock("../../src/routes/votes", () => ({ votesPost: mockVotesPost }));
jest.mock("../../src/comment", () => ({
  detectLanguage: jest.fn(async () => [{ language: "en", confidence: 1 }]),
}));
jest.mock("../../src/server-helpers", () => ({
  safeTimestampToMillis: (n: number) => n,
  updateConversationModifiedTime: jest.fn(),
  updateLastInteractionTimeForConversation: jest.fn(),
  updateVoteCount: jest.fn(),
}));
jest.mock("../../src/utils/moderation", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/utils/metered", () => ({}));
jest.mock("../../src/nextComment", () => ({}));
jest.mock("../../src/utils/pagination", () => ({}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handle_POST_comments } = require("../../src/routes/comments");

const OWNER_UID = 11;
const OWNER_PID = 0;
const NEW_TID = 3;

async function createStatement(p: Record<string, unknown>) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle_POST_comments(
    {
      p: { uid: OWNER_UID, pid: OWNER_PID, txt: "A public-fixture seed", ...p },
      headers: {},
    },
    res
  );
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({
    tid: NEW_TID,
    currentPid: OWNER_PID,
  });
  return mockVotesPost.mock.calls;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockQuery.mockImplementation(async (sql: string) =>
    /INSERT INTO COMMENTS/.test(sql)
      ? [{ tid: NEW_TID, created: 10000000000000 }]
      : []
  );
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("a seed statement's automatic pass and the legacy cutoff", () => {
  test.each([1, 17036, 17037])(
    "conversation %d (at or below the cutoff): a seed with no vote takes an automatic pass",
    async (zid) => {
      expect(await createStatement({ zid, is_seed: true })).toEqual([
        [OWNER_UID, OWNER_PID, zid, NEW_TID, WIRE_PASS, 0, false],
      ]);
    }
  );

  test.each([17038, 17039, 250000])(
    "conversation %d (above the cutoff): a seed with no vote records no vote",
    async (zid) => {
      expect(await createStatement({ zid, is_seed: true })).toEqual([]);
    }
  );

  test.each([17037, 17038])(
    "conversation %d: a seed with an explicit vote records that vote",
    async (zid) => {
      for (const vote of ["agree", "disagree", "pass"] as const) {
        mockVotesPost.mockClear();
        expect(
          await createStatement({ zid, is_seed: true, vote: toWire(vote) })
        ).toEqual([
          [OWNER_UID, OWNER_PID, zid, NEW_TID, toWire(vote), 0, false],
        ]);
      }
    }
  );

  test.each([17037, 17038])(
    "conversation %d: a statement that is not a seed takes no automatic pass",
    async (zid) => {
      expect(await createStatement({ zid, is_seed: false })).toEqual([]);
      expect(await createStatement({ zid })).toEqual([]);
    }
  );
});
