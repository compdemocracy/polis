import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import Config from "../../src/config";
import { loadConversationSummary } from "../../src/report";
import { setupAuthAndConvo, newAgent } from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";

/**
 * C7 -- a conversation's comments come from the `comments` table, never from the
 * math blob's `tids`.
 *
 * The math engine is moving to an honest, explicit EMPTY result for a
 * conversation with zero votes: `tids: []`, `n-cmts: 0`, `pca.center: []`,
 * `pca.comment-extremity: []`. Production holds 3,212 zero-vote blobs in five
 * distinct legacy shapes (none of which carries a `pca` key), plus B1's
 * synthetic Clojure shape; 2,884 of those conversations have approved comments.
 * The server used to paper over that by backfilling every approved comment id
 * into the served blob, which made the blob look like a comment index.
 *
 * These tests pin the invariant that survives the change: for a zero-vote
 * conversation with approved comments, every legacy blob shape, the new explicit
 * empty golden, and no blob at all must serve the SAME comment set and the SAME
 * comment count -- through participationInit, /math/pca2, nextComment and the
 * conversation summary CSV -- and a conversation with real math must be
 * untouched.
 *
 * Each shape is published under its own `math_env` so it gets its own row and
 * its own `pcaCache` entry (the cache is keyed `[math_env, zid]`), which lets
 * one conversation with one comment set exercise every shape.
 */

const numeric = (a: number, b: number) => a - b;

const EMPTY_BASE_CLUSTERS = { id: [], members: [], x: [], y: [], count: [] };

type Shape = {
  name: string;
  env: string;
  blob: Record<string, unknown> | null;
};

// The five distinct key sets observed across the 3,212 zero-vote production
// blobs (counts from the round-3 review of the production dump), plus B1's
// synthetic Clojure output, plus the corrected 20-field golden. Not one of the
// production shapes has a `pca` key.
function legacyShapes(zid: number): Shape[] {
  return [
    {
      // 3,024 rows
      name: "legacy prod shape 1 (in-conv, meta-tids, mod-in, mod-out)",
      env: "c7-legacy-1",
      blob: {
        zid,
        "base-clusters": EMPTY_BASE_CLUSTERS,
        "in-conv": [],
        "meta-tids": [],
        "mod-in": [],
        "mod-out": [],
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
      },
    },
    {
      // 81 rows
      name: "legacy prod shape 2 (base-clusters only)",
      env: "c7-legacy-2",
      blob: {
        zid,
        "base-clusters": EMPTY_BASE_CLUSTERS,
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
      },
    },
    {
      // 63 rows
      name: "legacy prod shape 3 (in-conv, mod-out)",
      env: "c7-legacy-3",
      blob: {
        zid,
        "base-clusters": EMPTY_BASE_CLUSTERS,
        "in-conv": [],
        "mod-out": [],
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
      },
    },
    {
      // 40 rows
      name: "legacy prod shape 4 (in-conv, meta-tids, mod-out)",
      env: "c7-legacy-4",
      blob: {
        zid,
        "base-clusters": EMPTY_BASE_CLUSTERS,
        "in-conv": [],
        "meta-tids": [],
        "mod-out": [],
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
      },
    },
    {
      // 4 rows
      name: "legacy prod shape 5 (meta-tids, mod-in, mod-out)",
      env: "c7-legacy-5",
      blob: {
        zid,
        "base-clusters": EMPTY_BASE_CLUSTERS,
        "meta-tids": [],
        "mod-in": [],
        "mod-out": [],
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
      },
    },
    {
      name: "B1 synthetic Clojure empty (six keys, pca.comps [[1],[1]])",
      env: "c7-legacy-b1",
      blob: {
        zid,
        "meta-tids": [],
        "base-clusters": EMPTY_BASE_CLUSTERS,
        pca: { comps: [[1.0], [1.0]] },
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
      },
    },
    {
      name: "corrected polis-empty/1 golden (20 explicit fields)",
      env: "c7-golden-empty",
      blob: {
        zid,
        n: 0,
        "n-cmts": 0,
        tids: [],
        "in-conv": [],
        "base-clusters": EMPTY_BASE_CLUSTERS,
        "group-clusters": [],
        "group-votes": {},
        "votes-base": {},
        "user-vote-counts": {},
        "comment-priorities": {},
        consensus: { agree: [], disagree: [] },
        "group-aware-consensus": {},
        repness: {},
        "meta-tids": [],
        "mod-in": [],
        "mod-out": [],
        lastVoteTimestamp: 0,
        lastModTimestamp: null,
        pca: {
          center: [],
          comps: [[], []],
          "comment-projection": [[], []],
          "comment-extremity": [],
        },
      },
    },
    {
      name: "no math row at all",
      env: "c7-no-row",
      blob: null,
    },
  ];
}

