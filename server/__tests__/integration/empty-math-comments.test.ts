import fs from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import Config from "../../src/config";
import { loadConversationSummary } from "../../src/report";
import { setupAuthAndConvo, newAgent } from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";

/**
 * C7 -- the math engine emits an honest EMPTY result; the server keeps serving
 * the same bytes.
 *
 * The engine is moving to an explicit empty result for a conversation with zero
 * votes: `tids: []`, `n-cmts: 0`, `pca.center: []`, `pca.comment-extremity: []`.
 * `createEmptyPcaStructure` (src/utils/pca.ts) matches it -- a template of
 * absences that asks the database nothing.
 *
 * The decision that governs the API is the other half: served output must not
 * change. 2,884 production conversations hold zero votes and approved comments,
 * in five distinct legacy blob shapes (none of which carries a `pca` key), plus
 * the no-math-row fallback; already-loaded clients read `math["n-cmts"]` and
 * `tids` straight off those responses and cannot be updated. So the historical
 * comment/PCA defaults are put back at the response boundary by `presentPca`
 * (src/utils/pcaPresentation.ts), from the `comments` table, using the predicate
 * the old backfill used.
 *
 * These tests are a byte-for-byte characterization, not an opinion about what
 * the response ought to contain. The golden checked in beside this file was
 * RECORDED BY RUNNING THIS FILE ON `origin/edge` -- see `RECORD_ENV` below --
 * so every assertion is "identical to what edge serves", and any difference at
 * all fails, including one nobody thought to assert.
 *
 * Each shape is published under its own `math_env` so it gets its own row and
 * its own `pcaCache` entry (the cache is keyed `[math_env, zid]`), which lets one
 * conversation with one comment set exercise every shape from a cold cache.
 *
 * There are two comparisons here, and the second is the one that gates the
 * cutover:
 *
 *   1. SAME INPUT -- each blob shape through this server must serve exactly what
 *      the same blob shape served on `edge`. That is this server release, before
 *      any engine change.
 *   2. THE CUTOVER -- with the comments table unchanged, the corrected engine's
 *      `polis-empty/1` result through THIS server must serve what the legacy
 *      blob served through `edge`. That is the pair BOARD [55] is about: the
 *      conversation whose blob is about to be replaced. Comparing the corrected
 *      golden on `edge` against the corrected golden here compares the wrong
 *      pair -- the old engine never emitted it -- and is kept below only as the
 *      failing control it is.
 */

const GOLDEN_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "c7-empty-math-golden.json"
);

/**
 * How the golden was made, and how to remake it. `EDGE` is this branch's base,
 * `451ab8265` (`server/src/utils/pca.ts` there is identical to `origin/edge`'s):
 *
 *   git archive $EDGE | tar -x -C /tmp/edge-tree
 *   ln -s "$PWD/server/node_modules" /tmp/edge-tree/server/node_modules
 *   cp server/.env /tmp/edge-tree/server/.env
 *   cp server/__tests__/integration/empty-math-comments.test.ts \
 *      /tmp/edge-tree/server/__tests__/integration/
 *   cd /tmp/edge-tree/server && C7_RECORD_GOLDEN=1 npx jest --ci empty-math-comments
 *   cp /tmp/edge-tree/server/__tests__/fixtures/c7-empty-math-golden.json \
 *      "$OLDPWD/server/__tests__/fixtures/"
 *
 * Recording on this branch instead would make the test tautological. In
 * `C7_RECORD_GOLDEN=1` mode every assertion returns early, so the recorder runs
 * green on `edge` even for the cases `edge` fails; it records, it does not judge.
 */
const RECORD_ENV = "C7_RECORD_GOLDEN";
const RECORDING = process.env[RECORD_ENV] === "1";

const numeric = (a: number, b: number) => a - b;

const EMPTY_BASE_CLUSTERS = { id: [], members: [], x: [], y: [], count: [] };

// A fixed topic and description: the default ones carry Date.now().
const TOPIC = "C7 empty math characterization";
const DESCRIPTION = "C7 empty math characterization description";
const SITE_URL = "https://example.com";

type Scenario = {
  name: string;
  env: string;
  blob: ((zid: number, tids: number[]) => Record<string, unknown>) | null;
  // Whether `edge` filled the four presentation fields from `comments` for this
  // shape -- true when the blob does not carry them itself.
  backfilled: boolean;
};

