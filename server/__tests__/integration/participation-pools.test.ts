/**
 * The participation path runs on pools nothing else uses, and nothing it does
 * can reach another pool (src/db/pg-query.ts, src/db/participation-scope.ts).
 *
 * - Structure: exactly the four participation routes (POST /votes, POST
 *   /comments, GET /nextComment, GET /participationInit) enter the
 *   participation pools, each as its first handler, and nothing else in the
 *   server can enter them.
 * - Construction: in that scope every query helper takes its connection from a
 *   participation pool; outside it none does.
 * - Requests: every connection a participation request takes, from its first
 *   middleware to the bookkeeping it schedules, comes from a participation
 *   pool, for every kind of participant and route variant below; other work
 *   (report tallies, exports, the opinion map, a participant's vote list,
 *   admin reads) never takes one.
 *
 * A guard of the participation path, like ./participation-under-load.test.ts:
 * a failure is read first as the participation path sharing a pool with other
 * work again. Never loosened to get a build green.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { Pool } from "pg";
import pg, { poolRole, PoolRole } from "../../src/db/pg-query";
import { onParticipationPools } from "../../src/db/participation-scope";
import { getApp } from "../app-loader";
import {
  getJwtAuthenticatedAgent,
  getOidcToken,
  setupAuthAndConvo,
  wait,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { semanticToWire } from "../../src/votes/convention";

const PARTICIPATION_ROLES: PoolRole[] = ["participation", "participation-read"];
const isParticipation = (role: PoolRole) => PARTICIPATION_ROLES.includes(role);
/** Long enough for the bookkeeping a request schedules (100 ms after it). */
const BOOKKEEPING_MS = 800;

// Every pooled connection is taken through Pool.prototype.connect (pg-pool's
// own query() calls it too). Record which pool each one came from.
let taken: PoolRole[] | null = null;
const PoolPrototype = Pool.prototype as unknown as {
  connect: (...args: unknown[]) => unknown;
};
const hadOwnConnect = Object.prototype.hasOwnProperty.call(
  PoolPrototype,
  "connect"
);
const realConnect = PoolPrototype.connect;

beforeAll(() => {
  PoolPrototype.connect = function (this: Pool, ...args: unknown[]) {
    const role = poolRole(this);
    if (taken && role) taken.push(role);
    return realConnect.apply(this, args);
  };
});
afterAll(() => {
  if (hadOwnConnect) PoolPrototype.connect = realConnect;
  else delete (PoolPrototype as { connect?: unknown }).connect;
});

/** The pools `work` took connections from, including what it scheduled. */
async function poolsTakenBy(
  work: () => PromiseLike<unknown>,
  settleMs = BOOKKEEPING_MS
): Promise<{ roles: PoolRole[]; result: any }> {
  taken = [];
  try {
    const result = await work();
    await wait(settleMs);
    return { roles: [...taken], result };
  } finally {
    taken = null;
  }
}

/** Run `work` the way a participation route runs its handlers. */
function inParticipationScope<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    onParticipationPools(undefined, undefined, () => {
      work().then(resolve, reject);
    })
  );
}

const PARTICIPATION_ROUTES = [
  "GET /api/v3/nextComment",
  "GET /api/v3/participationInit",
  "POST /api/v3/comments",
  "POST /api/v3/votes",
];

describe("structure", () => {
  test("exactly the participation routes enter the participation pools, as their first handler", async () => {
    const app = (await getApp()) as Express & {
      routes: Record<string, Array<{ path: string; callbacks: unknown[] }>>;
    };
    const entering: string[] = [];
    const notFirst: string[] = [];
    for (const [method, routes] of Object.entries(app.routes)) {
      for (const route of routes) {
        const at = route.callbacks.indexOf(onParticipationPools);
        if (at < 0) continue;
        const name = `${method.toUpperCase()} ${route.path}`;
        entering.push(name);
        if (at !== 0) notFirst.push(name);
      }
    }
    expect(entering.sort()).toEqual(PARTICIPATION_ROUTES);
    expect(notFirst).toEqual([]);
  });

  test("nothing else in the server can enter the participation pools", () => {
    const root = path.resolve(__dirname, "../..");
    const files = [path.join(root, "app.ts")];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(root, "src"));
    const users = files
      .filter((file) =>
        fs.readFileSync(file, "utf8").includes("onParticipationPools")
      )
      .map((file) => path.relative(root, file))
      .sort();
    expect(users).toEqual(["app.ts", "src/db/participation-scope.ts"]);
  });
});

