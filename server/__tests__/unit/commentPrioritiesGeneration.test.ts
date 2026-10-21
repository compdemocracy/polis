// The serve log names the math generation whose priorities a draw used, so
// getLatestCommentPriorities' map must be traceable to its math_tick and
// math_env. Existing callers keep receiving the bare map.
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const queryP_readOnly = jest.fn();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_readOnly },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { mathEnv: "test-math-env", cacheMathResults: true },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: () => undefined,
    silly: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));
jest.mock("../../src/utils/metered", () => ({
  __esModule: true,
  addInRamMetric: () => undefined,
  MPromise: Promise,
}));

import {
  commentPrioritiesGeneration,
  getLatestCommentPriorities,
  getLatestExistingPca,
} from "../../src/utils/pca";

let nextZid = 910000;
const freshZid = () => ++nextZid;

// node-pg hands a BIGINT back as a string.
function serve(mathTick: unknown, priorities: Record<string, number>) {
  queryP_readOnly.mockImplementation(((sql: string) => {
    const s = String(sql);
    if (s.includes("data->'comment-priorities'")) {
      return Promise.resolve([{ math_tick: mathTick, priorities }]);
    }
    if (s.includes("select math_tick from math_main")) {
      return Promise.resolve([{ math_tick: mathTick }]);
    }
    if (s.includes("from math_main")) {
      return Promise.resolve([
        {
          data: { "comment-priorities": priorities, math_tick: 34807 },
          math_tick: mathTick,
        },
      ]);
    }
    if (s.includes("from comments")) return Promise.resolve([]);
    return Promise.resolve([]);
  }) as never);
}

beforeEach(() => {
  queryP_readOnly.mockReset();
});

describe("commentPrioritiesGeneration", () => {
  test("a map read from the priorities field names its committed tick", async () => {
    const zid = freshZid();
    serve("7", { "1": 2 });
    const priorities = await getLatestCommentPriorities(zid);
    expect(priorities).toEqual({ "1": 2 });
    expect(commentPrioritiesGeneration(priorities)).toEqual({
      mathTick: 7,
      mathEnv: "test-math-env",
    });
  });

  test("a map re-served from the 3 s window keeps its tick", async () => {
    const zid = freshZid();
    serve("8", { "2": 3 });
    await getLatestCommentPriorities(zid);
    const again = await getLatestCommentPriorities(zid);
    expect(commentPrioritiesGeneration(again)).toEqual({
      mathTick: 8,
      mathEnv: "test-math-env",
    });
  });

  test("a map taken from a live math cache entry names that entry's tick", async () => {
    const zid = freshZid();
    serve("4", { "0": 5 });
    await getLatestExistingPca(zid);
    const priorities = await getLatestCommentPriorities(zid);
    expect(priorities).toEqual({ "0": 5 });
    expect(commentPrioritiesGeneration(priorities)).toEqual({
      mathTick: 4,
      mathEnv: "test-math-env",
    });
  });

  test("a newer generation's map gets the new tick; the old map keeps its own", async () => {
    const zid = freshZid();
    const realNow = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(realNow);
    try {
      serve("8", { "1": 2 });
      const older = await getLatestCommentPriorities(zid);
      now.mockReturnValue(realNow + 3001); // past the 3 s window
      serve("9", { "1": 5 });
      const newer = await getLatestCommentPriorities(zid);
      expect(newer).toEqual({ "1": 5 });
      expect(newer).not.toBe(older);
      expect(commentPrioritiesGeneration(newer)).toEqual({
        mathTick: 9,
        mathEnv: "test-math-env",
      });
      expect(commentPrioritiesGeneration(older)).toEqual({
        mathTick: 8,
        mathEnv: "test-math-env",
      });
    } finally {
      now.mockRestore();
    }
  });

  test("no math row: no map and no generation", async () => {
    const zid = freshZid();
    queryP_readOnly.mockImplementation((() => Promise.resolve([])) as never);
    const priorities = await getLatestCommentPriorities(zid);
    expect(priorities).toBeUndefined();
    expect(commentPrioritiesGeneration(priorities)).toBeUndefined();
  });

  test("an unknown object has no generation", () => {
    expect(commentPrioritiesGeneration({ "1": 1 })).toBeUndefined();
  });
});