// The five distinct key sets observed across the 3,212 zero-vote production
// blobs (counts from the round-3 review of the production dump), plus B1's
// public-fixture Clojure output, plus the corrected 20-field golden, plus no row at
// all. Not one of the production shapes has a `pca` key, which is why all four
// presentation fields are template-defaulted for every one of them.
const EMPTY_SCENARIOS: Scenario[] = [
  {
    // 3,024 rows
    name: "legacy prod shape 1 (in-conv, meta-tids, mod-in, mod-out)",
    env: "c7-legacy-1",
    backfilled: true,
    blob: (zid) => ({
      zid,
      "base-clusters": EMPTY_BASE_CLUSTERS,
      "in-conv": [],
      "meta-tids": [],
      "mod-in": [],
      "mod-out": [],
      lastModTimestamp: null,
      lastVoteTimestamp: 0,
    }),
  },
  {
    // 81 rows
    name: "legacy prod shape 2 (base-clusters only)",
    env: "c7-legacy-2",
    backfilled: true,
    blob: (zid) => ({
      zid,
      "base-clusters": EMPTY_BASE_CLUSTERS,
      lastModTimestamp: null,
      lastVoteTimestamp: 0,
    }),
  },
  {
    // 63 rows
    name: "legacy prod shape 3 (in-conv, mod-out)",
    env: "c7-legacy-3",
    backfilled: true,
    blob: (zid) => ({
      zid,
      "base-clusters": EMPTY_BASE_CLUSTERS,
      "in-conv": [],
      "mod-out": [],
      lastModTimestamp: null,
      lastVoteTimestamp: 0,
    }),
  },
  {
    // 40 rows
    name: "legacy prod shape 4 (in-conv, meta-tids, mod-out)",
    env: "c7-legacy-4",
    backfilled: true,
    blob: (zid) => ({
      zid,
      "base-clusters": EMPTY_BASE_CLUSTERS,
      "in-conv": [],
      "meta-tids": [],
      "mod-out": [],
      lastModTimestamp: null,
      lastVoteTimestamp: 0,
    }),
  },
  {
    // 4 rows
    name: "legacy prod shape 5 (meta-tids, mod-in, mod-out)",
    env: "c7-legacy-5",
    backfilled: true,
    blob: (zid) => ({
      zid,
      "base-clusters": EMPTY_BASE_CLUSTERS,
      "meta-tids": [],
      "mod-in": [],
      "mod-out": [],
      lastModTimestamp: null,
      lastVoteTimestamp: 0,
    }),
  },
  {
    name: "B1 public-fixture Clojure empty (six keys, pca.comps [[1],[1]])",
    env: "c7-legacy-b1",
    backfilled: true,
    blob: (zid) => ({
      zid,
      "meta-tids": [],
      "base-clusters": EMPTY_BASE_CLUSTERS,
      pca: { comps: [[1.0], [1.0]] },
      lastModTimestamp: null,
      lastVoteTimestamp: 0,
    }),
  },
  {
    name: "no math row at all",
    env: "c7-no-row",
    backfilled: true,
    blob: null,
  },
];

/**
 * The corrected engine's own output: `polis-empty/1` from
 * P-022-G-engine-contract.md, all 20 fields, as the engine will emit it for a
 * conversation with zero votes.
 *
 * This is NOT a same-input case. It is the thing the legacy blobs above are
 * about to be replaced BY, so its comparison is against what those blobs served
 * on `edge` -- see "the cutover" tests below. Recorded on `edge` too, where it
 * is G rev4's documented failing control: `edge` never backfilled a blob that
 * declares these fields, so publishing it through the old merge silently drops
 * the conversation's comments.
 */
const CORRECTED_GOLDEN: Scenario = {
  name: "corrected polis-empty/1 golden (20 explicit fields)",
  env: "c7-golden-empty",
  backfilled: false,
  blob: (zid) => ({
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
  }),
};