describe("construction", () => {
  const helpers: Array<[string, () => Promise<unknown>]> = [
    [
      "query",
      () =>
        new Promise((resolve, reject) =>
          pg.query("select 1", [], (err: unknown, res: unknown) =>
            err ? reject(err) : resolve(res)
          )
        ),
    ],
    [
      "query_readOnly",
      () =>
        new Promise((resolve, reject) =>
          pg.query_readOnly("select 1", [], (err: unknown, res: unknown) =>
            err ? reject(err) : resolve(res)
          )
        ),
    ],
    ["queryP", () => pg.queryP("select 1", [])],
    ["queryP_readOnly", () => pg.queryP_readOnly("select 1", [])],
    [
      // Empty on the read pool, so it asks the read-write pool again.
      "queryP_readOnly_wRetryIfEmpty",
      () => pg.queryP_readOnly_wRetryIfEmpty("select 1 where false", []),
    ],
    ["queryP_metered", () => pg.queryP_metered("pools", "select 1", [])],
    [
      "queryP_metered_readOnly",
      () => pg.queryP_metered_readOnly("pools", "select 1", []),
    ],
    [
      "stream_queryP_readOnly",
      () =>
        new Promise<void>((resolve, reject) =>
          pg.stream_queryP_readOnly(
            "select 1",
            [],
            () => undefined,
            resolve,
            reject
          )
        ),
    ],
    ["connect", async () => (await pg.connect()).release()],
    ["connectReadOnly", async () => (await pg.connectReadOnly()).release()],
    [
      "withTransaction",
      () => pg.withTransaction((client) => client.query("select 1")),
    ],
    [
      "connectResultSnapshot",
      async () => (await pg.connectResultSnapshot()).release(),
    ],
  ];

  test.each(helpers)(
    "%s takes a participation connection in the scope, and never outside it",
    async (_name, run) => {
      const inside = await poolsTakenBy(() => inParticipationScope(run), 0);
      const outside = await poolsTakenBy(run, 0);
      expect(inside.roles.length).toBeGreaterThan(0);
      expect(inside.roles.filter((role) => !isParticipation(role))).toEqual([]);
      expect(outside.roles.length).toBeGreaterThan(0);
      expect(outside.roles.filter(isParticipation)).toEqual([]);
    }
  );
});

