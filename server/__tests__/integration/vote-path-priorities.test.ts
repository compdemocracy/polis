import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";
import Config from "../../src/config";
import pg from "../../src/db/pg-query";
import { WIRE_AGREE } from "../../src/votes/convention";
import {
  initializeParticipant,
  newAgent,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";

/**
 * POST /api/v3/votes, GET /api/v3/nextComment and participationInit choose
 * the next statement with the latest committed generation's
 * `comment-priorities`. Only that map is read for the choice: a new
 * generation costs one tick read and one read of that field, shared by
 * concurrent requests, and never the whole `math_main` row with its
 * normalization and compression.
 *
 * The draw itself is unchanged: the same priorities give the same statement
 * and the same body, whichever cache they came from, and a conversation with
 * no committed math draws unprioritized exactly as before.
 *
 * The 3 s cache window is crossed by moving `Date.now` forward, not by
 * sleeping. `Math.random` is pinned where a body is compared.
 */
describe("next-statement priorities without the whole math result", () => {
  // A label of its own, so no math engine in the test stack writes these rows.
  const mathEnv = "prioritiescache";
  const originalMathEnv = Config.mathEnv;
  const realNow = Date.now.bind(Date);
  const realRead = pg.queryP_readOnly;
  let skew = 0;
  let failMathReads = false;
  let reads: jest.SpiedFunction<typeof pg.queryP_readOnly>;
  let random: jest.SpiedFunction<typeof Math.random> | undefined;

  let conversationId: string;
  let zid: number;
  let commentIds: number[];
  let tick = 0;

  // Large enough that a whole-row read is unmistakable in the bytes moved.
  const PADDING = "x".repeat(256 * 1024);

  function expireCaches() {
    skew += 3001;
  }

  function pinRandom(value: number) {
    random?.mockRestore();
    random = jest.spyOn(Math, "random").mockReturnValue(value);
  }

  function unpinRandom() {
    random?.mockRestore();
    random = undefined;
  }

  const mathMainCalls = () =>
    reads.mock.calls
      .map((call, i) => ({
        sql: String(call[0]),
        result: reads.mock.results[i],
      }))
      .filter(({ sql }) => sql.includes("from math_main"));
  const isTickRead = (sql: string) =>
    sql.startsWith("select math_tick from math_main");
  const isPrioritiesRead = (sql: string) =>
    sql.includes("data->'comment-priorities'");
  // Any math_main read that is neither: the whole row (getPca) or a Bundle.
  const wholeMathReads = () =>
    mathMainCalls().filter(
      ({ sql }) => !isTickRead(sql) && !isPrioritiesRead(sql)
    ).length;
  const tickReads = () =>
    mathMainCalls().filter(({ sql }) => isTickRead(sql)).length;
  const prioritiesReads = () =>
    mathMainCalls().filter(({ sql }) => isPrioritiesRead(sql)).length;
  // The JSON size of what each math_main read brought back to this process.
  const mathMainBytes = () =>
    Promise.all(
      mathMainCalls().map(async ({ result }) =>
        Buffer.byteLength(JSON.stringify(await result.value))
      )
    );

  // Publish generation `t` the way a writer does: one row per (zid, math_env).
  async function publish(
    targetZid: number,
    t: number,
    priorities: Record<string, number>,
    tids: number[]
  ) {
    const data = {
      lastVoteTimestamp: 1700000000000,
      n: 1,
      "n-cmts": tids.length,
      tids,
      "in-conv": [0],
      "user-vote-counts": { "0": 1 },
      "group-clusters": [{ id: 0, center: [0, 0], members: [0] }],
      "base-clusters": { id: [0], x: [0], y: [0], count: [1], members: [[0]] },
      pca: {
        comps: [[0.1], [0.2]],
        center: [0, 0],
        "comment-extremity": tids.map(() => 0.5),
        "comment-projection": [tids.map(() => 0.1), tids.map(() => 0.2)],
      },
      repness: {},
      consensus: { agree: [], disagree: [] },
      "comment-priorities": priorities,
      padding: PADDING,
      math_tick: t,
    };
    await pool.query(
      `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
       values ($1, $2, $3, 0, $4, $4)
       on conflict (zid, math_env) do update
         set data = excluded.data, math_tick = excluded.math_tick,
             caching_tick = excluded.caching_tick`,
      [targetZid, mathEnv, data, t]
    );
  }

  // Priorities under which one statement is all but certain to be drawn.
  const dominating = (tid: number) =>
    Object.fromEntries(
      commentIds.map((c) => [String(c), c === tid ? 1000000 : 1])
    );

  async function zidOf(id: string) {
    const rows = await pool.query(
      "select zid from zinvites where zinvite = $1",
      [id]
    );
    return rows.rows[0].zid as number;
  }

  // The statements a participant can be served, in the order selection reads
  // them. The setup helper also leaves seed statements of its own.
  async function visibleStatements(targetZid: number) {
    const rows = await pool.query(
      "select tid from comments where zid = $1 and active and velocity > 0 and mod <> -1 order by created",
      [targetZid]
    );
    return rows.rows.map((row) => row.tid as number);
  }

  // A participant who has voted on `voted`, with a JWT for later requests.
  async function participantWhoVoted(id: string, voted: number[]) {
    const { agent } = await initializeParticipant(id);
    for (const tid of voted) {
      const res = await submitVote(agent, {
        conversation_id: id,
        tid,
        vote: WIRE_AGREE,
      });
      expect(res.status).toBe(200);
    }
    return agent;
  }

  const nextComment = (agent: Agent, id: string) =>
    agent.get(`/api/v3/nextComment?conversation_id=${id}`);

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({ commentCount: 5 });
    conversationId = convo.conversationId;
    commentIds = convo.commentIds;
    zid = await zidOf(conversationId);
    Config.mathEnv = mathEnv;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    reads = jest
      .spyOn(pg, "queryP_readOnly")
      .mockImplementation(((sql: string, ...args: any[]) =>
        failMathReads && String(sql).includes("from math_main")
          ? Promise.reject(new Error("generated math read failure"))
          : (realRead as any).call(pg, sql, ...args)) as any);
  });

  beforeEach(() => {
    reads.mockClear();
    failMathReads = false;
    unpinRandom();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    Config.mathEnv = originalMathEnv;
    await pool.query("delete from math_main where math_env = $1", [mathEnv]);
    await closePool();
  });

  test("concurrent votes after a new generation read only its tick and its priorities", async () => {
    const [first, second] = commentIds;
    await publish(zid, ++tick, dominating(commentIds[2]), commentIds);
    expireCaches();
    const agents = await Promise.all(
      Array.from({ length: 8 }, () =>
        participantWhoVoted(conversationId, [first])
      )
    );

    // The next generation favours another statement.
    await publish(zid, ++tick, dominating(commentIds[4]), commentIds);
    expireCaches();
    pinRandom(0.5);
    reads.mockClear();
    const responses = await Promise.all(
      agents.map((agent) =>
        submitVote(agent, {
          conversation_id: conversationId,
          tid: second,
          vote: WIRE_AGREE,
        })
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      // Drawn with the new generation's priorities, on the first request after
      // the window, as before.
      expect(res.body.nextComment.tid).toBe(commentIds[4]);
    }
    expect(wholeMathReads()).toBe(0);
    expect(tickReads()).toBe(1);
    expect(prioritiesReads()).toBe(1);
    // The blob carries 256 KiB; the vote path brings back only the map.
    for (const bytes of await mathMainBytes()) {
      expect(bytes).toBeLessThan(4096);
    }
  });

  test("the same priorities give the same draw from the math entry, the priorities read and the priorities cache", async () => {
    // Left with exactly three statements to draw from.
    const candidates = commentIds.slice(2);
    const voted = (await visibleStatements(zid)).filter(
      (tid) => !candidates.includes(tid)
    );
    const agent = await participantWhoVoted(conversationId, voted);
    // Weights that matter: a draw over 1 + 50 + 1. A priority of 0 and a
    // statement the map does not score both weigh 1, as before.
    const priorities = {
      [String(commentIds[0])]: 7,
      [String(commentIds[2])]: 0,
      [String(commentIds[3])]: 50,
    };
    const weightTotal = candidates.reduce(
      (sum, tid) => sum + (priorities[String(tid)] || 1),
      0
    );
    const pca2 = await newAgent();
    const drawn = new Set<number>();

    for (const r of [0.004, 0.2, 0.5, 0.93, 0.999]) {
      pinRandom(r);

      // From the math entry: a pca2 read has just loaded this generation.
      await publish(zid, ++tick, priorities, commentIds);
      expireCaches();
      const loaded = await pca2.get(
        `/api/v3/math/pca2?conversation_id=${conversationId}`
      );
      expect(loaded.status).toBe(200);
      reads.mockClear();
      const fromMathEntry = await nextComment(agent, conversationId);
      expect(fromMathEntry.status).toBe(200);
      expect(mathMainCalls()).toHaveLength(0);

      // From the priorities read: a new generation with the same priorities.
      await publish(zid, ++tick, priorities, commentIds);
      expireCaches();
      reads.mockClear();
      const fromRead = await nextComment(agent, conversationId);
      expect(fromRead.status).toBe(200);
      expect(wholeMathReads()).toBe(0);
      expect(prioritiesReads()).toBe(1);

      // From the priorities cache, inside the window.
      reads.mockClear();
      const fromCache = await nextComment(agent, conversationId);
      expect(fromCache.status).toBe(200);
      expect(mathMainCalls()).toHaveLength(0);

      expect(fromRead.text).toBe(fromMathEntry.text);
      expect(fromCache.text).toBe(fromMathEntry.text);
      // The weighted draw: priorities[tid] || 1 over the candidates.
      expect(fromMathEntry.body.randomN).toBe(r * weightTotal);
      expect(candidates).toContain(fromMathEntry.body.tid);
      drawn.add(fromMathEntry.body.tid);
    }
    // The pinned draws reach every candidate, so the weights are exercised.
    expect([...drawn].sort()).toEqual([...candidates].sort());
  });

  test("a conversation without committed math draws unprioritized, as before", async () => {
    const other = await setupAuthAndConvo({ commentCount: 3 });
    const otherZid = await zidOf(other.conversationId);
    const voted = [other.commentIds[0]];
    const agent = await participantWhoVoted(other.conversationId, voted);
    const candidates = (await visibleStatements(otherZid)).filter(
      (tid) => !voted.includes(tid)
    );
    const r = 0.5;
    pinRandom(r);

    // No math_main row at all: one read, no priorities.
    expireCaches();
    reads.mockClear();
    const noRow = await nextComment(agent, other.conversationId);
    expect(noRow.status).toBe(200);
    // Every weight is 1.
    expect(noRow.body.randomN).toBe(r * candidates.length);
    expect(noRow.body.tid).toBe(candidates[Math.floor(r * candidates.length)]);
    expect(mathMainCalls()).toHaveLength(1);

    // A row whose generation is not committed yet (math_tick -1) is no math.
    await publish(
      otherZid,
      -1,
      { [String(candidates[0])]: 1000000 },
      other.commentIds
    );
    expireCaches();
    reads.mockClear();
    const uncommitted = await nextComment(agent, other.conversationId);
    expect(uncommitted.status).toBe(200);
    expect(uncommitted.text).toBe(noRow.text);
    expect(mathMainCalls()).toHaveLength(1);
  });

  test("a failed math read fails the next statement as before, and the next request reads again", async () => {
    const agent = await participantWhoVoted(conversationId, [commentIds[0]]);
    await publish(zid, ++tick, dominating(commentIds[3]), commentIds);
    expireCaches();
    failMathReads = true;
    const failed = await nextComment(agent, conversationId);
    expect(failed.status).toBe(500);
    expect(failed.text).toContain("polis_err_get_next_comment");

    failMathReads = false;
    const answered = await nextComment(agent, conversationId);
    expect(answered.status).toBe(200);
    expect(answered.body.tid).toBe(commentIds[3]);
  });
});
