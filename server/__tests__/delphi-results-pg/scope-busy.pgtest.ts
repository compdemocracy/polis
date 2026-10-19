/** One writer scope per conversation couples every Delphi result writer.
 *
 * Under DELPHI_RESULT_BACKEND=postgres, a full pipeline run, a narrative batch
 * and every synchronous result edit (a collective-statement save is one) are
 * admitted through pd_writer_admit, which takes one guard per conversation,
 * "including HTTP edits" (server/postgres/migrations/000030_create_delphi_writers.sql:46-50).
 * While a run or a narrative batch holds that guard (a batch parked on the
 * provider's batch API can hold it for a day), the other writers are refused:
 *
 *   (a) a collective-statement save is refused by the store after the model
 *       call it pays for (src/routes/collectiveStatement.ts:144, then :350);
 *   (b) a narrative admission meets 'scope binding mismatch' and is answered
 *       503 (000023_create_delphi_foundation.sql:525-528, as replaced in
 *       000024_create_polis_queue_large_class.sql:272-276; src/routes/delphi/jobGuard.ts:1708-1709);
 *   (c) a second full run with other settings meets 'conflict' and is answered
 *       409 "idempotency_key was already used" although it sent no key
 *       (000024:277, src/routes/delphi/jobGuard.ts:1702, src/routes/delphi/jobs.ts:151-156).
 *
 * The ruled target is per-family publication: each result family publishes on
 * its own, with its own failure state and explicit dependencies, so a
 * statement or a narrative never waits on a run. Each case is recorded twice:
 * a plain test pins today's exact answer (status, message, the SQL error and
 * the provider calls), and a `test.failing` whose name says what it is
 * expected to fail on asserts the target, the convention of
 * ../integration/participation-under-load.test.ts. Both flip when the scopes
 * split: the "today:" pins then fail and are deleted, and jest reports each
 * failing case as "Failing test passed even though it was supposed to fail",
 * the cue to make it a plain test.
 *
 * The model provider is a stand-in: @anthropic-ai/sdk is replaced by a class
 * that counts calls and answers at once, so nothing leaves the process. Every
 * request goes through the real handlers, admission and SQL functions; only
 * authentication is a stand-in that sets req.p as hybridAuth does. The queue
 * steps polis-jobs would take (claim, provider intent, park) are its own SQL
 * functions. Generated data only; see scripts/test-delphi-result-reads.sh. */
import { randomBytes, randomUUID } from "crypto";
import { Server } from "http";
import { Client } from "pg";
import request from "supertest";
import { conversation, postgres, publish } from "./support";

const ENV = "scopebusy", SCOPE = "delphi";
const CODE_SHA = "c0de".repeat(10);
const MODEL_KEY = "stand-in-key-never-sent";
const JOB = "00000000-0000-4000-8000-00000000b551";
const TOPIC_KEY = `${JOB}#0#1`;
const S = (s: string) => ({ S: s });
const N = (n: number) => ({ N: String(n) });

/** What the stand-in provider saw, and the order of paid calls and refused stores. */
const mockProvider = { constructed: 0, calls: 0, keys: [] as unknown[], events: [] as string[] };
jest.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async () => {
        mockProvider.calls++;
        mockProvider.events.push("provider call");
        const statement = {
          id: "collective_statement",
          title: "Collective Statement: Generated topic",
          paragraphs: [{ id: "shared", title: "Shared", sentences: [{ clauses: [
            { text: "We agree on the generated evidence", citations: [0, 1] },
          ] }] }],
        };
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(statement) }] };
      },
    };
    constructor(options: { apiKey?: unknown }) {
      mockProvider.constructed++;
      mockProvider.keys.push(options?.apiKey);
    }
  }
  return { __esModule: true, default: Anthropic };
});

let pg: Client;
let app: Server;
/** SQL failures of the admission and edit functions, in order. */
const sqlFailures: Array<{ fn: string; message: string }> = [];

