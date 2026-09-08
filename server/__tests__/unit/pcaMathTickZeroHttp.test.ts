// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// HTTP-level companion to pcaMathTickZero.test.ts.
//
// Generation 0 reaches different routes differently, and the difference is
// entirely each route's `want("math_tick", ...)` default in server/app.ts:
//
//   /api/v3/math/pca2   want("math_tick", getInt, assignToP)      -> undefined
//                       routes/math.ts:82 then substitutes -1     -> SERVED
//   /api/v3/bid         want("math_tick", getInt, assignToP, 0)   -> 0
//                       0 is not newer than 0                     -> was a 500
//
// These tests mount the real exported handlers on a real express app and drive
// them with real HTTP requests, replicating only app.ts's parameter binding.
// Confirms Astra's independent probe (cost-reduction/scripts/p2727-r2-node-review.cjs,
// review cost-reduction/04-plans/P-026-step2-astra-review.md): pca2 answers 200
// with ETag "0" at a committed generation 0.

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import zlib from "zlib";

const queryP_readOnly = jest.fn();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP_readOnly,
    queryP: queryP_readOnly,
    // callback style, used by routes/participation.ts:71 (_getParticipant)
    query_readOnly: (_sql: string, _params: any[], cb: any) =>
      cb(null, { rows: [{ zid: 1, uid: 7, pid: 11 }] }),
  },
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
  // Called both as `new MPromise(name, resolver)` and, in
  // routes/participation.ts:67, as a bare `MPromise(name, resolver)`. A plain
  // function returning an object satisfies both.
  MPromise: function (_name: string, resolver: any) {
    return new Promise(resolver);
  },
}));

jest.mock("../../src/user", () => ({
  __esModule: true,
  getPidPromise: () => Promise.resolve(11),
  getPid: () => Promise.resolve(11),
  getUser: () => Promise.resolve({ uid: 7, pid: 11, hname: "t" }),
}));

jest.mock("../../src/utils/zinvite", () => ({
  __esModule: true,
  getZidForRid: () => Promise.resolve(1),
}));

jest.mock("../../src/utils/common", () => ({
  __esModule: true,
  default: { isModerator: () => Promise.resolve(true) },
  isConversationOwner: () => Promise.resolve(true),
  isOwner: () => Promise.resolve(true),
}));

// Collaborators of handle_GET_participationInit. Only `../../src/utils/pca` is
// left real -- that is the module under test.
jest.mock("../../src/participant", () => ({
  __esModule: true,
  addExtendedParticipantInfo: () => Promise.resolve(),
  joinConversation: () => Promise.resolve({ pid: 11 }),
}));
jest.mock("../../src/conversation", () => ({
  __esModule: true,
  getConversationInfo: () => Promise.resolve({ zid: 1 }),
}));
jest.mock("../../src/nextComment", () => ({
  __esModule: true,
  getNextComment: () => Promise.resolve(null),
}));
jest.mock("../../src/routes/votes", () => ({
  __esModule: true,
  getVotesForSingleParticipant: () => Promise.resolve([]),
}));
jest.mock("../../src/xids", () => ({
  __esModule: true,
  getXidRecord: () => Promise.resolve([]),
}));
jest.mock("../../src/routes/xids", () => ({
  __esModule: true,
  getXids: () => Promise.resolve([]),
}));
jest.mock("../../src/db/sql", () => ({
  __esModule: true,
  sql_participants_extended: {},
}));
jest.mock("../../src/server-helpers", () => ({
  __esModule: true,
  doFamousQuery: () => Promise.resolve({}),
  updateLastInteractionTimeForConversation: () => undefined,
  getOneConversation: () => Promise.resolve({ zid: 1, topic: "t" }),
  userHasAnsweredZeQuestions: () => Promise.resolve(true),
}));

import { handle_GET_bid, handle_GET_math_pca2 } from "../../src/routes/math";
import { handle_GET_participationInit } from "../../src/routes/participation";

