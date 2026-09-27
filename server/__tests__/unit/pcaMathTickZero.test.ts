// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Generation zero is a real production state, not a hypothetical one:
// `math_ticks.math_tick` is `BIGINT NOT NULL DEFAULT 0`
// (server/postgres/migrations/000000_initial.sql:649) and every writer mints
// ticks with the same statement -- `insert into math_ticks (zid, math_env)
// values (?, ?) on conflict (zid, math_env) do update set math_tick =
// math_ticks.math_tick + 1 returning math_tick` -- so the INSERT arm of the
// first publication for a (zid, math_env) returns 0. See
// math/src/polismath/components/postgres.clj:292-295 (Clojure) and
// delphi/polismath/database/postgres.py:948-976 (Python poller).
//
// These tests pin how `getPca` treats such a row.

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import crypto from "crypto";
import zlib from "zlib";

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
  getLatestExistingPca,
  getPca,
  prefetchLatestPcaData,
} from "../../src/utils/pca";

// sha256(asJSON) for the tick-1 fixture below, recorded against origin/edge
// BEFORE the tick-0 guard fix and unchanged after it. This is the "served bytes
// for tick >= 1 are unchanged" proof. Verified identical on macOS and on CI's
// Linux runner; see the test for why the gzip hash is deliberately not pinned.
const TICK_ONE_JSON_GOLDEN =
  "14a67d485bd330c374fe4f76ccdac37027c5d853fce1e66c27398122fcfa4d96";

// A blob shaped like what the engines actually store in math_main.data.
// NOTE the blob's own `math_tick`: the Python engine stamps a wall-clock
// derived value in the 25000-35000 range
// (delphi/polismath/conversation/conversation.py:2460-2467), which is NOT the
// database tick. The column must always win.
const BLOB_WALL_CLOCK_TICK = 34807;

function mathBlob() {
  return {
    "group-clusters": [],
    "base-clusters": { x: [], y: [], id: [], count: [], members: [] },
    "group-votes": {},
    "group-aware-consensus": {},
    "user-vote-counts": { "1": 3 },
    "in-conv": [1],
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
    math_tick: BLOB_WALL_CLOCK_TICK,
  };
}

/**
 * Serve one math_main row for `zid`, plus the `comments` lookup that
 * ensureCompletePcaStructure issues.
 *
 * `mathTickColumn` is passed through verbatim so a test can choose between the
 * string node-pg actually hands back for a BIGINT (no int8 type parser is
 * registered anywhere in server/src/db/pg-query.ts) and the number a future
 * parser would produce.
 */
function serveRow(mathTickColumn: unknown) {
  queryP_readOnly.mockImplementation(((sql: string) => {
    if (String(sql).includes("from math_main")) {
      return Promise.resolve([{ data: mathBlob(), math_tick: mathTickColumn }]);
    }
    if (String(sql).includes("from comments")) {
      return Promise.resolve([{ tid: 0 }, { tid: 1 }]);
    }
    return Promise.resolve([]);
  }) as never);
}

function serveNoRows() {
  queryP_readOnly.mockImplementation(((sql: string) => {
    if (String(sql).includes("from math_main")) {
      return Promise.resolve([]);
    }
    if (String(sql).includes("from comments")) {
      return Promise.resolve([{ tid: 0 }, { tid: 1 }]);
    }
    return Promise.resolve([]);
  }) as never);
}