async function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const express = (await import("express")).default as any;
  const { moveToBody } = await import("../../src/utils/parameter");
  const { handle_POST_delphi_jobs } = await import("../../src/routes/delphi/jobs");
  const { handle_POST_delphi_batch_reports } = await import("../../src/routes/delphi/batchReports");
  const { handle_POST_collectiveStatement, handle_GET_collectiveStatement } = await import(
    "../../src/routes/collectiveStatement"
  );
  const a = express();
  a.use(express.bodyParser({ limit: "5mb" }));
  // Stand-in for hybridAuth(assignToP): the conversation's owner, Delphi enabled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const owner = (req: any, _res: any, next: () => void) => {
    req.p = { ...(req.p || {}), uid: Number(req.headers["x-generated-uid"]), delphiEnabled: true };
    next();
  };
  a.post("/api/v3/delphi/jobs", moveToBody, owner, handle_POST_delphi_jobs);
  a.post("/api/v3/delphi/batchReports", moveToBody, owner, handle_POST_delphi_batch_reports);
  a.post("/api/v3/collectiveStatement", moveToBody, owner, handle_POST_collectiveStatement);
  a.get("/api/v3/collectiveStatement", moveToBody, handle_GET_collectiveStatement);
  return a;
}

type Outcome = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  providerCalls: number;
  sql: Array<{ fn: string; message: string }>;
  events: string[];
};
/** One request, with the provider calls and SQL failures it caused. */
async function attempt(send: () => request.Test): Promise<Outcome> {
  const calls = mockProvider.calls, failures = sqlFailures.length, events = mockProvider.events.length;
  const res = await send();
  return {
    status: res.status, body: res.body, providerCalls: mockProvider.calls - calls,
    sql: sqlFailures.slice(failures), events: mockProvider.events.slice(events),
  };
}

/** A conversation with one topic of four comments, its report, and the
 * cluster assignments a run would have published. */
async function seed(zid: number): Promise<string> {
  const report = `rscopebusy${zid}`;
  await conversation(pg, zid, [report]);
  await pg.query("SET session_replication_role = replica");
  for (const tid of [0, 1, 2, 3]) {
    await pg.query(
      `INSERT INTO comments(zid,tid,pid,uid,txt,mod,active) VALUES($1,$2,0,$1,$3,0,true)
      ON CONFLICT(zid,tid) DO UPDATE SET txt=EXCLUDED.txt`,
      [zid, tid, `Generated evidence ${tid}`]
    );
  }
  await pg.query("SET session_replication_role = origin");
  await publish(pg, { env: ENV, scope: SCOPE, zid, families: {
    Delphi_CommentHierarchicalClusterAssignments: [0, 1, 2, 3].map((tid) => ({
      conversation_id: S(String(zid)), comment_id: N(tid), layer0_cluster_id: N(1),
    })),
  } });
  return report;
}

const as = (zid: number) => ({ "x-generated-uid": String(zid), "Content-Type": "application/json" });
/** The topic page's save (client-report CollectiveStatementModal), without the client-side filter. */
const save = (zid: number, report: string) => () =>
  request(app).post("/api/v3/collectiveStatement").set(as(zid))
    .send({ report_id: report, topic_key: TOPIC_KEY, topic_name: "Generated topic" });
/** The report page's run request (client-report CommentsReport). */
const runPipeline = (zid: number, body: Record<string, unknown>) => () =>
  request(app).post("/api/v3/delphi/jobs").set(as(zid)).send(body);
/** The report page's narrative request. */
const runNarrative = (zid: number, report: string) => () =>
  request(app).post("/api/v3/delphi/batchReports").set(as(zid))
    .send({ report_id: report, model: "generated-model", no_cache: false, include_moderation: true });