describe("requests", () => {
  let app: Express;
  let conversationId: string;
  let strictConversationId: string;
  let reportId: string;
  let tids: number[];
  let strictTids: number[];
  let ownerToken: string;

  beforeAll(async () => {
    app = await getApp();
    const setup = await setupAuthAndConvo({ commentCount: 5 });
    conversationId = setup.conversationId;
    tids = setup.commentIds;
    const strict = await setupAuthAndConvo({
      commentCount: 2,
      conversationOptions: { strict_moderation: true },
    });
    strictConversationId = strict.conversationId;
    strictTids = strict.commentIds;
    const { agent: owner, token } = await getJwtAuthenticatedAgent(
      setup.testUser
    );
    ownerToken = token;
    const created = await owner
      .post("/api/v3/reports")
      .send({ conversation_id: conversationId });
    expect(created.status).toBe(200);
    const reports = await owner.get(
      `/api/v3/reports?conversation_id=${conversationId}`
    );
    reportId = reports.body[0].report_id;
  }, 120000);

  const wire = (vote: "agree" | "disagree" | "pass") => semanticToWire(vote);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** One participation request: it answered 200, and every connection it
   * and its bookkeeping took came from a participation pool. */
  async function participation(name: string, send: () => request.Test) {
    const { roles, result } = await poolsTakenBy(() => send());
    process.stdout.write(
      `${JSON.stringify({
        request: name,
        status: result.status,
        pools: roles,
      })}\n`
    );
    expect({ name, status: result.status }).toEqual({ name, status: 200 });
    expect(roles.length).toBeGreaterThan(0);
    expect({
      name,
      other: roles.filter((role) => !isParticipation(role)),
    }).toEqual({ name, other: [] });
    return result.body;
  }

  /** One request of other work: no connection it took came from a
   * participation pool. (One served from a cache takes none.) */
  async function otherWork(name: string, send: () => request.Test) {
    const { roles, result } = await poolsTakenBy(() => send());
    process.stdout.write(
      `${JSON.stringify({
        request: name,
        status: result.status,
        pools: roles,
      })}\n`
    );
    expect({ name, participation: roles.filter(isParticipation) }).toEqual({
      name,
      participation: [],
    });
    return roles;
  }

  test("every participation request, of every kind of participant, takes only participation connections", async () => {
    const init = (query: string, token?: string) => {
      const sent = request(app).get(`/api/v3/participationInit?${query}`);
      return token ? sent.set(bearer(token)) : sent;
    };

    // A first visit, then a first vote that creates the participant.
    await participation("participationInit, first visit", () =>
      init(`conversation_id=${conversationId}&pid=mypid&lang=acceptLang`)
    );
    const first = await participation("vote, new participant", () =>
      request(app)
        .post("/api/v3/votes")
        .send({
          conversation_id: conversationId,
          tid: tids[0],
          vote: wire("agree"),
          lang: "en",
        })
    );
    const token: string = first.auth.token;

    // A returning participant.
    await participation("vote, returning participant", () =>
      request(app)
        .post("/api/v3/votes")
        .set(bearer(token))
        .send({
          conversation_id: conversationId,
          tid: tids[1],
          vote: wire("disagree"),
          lang: "en",
        })
    );
    await participation("comment with the author's vote", () =>
      request(app)
        .post("/api/v3/comments")
        .set(bearer(token))
        .send({
          conversation_id: conversationId,
          txt: `pools ${Date.now()}`,
          vote: wire("agree"),
        })
    );
    await participation("nextComment", () =>
      request(app)
        .get(`/api/v3/nextComment?conversation_id=${conversationId}&lang=en`)
        .set(bearer(token))
    );
    await participation("nextComment with a preferred statement", () =>
      request(app)
        .get(
          `/api/v3/nextComment?conversation_id=${conversationId}&lang=en&initial_tid=${tids[2]}`
        )
        .set(bearer(token))
    );
    await participation("participationInit, returning participant", () =>
      init(
        `conversation_id=${conversationId}&pid=mypid&lang=en&includePCA=true`,
        token
      )
    );

    // An xid participant: first visit, then the first vote.
    const xid = `pools-xid-${Date.now()}`;
    await participation("participationInit, new xid", () =>
      init(`conversation_id=${conversationId}&xid=${xid}&pid=-1&lang=en`)
    );
    await participation("vote, new xid participant", () =>
      request(app)
        .post("/api/v3/votes")
        .send({
          conversation_id: conversationId,
          xid,
          tid: tids[0],
          vote: wire("agree"),
          lang: "en",
        })
    );

    // A signed-in user taking part.
    const user = getPooledTestUser(3);
    const oidc = await getOidcToken({
      email: user.email,
      password: user.password,
    });
    await participation("vote, signed-in user", () =>
      request(app)
        .post("/api/v3/votes")
        .set(bearer(oidc))
        .send({
          conversation_id: conversationId,
          tid: tids[0],
          vote: wire("pass"),
          lang: "en",
        })
    );
    await participation("comment, signed-in user", () =>
      request(app)
        .post("/api/v3/comments")
        .set(bearer(oidc))
        .send({
          conversation_id: conversationId,
          txt: `pools signed in ${Date.now()}`,
        })
    );

    // A comment in a strictly moderated conversation: the moderators are told.
    const strictFirst = await participation(
      "vote, strictly moderated conversation",
      () =>
        request(app)
          .post("/api/v3/votes")
          .send({
            conversation_id: strictConversationId,
            tid: strictTids[0],
            vote: wire("agree"),
            lang: "en",
          })
    );
    await participation("comment, strictly moderated conversation", () =>
      request(app)
        .post("/api/v3/comments")
        .set(bearer(strictFirst.auth.token))
        .send({
          conversation_id: strictConversationId,
          txt: `pools strict ${Date.now()}`,
        })
    );

    // Topical routing of the next statement.
    const saved = process.env.TOPICAL_COMMENT_RATIO;
    process.env.TOPICAL_COMMENT_RATIO = "1";
    try {
      const picked = await request(app)
        .post("/api/v3/topicAgenda/selections")
        .set(bearer(token))
        .send({
          conversation_id: conversationId,
          selections: [
            { topic_key: "pools-topic", topic_id: "pools-topic", priority: 1 },
          ],
        });
      expect(picked.status).toBe(200);
      const topical: string = picked.body?.auth?.token ?? token;
      await participation("nextComment, topical routing", () =>
        request(app)
          .get(`/api/v3/nextComment?conversation_id=${conversationId}&lang=en`)
          .set(bearer(topical))
      );
      await participation("vote, topical routing of the next statement", () =>
        request(app)
          .post("/api/v3/votes")
          .set(bearer(topical))
          .send({
            conversation_id: conversationId,
            tid: tids[3],
            vote: wire("agree"),
            lang: "en",
          })
      );
    } finally {
      if (saved === undefined) delete process.env.TOPICAL_COMMENT_RATIO;
      else process.env.TOPICAL_COMMENT_RATIO = saved;
    }
  }, 120000);

  test("other work never takes a participation connection", async () => {
    const roles: PoolRole[] = [];
    const record = async (got: Promise<PoolRole[]>) =>
      roles.push(...(await got));
    await record(
      otherWork("report page tallies", () =>
        request(app).get(
          `/api/v3/comments?conversation_id=${conversationId}&report_id=${reportId}` +
            "&moderation=true&mod_gt=-2&include_voting_patterns=true"
        )
      )
    );
    await record(
      otherWork("vote export", () =>
        request(app).get(`/api/v3/reportExport/${reportId}/votes.csv`)
      )
    );
    await record(
      otherWork("opinion map", () =>
        request(app).get(`/api/v3/math/pca2?conversation_id=${conversationId}`)
      )
    );
    await record(
      otherWork("a participant's vote list", () =>
        request(app).get(
          `/api/v3/votes?conversation_id=${conversationId}&pid=mypid`
        )
      )
    );
    await record(
      otherWork("moderation list", () =>
        request(app)
          .get(
            `/api/v3/comments?conversation_id=${conversationId}&moderation=true&mod=0`
          )
          .set(bearer(ownerToken))
      )
    );
    await record(
      otherWork("conversation admin read", () =>
        request(app)
          .get(`/api/v3/conversations?conversation_id=${conversationId}`)
          .set(bearer(ownerToken))
      )
    );
    // The recording saw that work: the tallies on the read pool, the export on
    // its own pool.
    expect(roles).toEqual(expect.arrayContaining(["read", "report-export"]));
  }, 120000);
});
