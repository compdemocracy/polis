// The ε-arm of next-statement routing and the serve log
// (PROPENSITY-LOGGING-DESIGN.md sections 4 and 5). Selection code is real;
// storage, math, configuration and the topic store are stubs, and
// Math.random is a scripted sequence that fails on any unexpected draw.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

const mockComments = jest.fn<(params: any) => Promise<any[]>>();
const mockCounts = jest.fn<() => Promise<any[]>>();
const mockEligibleCount = jest.fn<(params: any) => Promise<number>>();
const mockPriorities = jest.fn<() => Promise<any>>();
const mockGeneration = jest.fn<(p: unknown) => any>();
const mockQuery = jest.fn<(sql: string, params?: any[]) => Promise<any[]>>();
const mockClusterTids = jest.fn<() => Promise<number[]>>();
const mockLoggerError = jest.fn();
const mockConfig: Record<string, any> = {};

jest.mock("../../src/comment", () => ({
  getComments: mockComments,
  getNumberOfCommentsRemaining: mockCounts,
  countEligibleComments: mockEligibleCount,
  translateAndStoreComment: jest.fn(),
}));
jest.mock("../../src/utils/pca", () => ({
  getLatestCommentPriorities: mockPriorities,
  commentPrioritiesGeneration: mockGeneration,
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: mockQuery },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: mockConfig,
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
  },
}));
jest.mock("../../src/utils/commentClusters", () => ({
  getCommentIdsForClusters: mockClusterTids,
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: jest.fn() }));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async () => ({ Items: [{ layer_id: 0, cluster_id: 1 }] }),
    }),
  },
  QueryCommand: jest.fn(),
}));

import {
  checkInitialComment,
  getNextComment,
  routingPropensity,
} from "../../src/nextComment";

const ZID = 7;
const PID = 3;
const ELIGIBLE = 1200; // more than the 999-statement lottery window
let rows: Array<{ zid: number; tid: number; txt: string }>;
let sequence: number[];
let draws: number[];

function script(...values: number[]) {
  sequence = values;
}

// The columns of the one serve-log insert, zipped with its parameters.
function serveRows(): Array<Record<string, unknown>> {
  return mockQuery.mock.calls
    .filter(([sql]) => /insert into comment_serve_log/i.test(sql))
    .map(([sql, params]) => {
      const columns = /comment_serve_log\s*\(([^)]*)\)/i
        .exec(sql)![1]
        .split(",")
        .map((c) => c.trim());
      expect(params).toHaveLength(columns.length);
      return Object.fromEntries(columns.map((c, i) => [c, params![i]]));
    });
}

function topicalQueried() {
  return mockQuery.mock.calls.some(([sql]) =>
    sql.includes("topic_agenda_selections")
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = Array.from({ length: ELIGIBLE }, (_, tid) => ({
    zid: ZID,
    tid,
    txt: `Statement ${tid}`,
  }));
  Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  Object.assign(mockConfig, {
    mathEnv: "prod",
    getValidTopicalRatio: () => null,
    getValidRoutingEpsilon: () => null,
  });
  // As the database: ORDER BY created, OFFSET, then the default LIMIT 999;
  // the count applies the same filter with neither.
  const eligible = (params: any) =>
    rows.filter(
      (r) =>
        (!params.tids || params.tids.includes(r.tid)) &&
        !(params.withoutTids ?? []).includes(r.tid)
    );
  mockComments.mockImplementation(async (params) => {
    const offset = params.offset ?? 0;
    return eligible(params)
      .slice(offset, offset + (params.limit ?? 999))
      .map((r) => ({ ...r }));
  });
  mockEligibleCount.mockImplementation(
    async (params) => eligible(params).length
  );
  mockCounts.mockResolvedValue([{ total: ELIGIBLE, remaining: ELIGIBLE }]);
  mockPriorities.mockResolvedValue({ 5: 2 }); // window weight sum 998 + 2
  // As the real function: only a map handed out by pca has a generation.
  mockGeneration.mockImplementation((p) =>
    p ? { mathTick: 12, mathEnv: "prod" } : undefined
  );
  mockQuery.mockResolvedValue([]);
  mockClusterTids.mockResolvedValue([4, 5, 6]);
  draws = [];
  sequence = [];
  jest.spyOn(Math, "random").mockImplementation(() => {
    const n = sequence.shift();
    if (n === undefined) throw new Error("unexpected Math.random draw");
    draws.push(n);
    return n;
  });
});
afterEach(() => jest.restoreAllMocks());

