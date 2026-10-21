/** The ε-arm and the serve log against a real migrated database
 * (PROPENSITY-LOGGING-DESIGN.md sections 4 and 5).
 *
 * getNextComment runs with its real SQL (comment.ts, utils/pca.ts) on a
 * conversation with more eligible statements than the 999-statement lottery
 * window, so the ε branch can only serve the last statement if its read has
 * no LIMIT. Each choice must leave one comment_serve_log row (migration
 * 000044) naming its branch, pool, weight and propensity.
 *
 * Generated data only. Needs DATABASE_URL (superuser, migrated); see
 * scripts/test-delphi-result-reads.sh. */
import { afterAll, beforeAll, expect, jest, test } from "@jest/globals";
import { Client } from "pg";
import Config from "../../src/config";
import { getNextComment } from "../../src/nextComment";

const ZID = 9701;
const VOTER_PID = 4242; // has voted on nothing
const STATEMENTS = 1005;
const MATH_ENV = "serve_log_pgtest";
let pg: Client;

function draws(...values: number[]) {
  const queue = [...values];
  jest.spyOn(Math, "random").mockImplementation(() => {
    const n = queue.shift();
    if (n === undefined) throw new Error("unexpected Math.random draw");
    return n;
  });
}

async function serveRows(): Promise<Array<Record<string, any>>> {
  return (
    await pg.query(
      "SELECT * FROM comment_serve_log WHERE zid = $1 ORDER BY id",
      [ZID]
    )
  ).rows;
}

// The insert is fire-and-forget: wait for it, boundedly.
async function waitForRows(n: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await serveRows();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return serveRows();
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const owner = ZID * 1000;
  await pg.query("INSERT INTO users (uid, created) VALUES ($1, default)", [
    owner,
  ]);
  await pg.query(
    "INSERT INTO conversations (zid, owner, topic) VALUES ($1, $2, 'generated')",
    [ZID, owner]
  );
  const author = (
    await pg.query(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
      [ZID, owner]
    )
  ).rows[0].pid;
  await pg.query("BEGIN");
  for (let i = 0; i < STATEMENTS; i++) {
    // Distinct `created`, so ORDER BY created is the insertion order.
    await pg.query(
      `INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid)
       VALUES ($1, $2, $3, 1, true, 0, $4, false, false, $5, null)`,
      [author, ZID, `Generated statement ${i}`, owner, 1700000000000 + i]
    );
  }
  await pg.query("COMMIT");
  await pg.query(
    `INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
     VALUES ($1, $2, $3, 0, 7, 7)`,
    [ZID, MATH_ENV, JSON.stringify({ "comment-priorities": { "5": 2 } })]
  );
  Config.mathEnv = MATH_ENV;
  delete process.env.TOPICAL_COMMENT_RATIO;
  delete process.env.ROUTING_SERVE_LOG;
});

afterAll(async () => {
  jest.restoreAllMocks();
  delete process.env.ROUTING_EPSILON;
  await pg?.end();
});

test("ε = 1: the uniform draw reaches past the 999 window, and its serve row is written", async () => {
  process.env.ROUTING_EPSILON = "1";
  draws(0.5, 0.9995); // ε coin, then index floor(0.9995 * 1005) = 1004
  const next = await getNextComment(ZID, VOTER_PID, [], undefined, ZID * 1000);
  jest.restoreAllMocks();
  expect(next?.tid).toBe(1004);
  const [row] = await waitForRows(1);
  expect(row).toMatchObject({
    zid: ZID,
    pid: VOTER_PID,
    uid: ZID * 1000,
    tid: 1004,
    branch: "epsilon",
    epsilon: 1,
    topical_ratio: null,
    math_env: MATH_ENV,
    math_tick: "7", // BIGINT arrives as a string
    pool_size: 999,
    eligible_count: STATEMENTS,
    weight: null,
    weight_sum: 1000, // 998 statements at 1, tid 5 at 2
    random_n: null,
    topical_pool_size: null,
  });
  expect(row.propensity).toBeCloseTo(1 / STATEMENTS, 12);
});

test("ε = 0.5, priority branch: the lottery over the window, m counted", async () => {
  process.env.ROUTING_EPSILON = "0.5";
  draws(0.7, 0.5); // no ε; lottery randomN = 500: tid 499
  const next = await getNextComment(ZID, VOTER_PID, []);
  jest.restoreAllMocks();
  expect(next?.tid).toBe(499);
  const rows = await waitForRows(2);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    tid: 499,
    branch: "priority",
    epsilon: 0.5,
    pool_size: 999,
    eligible_count: STATEMENTS,
    weight: 1,
    weight_sum: 1000,
    random_n: 500,
  });
  expect(rows[1].propensity).toBeCloseTo(0.5 / STATEMENTS + 0.5 / 1000, 12);
});

test("ε unset: the lottery over the capped window, as before, with its serve row", async () => {
  delete process.env.ROUTING_EPSILON;
  draws(0.5); // randomN = 500: tid 499 (cumulative 501)
  const next = await getNextComment(ZID, VOTER_PID, []);
  jest.restoreAllMocks();
  expect(next?.tid).toBe(499);
  const rows = await waitForRows(3);
  expect(rows).toHaveLength(3);
  expect(rows[2]).toMatchObject({
    tid: 499,
    branch: "priority",
    epsilon: 0,
    pool_size: 999,
    eligible_count: null, // the window is full: m unknown
    weight: 1,
    weight_sum: 1000,
    random_n: 500,
  });
  expect(rows[2].propensity).toBeCloseTo(1 / 1000, 12);
});

test("ROUTING_SERVE_LOG=0 writes nothing", async () => {
  process.env.ROUTING_SERVE_LOG = "0";
  draws(0.5);
  expect((await getNextComment(ZID, VOTER_PID, []))?.tid).toBe(499);
  jest.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 200));
  expect(await serveRows()).toHaveLength(3);
  delete process.env.ROUTING_SERVE_LOG;
});
