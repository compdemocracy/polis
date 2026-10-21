// countEligibleComments counts exactly the rows getComments lists: the same
// WHERE clause, built by the same code, without ORDER BY or LIMIT. The list
// query keeps its LIMIT 999 default.
import { beforeEach, expect, jest, test } from "@jest/globals";

const mockQuery = jest.fn(
  (sql: string, _params: unknown[], cb: (e: unknown, r: unknown) => void) => {
    cb(null, { rows: [{ count: "1005" }] });
  }
);

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { query: mockQuery, queryP: jest.fn(), queryP_readOnly: jest.fn() },
}));
jest.mock("../../src/conversation", () => ({
  getConversationInfo: async () => ({
    strict_moderation: false,
    prioritize_seed: false,
  }),
}));
jest.mock("../../src/routes/comments", () => ({}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { countEligibleComments, getComments } from "../../src/comment";

const params = { zid: 7, not_voted_by_pid: 3, withoutTids: [4, 9] };

beforeEach(() => mockQuery.mockClear());

const sqlOf = (call: number) => String(mockQuery.mock.calls[call][0]);
const whereOf = (sql: string) =>
  sql.slice(
    sql.indexOf(" WHERE "),
    sql.indexOf(" ORDER BY ") > 0 ? sql.indexOf(" ORDER BY ") : undefined
  );

test("the list keeps ORDER BY created and the default LIMIT 999", async () => {
  await getComments(params as never);
  expect(sqlOf(0)).toMatch(/ ORDER BY .*created.* LIMIT 999$/i);
});

test("the count has the list's exact WHERE clause and returns m", async () => {
  await getComments(params as never);
  const m = await countEligibleComments(params as never);
  expect(m).toBe(1005);
  const list = sqlOf(0);
  const count = sqlOf(1);
  expect(count).toMatch(
    /^SELECT COUNT\("comments"\.\*\) AS "count" FROM "comments" WHERE /
  );
  expect(count).not.toMatch(/ORDER BY|LIMIT|OFFSET/i);
  expect(whereOf(count)).toBe(whereOf(list));
});

test("limit 1 with an offset reads one row at that position, same order", async () => {
  await getComments({ ...params, limit: 1, offset: 1004 } as never);
  expect(sqlOf(0)).toMatch(/ ORDER BY .*created.* LIMIT 1 OFFSET 1004$/i);
});
