/**
 * Votes, comments and the next-statement call must answer promptly, and must
 * never fail, while slower work runs. Everything else (exports, reports,
 * outside services) may be slow; the participation path may not wait on it.
 *
 * Each scenario below starts one kind of slow work (the last starts all of
 * them), then has PARTICIPANTS participants of one conversation each send a
 * vote, a comment and a nextComment call at the same moment, the way the
 * participation client sends them. Every one of those requests must answer 200
 * within BUDGET_MS, and every vote and comment sent must end up stored. A last
 * case sends bursts of comments with no slow work at all. The slow work:
 *
 *   - exports: the conversation's vote exports (votes.csv,
 *     participant-votes.csv, participant-importance.csv, comments.csv), each
 *     read held in the database for the whole window;
 *   - report tallies: report page loads, whose per-statement vote tallies are
 *     held in the database for the whole window;
 *   - outside services that never answer: the identity provider's management
 *     API, the topic lookup behind topic-agenda routing, and the language
 *     provider (translation is switched on in this file, with a stand-in
 *     provider, so the language step is on the path as it is wherever
 *     translation is enabled);
 *   - every connection of every pool other work uses, taken and kept: the
 *     read-write and read pools, the report/export pool, the agent exchange
 *     pool and the Delphi results pool. The participation path has pools of
 *     its own (src/db/pg-query.ts), so this is the case that shows slow work
 *     holding the connections it can reach cannot delay a vote.
 *
 * The conversation is small. What makes an export or a tally slow here is a
 * database-side hold on exactly those statements: each one first waits on an
 * advisory lock the test holds, on the same pooled connection, so it keeps that
 * connection for as long as the test says (a large conversation's export or
 * tally takes seconds; here it takes the whole window). No single wait outlives
 * the statement timeout of the pool it runs on: where a pool has one,
 * Postgres ends a wait at that bound, and the wait is issued again at once on
 * the same connection, so the connection is held across a window longer than
 * the bound, as slow statements run back to back would hold it. The hold is keyed
 * to the statement text, not to a pool, so the scenario still applies when a
 * statement moves to another pool. Outside services are stand-ins that never
 * answer until the test releases them.
 *
 * Expected failures. Where today's server makes a participation request wait on
 * the slow work, or rejects it, that case is a `test.failing` whose name says
 * what it waits on: the suite is green, and the case turns into a real failure
 * (jest reports "Failing test passed even though it was supposed to fail") on
 * the day the server stops waiting, which is the cue to make it a plain `test`.
 * Every other case is a real assertion.
 *
 * This is a guard, like ../delphi-results-pg/concurrency.pgtest.ts and
 * ../participation-pg/export-budget.pgtest.ts: a failure is investigated as
 * possible starvation of the participation path first, and it is never skipped
 * or loosened (no wider budget, fewer participants or shorter holds) to get a
 * build green.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import request from "supertest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { Client, PoolClient } from "pg";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getApp } from "../app-loader";
import {
  getJwtAuthenticatedAgent,
  initializeParticipant,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";
import pg, {
  AGENT_EXCHANGE_POOL_MAX,
  MAIN_POOL_MAX,
  REPORT_EXPORT_POOL_MAX,
  RESULT_SNAPSHOT_POOL_MAX,
} from "../../src/db/pg-query";
import { polisTypes } from "../../src/utils/common";
import { semanticToWire } from "../../src/votes/convention";
import type { VoteData } from "../../types/test-helpers";

/** Every vote, comment and nextComment call must answer 200 within this. It
 * is the participation budget of ../participation-pg/export-budget.pgtest.ts,
 * and half the time after which the participation client gives up on a
 * request (REQUEST_TIMEOUT_MS, client-participation-alpha/src/lib/net.ts). */
const BUDGET_MS = 5000;
/** A participation request still unanswered after this is recorded as never
 * answered: the participation client has given up on it by then. */
const GIVE_UP_MS = 10000;
/** Participants acting at once in each scenario: three requests each. */
const PARTICIPANTS = 12;
/** Export downloads in flight: more than the export pool has connections. */
const EXPORT_DOWNLOADS = 8;
/** Report page loads in flight: as many as a production server's read pool has
 * connections, and more than a development server's. */
