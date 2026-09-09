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
// Confirms the second reviewer's independent probe (cost-reduction/scripts/p2727-r2-node-review.cjs,
// review cost-reduction/04-plans/P-026-step2-review.md): pca2 answers 200
// with ETag "0" at a committed generation 0.

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import fs from "fs";
import path from "path";
import request from "supertest";
import ts from "typescript";
import zlib from "zlib";
import crypto from "crypto";

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
import { getLatestExistingPca } from "../../src/utils/pca";

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
function serveNoRow() {
  queryP_readOnly.mockImplementation(((sql: string) => {
    const s = String(sql);
    if (s.includes("from math_main")) {
      return Promise.resolve([]);
    }
    if (s.includes("from comments")) {
      return Promise.resolve([{ tid: 0 }, { tid: 1 }]);
    }
    return Promise.resolve([]);
  }) as never);
}

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
 * Reads the `math_tick` default straight out of a route's real registration in
 * server/app.ts, via TypeScript's AST.
 *
 * The second reviewer's review (F1) caught the earlier version of this file hardcoding -1,
 * which meant reverting the app.ts fix left every test passing. Binding to the
 * registration closes that: change `want("math_tick", getInt, assignToP, -1)`
 * back to `0` and the /api/v3/bid positive test below fails.
 *
 * Returns the fourth argument to `want("math_tick", ...)` inside the
 * `app.get(<routePath>, ...)` call, or undefined when the registration supplies
 * no default (which is the case for /api/v3/math/pca2).
 */
function mathTickDefaultForRoute(routePath: string): number | undefined {
  const source = ts.createSourceFile(
    "app.ts",
    fs.readFileSync(path.join(__dirname, "../../app.ts"), "utf-8"),
    ts.ScriptTarget.Latest,
    true
  );

  let registration: ts.CallExpression | undefined;
  const findRegistration = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === routePath
    ) {
      registration = node;
      return;
    }
    ts.forEachChild(node, findRegistration);
  };
  findRegistration(source);
  if (!registration) {
    throw new Error(`no app.get registration found for ${routePath}`);
  }

  const wantCall = registration.arguments.find(
    (arg): arg is ts.CallExpression =>
      ts.isCallExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      arg.expression.text === "want" &&
      arg.arguments.length > 0 &&
      ts.isStringLiteral(arg.arguments[0]) &&
      arg.arguments[0].text === "math_tick"
  );
  if (!wantCall) {
    throw new Error(`no want("math_tick", ...) found for ${routePath}`);
  }

  const fourth = wantCall.arguments[3];
  if (fourth === undefined) {
    return undefined;
  }
  if (
    ts.isPrefixUnaryExpression(fourth) &&
    fourth.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(fourth.operand)
  ) {
    return -Number(fourth.operand.text);
  }
  if (ts.isNumericLiteral(fourth)) {
    return Number(fourth.text);
  }
  throw new Error(
    `want("math_tick", ...) default for ${routePath} is not a numeric literal`
  );
}

/**
 * Replicates only the parameter binding app.ts performs for these routes.
 *
 * `mathTickDefault` is the fourth argument to `want("math_tick", getInt,
 * assignToP, ...)`, read from the real registration by
 * mathTickDefaultForRoute.
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

// Bound to the real registrations, not to literals.
const PCA2_MATH_TICK_DEFAULT = mathTickDefaultForRoute("/api/v3/math/pca2");
const BID_MATH_TICK_DEFAULT = mathTickDefaultForRoute("/api/v3/bid");

const pca2App = (zid: number) =>
  appFor(handle_GET_math_pca2, zid, PCA2_MATH_TICK_DEFAULT);
const bidApp = (zid: number) =>
  appFor(handle_GET_bid, zid, BID_MATH_TICK_DEFAULT);
// Negative control: the pre-fix default, kept to pin the failure it caused.
const bidAppWithOldDefault = (zid: number) => appFor(handle_GET_bid, zid, 0);

/** The real participationInit handler on a real express route. */
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

