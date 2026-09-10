// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Round 2 of P-040: the two internal callers that passed a literal
// `getPca(zid, 0)`.
//
// A literal 0 means "give me something strictly NEWER than generation 0". A
// conversation's first committed generation IS 0 (`math_ticks.math_tick BIGINT
// NOT NULL DEFAULT 0`), so both callers silently discarded real math for the
// whole first-generation window:
//
//   nextComment.ts:72       lost `comment-priorities` -> unprioritized routing
//   server-helpers.ts:287   lost the consensus/repness tids -> no featured
//                           comment authors at all
//
// The second reviewer's review rejected treating that as a cost-authorized waiver, and asked
// for a latest-EXISTING read that still returns undefined after a single query
// when a conversation has no math row. That is `getLatestExistingPca`.
//
// These tests drive the real `getNextComment` and the real `doFamousQuery` over
// real loopback HTTP, with the real `src/utils/pca.ts`. They mount those two
// functions on thin express routes rather than importing `routes/comments.ts`
// and `routes/votes.ts`: the changed lines live in `nextComment.ts` and
// `server-helpers.ts`, and both route handlers are thin pass-throughs, so
// pulling in their unrelated import graphs (auth0, csv-parse, badwords,
// moderation, ...) would mock far more than it proves.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import express from "express";
import request from "supertest";

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

// --- nextComment collaborators -------------------------------------------
// Two comments, neither voted on. Real `selectProbabilistically` decides which
// one is returned, from the priorities the real pca reader supplies.
const COMMENTS = [
  { tid: 0, txt: "comment zero", zid: 1 },
  { tid: 1, txt: "comment one", zid: 1 },
];

jest.mock("../../src/comment", () => ({
  __esModule: true,
  getComments: () => Promise.resolve(COMMENTS.map((c) => ({ ...c }))),
  getNumberOfCommentsRemaining: () =>
    Promise.resolve([{ total: 2, remaining: 2 }]),
  translateAndStoreComment: (c: unknown) => Promise.resolve(c),
}));

