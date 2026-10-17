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
 * GET /api/v3/math/pca2, POST /api/v3/votes and GET /api/v3/nextComment read
 * the latest math generation through one [math_env, zid] cache. An entry is
 * served for 3 s; after that the committed `math_tick` is read first, and the
 * whole `math_main` row only when the generation changed. A held entity tag is
 * compared with that tick before any blob is read.
 *
 * The 3 s window is crossed by moving `Date.now` forward, not by sleeping.
 */
describe("math generation cache keyed by the committed tick", () => {
  // A label of its own, so no math engine in the test stack writes these rows.
  const mathEnv = "tickcache";
  const originalMathEnv = Config.mathEnv;
  const realNow = Date.now.bind(Date);
  let skew = 0;
  let conversationId: string;
  let zid: number;
  let commentIds: number[];
  let api: Agent;
  let reads: jest.SpiedFunction<typeof pg.queryP_readOnly>;
  let tick = 0;

  const url = () => `/api/v3/math/pca2?conversation_id=${conversationId}`;
  const tag = (t: number) => `"${mathEnv}-${t}"`;

  function expireCaches() {
    skew += 3001;
  }

  function mathMainReads() {
    return reads.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes("from math_main"));
  }
  const blobReads = () =>
    mathMainReads().filter((sql) => !sql.startsWith("select math_tick from"))
      .length;
  const tickReads = () =>
    mathMainReads().filter((sql) => sql.startsWith("select math_tick from"))
      .length;

  // Publish generation `t` the way a writer does: one row per (zid, math_env),
  // with the blob's own lastVoteTimestamp unless told otherwise.
  async function publish(
    t: number,
    {
      lastVoteTimestamp = 1700000000000,
    }: { lastVoteTimestamp?: number | null } = {}
  ) {
    const data = {
      lastVoteTimestamp,
      n: 1,
      "n-cmts": commentIds.length,
      tids: commentIds,
      "in-conv": [0],
      "user-vote-counts": { "0": 1 },
      "group-clusters": [{ id: 0, center: [0, 0], members: [0] }],
      "base-clusters": { id: [0], x: [0], y: [0], count: [1], members: [[0]] },
      pca: {
        comps: [[0.1], [0.2]],
        center: [0, 0],
        "comment-extremity": commentIds.map(() => 0.5),
        "comment-projection": [
          commentIds.map(() => 0.1),
          commentIds.map(() => 0.2),
        ],
      },
      repness: {},
      consensus: { agree: [], disagree: [] },
      "comment-priorities": Object.fromEntries(
        commentIds.map((tid) => [String(tid), 1])
      ),
      generation: t,
      math_tick: t,
    };
    await pool.query(
      `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
       values ($1, $2, $3, 0, $4, $4)
       on conflict (zid, math_env) do update
         set data = excluded.data, math_tick = excluded.math_tick,
             caching_tick = excluded.caching_tick`,
      [zid, mathEnv, data, t]
    );
  }

  // Publish the next generation and serve it once from a window of its own.
  async function publishAndServe() {
    await publish(++tick);
    expireCaches();
    const res = await api.get(url());
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(tag(tick));
    return res;
  }

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({ commentCount: 3 });
    conversationId = convo.conversationId;
    commentIds = convo.commentIds;
    const rows = await pool.query(
      "select zid from zinvites where zinvite = $1",
      [conversationId]
    );
    zid = rows.rows[0].zid;
    api = await newAgent();
    Config.mathEnv = mathEnv;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    reads = jest.spyOn(pg, "queryP_readOnly");
  });

  beforeEach(() => {
    reads.mockClear();
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

  test("concurrent polls after the window share one row read", async () => {
    await publishAndServe();

    await publish(++tick);
    expireCaches();
    reads.mockClear();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => api.get(url()))
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe(tag(tick));
      expect(res.body.generation).toBe(tick);
    }
    expect(blobReads()).toBe(1);
  });

  test("concurrent polls of an unchanged generation read only its tick", async () => {
    const warm = await publishAndServe();

    expireCaches();
    reads.mockClear();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => api.get(url()))
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe(tag(tick));
      expect(res.text).toBe(warm.text);
    }
    expect(blobReads()).toBe(0);
    expect(tickReads()).toBe(1);
  });

  test("a held current tag gets the 304 without a blob read", async () => {
    await publishAndServe();
    const fromCache = await api.get(url()).set("If-None-Match", tag(tick));
    // The same 304 a warm cache answers: same headers apart from the clock.
    const headers = (r: typeof fromCache) => {
      const rest = { ...r.headers };
      delete rest.date;
      return rest;
    };

    expireCaches();
    reads.mockClear();
    const res = await api.get(url()).set("If-None-Match", tag(tick));
    expect(res.status).toBe(304);
    expect(blobReads()).toBe(0);
    expect(fromCache.status).toBe(304);
    expect(headers(res)).toEqual(headers(fromCache));
    expect(res.headers.etag).toBe(tag(tick));
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.text).toBe("");
  });

  test("a held tag of a generation this process has not read gets the 304 without a blob read", async () => {
    await publishAndServe();
    // A tag this process never served, e.g. one another process handed out.
    await publish(++tick);
    expireCaches();
    reads.mockClear();
    const res = await api.get(url()).set("If-None-Match", tag(tick));
    expect(res.status).toBe(304);
    expect(res.headers.etag).toBe(tag(tick));
    expect(blobReads()).toBe(0);
  });

  test("a new generation is served on the first poll after the window", async () => {
    const held = await publishAndServe();

    await publish(++tick);
    expireCaches();
    const res = await api.get(url()).set("If-None-Match", held.headers.etag);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(tag(tick));
    expect(res.body.generation).toBe(tick);
    expect(res.body.math_tick).toBe(tick);

    const subset = await api
      .get(`${url()}&keys=generation,math_tick`)
      .set("If-None-Match", held.headers.etag);
    expect(subset.status).toBe(200);
    expect(subset.body).toEqual({ generation: tick, math_tick: tick });
  });

  test("a generation without its own lastVoteTimestamp is read again each window", async () => {
    // Such a blob is given Date.now() each time it is read, so its served
    // bytes move every window; serving the entry again would freeze them.
    await publish(++tick, { lastVoteTimestamp: null });
    expireCaches();
    const first = await api.get(url());
    expect(first.headers.etag).toBe(tag(tick));

    expireCaches();
    reads.mockClear();
    const second = await api.get(url());
    expect(second.headers.etag).toBe(tag(tick));
    expect(blobReads()).toBe(1);
    expect(second.body.lastVoteTimestamp).toBeGreaterThanOrEqual(
      first.body.lastVoteTimestamp + 3001
    );
  });

  test("a vote after the window answers without reloading an unchanged generation", async () => {
    await publish(++tick);
    expireCaches();
    // participationInit reads this generation; its featured-author read then
    // leaves a Bundle entry in the cache slot.
    const { agent } = await initializeParticipant(conversationId);
    const first = await submitVote(agent, {
      conversation_id: conversationId,
      tid: commentIds[0],
      vote: WIRE_AGREE,
    });
    expect(first.status).toBe(200);

    expireCaches();
    reads.mockClear();
    const second = await submitVote(agent, {
      conversation_id: conversationId,
      tid: commentIds[1],
      vote: WIRE_AGREE,
    });
    expect(second.status).toBe(200);
    expect(blobReads()).toBe(0);
    expect(tickReads()).toBe(1);
  });
});
