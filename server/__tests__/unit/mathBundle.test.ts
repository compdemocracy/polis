// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Unit-level pins for the coherent math Bundle reader: the shape of the single
// statement, the admission rules, the purity and exactness of the accessors,
// and the bounded cache with its tick invalidation.
//
// The interleaved torn-read witness lives in
// __tests__/integration/math-bundle-coherence.test.ts, against real Postgres.

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

import {
  bidsForPids,
  clearMathBundleCache,
  getMathBundle,
  invalidateMathBundleForTick,
  loadBundle,
  MATH_BUNDLE_CACHE_MAX,
  MathBundle,
  pidsForGid,
} from "../../src/utils/mathBundle";

// Generation A. Two base clusters, one participant each, one group each.
// `base-clusters.id` is the bid at each INDEX; `bidToPid` is the pids at each
// INDEX. The two are only meaningful together, which is the whole point.
const A_MAIN = {
  "group-clusters": [
    { id: 0, members: [10], center: [0, 0] },
    { id: 1, members: [20], center: [1, 1] },
  ],
  "base-clusters": {
    id: [10, 20],
    members: [[1], [2]],
    x: [],
    y: [],
    count: [],
  },
  math_tick: 34807, // the engine's wall clock, NOT the database generation
};
const A_BIDTOPID = { bidToPid: [[1], [2]], math_tick: 34807 };
const A_PTPTSTATS = { math_tick: 34807 };

function bundleRow(overrides: Record<string, unknown> = {}) {
  return {
    main_data: JSON.parse(JSON.stringify(A_MAIN)),
    main_math_tick: "7", // node-postgres hands BIGINT back as a string
    main_caching_tick: "70",
    last_vote_timestamp: "1700000000000",
    bidtopid_data: JSON.parse(JSON.stringify(A_BIDTOPID)),
    bidtopid_math_tick: "7",
    ptptstats_data: JSON.parse(JSON.stringify(A_PTPTSTATS)),
    ptptstats_math_tick: "7",
    ticks_math_tick: "7",
    ...overrides,
  };
}

function serve(overrides: Record<string, unknown> = {}) {
  queryP_readOnly.mockImplementation((() =>
    Promise.resolve([bundleRow(overrides)])) as never);
}

function admittedBundle(overrides: Record<string, unknown> = {}): MathBundle {
  const row = bundleRow(overrides);
  return {
    mathEnv: "test-math-env",
    zid: 1,
    mathTick: Number(row.main_math_tick),
    cachingTick: Number(row.main_caching_tick),
    lastVoteTimestamp: Number(row.last_vote_timestamp),
    main: row.main_data,
    bidToPid: row.bidtopid_data,
    ptptStats: row.ptptstats_data,
  } as MathBundle;
}

let nextZid = 500000;
function freshZid() {
  nextZid += 1;
  return nextZid;
}

beforeEach(() => {
  queryP_readOnly.mockReset();
  clearMathBundleCache();
});

describe("loadBundle reads one coherent generation in one statement", () => {
  test("one statement, every math table, scoped by (zid, math_env)", async () => {
    serve();
    const zid = freshZid();
    const read = await loadBundle(zid);

    expect(queryP_readOnly).toHaveBeenCalledTimes(1);
    const [sql, params] = queryP_readOnly.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([zid, "test-math-env"]);
    // One statement: no BEGIN, no second SELECT.
    expect(sql.match(/select/gi)).toHaveLength(1);
    for (const table of [
      "math_main",
      "math_bidtopid",
      "math_ptptstats",
      "math_ticks",
    ]) {
      expect(sql).toContain(table);
    }
    // Every join carries math_env, so a Bundle can never mix namespaces.
    expect(sql.match(/math_env = m\.math_env/g)).toHaveLength(3);
    expect(sql).toContain("m.math_env = ($2)");
    // Comment-owned data is not math-owned and is not in the Bundle.
    expect(sql).not.toContain("comments");

    expect(read.present).toBe(true);
    expect(read.present && read.admitted).toBe(true);
  });

  test("the generation is the COLUMN tick, coerced from the driver's string", async () => {
    serve();
    const read = await loadBundle(freshZid());
    if (!read.present || !read.admitted) throw new Error("expected admission");
    expect(read.bundle.mathTick).toBe(7);
    expect(read.bundle.cachingTick).toBe(70);
    expect(read.bundle.lastVoteTimestamp).toBe(1700000000000);
    // The blob's own engine wall clock is a different quantity and is untouched.
    expect(read.bundle.main.math_tick).toBe(34807);
  });

  test("no math_main row is absence, not a refusal", async () => {
    queryP_readOnly.mockImplementation((() => Promise.resolve([])) as never);
    expect(await loadBundle(freshZid())).toEqual({ present: false });
  });

  test.each([
    ["math_bidtopid", { bidtopid_data: null, bidtopid_math_tick: null }],
    ["math_ptptstats", { ptptstats_data: null, ptptstats_math_tick: null }],
    ["math_ticks", { ticks_math_tick: null }],
  ])(
    "a missing %s companion is refused, not served torn",
    async (companion, overrides) => {
      serve(overrides as Record<string, unknown>);
      const read = await loadBundle(freshZid());
      if (!read.present || read.admitted) throw new Error("expected refusal");
      expect(read.refusal).toEqual({ reason: "missing_companion", companion });
      // Main is still reported: a main-only consumer may legitimately continue.
      expect(read.mathTick).toBe(7);
      expect(read.main["base-clusters"]).toBeDefined();
    }
  );

  test.each([
    ["math_bidtopid", "bidtopid_math_tick"],
    ["math_ptptstats", "ptptstats_math_tick"],
    ["math_ticks", "ticks_math_tick"],
  ])("a %s at another generation is refused", async (companion, column) => {
    serve({ [column]: "9" });
    const read = await loadBundle(freshZid());
    if (!read.present || read.admitted) throw new Error("expected refusal");
    expect(read.refusal).toEqual({
      reason: "tick_mismatch",
      companion,
      companionTick: 9,
      mainTick: 7,
    });
  });
});