describe("routingPropensity", () => {
  const base = {
    epsilon: 0,
    topicalRatio: 0,
    m: null as number | null,
    inWindow: true,
    weight: 2 as number | null,
    weightSum: 4,
  };
  test("ε off: the lottery share alone", () => {
    expect(routingPropensity(base)).toBeCloseTo(0.5, 12);
    expect(routingPropensity({ ...base, epsilon: null })).toBeCloseTo(0.5, 12);
  });
  test("ε mixes the uniform share 1/m with the lottery share", () => {
    expect(
      routingPropensity({ ...base, epsilon: 0.5, m: 4, weight: 1 })
    ).toBeCloseTo(0.5 * 0.25 + 0.5 * 0.25, 12);
  });
  test("outside the window only the uniform share remains", () => {
    expect(
      routingPropensity({
        ...base,
        epsilon: 0.5,
        m: 2000,
        inWindow: false,
        weight: null,
      })
    ).toBeCloseTo(0.5 / 2000, 15);
    expect(routingPropensity({ ...base, inWindow: false, weight: null })).toBe(
      0
    );
  });
  test("the topical ratio scales the lottery share by (1 - r)", () => {
    expect(
      routingPropensity({
        ...base,
        epsilon: 0.5,
        topicalRatio: 0.6,
        m: 10,
        weight: 3,
        weightSum: 6,
      })
    ).toBeCloseTo(0.05 + 0.5 * 0.4 * 0.5, 12);
  });
  test("ε = 1 is uniform over all m", () => {
    expect(
      routingPropensity({ ...base, epsilon: 1, m: 8, inWindow: false })
    ).toBeCloseTo(0.125, 12);
  });
  test("not computable: ε > 0 without m, or an empty weight sum", () => {
    expect(routingPropensity({ ...base, epsilon: 0.5, m: null })).toBeNull();
    expect(routingPropensity({ ...base, epsilon: 0.5, m: 0 })).toBeNull();
    expect(routingPropensity({ ...base, weightSum: 0 })).toBeNull();
  });
});

describe("getNextComment with the ε-arm off", () => {
  test.each([
    ["unset", null],
    ["zero", 0],
  ])(
    "ε %s: one draw, the capped query, unchanged lottery",
    async (_label, epsilon) => {
      mockConfig.getValidRoutingEpsilon = () => epsilon;
      script(0.5); // lottery: 0.5 * 1000 = 500 -> cumulative 501 at tid 499
      const next = await getNextComment(ZID, PID, []);
      expect(next?.tid).toBe(499);
      expect(draws).toEqual([0.5]);
      expect(mockComments).toHaveBeenCalledTimes(1);
      expect(mockComments.mock.calls[0][0]).not.toHaveProperty("limit");
      expect(mockEligibleCount).not.toHaveBeenCalled();
    }
  );

  test("no serve log when the flag is absent (the routing harness's Config)", async () => {
    script(0.5);
    await getNextComment(ZID, PID, []);
    expect(serveRows()).toEqual([]);
  });

  test("the harness Config has no ε reader: routing still runs, ε off", async () => {
    delete mockConfig.getValidRoutingEpsilon;
    script(0.5);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(499);
    expect(draws).toEqual([0.5]);
  });

  test("serve log with ε off: lottery propensity, eligible count unknown when the window is full", async () => {
    mockConfig.routingServeLog = true;
    script(0.5);
    await getNextComment(ZID, PID, []);
    const [row] = serveRows();
    expect(row).toMatchObject({
      zid: ZID,
      pid: PID,
      tid: 499,
      branch: "priority",
      epsilon: 0,
      topical_ratio: null,
      math_env: "prod",
      math_tick: 12,
      pool_size: 999,
      eligible_count: null,
      weight: 1,
      weight_sum: 1000,
      random_n: 500,
      topical_pool_size: null,
    });
    expect(row.propensity as number).toBeCloseTo(1 / 1000, 15);
  });

  test("serve log with ε off and a short pool records its size as m", async () => {
    mockConfig.routingServeLog = true;
    rows = rows.slice(0, 3);
    mockPriorities.mockResolvedValue(undefined);
    mockGeneration.mockReturnValue(undefined);
    script(0.0);
    await getNextComment(ZID, PID, []);
    expect(serveRows()[0]).toMatchObject({
      tid: 0,
      pool_size: 3,
      eligible_count: 3,
      math_tick: null,
      math_env: null,
      weight: 1,
      weight_sum: 3,
    });
  });
});