function mathBlob() {
  return {
    "group-clusters": [{ id: 0, center: [0, 0], members: [0] }],
    "base-clusters": {
      x: [0.1],
      y: [0.2],
      id: [0],
      count: [1],
      members: [[11]],
    },
    "group-votes": {},
    "group-aware-consensus": {},
    "user-vote-counts": { "11": 3 },
    "in-conv": [11],
    "n-cmts": 2,
    pca: {
      comps: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      center: [0, 0],
      "comment-extremity": [0.5, 0.6],
      "comment-projection": {},
    },
    tids: [0, 1],
    n: 1,
    repness: {},
    consensus: { agree: [], disagree: [] },
    "votes-base": {},
    lastModTimestamp: null,
    lastVoteTimestamp: 1700000000000,
    "comment-priorities": { "0": 1.5, "1": 2.5 },
    math_tick: 34807, // the engine-local blob tick; never the served one
  };
}

// node-pg returns BIGINT as a string: no int8 type parser is registered in
// server/src/db/pg-query.ts.
function serveTick(tick: string) {
  queryP_readOnly.mockImplementation(((sql: string) => {
    const s = String(sql);
    if (s.includes("from math_main")) {
      return Promise.resolve([{ data: mathBlob(), math_tick: tick }]);
    }
    if (s.includes("from math_bidtopid")) {
      return Promise.resolve([{ data: { bidToPid: [[11]] } }]);
    }
    if (s.includes("from comments")) {
      return Promise.resolve([{ tid: 0 }, { tid: 1 }]);
    }
    return Promise.resolve([]);
  }) as never);
}

// Fresh zid per case: the pcaCache is module-level and keyed [math_env, zid].
let nextZid = 800000;
function freshZid() {
  nextZid += 1;
  return nextZid;
}

/**
 * Replicates only the parameter binding app.ts performs for these two routes.
 *
 * `mathTickDefault` is the fourth argument to `want("math_tick", getInt,
 * assignToP, ...)`: absent for /api/v3/math/pca2 (server/app.ts:345), 0 for
 * /api/v3/bid (server/app.ts:433).
 */
function appFor(
  handler: (req: any, res: any) => void,
  zid: number,
  mathTickDefault?: number
) {
  const app = express();
  app.get("/route", (req: any, res: any) => {
    const raw = req.query.math_tick;
    const p: any = { zid };
    if (raw !== undefined) {
      p.math_tick = Number.parseInt(String(raw), 10);
    } else if (mathTickDefault !== undefined) {
      p.math_tick = mathTickDefault;
    }
    if (req.query.keys !== undefined) {
      p.keys = String(req.query.keys).split(",");
    }
    const inm = req.headers["if-none-match"];
    if (inm !== undefined) {
      p.ifNoneMatch = inm;
    }
    p.uid = 7;
    req.p = p;
    handler(req, res);
  });
  return app;
}

const pca2App = (zid: number) => appFor(handle_GET_math_pca2, zid, undefined);
const bidApp = (zid: number) => appFor(handle_GET_bid, zid, 0);