function sha256(buf: Buffer | string) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Every case uses a fresh zid so the module-level LruCache (keyed
// [math_env, zid] since #2703) cannot leak state between assertions.
let nextZid = 900000;
function freshZid() {
  nextZid += 1;
  return nextZid;
}

describe("getPca and a committed math generation of tick 0", () => {
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  test("a committed tick 0 is served when the caller asks for the latest (math_tick undefined)", async () => {
    serveRow("0");
    const result = await getPca(freshZid(), undefined);
    expect(result).toBeDefined();
    expect(result?.asPOJO.math_tick).toBe(0);
  });

  test("a committed tick 0 is served for the explicit -1 sentinel", async () => {
    serveRow("0");
    const result = await getPca(freshZid(), -1);
    expect(result).toBeDefined();
    expect(result?.asPOJO.math_tick).toBe(0);
  });

  test("a committed tick 0 is NOT newer than an explicit request for tick 0", async () => {
    // This is the correct ETag semantic: a client holding `"0"` sends
    // If-None-Match: "0", routes/math.ts turns that into math_tick 0, and 0 is
    // not newer than 0, so /api/v3/math/pca2 answers 304.
    serveRow("0");
    expect(await getPca(freshZid(), 0)).toBeUndefined();
  });

  test("the math_main column tick always beats the blob's own math_tick, including at 0", async () => {
    // The Python engine's blob tick is wall-clock derived and far larger than
    // any real tick. If it leaked into the served POJO the ETag would be
    // "34807"; the client would then send If-None-Match: "34807" forever and
    // never be told about real ticks 1, 2, 3...
    for (const columnTick of ["0", 0]) {
      serveRow(columnTick);
      const result = await getPca(freshZid(), -1);
      expect(result?.asPOJO.math_tick).toBe(0);
      expect(result?.asPOJO.math_tick).not.toBe(BLOB_WALL_CLOCK_TICK);
    }
  });

  test("tick 1 is unaffected: identical bytes for every request form", async () => {
    // Pins that treating 0 as a valid tick changed nothing about what is served
    // for tick >= 1.
    //
    // asJSON is what participationInit embeds as response.pca;
    // asBufferOfGzippedJson is the literal GET /api/v3/math/pca2 body.
    //
    // Only the asJSON hash is pinned as a cross-machine constant. The gzip
    // ENCODING of that JSON is not portable: zlib's deflate output depends on
    // the zlib build, so the same input produces different compressed bytes on
    // different platforms. The first version of this test pinned the gzip hash
    // too and passed locally while failing in CI with the JSON hash equal and
    // only the gzip hash different:
    //
    //   local  ...:96e71406c2c85d29e1ac90116ad29668cb4d371e6e65a845b6fbc0757a18f591
    //   CI     ...:abe9cc747dbc157c39e3d3b09d067daf79f5388248f6910847996efd42ec3591
    //
    // which is evidence that the served payload is identical, not that it
    // differs. The portable invariants are asserted instead: one JSON for all
    // request forms, matching the pinned constant; one gzip buffer for all
    // request forms within a process; and the gzip decoding to exactly asJSON.
    const seenJson = new Set<string>();
    const seenGzip = new Set<string>();
    for (const requested of [undefined, -1, 0] as Array<number | undefined>) {
      serveRow("1");
      const result = await getPca(freshZid(), requested);
      expect(result).toBeDefined();
      expect(result?.asPOJO.math_tick).toBe(1);
      seenJson.add(sha256(result!.asJSON));
      seenGzip.add(sha256(result!.asBufferOfGzippedJson));
      expect(
        zlib.gunzipSync(result!.asBufferOfGzippedJson).toString("utf-8")
      ).toBe(result!.asJSON);
    }
    expect(seenJson.size).toBe(1);
    expect(seenGzip.size).toBe(1);
    expect([...seenJson][0]).toBe(TICK_ONE_JSON_GOLDEN);
  });

  test("a still-uncomputed conversation (no math_main row) is unchanged", async () => {
    // No row at all still synthesizes createEmptyPcaStructure for the "latest"
    // callers and still returns undefined for an explicit tick.
    serveNoRows();
    const latest = await getPca(freshZid(), undefined);
    expect(latest).toBeDefined();
    expect(latest?.asPOJO.math_tick).toBe(0);
    expect(latest?.asPOJO.n).toBe(0);

    serveNoRows();
    expect(await getPca(freshZid(), 0)).toBeUndefined();
  });

  test("the math_main default of -1 is still treated as no data", async () => {
    // math_main.math_tick defaults to -1 (migrations/000000_initial.sql:664).
    // A row that never received a real tick must stay unserved.
    serveRow("-1");
    expect(await getPca(freshZid(), undefined)).toBeUndefined();
    serveRow("-1");
    expect(await getPca(freshZid(), -1)).toBeUndefined();
  });
});

describe("prefetchLatestPcaData column authority at zero", () => {
  // The second reviewer's review noted the prefetch guards had no direct committed test.
  // These pin both of them, and the ONE place where the fix intentionally
  // changes bytes even at a positive math_tick.
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  function prefetchRow(zid: number, mathTick: unknown, cachingTick: unknown) {
    queryP_readOnly.mockImplementation(((sql: string) => {
      if (String(sql).includes("from math_main")) {
        return Promise.resolve([
          {
            zid,
            data: { ...mathBlob(), caching_tick: 34808 },
            math_tick: mathTick,
            caching_tick: cachingTick,
          },
        ]);
      }
      if (String(sql).includes("from comments")) {
        return Promise.resolve([{ tid: 0 }, { tid: 1 }]);
      }
      return Promise.resolve([]);
    }) as never);
  }

  test("a numeric column math_tick of 0 reaches the cache, not the blob's clock", async () => {
    const zid = freshZid();
    prefetchRow(zid, 0, 1);
    await prefetchLatestPcaData();
    const cached = await getPca(zid, -1);
    expect(cached?.asPOJO.math_tick).toBe(0);
    expect(cached?.asPOJO.math_tick).not.toBe(BLOB_WALL_CLOCK_TICK);
  });

  test("a numeric column caching_tick of 0 overrides the blob -- an INTENTIONAL byte change", async () => {
    // This is the one qualifier to "tick >= 1 bytes are identical". With a
    // numeric int8 parser, math_tick 1 and column caching_tick 0, prefetch now
    // emits the column's 0 where it used to leave the blob's 34808. The second
    // reviewer reproduced this independently (34808 -> 0). It is the intended
    // column-authority repair, not a regression: under the CURRENT
    // string-returning BIGINT parser no such row occurs, because "0" is truthy
    // and the column already won.
    const zid = freshZid();
    prefetchRow(zid, 1, 0);
    await prefetchLatestPcaData();
    const cached = await getPca(zid, -1);
    expect(cached?.asPOJO.math_tick).toBe(1);
    expect((cached?.asPOJO as any).caching_tick).toBe(0);
    expect((cached?.asPOJO as any).caching_tick).not.toBe(34808);
  });

  test("string column ticks -- what node-pg actually returns -- are unchanged", async () => {
    const zid = freshZid();
    prefetchRow(zid, "1", "7");
    await prefetchLatestPcaData();
    const cached = await getPca(zid, -1);
    expect(cached?.asPOJO.math_tick).toBe(1);
    expect((cached?.asPOJO as any).caching_tick).toBe(7);
  });
});

describe("getLatestExistingPca", () => {
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  test("returns a committed generation 0", async () => {
    serveRow("0");
    const result = await getLatestExistingPca(freshZid());
    expect(result?.asPOJO.math_tick).toBe(0);
    expect(result?.asPOJO["comment-priorities"]).toEqual({
      "0": 1.5,
      "1": 2.5,
    });
  });

  test("returns undefined after exactly one query when there is no math row", async () => {
    // The cheap no-row path the second reviewer required: never createEmptyPcaStructure's
    // second query. Contrast with getPca(zid), which synthesizes.
    serveNoRows();
    expect(await getLatestExistingPca(freshZid())).toBeUndefined();
    const sql = queryP_readOnly.mock.calls.map((c: any) => String(c[0]));
    expect(sql.filter((s) => s.includes("from math_main"))).toHaveLength(1);
    expect(
      sql.filter((s) => s.includes("select tid from comments"))
    ).toHaveLength(0);
  });

  test("getPca(zid) still synthesizes, so existing callers are untouched", async () => {
    serveNoRows();
    const result = await getPca(freshZid());
    expect(result).toBeDefined();
    expect(result?.asPOJO.n).toBe(0);
  });
});

describe("latest-existing cache provenance (review R2-F1)", () => {
  // The [math_env, zid] cache is shared. Before this fix the
  // synthesizeEmptyWhenMissing option gated only the cold missing-row branch,
  // so whichever caller warmed the cache first decided what the
  // existing-only reader returned.
  beforeEach(() => {
    queryP_readOnly.mockReset();
  });

  test("Review: latest-existing refuses a synthesized warm cache entry", async () => {
    // The second reviewer's acceptance test, verbatim in behaviour: ordinary latest
    // synthesizes and caches an empty presentation for a conversation with no
    // row; latest-existing must not adopt it.
    serveNoRows();
    const zid = freshZid();
    expect(await getPca(zid)).toBeDefined();
    queryP_readOnly.mockClear();
    expect(await getLatestExistingPca(zid)).toBeUndefined();
  });

  test("it re-reads the store, so a first publication after the warm-up is visible", async () => {
    // The second reviewer's step 3: the fallback entry must not hide a generation that was
    // committed after it was cached.
    const zid = freshZid();
    serveNoRows();
    expect(await getPca(zid)).toBeDefined();

    serveRow("0");
    const result = await getLatestExistingPca(zid);
    expect(result?.asPOJO.math_tick).toBe(0);
    expect(result?.asPOJO["comment-priorities"]).toEqual({
      "0": 1.5,
      "1": 2.5,
    });
  });

  test("a REAL empty generation 0 stays valid, cacheable and warm-readable", async () => {
    // Provenance is carried, never inferred: this row is empty in exactly the
    // ways a synthesized entry is, and must still be returned and cached.
    const zid = freshZid();
    const realEmpty = {
      ...mathBlob(),
      n: 0,
      tids: [],
      "in-conv": [],
      repness: {},
      consensus: { agree: [], disagree: [] },
      "comment-priorities": {},
    };
    queryP_readOnly.mockImplementation(((sql: string) => {
      if (String(sql).includes("from math_main")) {
        return Promise.resolve([{ data: realEmpty, math_tick: "0" }]);
      }
      if (String(sql).includes("from comments")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as never);

    const first = await getLatestExistingPca(zid);
    expect(first?.asPOJO.math_tick).toBe(0);
    expect(first?.asPOJO.n).toBe(0);

    // Second read is served from cache: row-backed entries are never bypassed.
    queryP_readOnly.mockClear();
    const second = await getLatestExistingPca(zid);
    expect(second?.asPOJO.math_tick).toBe(0);
    expect(queryP_readOnly).not.toHaveBeenCalled();
  });

  test("a row-backed warm entry costs zero queries", async () => {
    const zid = freshZid();
    serveRow("1");
    expect((await getPca(zid))?.asPOJO.math_tick).toBe(1);
    queryP_readOnly.mockClear();
    expect((await getLatestExistingPca(zid))?.asPOJO.math_tick).toBe(1);
    expect(queryP_readOnly).not.toHaveBeenCalled();
  });

  test("the synthesized entry is bypassed, not evicted: ordinary reads keep it", async () => {
    const zid = freshZid();
    serveNoRows();
    const fallback = await getPca(zid);
    expect(fallback).toBeDefined();
    expect(await getLatestExistingPca(zid)).toBeUndefined();

    // Still cached for the ordinary caller, still zero queries.
    queryP_readOnly.mockClear();
    const again = await getPca(zid);
    expect(again).toBe(fallback);
    expect(queryP_readOnly).not.toHaveBeenCalled();
  });

  test("provenance does not leak into the served payload", async () => {
    serveRow("1");
    const result = await getPca(freshZid());
    expect(result?.asJSON).not.toContain("synthesized");
    expect(Object.keys(result!.asPOJO)).not.toContain("synthesized");
  });
});