/** Statements the topic page would read for the report. */
async function stored(report: string): Promise<number> {
  const res = await request(app).get("/api/v3/collectiveStatement").query({ report_id: report });
  if (res.status !== 200) throw new Error(`statement read failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.count;
}

/** What polis-jobs does first with a queued job: claim it (state running). */
async function claim(expected: string) {
  const owner = randomUUID(), attemptId = randomUUID();
  const v = (await pg.query("SELECT public.pq_claim($1,1::smallint,$2::uuid,$3::uuid,900,'delphi') AS v",
    [ENV, owner, attemptId])).rows[0].v;
  if (v.outcome !== "owned" || v.job_id !== expected) throw new Error(`claim: ${JSON.stringify(v)}`);
  return { job: v.job_id as string, owner, attempt: attemptId, epoch: v.lease_epoch as string };
}
/** The job that holds the conversation's writer guard now, if any. */
async function guardHolder(zid: number): Promise<{ job: string; state: string; kind: string } | null> {
  const rows = (await pg.query(`SELECT g.root_job_id::text AS job, q.state, d.kind FROM delphi_job_guards g
    JOIN polis_queue_jobs q ON q.env=g.env AND q.job_id=g.root_job_id
    JOIN delphi_jobs d ON d.env=g.env AND d.job_id=g.root_job_id
    WHERE g.env=$1 AND g.zid=$2 AND g.scope_key LIKE 'writer:%'`, [ENV, zid])).rows;
  return rows[0] ?? null;
}

beforeAll(async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  process.env.DELPHI_WRITER_CODE_SHA = CODE_SHA;
  // Read once when the config module loads, below; the stand-in never sends it.
  process.env.ANTHROPIC_API_KEY = MODEL_KEY;
  pg = await postgres();
  const pgQuery = (await import("../../src/db/pg-query")).default;
  const queryP = pgQuery.queryP;
  jest.spyOn(pgQuery, "queryP").mockImplementation(async (sql: unknown, ...args: unknown[]) => {
    try {
      return await queryP(sql as string, ...args);
    } catch (error) {
      const fn = /pd_writer_admit|pd_result_mutate/.exec(String(sql))?.[0];
      if (fn) {
        sqlFailures.push({ fn, message: (error as Error).message });
        mockProvider.events.push(`${fn} refused`);
      }
      throw error;
    }
  });
  const routes = await buildApp();
  app = await new Promise<Server>((resolve) => {
    const s = routes.listen(0, "127.0.0.1", () => resolve(s));
  });
}, 60000);
afterAll(async () => {
  await new Promise((resolve) => app?.close(resolve));
  await pg?.end();
});

test("the provider is the counting stand-in, built once with the stand-in key", () => {
  expect({ constructed: mockProvider.constructed, keys: mockProvider.keys }).toEqual({ constructed: 1, keys: [MODEL_KEY] });
});

describe("while a full pipeline run (admitted as the report page admits it) holds the writer scope", () => {
  const ZID = 5201;
  let report: string;
  let pipelineJob: string;
  let free: Outcome, storedFree: number;
  let held: Outcome, storedHeld: number;
  let narrative: Outcome, rerunSame: Outcome, rerunOther: Outcome;

  beforeAll(async () => {
    report = await seed(ZID);
    // The harness: with the scope free, the same save is stored.
    free = await attempt(save(ZID, report));
    storedFree = await stored(report);
    const admitted = await attempt(runPipeline(ZID, { report_id: report }));
    if (admitted.status !== 200 || admitted.body.status !== "success" || admitted.body.deduplicated) {
      throw new Error(`pipeline admission: ${JSON.stringify(admitted)}`);
    }
    pipelineJob = admitted.body.job_id;
    await claim(pipelineJob);
    const holder = await guardHolder(ZID);
    if (holder?.job !== pipelineJob || holder.state !== "running") throw new Error(`guard: ${JSON.stringify(holder)}`);

    held = await attempt(save(ZID, report));
    storedHeld = await stored(report);
    narrative = await attempt(runNarrative(ZID, report));
    rerunSame = await attempt(runPipeline(ZID, { report_id: report }));
    rerunOther = await attempt(runPipeline(ZID, { report_id: report, include_moderation: true }));
    process.stdout.write(`${JSON.stringify({ holder: "full pipeline, running", free, held, narrative, rerunSame, rerunOther })}\n`);
  }, 120000);

  test("the harness: with the scope free, a save calls the provider once and is stored", () => {
    expect({ status: free.status, ok: free.body.status, providerCalls: free.providerCalls, sql: free.sql, stored: storedFree })
      .toEqual({ status: 200, ok: "success", providerCalls: 1, sql: [], stored: 1 });
  });

  // (a) collectiveStatement.ts:144 pays, then :350's store is refused inside
  // pd_result_mutate's admission. The run was admitted with the report id, so
  // pd_enqueue's binding check (000024:272-276: report_id IS NOT DISTINCT FROM
  // NULL) raises before the 'result scope busy or request conflict' branch
  // (000030:162-165) is reached; the handler answers 500 with that message.
  test("(a) today: a statement save pays one provider call, then the store is refused with scope binding mismatch (500) and nothing is stored", () => {
    expect({ status: held.status, body: held.body, providerCalls: held.providerCalls, sql: held.sql, events: held.events, stored: storedHeld })
      .toEqual({
        status: 500,
        body: { status: "error", message: "Error generating collective statement", error: "scope binding mismatch" },
        providerCalls: 1,
        sql: [{ fn: "pd_result_mutate", message: "scope binding mismatch" }],
        events: ["provider call", "pd_result_mutate refused"],
        stored: storedFree,
      });
  });
  test.failing("(a) a statement save during a run is stored [expected to fail: the save shares the run's writer scope and is refused after its paid call]", () => {
    expect({ status: held.status, ok: held.body.status, stored: storedHeld })
      .toEqual({ status: 200, ok: "success", stored: storedFree + 1 });
  });

  // (b) jobGuard.ts:1708-1709 turns any SQL error into
  // JobAdmissionUnavailableError; batchReports.ts:174-184 answers 503.
  test("(b) today: a narrative admission meets scope binding mismatch and is answered 503 with no job", () => {
    expect({ status: narrative.status, body: narrative.body, providerCalls: narrative.providerCalls, sql: narrative.sql })
      .toEqual({
        status: 503,
        body: {
          status: "error",
          message: "Delphi job admission is temporarily unavailable; no batch report job was created.",
          code: "JOB_ADMISSION_UNAVAILABLE",
          report_id: report,
        },
        providerCalls: 0,
        sql: [{ fn: "pd_writer_admit", message: "scope binding mismatch" }],
      });
  });
  test.failing("(b) a narrative batch requested during a run is admitted [expected to fail: it shares the run's writer scope and is answered 503]", () => {
    expect({ status: narrative.status, ok: narrative.body.status }).toEqual({ status: 200, ok: "success" });
  });

  // (c) The same request again is deduplicated (the guard's request sha
  // matches, 000024:278-280), which is right. With other settings the sha
  // differs and pd_enqueue answers 'conflict' (000024:277); jobGuard.ts:1702
  // maps it to idempotency_conflict and jobs.ts:151-156 to 409, though the
  // request sent no idempotency_key at all.
  test("(c) today: the same run request is deduplicated onto the live run", () => {
    expect({ status: rerunSame.status, ok: rerunSame.body.status, job: rerunSame.body.job_id, deduplicated: rerunSame.body.deduplicated, sql: rerunSame.sql })
      .toEqual({ status: 200, ok: "success", job: pipelineJob, deduplicated: true, sql: [] });
  });
  test("(c) today: a run request with other settings and no idempotency key is answered 409 idempotency_key was already used", () => {
    expect({ status: rerunOther.status, body: rerunOther.body, providerCalls: rerunOther.providerCalls, sql: rerunOther.sql })
      .toEqual({
        status: 409,
        body: { status: "error", error: "idempotency_key was already used for a different job payload", job_id: pipelineJob },
        providerCalls: 0,
        sql: [],
      });
  });
  // The target here is the least the ruling implies: a request that sent no
  // key is not refused as a reused key. Whether the second run queues behind
  // the first or gets an honest "a run is in progress" is for the design; the
  // "today:" pin above flips either way.
  test.failing("(c) a run request with other settings during a run is admitted as its own run [expected to fail: answered 409 as a reused idempotency key it never sent]", () => {
    expect({ status: rerunOther.status, ok: rerunOther.body.status, separate: rerunOther.body.job_id !== pipelineJob })
      .toEqual({ status: 200, ok: "success", separate: true });
  });
});

describe("while a narrative batch parked on the provider's batch API holds the writer scope", () => {
  const ZID = 5202;
  let report: string;
  let narrativeJob: string;
  let held: Outcome, storedHeld: number, pipeline: Outcome;

  beforeAll(async () => {
    report = await seed(ZID);
    const admitted = await attempt(runNarrative(ZID, report));
    if (admitted.status !== 200 || admitted.body.status !== "success" || admitted.body.deduplicated) {
      throw new Error(`narrative admission: ${JSON.stringify(admitted)}`);
    }
    narrativeJob = admitted.body.job_id;
    // polis-jobs' steps for a batch: claim, record the provider intent, mark it
    // submitted with the provider's batch id, park until the batch is due.
    const c = await claim(narrativeJob);
    const requestId = randomUUID();
    await pg.query("SELECT public.pd_provider_intent($1,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,'anthropic',$7::bytea)",
      [ENV, c.job, c.owner, c.attempt, c.epoch, requestId, randomBytes(32)]);
    await pg.query("SELECT public.pd_provider_update($1,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,'submitted',$7)",
      [ENV, c.job, c.owner, c.attempt, c.epoch, requestId, `msgbatch_generated_${randomUUID()}`]);
    const parked = (await pg.query(`SELECT public.pq_park($1,$2::uuid,$3::uuid,$4::uuid,$5::bigint,'provider_batch_pending',true,
      clock_timestamp()+interval '24 hours') AS v`, [ENV, c.job, c.owner, c.attempt, c.epoch])).rows[0].v;
    if (parked.outcome !== "parked") throw new Error(`park: ${JSON.stringify(parked)}`);
    const holder = await guardHolder(ZID);
    if (holder?.job !== narrativeJob || holder.state !== "parked") throw new Error(`guard: ${JSON.stringify(holder)}`);

    held = await attempt(save(ZID, report));
    storedHeld = await stored(report);
    pipeline = await attempt(runPipeline(ZID, { report_id: report }));
    process.stdout.write(`${JSON.stringify({ holder: "narrative batch, parked 24 h", held, pipeline })}\n`);
  }, 120000);

  // (a) as above, held by the parked batch: the edit is kind full_pipeline with
  // no report, the holder kind narrative (000024:272-276).
  test("(a) today: a statement save pays one provider call, then the store is refused with scope binding mismatch (500) and nothing is stored", () => {
    expect({ status: held.status, body: held.body, providerCalls: held.providerCalls, sql: held.sql, events: held.events, stored: storedHeld })
      .toEqual({
        status: 500,
        body: { status: "error", message: "Error generating collective statement", error: "scope binding mismatch" },
        providerCalls: 1,
        sql: [{ fn: "pd_result_mutate", message: "scope binding mismatch" }],
        events: ["provider call", "pd_result_mutate refused"],
        stored: 0,
      });
  });
  test.failing("(a) a statement save while a narrative batch is parked is stored [expected to fail: the save shares the batch's writer scope and is refused after its paid call]", () => {
    expect({ status: held.status, ok: held.body.status, stored: storedHeld }).toEqual({ status: 200, ok: "success", stored: 1 });
  });

  // The other direction of (b): a run cannot start while the batch waits.
  test("today: a full pipeline run requested while the batch is parked meets scope binding mismatch and is answered 503 with no job", () => {
    expect({ status: pipeline.status, code: pipeline.body.code, providerCalls: pipeline.providerCalls, sql: pipeline.sql })
      .toEqual({
        status: 503,
        code: "JOB_ADMISSION_UNAVAILABLE",
        providerCalls: 0,
        sql: [{ fn: "pd_writer_admit", message: "scope binding mismatch" }],
      });
  });
  test.failing("a full pipeline run requested while a narrative batch is parked is admitted [expected to fail: it shares the batch's writer scope and is answered 503]", () => {
    expect({ status: pipeline.status, ok: pipeline.body.status }).toEqual({ status: 200, ok: "success" });
  });
});

describe("while a full pipeline run admitted without a report holds the writer scope", () => {
  const ZID = 5203;
  let report: string;
  let held: Outcome, storedHeld: number;

  beforeAll(async () => {
    report = await seed(ZID);
    // A run requested by conversation id alone (jobs.ts:67-69) has no report
    // id, so the edit passes the binding check and meets the request check.
    const admitted = await attempt(runPipeline(ZID, { conversation_id: String(ZID) }));
    if (admitted.status !== 200 || admitted.body.status !== "success" || admitted.body.deduplicated) {
      throw new Error(`pipeline admission: ${JSON.stringify(admitted)}`);
    }
    await claim(admitted.body.job_id);
    const holder = await guardHolder(ZID);
    if (holder?.job !== admitted.body.job_id || holder.state !== "running") throw new Error(`guard: ${JSON.stringify(holder)}`);
    held = await attempt(save(ZID, report));
    storedHeld = await stored(report);
    process.stdout.write(`${JSON.stringify({ holder: "full pipeline without report, running", held })}\n`);
  }, 120000);

  // (a) the message 000030:162-165 raises when pd_enqueue answers 'conflict'.
  test("(a) today: a statement save pays one provider call, then the store is refused with result scope busy or request conflict (500) and nothing is stored", () => {
    expect({ status: held.status, body: held.body, providerCalls: held.providerCalls, sql: held.sql, events: held.events, stored: storedHeld })
      .toEqual({
        status: 500,
        body: { status: "error", message: "Error generating collective statement", error: "result scope busy or request conflict" },
        providerCalls: 1,
        sql: [{ fn: "pd_result_mutate", message: "result scope busy or request conflict" }],
        events: ["provider call", "pd_result_mutate refused"],
        stored: 0,
      });
  });
  test.failing("(a) a statement save during a run admitted without a report is stored [expected to fail: the save shares the run's writer scope and is refused after its paid call]", () => {
    expect({ status: held.status, ok: held.body.status, stored: storedHeld }).toEqual({ status: 200, ok: "success", stored: 1 });
  });
});