jest.mock("../../src/utils/commentClusters", () => ({
  __esModule: true,
  getCommentIdsForClusters: () => Promise.resolve([]),
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
  getSocialParticipants: () => Promise.resolve([]),
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

// doFamousQuery ALSO calls getBidsForPids(zid, -1, pids) further down
// (server-helpers.ts:387). That call is pre-existing, unrelated to the line
// under test, and on a no-row conversation it synthesizes an empty presentation
// of its own -- which would mask the query-count assertions below. Stubbed so
// the counts measure only getAuthorUidsOfFeaturedComments.
jest.mock("../../src/routes/math", () => ({
  __esModule: true,
  getBidsForPids: () => Promise.resolve({}),
}));

import { getNextComment } from "../../src/nextComment";
import { doFamousQuery } from "../../src/server-helpers";

// Priorities that make the choice observable: with them, tid 0 wins; without
// them every comment defaults to weight 1 and tid 1 wins. The second reviewer's review used
// exactly this shape ({0:100, 1:1}, random fraction 0.75).
const PRIORITIES = { "0": 100, "1": 1 };
const FIXED_RANDOM = 0.75;

function mathBlob() {
  return {
    "group-clusters": [],
    "base-clusters": { x: [], y: [], id: [], count: [], members: [] },
    "group-votes": {},
    "group-aware-consensus": {},
    "user-vote-counts": {},
    "in-conv": [11],
    "n-cmts": 2,
    pca: {
      comps: [[], []],
      center: [0, 0],
      "comment-extremity": [0, 0],
      "comment-projection": {},
    },
    tids: [0, 1],
    n: 1,
    repness: {},
    // Featured-comment input for doFamousQuery.
    consensus: { agree: [{ tid: 0 }], disagree: [{ tid: 1 }] },
    "votes-base": {},
    lastModTimestamp: null,
    lastVoteTimestamp: 1700000000000,
    "comment-priorities": PRIORITIES,
    math_tick: 34807, // engine-local blob clock, never the served tick
  };
}

// Every SQL string the reader path issues, so a test can assert on cost as well
// as behaviour.
let sqlSeen: string[] = [];

function installPg(mathRow: { math_tick: string } | null) {
  const impl = ((sql: string) => {
    const s = String(sql);
    sqlSeen.push(s);
    if (s.includes("from math_main m")) {
      return Promise.resolve(mathRow ? [{
        main_data: mathBlob(), main_math_tick: mathRow.math_tick,
        main_caching_tick: mathRow.math_tick, last_vote_timestamp: 0,
        bidtopid_data: {bidToPid: []}, bidtopid_math_tick: mathRow.math_tick,
        ptptstats_data: {}, ptptstats_math_tick: mathRow.math_tick,
        ticks_math_tick: mathRow.math_tick,
      }] : []);
    }
    if (s.includes("from math_main")) {
      return Promise.resolve(
        mathRow ? [{ data: mathBlob(), math_tick: mathRow.math_tick }] : []
      );
    }
    // The featured-comment author join inside doFamousQuery.
    if (s.includes("authors as (select distinct(uid) from comments")) {
      return Promise.resolve([{ uid: 7 }]);
    }
    // createEmptyPcaStructure's synthesis query. Reaching it on a no-row
    // conversation is exactly the extra cost getLatestExistingPca avoids.
    if (s.includes("select tid from comments")) {
      return Promise.resolve([{ tid: 0 }, { tid: 1 }]);
    }
    return Promise.resolve([]);
  }) as never;
  queryP_readOnly.mockImplementation(impl);
  queryP.mockImplementation(impl);
}

const countSql = (needle: string) =>
  sqlSeen.filter((s) => s.includes(needle)).length;

let nextZid = 700000;
const freshZid = () => (nextZid += 1);

/** Mounts one async function on a real express route. */
function routeFor(run: (zid: number) => Promise<unknown>) {
  const app = express();
  app.get("/route/:zid", async (req: any, res: any) => {
    try {
      res.status(200).json((await run(Number(req.params.zid))) ?? null);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
  return app;
}

const nextCommentApp = routeFor((zid) => getNextComment(zid, 11, [], "en"));
const famousApp = routeFor((zid) =>
  doFamousQuery({ uid: 7, zid, math_tick: -1, ptptoiLimit: 30 })
);

describe("nextComment over HTTP reads the latest EXISTING generation", () => {
  let randomSpy: any;

  beforeEach(() => {
    sqlSeen = [];
    queryP_readOnly.mockReset();
    queryP.mockReset();
    randomSpy = jest.spyOn(Math, "random").mockReturnValue(FIXED_RANDOM);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  test("generation 0's comment-priorities decide the routing", async () => {
    // Pre-fix (`getPca(zid, 0)`) the priorities were dropped and every comment
    // defaulted to weight 1, so this returned tid 1. That is a routing
    // difference, not a missing optional label.
    installPg({ math_tick: "0" });
    const res = await request(nextCommentApp).get(`/route/${freshZid()}`);
    expect(res.status).toBe(200);
    expect(res.body.tid).toBe(0);
  });

  test("generation 1 is unchanged", async () => {
    installPg({ math_tick: "1" });
    const res = await request(nextCommentApp).get(`/route/${freshZid()}`);
    expect(res.status).toBe(200);
    expect(res.body.tid).toBe(0);
  });

  test("a conversation with no math row still routes, and still costs one query", async () => {
    // The cheap path the second reviewer asked to preserve: no `math_main` row means one
    // query and an immediate undefined -- never createEmptyPcaStructure's
    // second `select tid from comments` synthesis.
    installPg(null);
    const res = await request(nextCommentApp).get(`/route/${freshZid()}`);
    expect(res.status).toBe(200);
    expect(res.body.tid).toBe(1); // unprioritized fallback, as before
    expect(countSql("from math_main")).toBe(1);
    expect(countSql("select tid from comments")).toBe(0);
  });
});

describe("doFamousQuery over HTTP reads the latest EXISTING generation", () => {
  beforeEach(() => {
    sqlSeen = [];
    queryP_readOnly.mockReset();
    queryP.mockReset();
  });

  test("generation 0's consensus produces featured-comment authors", async () => {
    // Pre-fix the reader returned undefined, featuredTids was empty, and the
    // author join was never issued -- getAuthorUidsOfFeaturedComments returned
    // []. Now the real consensus tids reach the real join.
    installPg({ math_tick: "0" });
    const res = await request(famousApp).get(`/route/${freshZid()}`);
    expect(res.status).toBe(200);
    const authorJoins = sqlSeen.filter((s) =>
      s.includes("authors as (select distinct(uid) from comments")
    );
    expect(authorJoins).toHaveLength(1);
    // Both consensus tids, from the committed generation-0 blob.
    expect(authorJoins[0]).toContain("tid in (0,1)");
  });

  test("generation 1 is unchanged", async () => {
    installPg({ math_tick: "1" });
    const res = await request(famousApp).get(`/route/${freshZid()}`);
    expect(res.status).toBe(200);
    expect(countSql("authors as (select distinct(uid) from comments")).toBe(1);
  });

  test("a conversation with no math row issues no author join and no synthesis query", async () => {
    installPg(null);
    const res = await request(famousApp).get(`/route/${freshZid()}`);
    expect(res.status).toBe(200);
    expect(countSql("authors as (select distinct(uid) from comments")).toBe(0);
    expect(countSql("from math_main")).toBe(1);
    expect(countSql("select tid from comments")).toBe(0);
  });
});