describe("the accessors are pure and exact", () => {
  test("pidsForGid joins through the Bundle's own mapping", () => {
    const bundle = admittedBundle();
    expect(pidsForGid(bundle, 0)).toEqual([1]);
    expect(pidsForGid(bundle, 1)).toEqual([2]);
    expect(pidsForGid(bundle, 2)).toEqual([]);
    // Purity: no query was issued to answer any of those.
    expect(queryP_readOnly).not.toHaveBeenCalled();
  });

  test("a substituted mapping changes the answer, so the expectation discriminates", () => {
    // The reviewer's control: a reader that ignored its mapping and returned an
    // arbitrary nonempty pid list would pass a "nonempty" assertion. It cannot
    // pass these.
    const swapped = admittedBundle({
      bidtopid_data: { bidToPid: [[999], [998]], math_tick: 34807 },
    });
    expect(pidsForGid(swapped, 0)).toEqual([999]);
    expect(pidsForGid(swapped, 0)).not.toEqual(pidsForGid(admittedBundle(), 0));
  });

  test("bidsForPids maps every pid, and leaves an unplaced pid undefined", () => {
    const bundle = admittedBundle();
    expect(bidsForPids(bundle, [1, 2, 3])).toEqual({
      1: 10,
      2: 20,
      3: undefined,
    });
    expect(queryP_readOnly).not.toHaveBeenCalled();
  });
});

describe("the bounded whole-Bundle cache", () => {
  test("has an explicit size bound", () => {
    expect(MATH_BUNDLE_CACHE_MAX).toBe(100);
  });

  test("a second read inside the TTL issues no statement", async () => {
    serve();
    const zid = freshZid();
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(1);
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(1);
  });

  test("namespaces do not share an entry", async () => {
    serve();
    const zid = freshZid();
    await getMathBundle(zid, "prod");
    await getMathBundle(zid, "python");
    expect(queryP_readOnly).toHaveBeenCalledTimes(2);
    expect(queryP_readOnly.mock.calls[0][1]).toEqual([zid, "prod"]);
    expect(queryP_readOnly.mock.calls[1][1]).toEqual([zid, "python"]);
  });

  test("invalidation is by tick: a new generation drops the entry, the same one keeps it", async () => {
    serve();
    const zid = freshZid();
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(1);

    invalidateMathBundleForTick("test-math-env", zid, 7); // still generation 7
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(1);

    invalidateMathBundleForTick("test-math-env", zid, 8); // a newer generation
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(2);
  });

  test("a refusal is cached too, and is retired by the same tick rule", async () => {
    serve({ bidtopid_data: null, bidtopid_math_tick: null });
    const zid = freshZid();
    const first = await getMathBundle(zid);
    expect(first.present && first.admitted).toBe(false);
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(1);
    invalidateMathBundleForTick("test-math-env", zid, 8);
    await getMathBundle(zid);
    expect(queryP_readOnly).toHaveBeenCalledTimes(2);
  });

  test("the bound is enforced: entry MAX+1 evicts the oldest", async () => {
    serve();
    const zids: number[] = [];
    for (let i = 0; i < MATH_BUNDLE_CACHE_MAX; i++) {
      const zid = freshZid();
      zids.push(zid);
      await getMathBundle(zid);
    }
    expect(queryP_readOnly).toHaveBeenCalledTimes(MATH_BUNDLE_CACHE_MAX);
    // Every one of them is still resident.
    await getMathBundle(zids[MATH_BUNDLE_CACHE_MAX - 1]);
    expect(queryP_readOnly).toHaveBeenCalledTimes(MATH_BUNDLE_CACHE_MAX);
    // One more conversation, and the least recently used one is gone.
    await getMathBundle(freshZid());
    await getMathBundle(zids[0]);
    expect(queryP_readOnly).toHaveBeenCalledTimes(MATH_BUNDLE_CACHE_MAX + 2);
  });

  test("no comment-owned field is ever cached with the math generation", async () => {
    serve();
    const read = await getMathBundle(freshZid());
    if (!read.present || !read.admitted) throw new Error("expected admission");
    // `tids` / `n-cmts` are comment-owned: they change at an unchanged math
    // tick, so they must not be reachable from a tick-keyed cache entry.
    const cached = JSON.stringify(read.bundle);
    expect(cached).not.toContain("n-cmts");
    expect(read.bundle.main.tids).toBeUndefined();
  });
});