const REPORT_LOADS = 12;
/** How long the test waits for released slow work to finish. */
const SLOW_WORK_DRAIN_MS = 60000;

// ---------------------------------------------------------------------------
// Outside services: stand-ins that answer at once until held, then never
// answer until released.

class Stall {
  private held = false;
  private waiting: Array<() => void> = [];
  /** Calls made while held. */
  calls = 0;
  hold(): void {
    this.held = true;
    this.calls = 0;
  }
  call<T>(answer: () => T | Promise<T>): Promise<T> {
    if (!this.held) return Promise.resolve().then(answer);
    this.calls++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        Promise.resolve().then(answer).then(resolve, reject);
      });
    });
  }
  /** Calls still waiting for an answer. */
  get pending(): number {
    return this.waiting.length;
  }
  release(): void {
    this.held = false;
    for (const go of this.waiting.splice(0)) go();
  }
}

const mockStalls = {
  identity: new Stall(),
  language: new Stall(),
  topics: new Stall(),
};

// The identity provider's management API (the owner's plan check).
jest.mock("auth0", () => ({
  ManagementClient: jest.fn().mockImplementation(() => ({
    usersByEmail: {
      getByEmail: () => mockStalls.identity.call(() => ({ data: [] })),
    },
    users: {
      getRoles: () => mockStalls.identity.call(() => ({ data: [] })),
    },
  })),
}));
// The language provider: detection on every comment, translation of the next
// statement when its language differs from the participant's.
jest.mock("@google-cloud/translate", () => ({
  v2: {
    Translate: jest.fn().mockImplementation(() => ({
      detect: () =>
        mockStalls.language.call(() => [{ language: "en", confidence: 0.9 }]),
      translate: (txt: string) => mockStalls.language.call(() => [txt]),
    })),
  },
}));
// Switch translation on without a credential file or a Google identity.
jest.mock("../../src/config", () => {
  const actual =
    jest.requireActual<typeof import("../../src/config")>("../../src/config");
  return {
    __esModule: true,
    ...actual,
    default: { ...actual.default, shouldUseTranslationAPI: true },
  };
});

// ---------------------------------------------------------------------------
// Database-side holds on named statements.

type HeldKind = "export" | "report tally";
const HELD_STATEMENTS: Record<HeldKind, RegExp> = {
  // The whole-conversation vote reads of the vote exports (src/report.ts).
  export: /^SELECT .* FROM votes WHERE zid = \(?\$1\)? ORDER BY /,
  // The report page's per-statement vote tallies: GET /api/v3/comments with
  // moderation and include_voting_patterns (src/comment.ts).
  "report tally":
    /from votes_latest_unique where zid = \(\$1\) group by tid, vote\) as foo full outer join comments/,
};
/** The advisory lock a held statement waits on; the test holds it. */
const HOLD_LOCK: [number, number] = [70411, 3];
const HOLD_TAG = "participation-under-load hold";
const heldKinds = new Set<HeldKind>();
/** Postgres ended a statement at the connection's statement timeout. */
const STATEMENT_TIMEOUT = "57014";
/** Waits that the statement timeout ended and that were issued again. */
const holdsRenewed: Record<HeldKind, number> = { export: 0, "report tally": 0 };