describe("getNextComment with ROUTING_EPSILON = 0.5", () => {
  beforeEach(() => {
    mockConfig.getValidRoutingEpsilon = () => 0.5;
  });

  test("ε branch: m from the count, then the row at offset floor(r * m)", async () => {
    script(0.2, 0.9); // ε coin, then the uniform position
    const next = await getNextComment(ZID, PID, [77]);
    expect(next?.tid).toBe(Math.floor(0.9 * (ELIGIBLE - 1)) + 1); // past tid 77
    expect(draws).toEqual([0.2, 0.9]);
    // The count and the offset read use the window query's own filters.
    expect(mockEligibleCount).toHaveBeenCalledTimes(1);
    expect(mockEligibleCount.mock.calls[0][0]).toEqual(
      mockComments.mock.calls[0][0]
    );
    expect(mockComments.mock.calls[0][0]).not.toHaveProperty("limit");
    expect(mockComments.mock.calls[0][0]).toMatchObject({
      not_voted_by_pid: PID,
      withoutTids: [77],
    });
    expect(mockComments).toHaveBeenCalledTimes(2);
    expect(mockComments.mock.calls[1][0]).toEqual({
      ...mockComments.mock.calls[0][0],
      limit: 1,
      offset: Math.floor(0.9 * (ELIGIBLE - 1)),
    });
  });

  test("ε branch reaches past the 999 window", async () => {
    script(0.2, 0.9);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(1080);
  });

  test("priority branch: the window query and the count, no offset read", async () => {
    script(0.7, 0.999999);
    const next = await getNextComment(ZID, PID, []);
    expect(next?.tid).toBe(998);
    expect(draws).toEqual([0.7, 0.999999]);
    expect(mockComments).toHaveBeenCalledTimes(1);
    expect(mockComments.mock.calls[0][0]).not.toHaveProperty("limit");
    expect(mockEligibleCount).toHaveBeenCalledTimes(1);
  });

  test("an ε draw whose row is gone falls back to the lottery, labelled", async () => {
    mockConfig.routingServeLog = true;
    mockComments.mockImplementation(async (params) =>
      params.offset === undefined
        ? rows.slice(0, 999).map((r) => ({ ...r }))
        : []
    );
    script(0.2, 0.9, 0.5);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(499);
    expect(draws).toEqual([0.2, 0.9, 0.5]);
    expect(serveRows()[0]).toMatchObject({
      tid: 499,
      branch: "priority_after_epsilon_miss",
      eligible_count: ELIGIBLE,
      random_n: 500,
      weight: 1,
    });
  });

  test("the ε coin comes before the topical coin; the ε branch skips topical", async () => {
    mockConfig.getValidTopicalRatio = () => 1;
    script(0.2, 0.0);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(0);
    expect(draws).toEqual([0.2, 0.0]);
    expect(topicalQueried()).toBe(false);
  });

  test("ε branch serve row", async () => {
    mockConfig.routingServeLog = true;
    script(0.2, 0.9);
    await getNextComment(ZID, PID, []);
    const [row] = serveRows();
    expect(row).toMatchObject({
      tid: 1080,
      branch: "epsilon",
      epsilon: 0.5,
      pool_size: 999,
      eligible_count: ELIGIBLE,
      weight: null,
      weight_sum: 1000,
      random_n: null,
      math_tick: 12,
    });
    expect(row.propensity as number).toBeCloseTo(0.5 / ELIGIBLE, 15);
  });

  test("priority branch serve row mixes both shares", async () => {
    mockConfig.routingServeLog = true;
    script(0.7, 0.999999);
    await getNextComment(ZID, PID, []);
    const [row] = serveRows();
    expect(row).toMatchObject({
      tid: 998,
      branch: "priority",
      pool_size: 999,
      eligible_count: ELIGIBLE,
      weight: 1,
      weight_sum: 1000,
    });
    expect(row.random_n as number).toBeCloseTo(999.999, 9);
    expect(row.propensity as number).toBeCloseTo(
      0.5 / ELIGIBLE + 0.5 * (1 / 1000),
      15
    );
  });

  test("topical fallback (no agenda): both coins end in the lottery, so r counts as 0", async () => {
    mockConfig.routingServeLog = true;
    mockConfig.getValidTopicalRatio = () => 0.6;
    // No agenda row: the topical path falls back to the lottery.
    script(0.7, 0.1, 0.0);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(0);
    expect(topicalQueried()).toBe(true);
    const [row] = serveRows();
    expect(row).toMatchObject({
      branch: "priority_after_topical_fallback",
      topical_ratio: 0.6,
      tid: 0,
    });
    expect(row.propensity as number).toBeCloseTo(
      0.5 / ELIGIBLE + 0.5 * (1 / 1000),
      15
    );
  });

  test("priority branch with topical routing on: agenda unknown, no propensity", async () => {
    mockConfig.routingServeLog = true;
    mockConfig.getValidTopicalRatio = () => 0.6;
    script(0.7, 0.9, 0.5); // no ε, no topical, lottery
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(499);
    expect(serveRows()[0]).toMatchObject({
      branch: "priority",
      topical_ratio: 0.6,
      propensity: null,
    });
  });

  test("ε branch with topical routing on: agenda unknown, no propensity", async () => {
    mockConfig.routingServeLog = true;
    mockConfig.getValidTopicalRatio = () => 0.6;
    script(0.2, 0.9);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(1080);
    expect(serveRows()[0]).toMatchObject({
      branch: "epsilon",
      propensity: null,
    });
  });

  test("a topical lookup that throws falls back, labelled, with no propensity", async () => {
    mockConfig.routingServeLog = true;
    mockConfig.getValidTopicalRatio = () => 0.6;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("topic_agenda_selections")) throw new Error("offline");
      return [];
    });
    script(0.7, 0.1, 0.5);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(499);
    expect(serveRows()[0]).toMatchObject({
      branch: "priority_after_topical_error",
      tid: 499,
      propensity: null,
    });
  });

  test("priority branch serving an in-window tid of priority 2: weight 2, exact π", async () => {
    mockConfig.routingServeLog = true;
    script(0.7, 0.006); // randomN = 6: cumulative 5 at tid 4, 7 at tid 5
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(5);
    const [row] = serveRows();
    expect(row).toMatchObject({
      branch: "priority",
      weight: 2,
      weight_sum: 1000,
    });
    expect(row.propensity as number).toBeCloseTo(
      0.5 / ELIGIBLE + 0.5 * (2 / 1000),
      15
    );
  });

  test("ε branch landing in the window: π = ε/m + (1 − ε)·w/Σw", async () => {
    mockConfig.routingServeLog = true;
    script(0.2, 0.0045); // offset floor(0.0045 * 1200) = 5
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(5);
    const [row] = serveRows();
    expect(row).toMatchObject({
      branch: "epsilon",
      weight: 2,
      weight_sum: 1000,
    });
    expect(row.propensity as number).toBeCloseTo(
      0.5 / ELIGIBLE + 0.5 * (2 / 1000),
      15
    );
  });

  test("anonymous pid -1 is routed and logged; topical never applies to it", async () => {
    mockConfig.routingServeLog = true;
    mockConfig.getValidTopicalRatio = () => 0.6;
    script(0.7, 0.1, 0.0);
    expect((await getNextComment(ZID, -1, []))?.tid).toBe(0);
    expect(topicalQueried()).toBe(false);
    const [row] = serveRows();
    expect(row).toMatchObject({ pid: -1, branch: "priority", tid: 0 });
    expect(row.propensity as number).toBeCloseTo(
      0.5 / ELIGIBLE + 0.5 * (1 / 1000),
      15
    );
  });

  test("nothing to serve: a row with no tid and no propensity", async () => {
    mockConfig.routingServeLog = true;
    rows = [];
    script(0.2);
    expect(await getNextComment(ZID, PID, [])).toBeNull();
    expect(draws).toEqual([0.2]);
    expect(serveRows()[0]).toMatchObject({
      tid: null,
      branch: "epsilon",
      pool_size: 0,
      eligible_count: 0,
      propensity: null,
    });
  });
});

