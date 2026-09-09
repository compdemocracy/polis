// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// The coherent math Bundle, against real migrated Postgres and the real server
// modules -- no copied SQL, no reimplementation of the readers.
//
// Two distinguishable generations are published for one conversation. A and B
// AGREE on what each group's participants are, and disagree only on the INDEX
// ordering that ties `base-clusters.id` to `bidToPid`. That is the actual
// production hazard: a join that mixes them returns a plausible, wrong answer
// rather than an error, so every expectation below is an exact list.
//
//   generation A   base-cluster ids [10, 20]   bidToPid [[1],    [2]   ]
//   generation B   base-cluster ids [20, 10]   bidToPid [[2, 4], [1, 3]]
//
//   group 0 (base cluster 10)   A -> [1]   B -> [1, 3]   torn -> [2, 4]
//   group 1 (base cluster 20)   A -> [2]   B -> [2, 4]   torn -> [1, 3]

import crypto from "crypto";
import { jest } from "@jest/globals";

import Config from "../../src/config";
import pg from "../../src/db/pg-query";
import {
  getPca,
  getPcaFromBundle,
  prefetchLatestPcaData,
} from "../../src/utils/pca";
import {
  getBidIndexToPidMapping,
  getPidsForGid,
} from "../../src/utils/participants";
import { getBidsForPids } from "../../src/routes/math";
import {
  clearMathBundleCache,
  getMathBundle,
  loadBundle,
} from "../../src/utils/mathBundle";
import { pool, closePool } from "../setup/db-test-helpers";

const ENV = "p027s2-bundle";
const OTHER_ENV = "p027s2-bundle-other";

type Generation = {
  ids: number[];
  clusterMembers: number[][];
  bidToPid: number[][];
};

const A: Generation = {
  ids: [10, 20],
  clusterMembers: [[1], [2]],
  bidToPid: [[1], [2]],
};
const B: Generation = {
  ids: [20, 10],
  clusterMembers: [
    [2, 4],
    [1, 3],
  ],
  bidToPid: [
    [2, 4],
    [1, 3],
  ],
};

const A_GROUPS: Record<number, number[]> = { 0: [1], 1: [2] };
const B_GROUPS: Record<number, number[]> = { 0: [1, 3], 1: [2, 4] };
// Old main (A) indexed with the new mapping (B). Neither generation's answer.
const TORN_GROUPS: Record<number, number[]> = { 0: [2, 4], 1: [1, 3] };

const A_BIDS = { 1: 10, 2: 20, 3: undefined, 4: undefined };
const B_BIDS = { 1: 10, 2: 20, 3: 10, 4: 20 };

function mainBlob(generation: Generation) {
  return {
    // Group 0 is base cluster 10, group 1 is base cluster 20, in BOTH
    // generations -- only the index ordering moves.
    "group-clusters": [
      { id: 0, members: [10], center: [0, 0] },
      { id: 1, members: [20], center: [1, 1] },
    ],
    "base-clusters": {
      id: generation.ids,
      members: generation.clusterMembers,
      x: [0, 1],
      y: [0, 1],
      count: [1, 1],
    },
    "group-votes": {},
    "user-vote-counts": {},
    "in-conv": [1, 2],
    "n-cmts": 0,
    pca: { comps: [[], []], center: [0, 0], "comment-extremity": [] },
    n: 2,
    repness: {},
    consensus: { agree: [], disagree: [] },
    lastVoteTimestamp: 1700000000000,
    math_tick: 34807, // the engine's wall clock, never the database generation
  };
}

let zid: number;
let tickBase = 0;
let reads: jest.SpyInstance;