function heldKind(text: string): HeldKind | undefined {
  for (const kind of heldKinds) {
    if (HELD_STATEMENTS[kind].test(text)) return kind;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
const realQuery = Client.prototype.query as unknown as AnyFn;
const realDynamoSend = DynamoDBDocumentClient.prototype
  .send as unknown as AnyFn;

const holdText = (kind: HeldKind) =>
  `SELECT pg_advisory_xact_lock_shared($1, $2) /* ${HOLD_TAG}: ${kind} */`;

/** Wait on this connection until the test releases its lock. A wait the
 * connection's statement timeout ends is issued again at once on the same
 * connection while the test still holds this kind, so the connection is never
 * given back in between. */
function holdOn(client: Client, kind: HeldKind): Promise<void> {
  return new Promise<void>((resolve) => {
    const wait = () =>
      realQuery.call(
        client,
        holdText(kind),
        HOLD_LOCK,
        (err: { code?: string } | null) => {
          if (err?.code === STATEMENT_TIMEOUT && heldKinds.has(kind)) {
            holdsRenewed[kind]++;
            wait();
          } else {
            resolve();
          }
        }
      );
    wait();
  });
}

/** Every pooled connection is a pg Client. A held statement first waits on the
 * test's advisory lock on its own connection, then runs unchanged. */
function holdNamedStatements(): void {
  jest
    .spyOn(Client.prototype as unknown as { query: AnyFn }, "query")
    .mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0] as
        | string
        | { text?: unknown; cursor?: { text?: unknown } }
        | undefined;
      const last = args[args.length - 1];
      const text =
        typeof first === "string" ? first : first?.text ?? first?.cursor?.text;
      const kind = typeof text === "string" ? heldKind(text) : undefined;
      if (!kind) return realQuery.apply(this, args);
      if (typeof first !== "string") {
        // A streamed read: queue one wait ahead of it on the same connection.
        // Streamed reads run on the report and export pool, whose statement
        // timeout is far longer than any window here.
        realQuery.call(this, holdText(kind), HOLD_LOCK, () => undefined);
        return realQuery.apply(this, args);
      }
      const held = holdOn(this, kind);
      if (typeof last === "function") {
        held.then(() => realQuery.apply(this, args));
        return undefined;
      }
      return held.then(() => realQuery.apply(this, args));
    });
}

/** Topic-agenda routing looks up each selected topic's clusters. */
function stallTopicLookups(): void {
  jest
    .spyOn(
      DynamoDBDocumentClient.prototype as unknown as { send: AnyFn },
      "send"
    )
    .mockImplementation(function (this: unknown, ...args: unknown[]) {
      const command = args[0] as { input?: { TableName?: string } };
      if (command?.input?.TableName === "Delphi_CommentClustersLLMTopicNames") {
        return mockStalls.topics.call(() => realDynamoSend.apply(this, args));
      }
      return realDynamoSend.apply(this, args);
    });
}

// ---------------------------------------------------------------------------
// The conversation and its participants.

/** Every timed request goes to one listening server. (A supertest agent bound
 * to the app closes its own server when each response arrives and waits for the
 * agent's other open requests first, which would tie one request's timing to
 * another's.) */
let server: Server;
let baseUrl: string;
let admin: Client;
let conversationId: string;
let reportId: string;
let zid: number;
let tids: number[];
let savedTopicalRatio: string | undefined;

beforeAll(async () => {
  savedTopicalRatio = process.env.TOPICAL_COMMENT_RATIO;
  // Participants with a topic agenda are always routed by topic.
  process.env.TOPICAL_COMMENT_RATIO = "1";
  holdNamedStatements();
  stallTopicLookups();

  const app = await getApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();

  const setup = await setupAuthAndConvo({ commentCount: 6 });
  conversationId = setup.conversationId;
  tids = setup.commentIds;
  const { agent: owner } = await getJwtAuthenticatedAgent(setup.testUser);
  const created = await owner
    .post("/api/v3/reports")
    .send({ conversation_id: conversationId });
  expect(created.status).toBe(200);
  const reports = await owner.get(
    `/api/v3/reports?conversation_id=${conversationId}`
  );
  reportId = reports.body[0].report_id;
  zid = (
    await admin.query("SELECT zid FROM zinvites WHERE zinvite = $1", [
      conversationId,
    ])
  ).rows[0].zid;
}, 120000);

afterAll(async () => {
  heldKinds.clear();
  for (const stall of Object.values(mockStalls)) stall.release();
  await admin?.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
  await admin?.end();
  await new Promise((resolve) => server?.close(resolve));
  jest.restoreAllMocks();
  if (savedTopicalRatio === undefined) delete process.env.TOPICAL_COMMENT_RATIO;
  else process.env.TOPICAL_COMMENT_RATIO = savedTopicalRatio;
});

type Participant = { token: string; pid: number };

/** A request to the listening server, as this participant. */
const as = (p: Participant) => ({
  get: (path: string) =>
    request(baseUrl).get(path).set("Authorization", `Bearer ${p.token}`),
  post: (path: string) =>
    request(baseUrl).post(path).set("Authorization", `Bearer ${p.token}`),
});

/** A participant who has opened the conversation and cast a first vote, and,
 * for topic-agenda scenarios, has picked topics. */