describe("who was served", () => {
  beforeEach(() => {
    mockConfig.routingServeLog = true;
  });
  test("the requester's uid is logged; absent, it is null", async () => {
    script(0.5, 0.5);
    await getNextComment(ZID, -1, [], undefined, 55);
    await getNextComment(ZID, PID, []);
    const [first, second] = serveRows();
    expect(first).toMatchObject({ pid: -1, uid: 55 });
    expect(second).toMatchObject({ pid: PID, uid: null });
  });
  test("an undefined pid is logged as -1, so the row is never refused", async () => {
    script(0.5);
    await getNextComment(ZID, undefined, []);
    expect(serveRows()[0]).toMatchObject({ pid: -1, tid: 499 });
  });
  test("an eligible initial_tid is logged as branch 'initial', no draw", async () => {
    const result = await checkInitialComment(ZID, PID, 7, undefined, 55);
    expect(result.status).toBe("eligible");
    expect(draws).toEqual([]);
    expect(serveRows()).toHaveLength(1);
    expect(serveRows()[0]).toMatchObject({
      zid: ZID,
      pid: PID,
      uid: 55,
      tid: 7,
      branch: "initial",
      pool_size: 0,
      propensity: null,
      random_n: null,
    });
  });
  test("an unavailable initial_tid logs nothing", async () => {
    rows = rows.filter((r) => r.tid !== 7);
    expect((await checkInitialComment(ZID, PID, 7)).status).toBe("unavailable");
    expect(serveRows()).toHaveLength(0);
  });
});

