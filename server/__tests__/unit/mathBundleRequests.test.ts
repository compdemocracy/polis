import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

const queryP_readOnly = jest.fn();
const queryP = jest.fn();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP_readOnly,
    queryP,
    query_readOnly: (_s: string, _p: any[], cb: any) => cb(null, { rows: [] }),
  },
}));

jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    mathEnv: "test-math-env",
    cacheMathResults: true,
    AWS_REGION: "us-east-1",
    getValidTopicalRatio: () => 0,
  },
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
  MPromise: function (_name: string, resolver: any) {
    return new Promise(resolver);
  },
}));

// --- doFamousQuery collaborators -----------------------------------------
jest.mock("../../src/conversation", () => ({
  __esModule: true,
  getConversationInfo: () => Promise.resolve({ zid: 1, is_anon: false }),
  getConversationHasMetadata: () => Promise.resolve(false),
}));

jest.mock("../../src/routes/metadata", () => ({
  __esModule: true,
  getConversationHasMetadata: () => Promise.resolve(false),
}));

jest.mock("../../src/participant", () => ({
  __esModule: true,
  getSocialParticipants: () => Promise.resolve([{uid: 7, pid: 1, priority: 1}]),
  addParticipant: () => Promise.resolve({}),
}));

jest.mock("../../src/user", () => ({
  __esModule: true,
  getUserInfoForUid2: () => Promise.resolve({ uid: 7 }),
  getPidPromise: () => Promise.resolve(11),
}));

jest.mock("../../src/utils/zinvite", () => ({
  __esModule: true,
  getZinvite: () => Promise.resolve("abc"),
  getZinvites: () => Promise.resolve([]),
  getZidForRid: () => Promise.resolve(1),
}));

jest.mock("../../src/email/senders", () => ({
  __esModule: true,
  sendTextEmail: () => Promise.resolve(),
}));


// These modules are REAL: no accessor or presentation stub can hide a second read.
import { doFamousQuery } from "../../src/server-helpers";
import { getPca, getPcaFromBundle } from "../../src/utils/pca";
import { getMathBundle, clearMathBundleCache } from "../../src/utils/mathBundle";

let now = 0;
let generation = 1;
let zid = 950000;
let events: string[] = [];
let authorSql: string[] = [];
function main(g: number) {
  return {
    "group-clusters": [{id: 0, members: [g * 10]}],
    "base-clusters": {id: [g * 10], members: [[1]], x: [0], y: [0], count: [1]},
    "in-conv": [1], "n-cmts": 0, tids: [], n: 1,
    pca: {comps: [[], []], center: [0, 0], "comment-extremity": []},
    repness: {}, consensus: {agree: [{tid: g}], disagree: []}, math_tick: g,
  };
}
beforeEach(() => {
  zid++; now = 0; generation = 1; events = []; authorSql = [];
  clearMathBundleCache();
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const query = (async (sql: string) => {
    if (sql.includes("from math_main m")) {
      const g = generation; events.push(`bundle${g}`);
      return [{main_data: main(g), main_math_tick: g, main_caching_tick: g,
        last_vote_timestamp: 0, bidtopid_data: {bidToPid: [[1]]},
        bidtopid_math_tick: g, ptptstats_data: {}, ptptstats_math_tick: g, ticks_math_tick: g}];
    }
    if (sql.includes("from math_main")) {
      events.push(`main${generation}`);
      return [{data: main(generation), math_tick: generation}];
    }
    if (sql.includes("authors as")) {
      authorSql.push(sql);
      // Publication between featured-author selection and bucket assignment.
      generation = 2; clearMathBundleCache();
      return [{uid: 7}];
    }
    if (sql.includes("from votes")) return [{pid: 1, tid: 0, vote: 0, weight: 32767}];
    return [];
  }) as never;
  queryP_readOnly.mockImplementation(query); queryP.mockImplementation(query);
});
afterEach(() => jest.restoreAllMocks());

test("one famous request retains its featured generation across a publication and cache eviction", async () => {
  const result = await doFamousQuery({uid: 7, zid, math_tick: -1, ptptoiLimit: 30});
  expect(authorSql[0]).toContain("tid in (1)");
  expect(result[1].bid).toBe(10);
  expect(events).toEqual(["bundle1"]);
});

test("a warm independent presentation cache cannot choose a different featured generation", async () => {
  await getPca(zid);
  generation = 2;
  const result = await doFamousQuery({uid: 7, zid, math_tick: -1, ptptoiLimit: 30});
  expect(authorSql[0]).toContain("tid in (2)");
  expect(result[1].bid).toBe(20);
  expect(events).toEqual(["main1", "bundle2"]);
});

test("near-expired bundle cannot renew old math in the shared presentation cache", async () => {
  await getMathBundle(zid);
  generation = 2; now = 2900;
  const old = await getPcaFromBundle(zid);
  expect(old?.asPOJO.math_tick).toBe(1);
  expect(old?.expiration).toBe(3000);
  now = 3000;
  expect((await getPca(zid))?.asPOJO.math_tick).toBe(2);
  now = 5800;
  expect((await getPca(zid))?.asPOJO.math_tick).toBe(2);
  expect((await getPca(zid + 100))?.asPOJO.math_tick).toBe(2);
});