/**
 * How far the cutover comparison gets as BYTES, and where it stops.
 *
 * The served key order is the merge's: the template's keys in template order,
 * then whatever else the blob carries, then the arrays the guards append when a
 * blob omits them, in guard order (`mod-in`, `mod-out`, `meta-tids`). The blob's
 * own key order is not the engine's -- `math_main.data` is `jsonb`, so Postgres
 * has already canonicalized it (by key length, then bytewise) before the server
 * sees it -- but the SPLIT between "carried by the blob" and "appended by the
 * guards" still depends on the blob's key SET.
 *
 * Three of the five production shapes therefore land on exactly `polis-empty/1`'s
 * served key order and are compared as exact strings. The two that carry
 * `mod-out` without `mod-in` (shapes 3 and 4, 103 of the 3,212 zero-vote rows)
 * put those three empty arrays in a different position. Their VALUES, and every
 * other key's position, are still compared exactly; only the position of these
 * three is exempt, and the exemption is itself asserted rather than assumed.
 *
 * This is not fixable at the presentation layer: `edge`'s order for a shape is a
 * function of that shape's key set, and same-input byte identity pins this
 * server to it, so no single presented order can equal all five.
 */
const MERGE_APPENDED_KEYS = ["meta-tids", "mod-in", "mod-out"];

const ORDER_ONLY_CUTOVER = new Set([
  "legacy prod shape 3 (in-conv, mod-out)",
  "legacy prod shape 4 (in-conv, meta-tids, mod-out)",
]);

const OTHER_SCENARIOS: Scenario[] = [
  {
    // The bug the backfill was papering over: a blob that covers only some of the
    // approved comments used to be indistinguishable from one that covered all
    // of them. It carries every presentation field itself, so `presentPca` is a
    // pass-through and the served bytes are edge's.
    name: "blob whose tids cover only one approved comment",
    env: "c7-subset-tids",
    backfilled: false,
    blob: (zid, tids) => ({
      zid,
      n: 1,
      "n-cmts": 1,
      tids: [tids[0]],
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
    }),
  },
  {
    name: "a conversation with real math",
    env: "c7-voted",
    backfilled: false,
    blob: (zid, tids) => ({
      zid,
      n: 2,
      "n-cmts": tids.length,
      tids,
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
      "mod-in": tids,
      "mod-out": [],
      lastModTimestamp: null,
      lastVoteTimestamp: 1700000000000,
      pca: {
        center: [0.3, -0.3, 0.05],
        comps: [
          tids.map((_, i) => (i === 0 ? 1 : 0)),
          tids.map((_, i) => (i === 1 ? 1 : 0)),
        ],
        "comment-projection": [
          tids.map((_, i) => 0.1 + i / 10),
          tids.map((_, i) => 0.4 + i / 10),
        ],
        "comment-extremity": tids.map((_, i) => 0.7 + i / 10),
      },
    }),
  },
  {
    // The most common production shape, under its own env so the cache is cold,
    // exercised with the last comment banned: it must drop out of the served
    // comment list, out of the backfilled ids, and out of both counts.
    name: "banned comment, empty math",
    env: "c7-banned",
    backfilled: true,
    blob: EMPTY_SCENARIOS.find((s) => s.env === "c7-legacy-1")!.blob,
  },
];

const ALL_SCENARIOS = [
  ...EMPTY_SCENARIOS,
  CORRECTED_GOLDEN,
  ...OTHER_SCENARIOS,
];

// Values that legitimately differ between two runs of this file. Everything else
// is compared exactly.
const VOLATILE_KEYS = new Set([
  "created", // comment/vote timestamps
  "modified",
  "expiration", // PcaCacheItem's own 3s cache stamp
  "asBufferOfGzippedJson", // gzip of asJSON, compared through asJSON instead
  "randomN", // nextComment's draw
]);

// `getJwtAuthenticatedAgent` mints its seed comments with a Date.now() suffix.
const SEED_TXT = /Seed comment for auth \d+/g;

function normalize(value: unknown, cid: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, cid));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      if (VOLATILE_KEYS.has(key)) {
        out[key] = "<volatile>";
      } else if (
        key === "lastVoteTimestamp" &&
        typeof v === "number" &&
        v > 1e12
      ) {
        // The no-row fallback stamps Date.now() here.
        out[key] = "<now>";
      } else {
        out[key] = normalize(v, cid);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .split(cid)
      .join("<conversation_id>")
      .replace(SEED_TXT, "Seed comment for auth <ts>");
  }
  return value;
}

function normalizeText(text: string | undefined, cid: string): string | null {
  if (typeof text !== "string") return null;
  return text
    .split(cid)
    .join("<conversation_id>")
    .replace(SEED_TXT, "Seed comment for auth <ts>")
    .replace(/"lastVoteTimestamp":\d{13}/g, '"lastVoteTimestamp":<now>');
}