describe("HTTP routes at a committed math generation of 0", () => {
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  test('GET /api/v3/math/pca2 serves generation 0 with status 200 and ETag "0"', async () => {
    // The second reviewer's probe result, reproduced here as a route test: the route has no
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

  test("the registered math_tick defaults are the ones these tests exercise", async () => {
    // Guards the guard: if app.ts stops matching what this file assumes, the
    // suite says so rather than silently testing a fiction.
    expect(PCA2_MATH_TICK_DEFAULT).toBeUndefined();
    expect(BID_MATH_TICK_DEFAULT).toBe(-1);
  });

  test("GET /api/v3/bid serves generation 0 using its REGISTERED math_tick default", async () => {
    // Bound to server/app.ts's actual want("math_tick", getInt, assignToP, -1).
    // Reverting that argument to 0 makes this test fail, which is the whole
    // point (review F1).
    //
    // With the old default of 0, handle_GET_bid called getPca(zid, 0), got
    // undefined, and dereferencing items[2].asPOJO threw into the .catch ->
    // failJson 500. -1 matches /api/v3/votes/famous and
    // getBidIndexToPidMapping's own `math_tick || -1` (utils/participants.ts:7),
    // which this same handler already calls.
    serveTick("0");
    const res = await request(bidApp(freshZid())).get("/route");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bid: 0 });
  });

  test("GET /api/v3/bid with the old default of 0 is the 500 this fixes", async () => {
    // Negative control, deliberately hardcoded: nothing in pca.ts can rescue a
    // caller that explicitly asks for "something newer than 0".
    serveTick("0");
    const res = await request(bidAppWithOldDefault(freshZid())).get("/route");
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

    for (const bidAppVariant of [bidApp, bidAppWithOldDefault]) {
      serveTick("1");
      const bid = await request(bidAppVariant(freshZid())).get("/route");
      expect(bid.status).toBe(200);
      expect(bid.body).toEqual({ bid: 0 });
    }
  });
});

