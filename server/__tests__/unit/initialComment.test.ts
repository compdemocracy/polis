const mockComments = jest.fn();
const mockMath = jest.fn();
const mockQuery = jest.fn();
const mockCounts = jest.fn();
jest.mock("../../src/comment", () => ({
  getComments: mockComments,
  getNumberOfCommentsRemaining: mockCounts,
  translateAndStoreComment: jest.fn(),
}));
jest.mock("../../src/utils/pca", () => ({ getLatestExistingPca: mockMath }));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: mockQuery },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { getValidTopicalRatio: () => 0 },
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
jest.mock("../../src/utils/commentClusters", () => ({
  getCommentIdsForClusters: jest.fn(),
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: jest.fn() }));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: jest.fn() },
  QueryCommand: jest.fn(),
}));
import { checkInitialComment } from "../../src/nextComment";
let rows: { zid: number; tid: number; txt: string }[];
beforeEach(() => {
  jest.clearAllMocks();
  rows = [3, 0, 2].map((tid) => ({ zid: 7, tid, txt: `Synthetic ${tid}` }));
  mockComments.mockImplementation(async (params) =>
    rows.filter((r) => !params.tids || params.tids.includes(r.tid))
  );
  mockMath.mockResolvedValue({
    asPOJO: { "comment-priorities": { 0: 0.2, 2: 0.9, 3: 0.3 } },
  });
  mockCounts.mockResolvedValue([{ total: 3, remaining: 3 }]);
  mockQuery.mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());
test("returning voted participant receives ordinary unvoted draw, including pid zero", async () => {
  mockQuery.mockResolvedValue([{}]);
  mockComments.mockImplementation(async (params) =>
    rows.filter((row) => params.not_voted_by_pid === undefined || row.tid !== 2)
  );
  const result = await checkInitialComment(7, 0, 2);
  expect(result.status).toBe("voted");
  expect([0, 3]).toContain(result.comment?.tid);
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("votes_latest_unique"),
    [7, 0, 2]
  );
  expect(mockComments).toHaveBeenCalledWith(
    expect.objectContaining({ not_voted_by_pid: 0 })
  );
});
test("returning all-voted participant gets no comment", async () => {
  mockQuery.mockResolvedValue([{}]);
  mockComments.mockResolvedValue([]);
  expect(await checkInitialComment(7, 0, 2)).toEqual({
    status: "voted",
    comment: null,
  });
});
test("unvoted SSR choice is retained even when current math ranks another higher", async () => {
  expect(await checkInitialComment(7, 0, 0)).toMatchObject({
    status: "eligible",
    comment: { tid: 0 },
  });
  expect(mockMath).not.toHaveBeenCalled();
  expect(mockComments).toHaveBeenCalledWith({
    zid: 7,
    tids: [0],
    not_voted_by_pid: 0,
  });
});
test("removed/muted/moderated candidate is unavailable, never a silent replacement", async () => {
  rows = rows.filter((row) => row.tid !== 2);
  expect(await checkInitialComment(7, 0, 2)).toEqual({
    status: "unavailable",
    comment: null,
  });
});
test("anonymous validation never reads another participants votes", async () => {
  expect(await checkInitialComment(7, -1, 0)).toMatchObject({
    status: "eligible",
  });
  expect(mockQuery).not.toHaveBeenCalled();
});
test("failed history lookup propagates; it cannot confirm eligibility", async () => {
  mockQuery.mockRejectedValueOnce(new Error("offline"));
  await expect(checkInitialComment(7, 0, 0)).rejects.toThrow("offline");
});
