import Config from "../../src/config";
import pg from "../../src/db/pg-query";
import { getPca, prefetchLatestPcaData } from "../../src/utils/pca";
import {
  getBidIndexToPidMapping,
  getPidsForGid,
} from "../../src/utils/participants";
import { pool, closePool } from "../setup/db-test-helpers";

// Real migrated Postgres, both engines publishing for the SAME conversation.
// The Clojure service in the test stack uses dev, leaving these fixtures alone.
describe("math_env namespace isolation", () => {
  const originalEnv = Config.mathEnv;
  let zid: number;
  let tickBase = 0;
  let reads: jest.SpyInstance;

  async function seed(env: string, tick: number, pid: number) {
    const data = {
      sentinel: env,
      math_tick: tick,
      "group-clusters": [{ id: 0, members: [0], center: [0, 0] }],
      "base-clusters": {
        id: [0],
        x: [0],
        y: [0],
        count: [1],
        members: [[pid]],
      },
    };
    await pool.query(
      `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
       values ($1, $2, $3, 0, $4, $4)`,
      [zid, env, data, tick]
    );
    await pool.query(
      "insert into math_bidtopid (zid, math_env, data, math_tick) values ($1, $2, $3, $4)",
      [zid, env, { math_tick: tick, bidToPid: [[pid]] }, tick]
    );
    await pool.query(
      "insert into math_ptptstats (zid, math_env, data, math_tick) values ($1, $2, $3, $4)",
      [zid, env, { sentinel: env }, tick]
    );
  }

  async function setTick(env: string, tick: number) {
    await pool.query(
      "update math_main set math_tick = $1, caching_tick = $1 where zid = $2 and math_env = $3",
      [tick, zid, env]
    );
  }

  beforeEach(async () => {
    tickBase += 10000;
    const result = await pool.query(
      "insert into conversations default values returning zid"
    );
    zid = result.rows[0].zid;
    await seed("prod", tickBase + 10, 11);
    await seed("python", tickBase + 1000, 22);
    reads = jest.spyOn(pg, "queryP_readOnly"); // Calls through to real Postgres.
  });

  afterEach(async () => {
    reads?.mockRestore();
    Config.mathEnv = originalEnv;
    for (const table of [
      "math_main",
      "math_bidtopid",
      "math_ptptstats",
      "conversations",
    ]) {
      await pool.query(`delete from ${table} where zid = $1`, [zid]);
    }
  });
  afterAll(closePool);

  test.each(["prod", "python"])(
    "%s point reads, participant joins, and cached latest/tick reads",
    async (env) => {
      Config.mathEnv = env;
      const tick = tickBase + (env === "prod" ? 10 : 1000);
      const pid = env === "prod" ? 11 : 22;
      // A point read must not pick the other engine's newer row.
      expect(await getPca(zid, tick)).toBeUndefined();
      const result = await getPca(zid, -1);
      expect(result?.asPOJO.sentinel).toBe(env);
      expect(result?.asPOJO.math_tick).toBe(tick);
      reads.mockClear();
      expect((await getPca(zid))?.asPOJO.sentinel).toBe(env);
      expect((await getPca(zid, tick - 1))?.asPOJO.sentinel).toBe(env);
      expect(await getPca(zid, tick)).toBeUndefined();
      expect(reads).not.toHaveBeenCalled();
      expect((await getBidIndexToPidMapping(zid, -1)).bidToPid).toEqual([
        [pid],
      ]);
      expect(await getBidIndexToPidMapping(zid, tick)).toEqual(
        new Error("polis_err_get_pca_results_not_new")
      );
      expect(await getPidsForGid(zid, 0, -1)).toEqual([pid]);
      Config.mathEnv = env === "prod" ? "python" : "prod";
      expect((await getPca(zid))?.asPOJO.sentinel).toBe(Config.mathEnv);
      expect(await getPidsForGid(zid, 0, -1)).toEqual([
        env === "prod" ? 22 : 11,
      ]);
      Config.mathEnv = env;
      expect((await getPca(zid, -1))?.asPOJO.sentinel).toBe(env);
    }
  );

  test("empty fallback cache stays in its namespace", async () => {
    await pool.query(
      "delete from math_main where zid = $1 and math_env = 'prod'",
      [zid]
    );
    Config.mathEnv = "prod";
    expect((await getPca(zid))?.asPOJO.math_tick).toBe(0);
    Config.mathEnv = "python";
    expect((await getPca(zid))?.asPOJO.sentinel).toBe("python");
    Config.mathEnv = "prod";
    expect((await getPca(zid))?.asPOJO.math_tick).toBe(0);
  });

  test.each(["prod", "python"])(
    "%s prefetch cursor and cache stay scoped across batches and env switches",
    async (env) => {
      const otherEnv = env === "prod" ? "python" : "prod";
      const currentTick = tickBase + 10;
      const foreignTick = tickBase + 1000;
      await setTick(env, currentTick);
      await setTick(otherEnv, foreignTick);
      Config.mathEnv = env;
      await prefetchLatestPcaData();
      reads.mockClear();
      expect((await getPca(zid))?.asPOJO.sentinel).toBe(env);
      expect(reads).not.toHaveBeenCalled(); // Really served the prefetched cache.
      await setTick(env, currentTick + 1);
      await prefetchLatestPcaData();
      expect(reads.mock.calls[0][1]).toEqual([currentTick, env]);
      expect((await getPca(zid))?.asPOJO.math_tick).toBe(currentTick + 1);
      Config.mathEnv = otherEnv;
      await prefetchLatestPcaData();
      reads.mockClear();
      expect((await getPca(zid))?.asPOJO.sentinel).toBe(otherEnv);
      expect(reads).not.toHaveBeenCalled();
      await prefetchLatestPcaData();
      expect(reads.mock.calls[0][1]).toEqual([foreignTick, otherEnv]);
      Config.mathEnv = env;
      reads.mockClear();
      await prefetchLatestPcaData();
      expect(reads.mock.calls[0][1]).toEqual([currentTick + 1, env]);
      expect((await getPca(zid))?.asPOJO.sentinel).toBe(env);
    }
  );

  test.each(["point", "prefetch"])(
    "%s results keep their original env when config changes in flight",
    async (path) => {
      const query = pg.queryP_readOnly.bind(pg);
      let release!: () => void;
      let arrived!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queried = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      reads.mockImplementationOnce(
        async (...args: Parameters<typeof pg.queryP_readOnly>) => {
          const rows = await query(...args); // Real DB result, held before delivery.
          arrived();
          await held;
          return rows;
        }
      );
      Config.mathEnv = "prod";
      const pending = path === "point" ? getPca(zid) : prefetchLatestPcaData();
      try {
        await queried;
        Config.mathEnv = "python";
      } finally {
        release();
      }
      await pending;
      expect((await getPca(zid))?.asPOJO.sentinel).toBe("python");
      Config.mathEnv = "prod";
      reads.mockClear();
      expect((await getPca(zid))?.asPOJO.sentinel).toBe("prod");
      expect(reads).not.toHaveBeenCalled();
      if (path === "prefetch") {
        await prefetchLatestPcaData();
        expect(reads.mock.calls[0][1]).toEqual([tickBase + 10, "prod"]);
      }
    }
  );
});