async function joinedParticipant(withTopics: boolean): Promise<Participant> {
  const { agent, token: initToken } = await initializeParticipant(
    conversationId
  );
  const first = await submitVote(agent, {
    conversation_id: conversationId,
    tid: tids[0],
    vote: semanticToWire("pass") as VoteData["vote"],
  });
  if (first.status !== 200) {
    throw new Error(`first vote failed: ${first.status} ${first.text}`);
  }
  const pid = Number(first.body.currentPid);
  let token: string | undefined = first.body.auth?.token ?? initToken;
  if (withTopics) {
    const picked = await agent.post("/api/v3/topicAgenda/selections").send({
      conversation_id: conversationId,
      selections: [
        { topic_key: "guard-topic-a", topic_id: "guard-topic-a", priority: 1 },
        { topic_key: "guard-topic-b", topic_id: "guard-topic-b", priority: 2 },
      ],
    });
    if (picked.status !== 200) {
      throw new Error(
        `topic selection failed: ${picked.status} ${picked.text}`
      );
    }
    token = picked.body?.auth?.token ?? token;
  }
  if (!token) throw new Error("participant has no token");
  return { token, pid };
}

// ---------------------------------------------------------------------------
// One scenario: start the slow work, act, release, check nothing was lost.

const OPS = ["vote", "comment", "nextComment"] as const;
type Op = (typeof OPS)[number];
const LABEL: Record<Op, string> = {
  vote: "votes",
  comment: "comments",
  nextComment: "nextComment calls",
};

type Outcome = {
  participant: number;
  ms: number;
  answered: boolean;
  status?: number;
  error?: string;
};

type Load = {
  exports?: boolean;
  reportTallies?: boolean;
  identity?: boolean;
  topics?: boolean;
  language?: boolean;
  otherPools?: boolean;
};

type Evidence = {
  otherPoolConnectionsHeld: number;
  otherPoolQueryWaited: number;
  heldExportsBefore: number;
  heldExportsAfter: number;
  heldTalliesBefore: number;
  heldTalliesAfter: number;
  holdsRenewed: number;
  identityWaitingBefore: number;
  identityWaitingAfter: number;
  topicLookupCalls: number;
  languageCalls: number;
  votesStored: number;
  commentsStored: number;
};

type Result = { outcomes: Record<Op, Outcome[]>; evidence: Evidence };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(
  participant: number,
  sent: request.Test
): Promise<Outcome> {
  const started = Date.now();
  try {
    const res = await sent
      .timeout({ response: GIVE_UP_MS, deadline: GIVE_UP_MS })
      .ok(() => true);
    return {
      participant,
      ms: Date.now() - started,
      answered: true,
      status: res.status,
      error: res.status === 200 ? undefined : res.text.slice(0, 200),
    };
  } catch (err) {
    return {
      participant,
      ms: Date.now() - started,
      answered: false,
      error: (err as Error)?.message ?? String(err),
    };
  }
}

/** Connections the test's hold keeps for statements of this kind right now:
 * waiting on the test's lock, or idle for the moment between a wait the
 * statement timeout ended and the same wait issued again (a held connection's
 * last statement is a wait until the test releases its lock). */