describe("HTTP routes at a committed math generation of 0", () => {
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  test('GET /api/v3/math/pca2 serves generation 0 with status 200 and ETag "0"', async () => {
    // Astra's probe result, reproduced here as a route test: the route has no
    // math_tick default, so routes/math.ts:82 substitutes -1 and the row is
    // served. This route was never broken by the tick-0 guard.
    serveTick("0");
    const res = await request(pca2App(freshZid()))
      .get("/route")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"0"');
    expect(res.headers["content-encoding"]).toBe("gzip");
    // superagent transparently inflates a gzip response, so the collected
    // buffer is already plain JSON. Gunzip only if it still has the magic.
    const raw = res.body as Buffer;
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    const decoded = JSON.parse(
      (isGzip ? zlib.gunzipSync(raw) : raw).toString("utf-8")
    );
    expect(decoded.math_tick).toBe(0);
    expect(decoded.n).toBe(1);
  });

  test("GET /api/v3/math/pca2 with ?keys= serves generation 0 as identity JSON", async () => {
    serveTick("0");
    const res = await request(pca2App(freshZid())).get(
      "/route?keys=math_tick,n,tids"
    );
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"0"');
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toEqual({ math_tick: 0, n: 1, tids: [0, 1] });
  });

  test('GET /api/v3/math/pca2 with If-None-Match: "0" answers 304', async () => {
    // The correct ETag round trip, and the shape P-026 reported as "304".
    serveTick("0");
    const res = await request(pca2App(freshZid()))
      .get("/route")
      .set("If-None-Match", '"0"');
    expect(res.status).toBe(304);
  });

  test("GET /api/v3/bid serves generation 0 (its math_tick default is -1, not 0)", async () => {
    // server/app.ts:433 used to default this route's math_tick to 0, so
    // handle_GET_bid called getPca(zid, 0), got undefined, and dereferencing
    // items[2].asPOJO threw into the .catch -> failJson 500. The default is now
    // -1, matching /api/v3/votes/famous and getBidIndexToPidMapping's own
    // `math_tick || -1` (src/utils/participants.ts:7).
    serveTick("0");
    const res = await request(appFor(handle_GET_bid, freshZid(), -1)).get(
      "/route"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bid: 0 });
  });

  test("GET /api/v3/bid with the old default of 0 is the 500 this fixes", async () => {
    // Pins why the route default had to change: nothing in pca.ts can rescue a
    // caller that explicitly asks for "something newer than 0".
    serveTick("0");
    const res = await request(bidApp(freshZid())).get("/route");
    expect(res.status).toBe(500);
  });

  test("generation 1 is unchanged on both routes, for either bid default", async () => {
    serveTick("1");
    const pca2 = await request(pca2App(freshZid())).get(
      "/route?keys=math_tick,n,tids"
    );
    expect(pca2.status).toBe(200);
    expect(pca2.headers.etag).toBe('"1"');
    expect(pca2.body).toEqual({ math_tick: 1, n: 1, tids: [0, 1] });

    for (const mathTickDefault of [0, -1]) {
      serveTick("1");
      const bid = await request(
        appFor(handle_GET_bid, freshZid(), mathTickDefault)
      ).get("/route");
      expect(bid.status).toBe(200);
      expect(bid.body).toEqual({ bid: 0 });
    }
  });
});

describe("GET /api/v3/participationInit at a committed math generation of 0", () => {
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  function participationApp(zid: number) {
    const app = express();
    app.get("/route", (req: any, res: any) => {
      req.p = {
        zid,
        conversation_id: "abc123",
        lang: "en",
        pid: 11,
        participantInfo: { uid: 7, pid: 11 },
        uid: 7,
        ptptoiLimit: 30,
      };
      handle_GET_participationInit(req, res);
    });
    return app;
  }

  // This is the caller the pca.ts guard fix exists for. routes/participation.ts
  // calls getPca(zid, undefined) -- no route parameter is involved, so unlike
  // /api/v3/math/pca2 there is no -1 substitution to rescue it, and
  // `response.pca = pcaData?.asPOJO ? pcaData : null` turned the dropped row
  // into a null.
  test("serves the generation-0 PCA rather than pca: null", async () => {
    serveTick("0");
    const res = await request(participationApp(freshZid())).get("/route");
    expect(res.status).toBe(200);
    expect(res.body.pca).not.toBeNull();
    expect(res.body.pca.asPOJO.math_tick).toBe(0);
    expect(res.body.pca.asPOJO.n).toBe(1);
  });

  test("generation 1 is unchanged", async () => {
    serveTick("1");
    const res = await request(participationApp(freshZid())).get("/route");
    expect(res.status).toBe(200);
    expect(res.body.pca.asPOJO.math_tick).toBe(1);
    expect(res.body.pca.asPOJO.n).toBe(1);
  });
});