describe("topical branch serve row", () => {
  test("records the agenda pool and no propensity", async () => {
    mockConfig.routingServeLog = true;
    mockConfig.getValidTopicalRatio = () => 1;
    mockQuery.mockImplementation(async (sql: string) =>
      sql.includes("topic_agenda_selections")
        ? [{ archetypal_selections: [{ topic_key: "k" }], delphi_job_id: "j" }]
        : []
    );
    mockComments.mockImplementation(async (params) =>
      params.tids ? [{ ...rows[5] }] : []
    );
    script(0.1);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(5);
    expect(serveRows()[0]).toMatchObject({
      tid: 5,
      branch: "topical",
      topical_ratio: 1,
      topical_pool_size: 3,
      pool_size: 0,
      propensity: null,
      math_tick: null,
    });
  });
});

describe("the serve log never holds or fails the response", () => {
  beforeEach(() => {
    mockConfig.routingServeLog = true;
  });
  test("an insert that never settles", async () => {
    mockQuery.mockImplementation(() => new Promise<any[]>(() => undefined));
    script(0.5);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(499);
    expect(serveRows()).toHaveLength(1);
  });
  test("an insert that fails is logged", async () => {
    mockQuery.mockRejectedValue(new Error("offline"));
    script(0.5);
    expect((await getNextComment(ZID, PID, []))?.tid).toBe(499);
    await new Promise((r) => setImmediate(r));
    expect(mockLoggerError).toHaveBeenCalledWith(
      "polis_err_comment_serve_log",
      expect.anything()
    );
  });
});
