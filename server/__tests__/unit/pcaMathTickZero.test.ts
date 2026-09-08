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

import { getPca } from "../../src/utils/pca";

// sha256(asJSON):sha256(asBufferOfGzippedJson) for the tick-1 fixture below,
// recorded against origin/edge BEFORE the tick-0 guard fix and unchanged after
// it. This is the "served bytes for tick >= 1 are unchanged" proof.
const TICK_ONE_GOLDEN =
  "14a67d485bd330c374fe4f76ccdac37027c5d853fce1e66c27398122fcfa4d96:" +
  "96e71406c2c85d29e1ac90116ad29668cb4d371e6e65a845b6fbc0757a18f591";

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
    // The golden hashes below are the pre-fix bytes. They pin that treating 0
    // as a valid tick changed nothing about what is served for tick >= 1.
    const seen = new Set<string>();
    for (const requested of [undefined, -1, 0] as Array<number | undefined>) {
      serveRow("1");
      const result = await getPca(freshZid(), requested);
      expect(result).toBeDefined();
      expect(result?.asPOJO.math_tick).toBe(1);
      // asJSON is what participationInit embeds as response.pca;
      // asBufferOfGzippedJson is the literal GET /api/v3/math/pca2 body.
      seen.add(
        `${sha256(result!.asJSON)}:${sha256(result!.asBufferOfGzippedJson)}`
      );
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(TICK_ONE_GOLDEN);
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