async function publish(zid: number, env: string, blob: unknown, tick: number) {
  await pool.query(
    `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
     values ($1, $2, $3, 0, $4, $4)
     on conflict (zid, math_env) do update
       set data = excluded.data, math_tick = excluded.math_tick, caching_tick = excluded.caching_tick`,
    [zid, env, blob, tick]
  );
}

async function zidFor(conversationId: string): Promise<number> {
  const rows = await pool.query("select zid from zinvites where zinvite = $1", [
    conversationId,
  ]);
  return rows.rows[0].zid;
}

function summaryField(rows: string[], field: string): string {
  const row = rows.find((r) => r.startsWith(`${field},`));
  if (!row) throw new Error(`no ${field} row in conversation summary`);
  return row.slice(field.length + 1);
}

describe("zero-vote conversations serve their comments from the comments table", () => {
  const originalMathEnv = Config.mathEnv;
  let conversationId: string;
  let zid: number;
  let approvedTids: number[];
  let agent: Agent;

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 3,
    });
    conversationId = convo.conversationId;
    zid = await zidFor(conversationId);

    // Approved comments, and genuinely zero votes: setupAuthAndConvo casts a
    // throwaway vote to mint a JWT, and this conversation must have none.
    await pool.query("update comments set mod = 1 where zid = $1", [zid]);
    await pool.query("delete from votes_latest_unique where zid = $1", [zid]);
    await pool.query("delete from votes where zid = $1", [zid]);

    const tids = await pool.query(
      "select tid from comments where zid = $1 order by tid",
      [zid]
    );
    // setupAuthAndConvo mints a JWT by voting, which requires a seed comment per
    // call, so the conversation ends up with more than `commentCount` comments.
    // The exact number does not matter; that every one of them is served does.
    approvedTids = tids.rows.map((r: { tid: number }) => r.tid);
    expect(approvedTids.length).toBeGreaterThanOrEqual(3);

    let tick = 1;
    for (const shape of legacyShapes(zid)) {
      if (shape.blob) await publish(zid, shape.env, shape.blob, tick++);
    }

    agent = await newAgent();
  });

  afterAll(async () => {
    Config.mathEnv = originalMathEnv;
    await pool.query("delete from math_main where zid = $1", [zid]);
    await closePool();
  });

  test.each(legacyShapes(0).map((s) => [s.name, s.env] as const))(
    "%s serves the full comment set and count",
    async (_name, env) => {
      Config.mathEnv = env;

      // 1. The comment list itself.
      const comments = await agent.get(
        `/api/v3/comments?conversation_id=${conversationId}`
      );
      expect(comments.status).toBe(200);
      expect(
        comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
      ).toEqual(approvedTids);

      // 2. participationInit: a next comment is offered, and the served math
      //    blob claims no comments of its own.
      const init = await agent.get(
        `/api/v3/participationInit?conversation_id=${conversationId}&pid=-1&lang=en`
      );
      expect(init.status).toBe(200);
      expect(approvedTids).toContain(init.body.nextComment.tid);
      expect(init.body.pca.asPOJO.tids).toEqual([]);
      expect(init.body.pca.asPOJO["n-cmts"]).toBe(0);

      // 3. /api/v3/math/pca2: no backfilled ids, no fabricated geometry.
      const pca2 = await agent.get(
        `/api/v3/math/pca2?conversation_id=${conversationId}`
      );
      expect(pca2.status).toBe(200);
      expect(pca2.body.tids).toEqual([]);
      expect(pca2.body["n-cmts"]).toBe(0);
      expect(pca2.body.pca["comment-extremity"]).toEqual([]);
      expect(pca2.body.pca.center).toEqual([]);

      // 4. nextComment.
      const next = await agent.get(
        `/api/v3/nextComment?conversation_id=${conversationId}&lang=en`
      );
      expect(next.status).toBe(200);
      expect(approvedTids).toContain(next.body.tid);

      // 5. The conversation summary CSV's `comments` column.
      const summary = await loadConversationSummary(zid, "https://example.com");
      expect(summaryField(summary, "comments")).toBe(
        String(approvedTids.length)
      );
    }
  );

  test("a blob whose tids cover only some approved comments hides none of them", async () => {
    Config.mathEnv = "c7-subset-tids";
    await publish(
      zid,
      "c7-subset-tids",
      {
        zid,
        n: 1,
        "n-cmts": 1,
        tids: [approvedTids[0]],
        "in-conv": [],
        "base-clusters": EMPTY_BASE_CLUSTERS,
        "group-clusters": [],
        "group-votes": {},
        "user-vote-counts": {},
        "comment-priorities": {},
        consensus: { agree: [], disagree: [] },
        repness: {},
        lastModTimestamp: null,
        lastVoteTimestamp: 0,
        pca: {
          center: [0],
          comps: [[0], [0]],
          "comment-projection": [[0], [0]],
          "comment-extremity": [0],
        },
      },
      99
    );

    // This is the bug the backfill was papering over: a partial math blob must
    // not shrink the conversation's comment list or its comment count.
    const comments = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );
    expect(
      comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
    ).toEqual(approvedTids);

    const summary = await loadConversationSummary(zid, "https://example.com");
    expect(summaryField(summary, "comments")).toBe(String(approvedTids.length));

    // The blob still says exactly what it computed over, unedited.
    const pca2 = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}`
    );
    expect(pca2.body.tids).toEqual([approvedTids[0]]);
    expect(pca2.body["n-cmts"]).toBe(1);
  });

  test("a conversation with real math is untouched", async () => {
    Config.mathEnv = "c7-voted";
    const voted = {
      zid,
      n: 2,
      "n-cmts": approvedTids.length,
      tids: approvedTids,
      "in-conv": [1, 2],
      "base-clusters": {
        id: [0, 1],
        members: [[1], [2]],
        x: [0.1, -0.1],
        y: [0.2, -0.2],
        count: [1, 1],
      },
      "group-clusters": [
        { id: 0, center: [0.1, 0.2], members: [0] },
        { id: 1, center: [-0.1, -0.2], members: [1] },
      ],
      "group-votes": {},
      "votes-base": {},
      "user-vote-counts": { 1: 3, 2: 3 },
      "comment-priorities": {},
      consensus: { agree: [], disagree: [] },
      "group-aware-consensus": {},
      repness: {},
      "meta-tids": [],
      "mod-in": approvedTids,
      "mod-out": [],
      lastModTimestamp: null,
      lastVoteTimestamp: 1700000000000,
      pca: {
        center: [0.3, -0.3, 0.05],
        comps: [
          approvedTids.map((_, i) => (i === 0 ? 1 : 0)),
          approvedTids.map((_, i) => (i === 1 ? 1 : 0)),
        ],
        "comment-projection": [
          approvedTids.map((_, i) => 0.1 + i / 10),
          approvedTids.map((_, i) => 0.4 + i / 10),
        ],
        "comment-extremity": approvedTids.map((_, i) => 0.7 + i / 10),
      },
    };
    await publish(zid, "c7-voted", voted, 42);

    const pca2 = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}`
    );
    expect(pca2.status).toBe(200);
    expect(pca2.body.tids).toEqual(approvedTids);
    expect(pca2.body["n-cmts"]).toBe(approvedTids.length);
    expect(pca2.body.n).toBe(2);
    expect(pca2.body.pca).toEqual(voted.pca);
    expect(pca2.body["group-clusters"]).toEqual(voted["group-clusters"]);
    expect(pca2.body["user-vote-counts"]).toEqual(voted["user-vote-counts"]);
    expect(pca2.body["in-conv"]).toEqual(voted["in-conv"]);
    expect(pca2.body.math_tick).toBe(42);

    const summary = await loadConversationSummary(zid, "https://example.com");
    expect(summaryField(summary, "comments")).toBe(String(approvedTids.length));
    expect(summaryField(summary, "voters")).toBe("2");
    expect(summaryField(summary, "voters-in-conv")).toBe("2");
    expect(summaryField(summary, "groups")).toBe("2");
  });

  test("a banned comment is excluded from both the list and the count", async () => {
    Config.mathEnv = "c7-golden-empty";
    await pool.query(
      "update comments set mod = -1 where zid = $1 and tid = $2",
      [zid, approvedTids[approvedTids.length - 1]]
    );
    try {
      const comments = await agent.get(
        `/api/v3/comments?conversation_id=${conversationId}`
      );
      expect(
        comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
      ).toEqual(approvedTids.slice(0, -1));
      const summary = await loadConversationSummary(zid, "https://example.com");
      expect(summaryField(summary, "comments")).toBe(
        String(approvedTids.length - 1)
      );
    } finally {
      await pool.query(
        "update comments set mod = 1 where zid = $1 and tid = $2",
        [zid, approvedTids[approvedTids.length - 1]]
      );
    }
  });
});