async function publish(
  generation: Generation,
  tick: number,
  env: string = ENV,
  target: number = zid
) {
  const rows: Array<[string, unknown, number]> = [
    ["math_main", mainBlob(generation), tick],
    [
      "math_bidtopid",
      { bidToPid: generation.bidToPid, math_tick: 34807 },
      tick,
    ],
    ["math_ptptstats", { generation: tick }, tick],
  ];
  for (const [table, data, t] of rows) {
    if (table === "math_main") {
      await pool.query(
        `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
         values ($1, $2, $3, 1700000000000, $4, $4)
         on conflict (zid, math_env) do update set data = $3, math_tick = $4, caching_tick = $4`,
        [target, env, data, t]
      );
    } else {
      await pool.query(
        `insert into ${table} (zid, math_env, data, math_tick) values ($1, $2, $3, $4)
         on conflict (zid, math_env) do update set data = $3, math_tick = $4`,
        [target, env, data, t]
      );
    }
  }
  await pool.query(
    `insert into math_ticks (zid, math_env, math_tick, caching_tick) values ($1, $2, $3, $3)
     on conflict (zid, math_env) do update set math_tick = $3, caching_tick = $3`,
    [target, env, tick]
  );
}

/**
 * The join `getPidsForGid` used to perform, verbatim, so the control below can
 * feed it the two independently-read halves the old implementation fetched.
 * The READS are the real server modules; only this arithmetic is restated,
 * because the production copy of it is what this change deleted.
 */
function joinTheOldWay(
  mainPojo: { [key: string]: any },
  mapping: { bidToPid?: number[][] },
  gid: number
): number[] {
  const clusters = mainPojo["group-clusters"];
  const indexToBid = mainPojo["base-clusters"].id;
  const bidToIndex: number[] = [];
  for (let i = 0; i < indexToBid.length; i++) bidToIndex[indexToBid[i]] = i;
  const indexToPids = mapping.bidToPid;
  const cluster = clusters[gid];
  if (!cluster) return [];
  let pids: number[] = [];
  for (const bid of cluster.members) {
    const morePids = indexToPids ? indexToPids[bidToIndex[bid]] : null;
    if (morePids) Array.prototype.push.apply(pids, morePids);
  }
  pids = pids.map((x) => parseInt(String(x)));
  pids.sort((a, b) => a - b);
  return pids;
}

