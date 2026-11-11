/**
 * Selecting the next statement writes one `polis_info_getNextComment` line at
 * info level, on every vote, every next-statement read and every
 * participationInit. The line carries the conversation and what was asked
 * (the excluded statements, the language, whether the topical path was
 * drawn), and never the participant: a participant number beside a
 * conversation number is a handle on that participant's public votes.
 */
import { beforeEach, expect, jest, test } from "@jest/globals";

const mockConfig = {
  shouldUseTranslationAPI: false,
  getValidTopicalRatio: (): number => 0,
};
jest.mock("@google-cloud/translate", () => ({
  v2: { Translate: jest.fn() },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: mockConfig,
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(async () => []) },
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
  getLatestCommentPriorities: async () => undefined,
}));
jest.mock("../../src/utils/commentClusters", () => ({
  getCommentIdsForClusters: async () => [],
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: jest.fn() }));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  QueryCommand: jest.fn(),
}));
jest.mock("../../src/conversation", () => ({}));
jest.mock("../../src/comment", () => ({
  getComments: async () => [],
  getNextCommentCandidates: async () => [{ tid: 3 }],
  getNextCommentRow: async () => ({ tid: 3, txt: "Generated fixture" }),
  getNumberOfCommentsRemaining: async () => [{ total: 5, remaining: 2 }],
  translateAndStoreComment: async () => null,
}));

import logger from "../../src/utils/logger";
import { getNextComment } from "../../src/nextComment";

const ZID = 7;
// A distinctive participant number that must appear nowhere in the line.
const PID = 424242;
const LINE = "polis_info_getNextComment";
const KEYS = ["zid", "withoutTids", "lang", "shouldUseTopical"];

function infoLines(): Record<string, unknown>[] {
  return (logger.info as jest.Mock).mock.calls
    .filter((call) => call[0] === LINE)
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.getValidTopicalRatio = () => 0;
});

test("the line carries the conversation and what was asked, in this order", async () => {
  const next = await getNextComment(ZID, PID, [11, 12], "fr");
  expect(next).toEqual(expect.objectContaining({ tid: 3, remaining: 2 }));
  const lines = infoLines();
  expect(lines).toHaveLength(1);
  expect(Object.keys(lines[0])).toEqual(KEYS);
  expect(lines[0]).toEqual({
    zid: ZID,
    withoutTids: [11, 12],
    lang: "fr",
    shouldUseTopical: false,
  });
});

test("the line never carries the participant", async () => {
  await getNextComment(ZID, PID, [], "en");
  // The topical draw: a ratio of 1 always takes it for a real participant.
  mockConfig.getValidTopicalRatio = () => 1;
  await getNextComment(ZID, PID, [], undefined);
  const lines = infoLines();
  expect(lines).toHaveLength(2);
  expect(lines[1].shouldUseTopical).toBe(true);
  for (const line of lines) {
    expect(Object.keys(line)).toEqual(KEYS);
    expect(line).not.toHaveProperty("pid");
    expect(JSON.stringify(line)).not.toContain(String(PID));
  }
});

test("no line this selection writes at info level names the participant", async () => {
  await getNextComment(ZID, PID, [], "en");
  const calls = (logger.info as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(JSON.stringify(call)).not.toContain(String(PID));
  }
});
