jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../../src/routes/math", () => ({}));
jest.mock("../../src/routes/metadata", () => ({}));
jest.mock("../../src/conversation", () => ({}));
jest.mock("../../src/utils/pca", () => ({}));
jest.mock("../../src/utils/mathBundle", () => ({}));
jest.mock("../../src/participant", () => ({}));
jest.mock("../../src/user", () => ({}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/email/senders", () => ({}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true, default: { warn: jest.fn() },
}));

import pg from "../../src/db/pg-query";
import {
  safeTimestampToMillis,
  updateConversationModifiedTime,
  addStar,
} from "../../src/server-helpers";

const millis = 1700000000123;
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

test.each([millis, String(millis), new Date(millis)])(
  "preserves database milliseconds %p through repeated normalization",
  (input) => {
    const normalized = safeTimestampToMillis(input);
    expect(normalized).toBe(millis);
    expect(safeTimestampToMillis(normalized)).toBe(millis);
  }
);

test.each([1700000000, "1700000000", 1700000000.125])(
  "converts legacy Unix seconds %p once", (input) => {
    const normalized = safeTimestampToMillis(input);
    expect(normalized).toBe(Number(input) * 1000);
    expect(safeTimestampToMillis(normalized)).toBe(normalized);
  }
);

test.each([1000000000, 4102444800, 4102444800000])(
  "preserves values outside the legacy seconds interval: %p",
  (input) => expect(safeTimestampToMillis(input)).toBe(input)
);

test("parses an ISO string as a date, not its numeric year prefix", () => {
  expect(safeTimestampToMillis("2023-11-14T22:13:20.123Z")).toBe(millis);
});

test.each([null, undefined, "", "garbage", NaN, Infinity, -1, new Date(NaN)])(
  "falls back to current time for invalid input %p", (input) => {
    jest.spyOn(Date, "now").mockReturnValue(millis);
    expect(safeTimestampToMillis(input)).toBe(millis);
  }
);

test("comment and vote chains write milliseconds to conversation.modified", async () => {
  // PostgreSQL BIGINTs arrive as strings; these mirror the comment and vote callers.
  const created = safeTimestampToMillis(String(millis));
  await updateConversationModifiedTime(1, new Date(created));
  await updateConversationModifiedTime(1, created);
  expect(pg.queryP).toHaveBeenNthCalledWith(1, expect.any(String), [1, millis]);
  expect(pg.queryP).toHaveBeenNthCalledWith(2, expect.any(String), [1, millis]);
});

test("vote-plus-star stores the same creation time as the vote", async () => {
  await addStar(1, 2, 3, 1, safeTimestampToMillis(String(millis)));
  expect(pg.queryP).toHaveBeenCalledWith(expect.any(String), [3, 1, 2, 1, millis]);
});