describe("coherent math Bundle reader", () => {
  const originalEnv = Config.mathEnv;

  beforeEach(async () => {
    tickBase += 10000;
    const result = await pool.query(
      "insert into conversations default values returning zid"
    );
    zid = result.rows[0].zid;
    Config.mathEnv = ENV;
    clearMathBundleCache();
    reads = jest.spyOn(pg, "queryP_readOnly"); // Calls through to real Postgres.
  });

  afterEach(async () => {
    reads?.mockRestore();
    Config.mathEnv = originalEnv;
    clearMathBundleCache();
    for (const table of [
      "math_main",
      "math_bidtopid",
      "math_ptptstats",
      "math_ticks",
      "conversations",
    ]) {
      await pool.query(`delete from ${table} where zid = $1`, [zid]);
    }
  });
  afterAll(closePool);

  // -- A/B expectations, exactly -------------------------------------------

  test("generation A: exact groups, exact bids, one admitted generation", async () => {
    const tick = tickBase + 1;
    await publish(A, tick);

    const read = await loadBundle(zid, ENV);
    expect(read.present).toBe(true);
    if (!read.present || !read.admitted) throw new Error("expected admission");
    expect(read.bundle.mathTick).toBe(tick);
    expect(read.bundle.bidToPid.bidToPid).toEqual(A.bidToPid);
    expect(read.bundle.main["base-clusters"]?.id).toEqual(A.ids);
    expect(read.bundle.ptptStats).toEqual({ generation: tick });

    expect(await getPidsForGid(zid, 0, -1)).toEqual(A_GROUPS[0]);
    expect(await getPidsForGid(zid, 1, -1)).toEqual(A_GROUPS[1]);
    expect(await getPidsForGid(zid, 2, -1)).toEqual([]);
    expect(await getBidsForPids(zid, -1, [1, 2, 3, 4])).toEqual(A_BIDS);
  });

  test("generation B is visible on a later request, exactly", async () => {
    await publish(A, tickBase + 1);
    expect(await getPidsForGid(zid, 0, -1)).toEqual(A_GROUPS[0]);

    await publish(B, tickBase + 2);
    // The production invalidation path: the background poller is the only
    // reader that learns a new generation exists without reading companions.
    await prefetchLatestPcaData();

    expect(await getPidsForGid(zid, 0, -1)).toEqual(B_GROUPS[0]);
    expect(await getPidsForGid(zid, 1, -1)).toEqual(B_GROUPS[1]);
    expect(await getBidsForPids(zid, -1, [1, 2, 3, 4])).toEqual(B_BIDS);
  });

  // -- the torn read, and its closure ---------------------------------------

  test("CONTROL: the pre-Bundle two-read sequence tears, through the real readers", async () => {
    await publish(A, tickBase + 1);

    // Statement one: the real getPca, reading generation A.
    const main = await getPca(zid, -1);
    expect(main?.asPOJO.math_tick).toBe(tickBase + 1);

    // A publication lands between the two reads.
    await publish(B, tickBase + 2);

    // Statement two: the real getBidIndexToPidMapping, reading generation B.
    // It has no cache at all, so it always sees the newest row.
    const mapping = (await getBidIndexToPidMapping(zid, -1)) as {
      bidToPid: number[][];
    };
    expect(mapping.bidToPid).toEqual(B.bidToPid);

    // Old main, new mapping: a plausible answer belonging to no generation.
    const torn = joinTheOldWay(main!.asPOJO, mapping, 0);
    expect(torn).toEqual(TORN_GROUPS[0]);
    expect(torn).not.toEqual(A_GROUPS[0]);
    expect(torn).not.toEqual(B_GROUPS[0]);
    expect(joinTheOldWay(main!.asPOJO, mapping, 1)).toEqual(TORN_GROUPS[1]);
  });

  test("WITNESS: a publication during the Bundle read cannot tear it", async () => {
    await publish(A, tickBase + 1);

    const realQuery = pg.queryP_readOnly.bind(pg);
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    // Hold the Bundle's rows after the statement has run against generation A
    // and before the reader is given them: the O1 "pause after main access,
    // publish a distinguishable next generation, resume mapping access" shape.
    reads.mockImplementationOnce(
      async (...args: Parameters<typeof pg.queryP_readOnly>) => {
        const rows = await realQuery(...args);
        arrived();
        await held;
        return rows;
      }
    );

    const pending = getPidsForGid(zid, 0, -1);
    await reached;
    await publish(B, tickBase + 2);
    release();

    // Every field belongs to the generation the read opened on.
    expect(await pending).toEqual(A_GROUPS[0]);

    // And the replacement is observed on a later request.
    await prefetchLatestPcaData();
    expect(await getPidsForGid(zid, 0, -1)).toEqual(B_GROUPS[0]);
  });

  // -- admission ------------------------------------------------------------

  test.each(["math_bidtopid", "math_ptptstats", "math_ticks"])(
    "a missing %s companion is refused, and the joining callers stay empty",
    async (table) => {
      await publish(A, tickBase + 1);
      await pool.query(`delete from ${table} where zid = $1`, [zid]);
      clearMathBundleCache();

      const read = await loadBundle(zid, ENV);
      if (!read.present || read.admitted) throw new Error("expected refusal");
      expect(read.refusal).toEqual({
        reason: "missing_companion",
        companion: table,
      });
      expect(await getPidsForGid(zid, 0, -1)).toEqual([]);
      expect(await getBidsForPids(zid, -1, [1, 2])).toEqual({
        1: undefined,
        2: undefined,
      });
    }
  );

  test("a companion left at the previous generation is refused", async () => {
    await publish(A, tickBase + 1);
    // Main and the checkpoint advance; the mapping does not. This is exactly
    // the state a partial publication leaves behind.
    await pool.query(
      "update math_main set data = $1, math_tick = $2, caching_tick = $2 where zid = $3 and math_env = $4",
      [mainBlob(B), tickBase + 2, zid, ENV]
    );
    await pool.query(
      "update math_ptptstats set math_tick = $1 where zid = $2 and math_env = $3",
      [tickBase + 2, zid, ENV]
    );
    await pool.query(
      "update math_ticks set math_tick = $1 where zid = $2 and math_env = $3",
      [tickBase + 2, zid, ENV]
    );
    clearMathBundleCache();

    const read = await loadBundle(zid, ENV);
    if (!read.present || read.admitted) throw new Error("expected refusal");
    expect(read.refusal).toEqual({
      reason: "tick_mismatch",
      companion: "math_bidtopid",
      companionTick: tickBase + 1,
      mainTick: tickBase + 2,
    });
    expect(await getPidsForGid(zid, 0, -1)).toEqual([]);
  });

  test("no math at all is absence, and the callers keep their empty answers", async () => {
    expect(await loadBundle(zid, ENV)).toEqual({ present: false });
    expect(await getPidsForGid(zid, 0, -1)).toEqual([]);
    expect(await getBidsForPids(zid, -1, [1, 2])).toEqual({
      1: undefined,
      2: undefined,
    });
  });

  // -- negative controls the reviewer required ------------------------------

  test("NEGATIVE: a substituted mapping is returned as substituted, so the expectation discriminates", async () => {
    await publish(A, tickBase + 1);
    // Generation B's mapping written under generation A's tick. Admission
    // checks presence and generation, not payload provenance -- a same-tick
    // payload substitution is an open O1 requirement, NOT something this
    // reader claims to catch. What must hold is that the reader really does
    // read the mapping it was given, so an exact expectation catches it.
    await pool.query(
      "update math_bidtopid set data = $1 where zid = $2 and math_env = $3",
      [{ bidToPid: B.bidToPid, math_tick: 34807 }, zid, ENV]
    );
    clearMathBundleCache();

    const pids = await getPidsForGid(zid, 0, -1);
    expect(pids).toEqual(TORN_GROUPS[0]);
    expect(pids).not.toEqual(A_GROUPS[0]);
  });

  test("NEGATIVE: an arbitrary nonempty pid list is not what the reader returns", async () => {
    await publish(A, tickBase + 1);
    await pool.query(
      "update math_bidtopid set data = $1 where zid = $2 and math_env = $3",
      [{ bidToPid: [[999], [999]] }, zid, ENV]
    );
    clearMathBundleCache();

    // A reader that invented pids -- or ignored its mapping -- would return
    // [999] against the unmodified fixture too, and every A/B assertion in
    // this file would fail. Here it is the fixture that says 999.
    expect(await getPidsForGid(zid, 0, -1)).toEqual([999]);
    expect(await getPidsForGid(zid, 0, -1)).not.toEqual(A_GROUPS[0]);
  });

  test("NEGATIVE: a companion in another namespace does not satisfy admission", async () => {
    await publish(A, tickBase + 1);
    // Move the mapping to a different math_env, leaving main where it is.
    await pool.query(
      "update math_bidtopid set math_env = $1 where zid = $2 and math_env = $3",
      [OTHER_ENV, zid, ENV]
    );
    clearMathBundleCache();

    const read = await loadBundle(zid, ENV);
    if (!read.present || read.admitted) throw new Error("expected refusal");
    expect(read.refusal).toEqual({
      reason: "missing_companion",
      companion: "math_bidtopid",
    });
    expect(await getPidsForGid(zid, 0, -1)).toEqual([]);

    await pool.query(`delete from math_bidtopid where zid = $1`, [zid]);
  });

  test("NEGATIVE: a foreign namespace's generation is never served here", async () => {
    await publish(A, tickBase + 1, ENV);
    await publish(B, tickBase + 2, OTHER_ENV);
    clearMathBundleCache();

    expect(await getPidsForGid(zid, 0, -1)).toEqual(A_GROUPS[0]);
    expect(await getPidsForGid(zid, 1, -1)).toEqual(A_GROUPS[1]);

    Config.mathEnv = OTHER_ENV;
    clearMathBundleCache();
    expect(await getPidsForGid(zid, 0, -1)).toEqual(B_GROUPS[0]);
    expect(await getPidsForGid(zid, 1, -1)).toEqual(B_GROUPS[1]);

    Config.mathEnv = "p027s2-bundle-empty";
    clearMathBundleCache();
    expect(await loadBundle(zid)).toEqual({ present: false });
    expect(await getPidsForGid(zid, 0, -1)).toEqual([]);

    Config.mathEnv = ENV;
    for (const table of [
      "math_main",
      "math_bidtopid",
      "math_ptptstats",
      "math_ticks",
    ]) {
      await pool.query(
        `delete from ${table} where zid = $1 and math_env = $2`,
        [zid, OTHER_ENV]
      );
    }
  });

  // -- presentation ---------------------------------------------------------

  test("the Bundle-backed presentation is byte-identical to the single-table one", async () => {
    await publish(A, tickBase + 1);
    const other = await pool.query(
      "insert into conversations default values returning zid"
    );
    const twin: number = other.rows[0].zid;
    try {
      await publish(A, tickBase + 1, ENV, twin);

      const viaPca = await getPca(zid);
      const viaBundle = await getPcaFromBundle(twin);
      expect(viaBundle).toBeDefined();
      expect(viaBundle!.asJSON).toEqual(viaPca!.asJSON);
      expect(
        crypto
          .createHash("sha256")
          .update(viaBundle!.asBufferOfGzippedJson)
          .digest("hex")
      ).toEqual(
        crypto
          .createHash("sha256")
          .update(viaPca!.asBufferOfGzippedJson)
          .digest("hex")
      );
    } finally {
      for (const table of [
        "math_main",
        "math_bidtopid",
        "math_ptptstats",
        "math_ticks",
        "conversations",
      ]) {
        await pool.query(`delete from ${table} where zid = $1`, [twin]);
      }
    }
  });

  test("the comment listing is composed per presentation, never held by math tick", async () => {
    await publish(A, tickBase + 1);
    const user = await pool.query(
      "insert into users (hname, email) values ('bundle test', $1) returning uid",
      [`bundle-${zid}@example.invalid`]
    );
    const uid: number = user.rows[0].uid;
    await pool.query("insert into participants (zid, uid) values ($1, $2)", [
      zid,
      uid,
    ]);
    const participant = await pool.query(
      "select pid from participants where zid = $1 and uid = $2",
      [zid, uid]
    );
    const pid: number = participant.rows[0].pid;
    try {
      await pool.query(
        "insert into comments (zid, pid, uid, txt, mod) values ($1, $2, $3, 'bundle statement one', 1)",
        [zid, pid, uid]
      );
      const first = await getPcaFromBundle(zid);
      expect(first!.asPOJO.tids).toEqual([0]);

      // Approve a second statement. The math generation does NOT move.
      await pool.query(
        "insert into comments (zid, pid, uid, txt, mod) values ($1, $2, $3, 'bundle statement two', 1)",
        [zid, pid, uid]
      );
      const bundleRead = await getMathBundle(zid, ENV);
      expect(bundleRead.present && bundleRead.mathTick).toBe(tickBase + 1);

      // The Bundle carries no comment-owned data at all, so nothing can pin
      // the listing to the unchanged math tick; the short presentation TTL is
      // what governs it, exactly as before this change.
      expect(JSON.stringify(bundleRead)).not.toContain("bundle statement");
      await new Promise((resolve) => setTimeout(resolve, 3100));
      const second = await getPcaFromBundle(zid);
      // `tids` is the comment-owned listing and it moved. (`n-cmts` is
      // math-owned: `ensureCompletePcaStructure` lets the math blob's own
      // value win, and this fixture's generation still says 0. That split is
      // pre-existing behaviour and is deliberately not changed here.)
      expect(second!.asPOJO.tids).toEqual([0, 1]);
      expect(first!.asPOJO.tids).toEqual([0]);
    } finally {
      await pool.query("delete from comments where zid = $1", [zid]);
      await pool.query("delete from participants where zid = $1", [zid]);
      await pool.query("delete from users where uid = $1", [uid]);
    }
  }, 20000);
});