async function heldNow(kind: HeldKind): Promise<number> {
  return (
    await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND query LIKE $1 AND (wait_event_type = 'Lock' OR state = 'idle')`,
      [`%${HOLD_TAG}: ${kind}%`]
    )
  ).rows[0].n;
}

/** Wait until `count` reaches `atLeast` and then stops growing. */
async function settled(count: () => Promise<number>, atLeast: number) {
  const deadline = Date.now() + 15000;
  let last = -1;
  let steadySince = Date.now();
  for (;;) {
    const n = await count();
    if (n !== last) {
      last = n;
      steadySince = Date.now();
    }
    if (n >= atLeast && Date.now() - steadySince >= 500) return n;
    if (Date.now() > deadline) return n;
    await sleep(50);
  }
}

async function runScenario(name: string, load: Load): Promise<Result> {
  const participants = await Promise.all(
    Array.from({ length: PARTICIPANTS }, () =>
      joinedParticipant(Boolean(load.topics))
    )
  );
  const stamp = Date.now();
  const voteTid = tids[1];
  const commentText = (i: number) =>
    `${name}: statement from participant ${i} (${stamp})`;
  const pids = participants.map((p) => p.pid);
  const texts = participants.map((_p, i) => commentText(i));
  const stored = async () => ({
    votesStored: (
      await admin.query(
        "SELECT count(*)::int AS n FROM votes WHERE zid = $1 AND tid = $2 AND pid = ANY($3::int[])",
        [zid, voteTid, pids]
      )
    ).rows[0].n as number,
    commentsStored: (
      await admin.query(
        "SELECT count(*)::int AS n FROM comments WHERE zid = $1 AND txt = ANY($2::text[])",
        [zid, texts]
      )
    ).rows[0].n as number,
  });

  // Start the slow work.
  holdsRenewed.export = 0;
  holdsRenewed["report tally"] = 0;
  const slowWork: Array<Promise<unknown>> = [];
  const slow = (url: string) =>
    slowWork.push(
      request(baseUrl)
        .get(url)
        .timeout({ deadline: SLOW_WORK_DRAIN_MS })
        .ok(() => true)
        .then(
          (res) => res.status,
          (err) => String(err)
        )
    );
  const reportPage = (level: number) =>
    `/api/v3/comments?conversation_id=${conversationId}&report_id=${reportId}` +
    `&moderation=true&mod_gt=${level}&include_voting_patterns=true`;
  if (load.topics) mockStalls.topics.hold();
  if (load.language) mockStalls.language.hold();
  // First the plan checks, so that each one reaches the identity provider
  // before any database hold could keep it from getting there.
  let identityWaitingBefore = 0;
  if (load.identity) {
    mockStalls.identity.hold();
    // A report page that leaves out banned statements checks the owner's plan
    // with the identity provider first (mod_gt above the "every statement" level).
    for (let k = 0; k < REPORT_LOADS; k++) slow(reportPage(polisTypes.mod.ban));
    identityWaitingBefore = await settled(
      async () => mockStalls.identity.pending,
      REPORT_LOADS
    );
  }
  if (load.exports || load.reportTallies || load.otherPools) {
    await admin.query("SELECT pg_advisory_lock($1, $2)", HOLD_LOCK);
  }
  // Every connection of every pool other work uses, taken and kept for the
  // whole window. The report/export pool has no raw client to take, so each of
  // its connections is kept by a read that waits on the test's lock (its
  // statement timeout is far longer than the window).
  const otherPoolClients: PoolClient[] = [];
  let otherPoolConnectionsHeld = 0;
  let otherPoolProbe: Promise<string> | undefined;
  if (load.otherPools) {
    const take = async (n: number, connect: () => Promise<PoolClient>) => {
      for (let i = 0; i < n; i++) otherPoolClients.push(await connect());
    };
    await take(MAIN_POOL_MAX, () => pg.connect());
    await take(MAIN_POOL_MAX, () => pg.connectReadOnly());
    await take(AGENT_EXCHANGE_POOL_MAX, () => pg.connectAgentExchange());
    await take(RESULT_SNAPSHOT_POOL_MAX, () => pg.connectResultSnapshot());
    for (let k = 0; k < REPORT_EXPORT_POOL_MAX; k++) {
      slowWork.push(
        pg
          .queryP_reportExport(
            `SELECT pg_advisory_xact_lock_shared($1, $2) /* ${HOLD_TAG}: other pools */`,
            HOLD_LOCK
          )
          .then(
            () => "released",
            (err) => String(err)
          )
      );
    }
    const reportExportHeld = await settled(
      async () =>
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND query LIKE $1
             AND wait_event_type = 'Lock'`,
            [`%${HOLD_TAG}: other pools%`]
          )
        ).rows[0].n,
      REPORT_EXPORT_POOL_MAX
    );
    otherPoolConnectionsHeld = otherPoolClients.length + reportExportHeld;
    // While they are held, a query from other work on the read pool waits:
    // the pools are exhausted. It is answered once they are released.
    otherPoolProbe = pg.queryP_readOnly("SELECT 1", []).then(
      () => "answered",
      (err) => String(err)
    );
    slowWork.push(otherPoolProbe);
  }
  let heldExportsBefore = 0;
  if (load.exports) {
    heldKinds.add("export");
    const files = [
      "votes.csv",
      "participant-votes.csv",
      "participant-importance.csv",
      "comments.csv",
    ];
    for (let k = 0; k < EXPORT_DOWNLOADS; k++) {
      slow(`/api/v3/reportExport/${reportId}/${files[k % files.length]}`);
    }
    heldExportsBefore = await settled(
      () => heldNow("export"),
      Math.min(EXPORT_DOWNLOADS, REPORT_EXPORT_POOL_MAX)
    );
  }
  let heldTalliesBefore = 0;
  if (load.reportTallies) {
    heldKinds.add("report tally");
    // The report page's default view: every statement, no plan check.
    for (let k = 0; k < REPORT_LOADS; k++) slow(reportPage(-2));
    heldTalliesBefore = await settled(() => heldNow("report tally"), 1);
  }

  // Every participant acts at once.
  const sent = participants.map((p, i) => ({
    vote: timed(
      i,
      as(p)
        .post("/api/v3/votes")
        .send({
          conversation_id: conversationId,
          tid: voteTid,
          vote: semanticToWire("agree"),
          lang: "en",
        })
    ),
    comment: timed(
      i,
      as(p)
        .post("/api/v3/comments")
        .send({
          conversation_id: conversationId,
          txt: commentText(i),
          // The participation client sends the author's own agree vote.
          vote: semanticToWire("agree"),
        })
    ),
    nextComment: timed(
      i,
      as(p).get(`/api/v3/nextComment?conversation_id=${conversationId}&lang=en`)
    ),
  }));
  const outcomes = {} as Record<Op, Outcome[]>;
  for (const op of OPS)
    outcomes[op] = await Promise.all(sent.map((s) => s[op]));

  // Every participant has been answered; the other work is still waiting.
  const otherPoolQueryWaited = otherPoolProbe
    ? Number(
        (await Promise.race([
          otherPoolProbe,
          sleep(0).then(() => "waiting"),
        ])) === "waiting"
      )
    : 0;
  const heldExportsAfter = load.exports ? await heldNow("export") : 0;
  const heldTalliesAfter = load.reportTallies
    ? await heldNow("report tally")
    : 0;
  const renewed = holdsRenewed.export + holdsRenewed["report tally"];
  const identityWaitingAfter = mockStalls.identity.pending;
  const topicLookupCalls = mockStalls.topics.calls;
  const languageCalls = mockStalls.language.calls;
  // What was already stored while the slow work held: a request stored but not
  // yet answered waited after its write; one not yet stored waited before it.
  const storedWhileHeld = await stored();

  // Release everything and let it finish.
  heldKinds.clear();
  while (otherPoolClients.length) otherPoolClients.pop()!.release();
  if (load.exports || load.reportTallies || load.otherPools) {
    await admin.query("SELECT pg_advisory_unlock($1, $2)", HOLD_LOCK);
  }
  for (const stall of Object.values(mockStalls)) stall.release();
  const slowStatuses = await Promise.all(slowWork);

  // Nothing a participant sent may be lost, however late it was answered.
  let { votesStored, commentsStored } = await stored();
  const storedBy = Date.now() + 30000;
  while (
    (votesStored < PARTICIPANTS || commentsStored < PARTICIPANTS) &&
    Date.now() < storedBy
  ) {
    await sleep(250);
    ({ votesStored, commentsStored } = await stored());
  }
  // Let late requests finish their bookkeeping before the next scenario.
  await sleep(1000);

  const evidence: Evidence = {
    otherPoolConnectionsHeld,
    otherPoolQueryWaited,
    heldExportsBefore,
    heldExportsAfter,
    heldTalliesBefore,
    heldTalliesAfter,
    holdsRenewed: renewed,
    identityWaitingBefore,
    identityWaitingAfter,
    topicLookupCalls,
    languageCalls,
    votesStored,
    commentsStored,
  };
  const worst = (op: Op) => Math.max(...outcomes[op].map((o) => o.ms));
  const bad = (op: Op) =>
    outcomes[op].filter(
      (o) => !o.answered || o.status !== 200 || o.ms >= BUDGET_MS
    ).length;
  process.stdout.write(
    `${JSON.stringify({
      scenario: name,
      budget_ms: BUDGET_MS,
      participants: PARTICIPANTS,
      vote_worst_ms: worst("vote"),
      vote_late_or_failed: bad("vote"),
      comment_worst_ms: worst("comment"),
      comment_late_or_failed: bad("comment"),
      nextcomment_worst_ms: worst("nextComment"),
      nextcomment_late_or_failed: bad("nextComment"),
      slow_work_statuses: slowStatuses,
      votes_stored_while_held: storedWhileHeld.votesStored,
      comments_stored_while_held: storedWhileHeld.commentsStored,
      ...evidence,
    })}\n`
  );
  return { outcomes, evidence };
}

