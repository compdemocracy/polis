import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import fs from "fs";
import path from "path";
import type { Agent } from "supertest";
import Config from "../../src/config";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
} from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

/**
 * GET /api/v3/nextComment draws among the statements the requester has not
 * voted on, each weighted by its priority in the latest math generation.
 *
 * The generation used here is the Python math writer's own output, recorded
 * by delphi/tests/poller/test_comment_priorities_key.py and inserted into
 * math_main unchanged: this test never names the key the priorities sit
 * under, so it fails whenever the writer and this route disagree about it.
 * In that conversation one statement's priority is nine times each of the
 * other three's, so a weighted draw picks it three times in four and a
 * uniform draw one time in four.
 */
const FIXTURE = path.resolve(
  __dirname,
  "../../../delphi/tests/poller/fixtures/math-main-priorities.json"
);

type Fixture = {
  dominant_tid: string;
  engine_priorities: Record<string, number>;
  math_main: Record<string, unknown> & { tids: number[] };
};

// A seeded generator for Math.random, so the draws are the same every run.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nextComment weights the draw by the math writer's priorities", () => {
  // A label of its own, so no math engine in the test stack writes these rows.
  const mathEnv = "prioritieskey";
  const originalMathEnv = Config.mathEnv;
  const draws = 400;
  const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  let conversationId: string;
  let zid: number;
  let anonymous: Agent;

  beforeAll(async () => {
    const tids = fixture.math_main.tids;
    const pooledUser = getPooledTestUser(1);
    const { agent: owner } = await getJwtAuthenticatedAgent({
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    });
    conversationId = await createConversation(owner, {
      topic: "Next statement priorities",
    });
    for (let i = 0; i < tids.length; i++) {
      const res = await owner.post("/api/v3/comments").send({
        conversation_id: conversationId,
        txt: `Statement ${i} ${Date.now()}`,
      });
      expect(res.status).toBe(200);
    }
    const rows = await pool.query(
      "select zid from zinvites where zinvite = $1",
      [conversationId]
    );
    zid = rows.rows[0].zid;
    // The recorded generation's statements are exactly this conversation's.
    const comments = await pool.query(
      "select tid from comments where zid = $1 order by tid",
      [zid]
    );
    expect(comments.rows.map((r) => r.tid)).toEqual(
      [...tids].sort((a, b) => a - b)
    );
    Config.mathEnv = mathEnv;
    await pool.query(
      `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
       values ($1, $2, $3, 0, 1, 1)`,
      [zid, mathEnv, JSON.stringify(fixture.math_main)]
    );
    anonymous = await newAgent();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    Config.mathEnv = originalMathEnv;
    await pool.query("delete from math_main where zid = $1 and math_env = $2", [
      zid,
      mathEnv,
    ]);
    await closePool();
  });

  test("the dominant statement is drawn in proportion to its priority", async () => {
    const counts = new Map<number, number>();
    jest.spyOn(Math, "random").mockImplementation(seededRandom(20261018));
    try {
      for (let i = 0; i < draws; i++) {
        const res = await anonymous.get(
          `/api/v3/nextComment?conversation_id=${conversationId}`
        );
        expect(res.status).toBe(200);
        counts.set(res.body.tid, (counts.get(res.body.tid) ?? 0) + 1);
      }
    } finally {
      jest.restoreAllMocks();
    }

    const tids = fixture.math_main.tids;
    expect([...counts.keys()].every((tid) => tids.includes(tid))).toBe(true);
    const weights = Object.values(fixture.engine_priorities);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const weighted = fixture.engine_priorities[fixture.dominant_tid] / total;
    const uniform = 1 / tids.length;
    const share = (counts.get(Number(fixture.dominant_tid)) ?? 0) / draws;
    // Wide margins: the two expectations are 0.75 and 0.25.
    expect(weighted - uniform).toBeGreaterThan(0.4);
    expect(Math.abs(share - weighted)).toBeLessThan(0.1);
  });
});