describe("GET /api/v3/participationInit at a committed math generation of 0", () => {
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

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

describe("cross-caller cache provenance over HTTP (review R2-F1)", () => {
  // The defect the second reviewer found: the [math_env, zid] cache is shared, so whichever
  // route warmed it first decided what the existing-only reader returned.
  // participationInit is a REAL route that synthesizes an empty presentation
  // for a conversation with no committed row; the existing-only reader must
  // not adopt it. Mounted on a thin route because no registered route calls
  // getLatestExistingPca directly -- nextComment and doFamousQuery reach it
  // through their own handlers, covered in pcaLatestExistingHttp.test.ts.
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  function latestExistingApp(zid: number) {
    const app = express();
    app.get("/route", async (_req: any, res: any) => {
      const result = await getLatestExistingPca(zid);
      // `n` distinguishes the real fixture (1) from the synthesized empty
      // presentation (0); math_tick alone cannot, since both are 0.
      res
        .status(200)
        .json(
          result
            ? { math_tick: result.asPOJO.math_tick, n: result.asPOJO.n }
            : null
        );
    });
    return app;
  }

  test("participationInit's synthesized entry is not served as existing math", async () => {
    const zid = freshZid();
    serveNoRow();

    const init = await request(participationApp(zid)).get("/route");
    expect(init.status).toBe(200);
    expect(init.body.pca).not.toBeNull();
    expect(init.body.pca.asPOJO.n).toBe(0); // the synthesized presentation

    const latest = await request(latestExistingApp(zid)).get("/route");
    expect(latest.status).toBe(200);
    expect(latest.body).toBeNull();
  });

  test("a first publication after that warm-up becomes visible", async () => {
    const zid = freshZid();
    serveNoRow();
    await request(participationApp(zid)).get("/route");

    serveTick("0");
    const latest = await request(latestExistingApp(zid)).get("/route");
    expect(latest.body).toEqual({ math_tick: 0, n: 1 });
  });

  test("a row-backed warm entry is still shared, not re-read", async () => {
    const zid = freshZid();
    serveTick("0");
    const init = await request(participationApp(zid)).get("/route");
    expect(init.body.pca.asPOJO.math_tick).toBe(0);

    queryP_readOnly.mockClear();
    const latest = await request(latestExistingApp(zid)).get("/route");
    expect(latest.body).toEqual({ math_tick: 0, n: 1 });
    expect(queryP_readOnly).not.toHaveBeenCalled();
  });
});

describe("Review: cache provenance must remain private over participationInit HTTP", () => {
  test.each(["missing", "1"])(
    "wrapper contains no synthesized key for %s",
    async (state) => {
      queryP_readOnly.mockReset();
      if (state === "missing") serveNoRow();
      else serveTick(state);
      const response = await request(participationApp(freshZid())).get(
        "/route"
      );
      expect(response.status).toBe(200);
      expect(response.body.pca).not.toBeNull();
      expect(Object.keys(response.body.pca)).toEqual([
        "asPOJO",
        "asJSON",
        "asBufferOfGzippedJson",
        "expiration",
        "consensus",
        "repness",
      ]);
      expect(response.body.pca).not.toHaveProperty("synthesized");
    }
  );
});

/**
 * A portable, NORMALIZED form of participationInit's `response.pca`, which is
 * the WHOLE cache entry, not just `asPOJO`.
 *
 * Normalized, so hashing it is not a claim of compressed-wire byte equality:
 * two of the served fields are deliberately not compared as sent (below).
 * What this pins is the wrapper's key list and order, and every field's decoded
 * value.
 *
 * Two fields are excluded by necessity, and only these two:
 *  - `expiration` is `Date.now() + 3000`, a clock;
 *  - `asBufferOfGzippedJson` serializes as raw gzip bytes, whose encoding
 *    depends on the zlib build (see the CI failure recorded in round 2). It is
 *    replaced by its DECODED text, which is portable and strictly stronger than
 *    hashing the compressed form.
 * Everything else, including the key list and its order, is compared verbatim.
 */
function canonicalWrapper(pca: any) {
  const buffer = Buffer.from(pca.asBufferOfGzippedJson.data);
  return JSON.stringify({
    keys: Object.keys(pca),
    entry: {
      ...pca,
      expiration: "<clock>",
      asBufferOfGzippedJson: zlib.gunzipSync(buffer).toString("utf-8"),
    },
  });
}

// sha256 of canonicalWrapper(response.pca) for a tick-1 row, recorded by running
// this exact test with src/utils/pca.ts at origin/edge (31a5c0921).
//
// This is equality of the NORMALIZED DECODED wrapper, not of the compressed
// bytes on the wire: `expiration` is excluded and the gzip buffer is compared
// decoded. Compressed-wire equality is established elsewhere, by the second reviewer's
// same-process before/after comparisons (44 positive-tick pairs), which is the
// right instrument for it -- a cross-machine constant cannot be (see round 2).
const EDGE_PARTICIPATION_WRAPPER_TICK1 =
  "267fc4b792e95eddb6cc3d161ac54ce37b1f4012ed427aa3ca53222a11c93af2";

describe("participationInit's served wrapper matches edge, decoded (review r3)", () => {
  // The second reviewer's R3 finding: round 3 added an enumerable `synthesized` property to
  // the cache entry, and participationInit assigns that entire entry to
  // `response.pca` and serializes it. So the wire gained a field production
  // never sent -- for EVERY tick, including 1. Keeping asPOJO/asJSON/the gzip
  // body clean did not protect the wrapper.
  //
  // The second reviewer's own acceptance tests above pin the key list. This pins the bytes.
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  test("tick 1: the whole decoded wrapper matches the pre-fix value", async () => {
    serveTick("1");
    const res = await request(participationApp(freshZid())).get("/route");
    expect(res.status).toBe(200);
    expect(res.body.pca.asPOJO.math_tick).toBe(1);
    expect(sha256Hex(canonicalWrapper(res.body.pca))).toBe(
      EDGE_PARTICIPATION_WRAPPER_TICK1
    );
  });

  test("the wrapper carries exactly the six keys production serves", async () => {
    for (const tick of ["0", "1"]) {
      serveTick(tick);
      const res = await request(participationApp(freshZid())).get("/route");
      expect(Object.keys(res.body.pca)).toEqual([
        "asPOJO",
        "asJSON",
        "asBufferOfGzippedJson",
        "expiration",
        "consensus",
        "repness",
      ]);
    }
  });
});

function sha256Hex(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