/** Every request answered 200 within the budget. */
function expectPrompt(outcomes: Outcome[], count = PARTICIPANTS): void {
  const describeOutcome = (o: Outcome) =>
    `participant ${o.participant}: ${
      o.answered ? `status ${o.status}` : "no answer"
    } after ${o.ms} ms${o.error ? ` (${o.error})` : ""}`;
  const late = outcomes.filter((o) => !o.answered || o.ms >= BUDGET_MS);
  const failed = outcomes.filter((o) => o.answered && o.status !== 200);
  expect({
    late: late.map(describeOutcome),
    failed: failed.map(describeOutcome),
  }).toEqual({ late: [], failed: [] });
  expect(outcomes).toHaveLength(count);
}

/** "prompt": a real assertion. A string: an expected failure, naming what the
 * request waits on today. */
type Expectation = "prompt" | string;

function guard(
  name: string,
  load: Load,
  expectations: Record<Op, Expectation>
): void {
  describe(name, () => {
    let result: Result;
    beforeAll(async () => {
      result = await runScenario(name, load);
    }, 180000);

    test("the slow work held for the whole window, and every vote and comment sent was stored", () => {
      const e = result.evidence;
      // Every check names the evidence it reads, and all that fall short are
      // reported together, so a failure says whether the slow work did not
      // hold, or what the participants sent was not stored, or both.
      type Check = [keyof Evidence, "exactly" | "at least", number];
      const checks: Check[] = [];
      if (load.exports) {
        const pool = Math.min(EXPORT_DOWNLOADS, REPORT_EXPORT_POOL_MAX);
        checks.push(["heldExportsBefore", "exactly", pool]);
        checks.push(["heldExportsAfter", "exactly", pool]);
      }
      if (load.reportTallies) {
        checks.push(["heldTalliesBefore", "at least", 1]);
        checks.push(["heldTalliesAfter", "at least", 1]);
      }
      if (load.identity) {
        checks.push(["identityWaitingBefore", "at least", 1]);
        checks.push(["identityWaitingAfter", "at least", 1]);
      }
      if (load.otherPools) {
        checks.push([
          "otherPoolConnectionsHeld",
          "exactly",
          2 * MAIN_POOL_MAX +
            AGENT_EXCHANGE_POOL_MAX +
            RESULT_SNAPSHOT_POOL_MAX +
            REPORT_EXPORT_POOL_MAX,
        ]);
        checks.push(["otherPoolQueryWaited", "exactly", 1]);
      }
      // Topic lookups and language detection are reached only by the
      // participants' own requests.
      if (load.topics) {
        checks.push(["topicLookupCalls", "at least", 1]);
      }
      if (load.language) {
        checks.push(["languageCalls", "at least", PARTICIPANTS]);
      }
      checks.push(["votesStored", "exactly", PARTICIPANTS]);
      checks.push(["commentsStored", "exactly", PARTICIPANTS]);
      const short = checks
        .filter(([key, how, n]) =>
          how === "exactly" ? e[key] !== n : e[key] < n
        )
        .map(([key, how, n]) => `${key} ${e[key]}, expected ${how} ${n}`);
      expect(short).toEqual([]);
    });

    for (const op of OPS) {
      const expectation = expectations[op];
      const title = `${LABEL[op]} answer 200 within ${BUDGET_MS / 1000} s`;
      if (expectation === "prompt") {
        test(title, () => expectPrompt(result.outcomes[op]));
      } else {
        test.failing(`${title} [expected to fail: ${expectation}]`, () =>
          expectPrompt(result.outcomes[op])
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The scenarios.

// What today's server waits on, named once for the expected failures below.
// A vote is answered only after the next statement is chosen
// (handle_POST_votes in src/routes/votes.ts), and topic-agenda routing sends
// one lookup per selected topic with no deadline and waits for all of them
// (getTidsForParticipantTopicAgenda in src/nextComment.ts).
const TOPIC_LOOKUPS_WITHOUT_DEADLINE =
  "next-statement selection waits on topic lookups that have no deadline";
// The language of a comment is detected before the comment is stored, within
// a 5 s provider budget (handle_POST_comments in src/routes/comments.ts,
// detectLanguage in src/comment.ts).
const DETECTION_BEFORE_INSERT =
  "language detection runs before the comment is stored, for up to 5 s";

guard(
  "quiet: no slow work",
  {},
  { vote: "prompt", comment: "prompt", nextComment: "prompt" }
);

guard(
  "exports of the conversation held in the database",
  { exports: true },
  { vote: "prompt", comment: "prompt", nextComment: "prompt" }
);

// The tallies (src/comment.ts) run on the read pool, which the participation
// path no longer uses: it has pools of its own (src/db/pg-query.ts).
guard(
  "report page tallies held in the database",
  { reportTallies: true },
  { vote: "prompt", comment: "prompt", nextComment: "prompt" }
);

guard(
  "the identity provider's management API never answers",
  { identity: true },
  { vote: "prompt", comment: "prompt", nextComment: "prompt" }
);

guard(
  "topic lookups for topic-agenda routing never answer",
  { topics: true },
  {
    vote: `the stored vote is answered only after ${TOPIC_LOOKUPS_WITHOUT_DEADLINE}`,
    comment: "prompt",
    nextComment: TOPIC_LOOKUPS_WITHOUT_DEADLINE,
  }
);

guard(
  "the language provider never answers",
  { language: true },
  { vote: "prompt", comment: DETECTION_BEFORE_INSERT, nextComment: "prompt" }
);

guard(
  "all of it at once",
  {
    exports: true,
    reportTallies: true,
    identity: true,
    topics: true,
    language: true,
  },
  {
    vote: `the stored vote is answered only after ${TOPIC_LOOKUPS_WITHOUT_DEADLINE}`,
    comment: DETECTION_BEFORE_INSERT,
    nextComment: TOPIC_LOOKUPS_WITHOUT_DEADLINE,
  }
);

guard(
  "every connection of every pool other work uses, held",
  { otherPools: true },
  { vote: "prompt", comment: "prompt", nextComment: "prompt" }
);

// ---------------------------------------------------------------------------
// Comments sent at the same moment, with no slow work at all.

/** Participants commenting at once, and how many times they do it. */
const BURST_PARTICIPANTS = 24;
const BURST_ROUNDS = 3;

describe("comments sent at the same moment in one conversation", () => {
  const outcomes: Outcome[] = [];
  const texts: string[] = [];
  let stored = 0;
  beforeAll(async () => {
    const participants = await Promise.all(
      Array.from({ length: BURST_PARTICIPANTS }, () => joinedParticipant(false))
    );
    const stamp = Date.now();
    for (let round = 0; round < BURST_ROUNDS; round++) {
      const burst = participants.map((p, i) => {
        const txt = `burst ${round}: statement from participant ${i} (${stamp})`;
        texts.push(txt);
        return timed(
          i,
          as(p)
            .post("/api/v3/comments")
            .send({
              conversation_id: conversationId,
              txt,
              vote: semanticToWire("agree"),
            })
        );
      });
      outcomes.push(...(await Promise.all(burst)));
    }
    await sleep(1000);
    stored = (
      await admin.query(
        "SELECT count(*)::int AS n FROM comments WHERE zid = $1 AND txt = ANY($2::text[])",
        [zid, texts]
      )
    ).rows[0].n;
    process.stdout.write(
      `${JSON.stringify({
        scenario: "comments sent at the same moment",
        sent: texts.length,
        stored,
        rejected: outcomes.filter((o) => o.answered && o.status !== 200).length,
        worst_ms: Math.max(...outcomes.map((o) => o.ms)),
      })}\n`
    );
  }, 120000);

  // The tid_auto trigger numbers a conversation's statements MAX(tid) + 1 under
  // a per-conversation advisory lock held until the inserting transaction ends
  // (server/postgres/migrations), so comments inserted at the same moment are
  // numbered one after another and none is refused.
  test("every one is answered 200 and stored", () => {
    expectPrompt(outcomes, BURST_PARTICIPANTS * BURST_ROUNDS);
    expect(stored).toBe(texts.length);
  });
});