const observations: Record<string, unknown> = {};

describe("zero-vote conversations serve exactly the bytes edge served", () => {
  const originalMathEnv = Config.mathEnv;
  let conversationId: string;
  let zid: number;
  let approvedTids: number[];
  let agent: Agent;

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 3,
      conversationOptions: { topic: TOPIC, description: DESCRIPTION },
    });
    conversationId = convo.conversationId;
    const zidRows = await pool.query(
      "select zid from zinvites where zinvite = $1",
      [conversationId]
    );
    zid = zidRows.rows[0].zid;

    // Approved comments, and genuinely zero votes: setupAuthAndConvo casts a
    // throwaway vote to mint a JWT, and this conversation must have none.
    await pool.query("update comments set mod = 1 where zid = $1", [zid]);
    await pool.query("delete from votes_latest_unique where zid = $1", [zid]);
    await pool.query("delete from votes where zid = $1", [zid]);

    const tids = await pool.query(
      "select tid from comments where zid = $1 order by tid",
      [zid]
    );
    approvedTids = tids.rows.map((r: { tid: number }) => r.tid);
    expect(approvedTids.length).toBeGreaterThanOrEqual(3);

    // The same `math_tick` for every shape. Each shape lives in its own
    // `math_env`, so they never compete, and an identical tick is what makes the
    // cutover comparison a comparison of BYTES: `math_tick` is serialized into
    // the response, and a legacy blob and its replacement carrying different
    // generation numbers would mask everything else with a diff nobody cares
    // about. It must be > 0 for `getPca` to consider the row newer than a
    // `math_tick`-less request.
    const MATH_TICK = 1;
    for (const scenario of ALL_SCENARIOS) {
      if (!scenario.blob) continue;
      await pool.query(
        `insert into math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick)
         values ($1, $2, $3, 0, $4, $4)
         on conflict (zid, math_env) do update
           set data = excluded.data, math_tick = excluded.math_tick, caching_tick = excluded.caching_tick`,
        [zid, scenario.env, scenario.blob(zid, approvedTids), MATH_TICK]
      );
    }

    agent = await newAgent();
  });

  afterAll(async () => {
    Config.mathEnv = originalMathEnv;
    await pool.query("delete from math_main where zid = $1", [zid]);
    if (RECORDING) {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(
        GOLDEN_PATH,
        JSON.stringify(observations, null, 2) + "\n"
      );
      // eslint-disable-next-line no-console
      console.log(`wrote golden: ${GOLDEN_PATH}`);
    }
    await closePool();
  });

  /**
   * Everything the four endpoints and the summary CSV put on the wire for one
   * `math_env`, normalized only where a value cannot repeat across runs.
   */
  async function observe(env: string) {
    Config.mathEnv = env;
    const n = (v: unknown) => normalize(v, conversationId);
    const t = (v: string | undefined) => normalizeText(v, conversationId);

    const comments = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}`
    );
    const init = await agent.get(
      `/api/v3/participationInit?conversation_id=${conversationId}&pid=-1&lang=en`
    );
    const pca2 = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}`
    );
    // The `keys` allowlist path, which client-participation-alpha uses.
    const pca2Keys = await agent.get(
      `/api/v3/math/pca2?conversation_id=${conversationId}&keys=tids&keys=n-cmts&keys=pca`
    );
    const next = await agent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}&lang=en`
    );
    const summary = await loadConversationSummary(zid, SITE_URL);

    const servedTids: number[] = (comments.body || []).map(
      (c: { tid: number }) => c.tid
    );
    const initPca = init.body?.pca;
    return {
      comments: { status: comments.status, body: n(comments.body) },
      participationInit: {
        status: init.status,
        // The whole cache item is serialized into the response, so its key set
        // is part of the contract too.
        pcaKeys: initPca ? Object.keys(initPca).sort() : null,
        pcaAsPOJO: n(initPca?.asPOJO),
        // The exact JSON string, which pins key ORDER as well as content.
        pcaAsJSON: t(initPca?.asJSON),
        pcaConsensus: n(initPca?.consensus),
        pcaRepness: n(initPca?.repness),
        // `getNextComment` draws at random (`randomN`), so what is pinned is
        // that a comment IS offered and that it is one of the served ones --
        // never that a particular one came back.
        nextCommentIsServedComment: servedTids.includes(
          init.body?.nextComment?.tid
        ),
        votes: n(init.body?.votes),
      },
      pca2: { status: pca2.status, body: n(pca2.body), text: t(pca2.text) },
      pca2Keys: { status: pca2Keys.status, body: n(pca2Keys.body) },
      nextComment: {
        status: next.status,
        keys: next.body ? Object.keys(next.body).sort() : null,
        isServedComment: servedTids.includes(next.body?.tid),
      },
      summaryCsv: summary.map((row) => t(row)),
    };
  }

  function readGolden(name: string) {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"))[name];
    expect(golden).toBeDefined();
    return golden;
  }

  /** Observe one shape and file it under `name` for the recorder. */
  async function record(name: string, env: string) {
    const observed = await observe(env);
    observations[name] = observed;
    return observed;
  }

  /** Observe one shape and require it to be what `edge` served for it. */
  async function check(name: string, env: string) {
    const observed = await record(name, env);
    if (RECORDING) return;
    expect(observed).toEqual(readGolden(name));
  }

  test.each(EMPTY_SCENARIOS.map((s) => [s.name, s.env] as const))(
    "same input: %s serves byte-for-byte what edge served",
    async (name, env) => {
      await check(name, env);

      if (RECORDING) return;
      // Spelled out on top of the byte comparison, so a golden regenerated for
      // the wrong reason still fails. `golden` here is edge's recorded response,
      // which the assertion above has already proved this branch reproduces.
      const golden = readGolden(name);

      // Independent of the shape: the comment list and the next comment never
      // came from the blob, on edge either.
      expect(
        golden.comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
      ).toEqual(approvedTids);
      expect(golden.nextComment.isServedComment).toBe(true);
      expect(golden.participationInit.nextCommentIsServedComment).toBe(true);

      // The fields the old backfill supplied, still on the wire. Every one of
      // these shapes leaves them to the merge's template.
      expect(golden.pca2.body.tids).toEqual(approvedTids);
      expect(golden.pca2.body["n-cmts"]).toBe(approvedTids.length);
      expect(golden.pca2.body.pca.center).toEqual([0, 0]);
      expect(golden.pca2.body.pca["comment-extremity"]).toEqual(
        approvedTids.map(() => 0)
      );
      expect(golden.pca2.body.pca["comment-projection"]).toEqual({});
      expect(golden.participationInit.pcaAsPOJO.tids).toEqual(approvedTids);
      expect(golden.participationInit.pcaAsPOJO["n-cmts"]).toBe(
        approvedTids.length
      );
      expect(
        golden.summaryCsv.find((r: string) => r.startsWith("comments,"))
      ).toBe(`comments,${approvedTids.length}`);
    }
  );

  // ------------------------------------------------------------------ cutover
  //
  // One observation of the corrected engine's output through THIS server,
  // compared against every legacy shape's recording from `edge`. This is the
  // pair BOARD [55] governs: the same conversation, the same comments table, the
  // blob replaced by the engine change.

  let correctedOnThisServer: Awaited<ReturnType<typeof observe>> | undefined;
  async function correctedGolden() {
    if (!correctedOnThisServer) {
      correctedOnThisServer = await record(
        CORRECTED_GOLDEN.name,
        CORRECTED_GOLDEN.env
      );
    }
    return correctedOnThisServer;
  }

  test("control: the corrected engine's blob through edge's merge drops the conversation's comments", async () => {
    await correctedGolden();
    if (RECORDING) return;
    // Recorded by running this file on `edge`. G rev4 "Third boundary" names
    // this row the failing control, and it is: `edge` only backfilled fields a
    // blob left out, and `polis-empty/1` declares all of them.
    const onEdge = readGolden(CORRECTED_GOLDEN.name);
    expect(onEdge.pca2.body.tids).toEqual([]);
    expect(onEdge.pca2.body["n-cmts"]).toBe(0);
    expect(onEdge.pca2.body.pca.center).toEqual([]);
    expect(onEdge.pca2.body.pca["comment-extremity"]).toEqual([]);
    expect(onEdge.pca2.body.pca["comment-projection"]).toEqual([[], []]);
    expect(
      onEdge.summaryCsv.find((r: string) => r.startsWith("comments,"))
    ).toBe("comments,0");
    // ... while the comment list itself never depended on the blob.
    expect(
      onEdge.comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
    ).toEqual(approvedTids);
  });

  test.each(
    EMPTY_SCENARIOS.filter((s) => s.name.startsWith("legacy prod")).map(
      (s) => [s.name] as const
    )
  )(
    "cutover: the corrected engine on this server serves what %s served on edge",
    async (name) => {
      const observed = await correctedGolden();
      if (RECORDING) return;
      const onEdge = readGolden(name);

      // Everything except the serialized key order, compared exactly. `toEqual`
      // on the parsed bodies is order-insensitive but value-exact, so a changed
      // `mod-in`, `meta-tids`, count, list or geometry still fails here.
      expect(observed.comments).toEqual(onEdge.comments);
      expect(observed.summaryCsv).toEqual(onEdge.summaryCsv);
      expect(observed.pca2.body).toEqual(onEdge.pca2.body);
      expect(observed.pca2.status).toBe(onEdge.pca2.status);
      expect(observed.pca2Keys).toEqual(onEdge.pca2Keys);
      expect(observed.participationInit.status).toBe(
        onEdge.participationInit.status
      );
      expect(observed.participationInit.pcaKeys).toEqual(
        onEdge.participationInit.pcaKeys
      );
      expect(observed.participationInit.pcaAsPOJO).toEqual(
        onEdge.participationInit.pcaAsPOJO
      );
      expect(observed.participationInit.pcaConsensus).toEqual(
        onEdge.participationInit.pcaConsensus
      );
      expect(observed.participationInit.pcaRepness).toEqual(
        onEdge.participationInit.pcaRepness
      );
      expect(observed.participationInit.votes).toEqual(
        onEdge.participationInit.votes
      );
      expect(observed.nextComment.status).toBe(onEdge.nextComment.status);
      expect(observed.nextComment.keys).toEqual(onEdge.nextComment.keys);
      expect(observed.nextComment.isServedComment).toBe(true);
      expect(observed.participationInit.nextCommentIsServedComment).toBe(true);

      // Named explicitly as well, so this cannot pass by both sides being empty.
      expect(observed.pca2.body.tids).toEqual(approvedTids);
      expect(observed.pca2.body["n-cmts"]).toBe(approvedTids.length);
      expect(observed.pca2.body.pca.center).toEqual([0, 0]);
      expect(observed.pca2.body.pca["comment-extremity"]).toEqual(
        approvedTids.map(() => 0)
      );
      expect(observed.pca2.body.pca["comment-projection"]).toEqual({});
      expect(observed.pca2.body.pca.comps).toEqual([[], []]);
      expect(observed.pca2.body.lastVoteTimestamp).toBe(0);
      expect(
        observed.summaryCsv.find((r: string) => r.startsWith("comments,"))
      ).toBe(`comments,${approvedTids.length}`);

      // And now the bytes: the exact response text and the exact `asJSON`
      // string, which pin key order as well as content.
      const pairs = [
        [observed.pca2.text, onEdge.pca2.text],
        [
          observed.participationInit.pcaAsJSON,
          onEdge.participationInit.pcaAsJSON,
        ],
      ] as const;
      if (!ORDER_ONLY_CUTOVER.has(name)) {
        for (const [mine, theirs] of pairs) {
          expect(mine).toBe(theirs);
        }
      } else {
        // The one permitted difference, checked rather than assumed: the
        // position of the three empty arrays the merge appends. See
        // ORDER_ONLY_CUTOVER above for why it cannot be closed here.
        for (const [mine, theirs] of pairs) {
          const a = Object.keys(JSON.parse(mine!));
          const b = Object.keys(JSON.parse(theirs!));
          expect(a).not.toEqual(b);
          expect([...a].sort()).toEqual([...b].sort());
          expect(a.filter((k) => !MERGE_APPENDED_KEYS.includes(k))).toEqual(
            b.filter((k) => !MERGE_APPENDED_KEYS.includes(k))
          );
        }
      }
    }
  );

  test("cutover: B1's public-fixture sentinel and the no-row fallback, with their scoped differences", async () => {
    const observed = await correctedGolden();
    if (RECORDING) return;

    // B1's replay-empty-6 is a public-fixture fixture with 0 production rows, and its
    // `pca.comps: [[1],[1]]` is a sentinel the corrected engine is explicitly not
    // required to reproduce (G rev4, "Third boundary"). Everything else matches.
    const b1 = readGolden(
      "B1 public-fixture Clojure empty (six keys, pca.comps [[1],[1]])"
    );
    expect(observed.comments).toEqual(b1.comments);
    expect(observed.summaryCsv).toEqual(b1.summaryCsv);
    expect(b1.pca2.body.pca.comps).toEqual([[1], [1]]);
    expect(observed.pca2.body.pca.comps).toEqual([[], []]);
    expect({ ...observed.pca2.body.pca, comps: null }).toEqual({
      ...b1.pca2.body.pca,
      comps: null,
    });

    // The no-row fallback is unchanged by this branch and is NOT a cutover pair:
    // a conversation with no math row still has no math row. If the engine ever
    // writes one, `math_tick` and `lastVoteTimestamp` become the real
    // checkpoint's, which is the honest report, not a regression. The comment
    // surface is what has to match, and does.
    const noRow = readGolden("no math row at all");
    expect(observed.comments).toEqual(noRow.comments);
    expect(observed.summaryCsv).toEqual(noRow.summaryCsv);
    expect(observed.pca2.body.tids).toEqual(noRow.pca2.body.tids);
    expect(observed.pca2.body["n-cmts"]).toBe(noRow.pca2.body["n-cmts"]);
    expect(observed.pca2.body.pca).toEqual(noRow.pca2.body.pca);
    expect(noRow.pca2.body.lastVoteTimestamp).toBe("<now>");
    expect(noRow.pca2.body.math_tick).toBe(0);
  });

  test("a blob whose tids cover only one approved comment: served bytes unchanged", async () => {
    await check(
      "blob whose tids cover only one approved comment",
      "c7-subset-tids"
    );

    if (RECORDING) return;
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"))[
      "blob whose tids cover only one approved comment"
    ];
    // The blob carries all four presentation fields, so nothing is backfilled
    // and the served blob is the math's own account of itself, unedited.
    expect(golden.pca2.body.tids).toEqual([approvedTids[0]]);
    expect(golden.pca2.body["n-cmts"]).toBe(1);
    // The comment list never read the blob, on edge either: a partial blob has
    // never been able to hide an approved comment from `/api/v3/comments`.
    expect(
      golden.comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
    ).toEqual(approvedTids);
    // The summary CSV, by contrast, still follows the math -- as it did on edge.
    // Making it follow the comments table instead is a product-visible count
    // change and is deliberately NOT part of this change.
    expect(
      golden.summaryCsv.find((r: string) => r.startsWith("comments,"))
    ).toBe("comments,1");
  });

  test("a conversation with real math is untouched", async () => {
    await check("a conversation with real math", "c7-voted");

    if (RECORDING) return;
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"))[
      "a conversation with real math"
    ];
    expect(golden.pca2.body.tids).toEqual(approvedTids);
    expect(golden.pca2.body["n-cmts"]).toBe(approvedTids.length);
    expect(golden.pca2.body.pca.center).toEqual([0.3, -0.3, 0.05]);
    expect(golden.summaryCsv.find((r: string) => r.startsWith("voters,"))).toBe(
      "voters,2"
    );
    expect(golden.summaryCsv.find((r: string) => r.startsWith("groups,"))).toBe(
      "groups,2"
    );
  });

  test("a banned comment leaves the list, the backfilled ids and the counts", async () => {
    const banned = approvedTids[approvedTids.length - 1];
    await pool.query(
      "update comments set mod = -1 where zid = $1 and tid = $2",
      [zid, banned]
    );
    try {
      await check("banned comment, empty math", "c7-banned");
    } finally {
      await pool.query(
        "update comments set mod = 1 where zid = $1 and tid = $2",
        [zid, banned]
      );
    }

    if (RECORDING) return;
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"))[
      "banned comment, empty math"
    ];
    const remaining = approvedTids.slice(0, -1);
    expect(golden.pca2.body.tids).toEqual(remaining);
    expect(golden.pca2.body["n-cmts"]).toBe(remaining.length);
    expect(
      golden.comments.body.map((c: { tid: number }) => c.tid).sort(numeric)
    ).toEqual(remaining);
    expect(
      golden.summaryCsv.find((r: string) => r.startsWith("comments,"))
    ).toBe(`comments,${remaining.length}`);
  });
});
