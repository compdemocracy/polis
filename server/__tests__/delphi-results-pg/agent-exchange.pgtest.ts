/** The collective-statement agent path on a migrated database, on both result
 * backends: the exact requests `polis collective export` and `polis collective
 * import` send (polis-cli/crates/polis/src/collective.rs), checked the way the
 * CLI checks the answers; provenance and stored versions; the reader the topic
 * page uses; and the participation pools staying clear while the exchange's
 * own pool is exhausted. Authentication is a stand-in that assigns req.p.uid
 * where hybridAuth does; everything after it is the real handler chain.
 * Generated data only. No votes are written: the consensus gate reads the
 * group votes in math_main, and the exported counts read votes_latest_unique
 * through the vote convention module. */
import { createHash } from "crypto";
import { Server } from "http";
import { Client, PoolClient } from "pg";
import request from "supertest";
import {
  conversation,
  postgres,
  publish,
  putDynamo,
  resetDynamo,
  ENV,
  SCOPE,
} from "./support";

const S = (s: string) => ({ S: s });
const N = (n: number) => ({ N: String(n) });
const MATH_ENV = "agentexchange";
const JOB = "00000000-0000-4000-8000-00000000c011";
const TOPIC = `${JOB}#0#1`;
const OTHER_TOPIC = `${JOB}#0#2`;
const STRANGER = 7199;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

let pg: Client;
let pgQuery: typeof import("../../src/db/pg-query").default;
// One loopback listener for the whole file: an ephemeral listener on every
// interface can share its port number with another process's loopback-only
// listener, which then answers the request instead.
let app: Server;

/** The routes as server/app.ts mounts them, with the body bound before the
 * shared parser and a stand-in for hybridAuth(assignToP). */
async function buildApp() {
  const express = (await import("express")).default as any;
  const { collectiveBody } = await import(
    "../../src/routes/delphi/collectiveBody"
  );
  const exchange = await import("../../src/routes/delphi/collectiveExchange");
  const { handle_GET_collectiveStatement } = await import(
    "../../src/routes/collectiveStatement"
  );
  const { moveToBody } = await import("../../src/utils/parameter");
  const a = express();
  a.use(collectiveBody);
  a.use(express.bodyParser({ limit: "50mb" }));
  const auth = (req: any, _res: any, next: any) => {
    req.p = req.p || {};
    const token = req.headers.authorization;
    if (typeof token === "string" && token.startsWith("Bearer uid-"))
      req.p.uid = Number(token.slice("Bearer uid-".length));
    next();
  };
  a.get(
    "/api/v3/delphi/collective/inputs",
    moveToBody,
    auth,
    exchange.handle_GET_collective_inputs
  );
  a.post(
    "/api/v3/delphi/collective/results",
    moveToBody,
    auth,
    exchange.handle_POST_collective_results
  );
  a.get(
    "/api/v3/delphi/collective/results",
    moveToBody,
    exchange.handle_GET_collective_results
  );
  a.get(
    "/api/v3/collectiveStatement",
    moveToBody,
    handle_GET_collectiveStatement
  );
  return a;
}

/** What the CLI does with an answer (polis-client request() and has_error,
 * then collective.rs): JSON, 2xx, no error marker, and for an export the
 * manifest checks before any file is written. */
function cliAccepts(
  res: request.Response,
  kind: "export" | "import",
  ids: { conversation: string; report: string }
) {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  expect(res.headers["content-type"]).toMatch(/application\/json/);
  const body = res.body;
  expect(body.ok).not.toBe(false);
  expect(body.success).not.toBe(false);
  expect([undefined, null, false, ""]).toContain(body.error);
  expect(["error", "failed"]).not.toContain(body.status);
  if (kind === "export") {
    expect(Array.isArray(body.sections)).toBe(true);
    expect(body.sections.length).toBeGreaterThanOrEqual(1);
    expect(body.sections.length).toBeLessThanOrEqual(99);
    expect(body.conversation_id).toBe(ids.conversation);
    expect(body.report_id).toBe(ids.report);
    expect(typeof body.result_schema).toBe("object");
    expect(Array.isArray(body.result_schema)).toBe(false);
    // The CLI's own receipt reports these two.
    expect(body.export_id).toMatch(/^external_/);
    expect(body.input_digest).toMatch(/^[0-9a-f]{64}$/);
  }
}

/** A writer's result for an export, as an outside agent would build it. */
function authored(
  manifest: any,
  model: string,
  clause = "We support the cited proposal."
) {
  const section = manifest.sections[0];
  return {
    schema_version: manifest.schema_version,
    conversation_id: manifest.conversation_id,
    report_id: manifest.report_id,
    export_id: manifest.export_id,
    input_digest: manifest.input_digest,
    section: manifest.section,
    model,
    prompt_sha256: sha256(section.instructions),
    runner: "generated-runner",
    results: [
      {
        section: section.section,
        report_data: {
          id: "collective_statement",
          title: "Candidate collective statement",
          paragraphs: [
            {
              id: "shared",
              title: "Common ground",
              sentences: [
                {
                  clauses: [
                    { text: clause, citations: [section.citation_ids[0]] },
                    {
                      text: "We also agree on the next cited point.",
                      citations: section.citation_ids.slice(1, 3),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

const families = (zid: number) => ({
  Delphi_CommentClustersLLMTopicNames: [
    {
      conversation_id: S(String(zid)),
      topic_key: S(TOPIC),
      layer_id: N(0),
      cluster_id: N(1),
      topic_name: S("Generated library hours"),
      job_id: S(JOB),
    },
    {
      conversation_id: S(String(zid)),
      topic_key: S(OTHER_TOPIC),
      layer_id: N(0),
      cluster_id: N(2),
      topic_name: S("Generated quiet topic"),
      job_id: S(JOB),
    },
  ],
  // Comments 0-3 are topic 1; comment 4 is topic 2, alone, so it can never qualify.
  Delphi_CommentHierarchicalClusterAssignments: [0, 1, 2, 3, 4].map((tid) => ({
    conversation_id: S(String(zid)),
    comment_id: N(tid),
    layer0_cluster_id: N(tid < 4 ? 1 : 2),
  })),
});

async function seed(zid: number, backend: string) {
  const conversationId = `agentexchange${zid}`;
  const reportId = `ragentexchange${zid}`;
  await conversation(pg, zid, [reportId]);
  await pg.query(
    "INSERT INTO users(uid,hname,email) VALUES($1,'generated stranger',$2) ON CONFLICT(uid) DO NOTHING",
    [STRANGER, `generated-${STRANGER}@example.invalid`]
  );
  await pg.query(
    "INSERT INTO zinvites(zid,zinvite) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [zid, conversationId]
  );
  await pg.query("SET session_replication_role = replica");
  for (const tid of [0, 1, 2, 3, 4]) {
    await pg.query(
      `INSERT INTO comments(zid,tid,pid,uid,txt,mod,active) VALUES($1,$2,0,$1,$3,0,true)
      ON CONFLICT(zid,tid) DO UPDATE SET txt=EXCLUDED.txt`,
      [zid, tid, `Generated evidence ${tid}`]
    );
  }
  // Every group agrees with comments 0-3 often enough to pass the report gate.
  const votes = Object.fromEntries(
    [0, 1, 2, 3, 4].map((tid) => [tid, { A: 18, D: 0, S: 20 }])
  );
  const math = {
    "group-votes": {
      0: { "n-members": 20, votes },
      1: { "n-members": 20, votes },
    },
  };
  await pg.query(
    `INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,math_tick) VALUES($1,$2,$3,0,7)
    ON CONFLICT(zid,math_env) DO UPDATE SET data=EXCLUDED.data,math_tick=EXCLUDED.math_tick`,
    [zid, MATH_ENV, JSON.stringify(math)]
  );
  await pg.query("SET session_replication_role = origin");
  if (backend === "postgres") {
    await publish(pg, { zid, families: families(zid) });
  } else {
    for (const [family, items] of Object.entries(families(zid)))
      await putDynamo(family, items);
  }
  return { conversation: conversationId, report: reportId };
}

beforeAll(async () => {
  process.env.MATH_ENV = MATH_ENV;
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  await resetDynamo([
    "Delphi_CommentClustersLLMTopicNames",
    "Delphi_CommentHierarchicalClusterAssignments",
    "Delphi_CollectiveStatement",
    "Delphi_NarrativeReports",
  ]);
  pgQuery = (await import("../../src/db/pg-query")).default;
  const routes = await buildApp();
  app = await new Promise<Server>((resolve) => {
    const s = routes.listen(0, "127.0.0.1", () => resolve(s));
  });
}, 60000);
afterAll(async () => {
  await new Promise((resolve) => app?.close(resolve));
  await pg?.end();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe.each([
  ["postgres", 7101],
  ["dynamodb", 7102],
])("%s backend", (backend, zid) => {
  let ids: { conversation: string; report: string };
  const owner = `Bearer uid-${zid}`;
  const exportQuery = () => ({
    conversation_id: ids.conversation,
    report_id: ids.report,
    section: TOPIC,
  });
  const exportTopic = () =>
    request(app)
      .get("/api/v3/delphi/collective/inputs")
      .query(exportQuery())
      .set("Accept", "application/json")
      .set("User-Agent", "polis-cli/0.1.0")
      .set("Authorization", owner);
  const importFile = (body: any, token = owner) =>
    request(app)
      .post("/api/v3/delphi/collective/results")
      .set("Accept", "application/json")
      .set("User-Agent", "polis-cli/0.1.0")
      .set("Authorization", token)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(body));
  const versions = (query: any) =>
    request(app).get("/api/v3/delphi/collective/results").query(query);

  beforeAll(async () => {
    process.env.DELPHI_RESULT_BACKEND = backend;
    ids = await seed(zid, backend);
  }, 60000);
  beforeEach(() => {
    process.env.DELPHI_RESULT_BACKEND = backend;
  });

  test("export, import, retry and read back with the CLI's request shapes", async () => {
    const participation = [
      jest.spyOn(pgQuery, "queryP"),
      jest.spyOn(pgQuery, "queryP_readOnly"),
      jest.spyOn(pgQuery, "connect"),
      jest.spyOn(pgQuery, "query_readOnly"),
    ];
    const exported = await exportTopic();
    cliAccepts(exported, "export", ids);
    expect(exported.headers["cache-control"]).toBe("no-store");
    const manifest = exported.body;
    expect(manifest.sections[0]).toMatchObject({
      section: TOPIC,
      topic_name: "Generated library hours",
      citation_ids: [0, 1, 2, 3],
    });
    expect(
      manifest.sections[0].comments.map((c: any) => [
        c.comment_id,
        c.total_votes,
        typeof c.consensus,
      ])
    ).toEqual([
      [0, 0, "string"],
      [1, 0, "string"],
      [2, 0, "string"],
      [3, 0, "string"],
    ]);
    expect(manifest.math_tick).toBe("7");
    expect(manifest.result_schema.title).toBe(
      "External agent collective statement import v1"
    );
    expect(Object.keys(manifest.result_schema.properties)).toEqual(
      expect.arrayContaining(["model", "prompt_sha256", "runner"])
    );

    const body = authored(manifest, "generated-model-a");
    const imported = await importFile(body);
    cliAccepts(imported, "import", ids);
    const id = `${zid}#${TOPIC}#${manifest.export_id}`;
    expect(imported.body).toMatchObject({
      status: "success",
      id,
      imported: 1,
      deduplicated: false,
    });
    expect(imported.body.provenance).toMatchObject({
      provenance: "external agent",
      model: "generated-model-a",
      prompt_sha256: body.prompt_sha256,
      runner: "generated-runner",
      math_tick: "7",
      export_id: manifest.export_id,
      input_digest: manifest.input_digest,
    });
    const createdAt = imported.body.provenance.created_at;
    expect(new Date(createdAt).toISOString()).toBe(createdAt);

    const retry = await importFile(body);
    cliAccepts(retry, "import", ids);
    expect(retry.body).toMatchObject({
      id,
      deduplicated: true,
      provenance: { created_at: createdAt },
    });
    const conflicting = await importFile({
      ...body,
      model: "generated-model-b",
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe("IMPORT_CONFLICT");
    // Export and import touched no participation pool.
    for (const spy of participation) expect(spy).not.toHaveBeenCalled();

    // The topic page's reader (newest per topic) serves it with its provenance.
    const page = await request(app)
      .get("/api/v3/collectiveStatement")
      .query({ report_id: ids.report });
    expect(page.status).toBe(200);
    const shown = page.body.statements.filter(
      (s: any) => s.topic_key === TOPIC
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      zid_topic_jobid: id,
      provenance: "external agent",
      model: "generated-model-a",
      prompt_sha256: body.prompt_sha256,
      runner: "generated-runner",
      math_tick: "7",
      created_at: createdAt,
    });
    expect(shown[0].statement_data).toEqual(body.results[0].report_data);
    expect(JSON.stringify(page.body)).not.toContain("imported_by");
  }, 60000);

  test("every import is a version; all are stored and listed newest first", async () => {
    const first = await exportTopic();
    const a = await importFile(
      authored(
        first.body,
        "generated-model-c",
        "We back the first cited version."
      )
    );
    expect(a.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    const second = await exportTopic();
    expect(second.body.export_id).not.toBe(first.body.export_id);
    const b = await importFile(
      authored(
        second.body,
        "generated-model-d",
        "We back the second cited version."
      )
    );
    expect(b.status).toBe(200);

    const listed = await versions({ report_id: ids.report, section: TOPIC });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      status: "success",
      report_id: ids.report,
      section: TOPIC,
    });
    const models = listed.body.statements.map((s: any) => s.model);
    expect(models.slice(0, 2)).toEqual([
      "generated-model-d",
      "generated-model-c",
    ]);
    expect(listed.body.count).toBe(listed.body.statements.length);
    expect(listed.body.count).toBeGreaterThanOrEqual(3);
    const created = listed.body.statements.map((s: any) => s.created_at);
    expect([...created].sort().reverse()).toEqual(created);
    for (const s of listed.body.statements) {
      expect(s).toMatchObject({
        topic_key: TOPIC,
        provenance: "external agent",
        runner: "generated-runner",
        math_tick: "7",
      });
      expect(s.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof s.statement_data).toBe("object");
    }
    expect(JSON.stringify(listed.body)).not.toContain("imported_by");
    expect(JSON.stringify(listed.body)).not.toContain("external-import");
    // The topic page shows the newest.
    const page = await request(app)
      .get("/api/v3/collectiveStatement")
      .query({ report_id: ids.report });
    expect(
      page.body.statements.find((s: any) => s.topic_key === TOPIC).model
    ).toBe("generated-model-d");
    const all = await versions({ report_id: ids.report });
    expect(all.body.count).toBe(listed.body.count);
  }, 60000);

  test("refusals: who may submit, what is bounded, and never a 404", async () => {
    const anonymous = await request(app)
      .get("/api/v3/delphi/collective/inputs")
      .query(exportQuery());
    expect(anonymous.status).toBe(401);
    const stranger = await request(app)
      .get("/api/v3/delphi/collective/inputs")
      .query(exportQuery())
      .set("Authorization", `Bearer uid-${STRANGER}`);
    expect([stranger.status, stranger.body.code]).toEqual([
      403,
      "OWNER_REQUIRED",
    ]);
    const manifest = (await exportTopic()).body;
    const strangerImport = await importFile(
      authored(manifest, "generated-model-e"),
      `Bearer uid-${STRANGER}`
    );
    expect([strangerImport.status, strangerImport.body.code]).toEqual([
      403,
      "OWNER_REQUIRED",
    ]);

    const unknown = await request(app)
      .get("/api/v3/delphi/collective/inputs")
      .set("Authorization", owner)
      .query({ ...exportQuery(), section: `${JOB}#0#9` });
    expect([unknown.status, unknown.body.code]).toEqual([
      422,
      "TOPIC_NOT_FOUND",
    ]);
    const quiet = await request(app)
      .get("/api/v3/delphi/collective/inputs")
      .set("Authorization", owner)
      .query({ ...exportQuery(), section: OTHER_TOPIC });
    expect([quiet.status, quiet.body.code]).toEqual([
      409,
      "INSUFFICIENT_CONSENSUS",
    ]);
    const noReport = await versions({ report_id: "rgeneratedmissing" });
    expect([noReport.status, noReport.body.code]).toEqual([
      422,
      "REPORT_NOT_FOUND",
    ]);

    const wrongType = await request(app)
      .post("/api/v3/delphi/collective/results")
      .set("Authorization", owner)
      .set("Content-Type", "text/plain")
      .send("{}");
    expect(wrongType.status).toBe(415);
    const large = await importFile({
      ...authored(manifest, "generated-model-e"),
      padding: "x".repeat(1024 * 1024),
    });
    expect(large.status).toBe(413);
    const extra = await importFile({
      ...authored(manifest, "generated-model-e"),
      imported_by: 1,
    });
    expect([extra.status, extra.body.code]).toEqual([400, "INVALID_NARRATIVE"]);
    const badHash = await importFile({
      ...authored(manifest, "generated-model-e"),
      prompt_sha256: "not-a-hash",
    });
    expect(badHash.status).toBe(400);
    const outside = authored(manifest, "generated-model-e");
    outside.results[0].report_data.paragraphs[0].sentences[0].clauses[0].citations =
      [4];
    expect((await importFile(outside)).status).toBe(400);

    // A statement written against inputs that have since changed is refused.
    await pg.query(
      "UPDATE comments SET txt='Generated evidence 0, edited' WHERE zid=$1 AND tid=0",
      [zid]
    );
    try {
      const stale = await importFile(authored(manifest, "generated-model-e"));
      expect([stale.status, stale.body.code]).toEqual([
        409,
        "STALE_COLLECTIVE_INPUTS",
      ]);
    } finally {
      await pg.query(
        "UPDATE comments SET txt='Generated evidence 0' WHERE zid=$1 AND tid=0",
        [zid]
      );
    }
    const listed = await versions({ report_id: ids.report, section: TOPIC });
    expect(listed.body.statements.map((s: any) => s.model)).not.toContain(
      "generated-model-e"
    );
  }, 60000);
});

test("with the exchange pool exhausted, participation pools answer and the exchange refuses", async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  const { AGENT_EXCHANGE_POOL_MAX } = await import("../../src/db/pg-query");
  const held: PoolClient[] = [];
  for (let i = 0; i < AGENT_EXCHANGE_POOL_MAX; i++)
    held.push(await pgQuery.connectAgentExchange());
  try {
    const exported = request(app)
      .get("/api/v3/delphi/collective/inputs")
      .set("Authorization", "Bearer uid-7101")
      .query({
        conversation_id: "agentexchange7101",
        report_id: "ragentexchange7101",
        section: TOPIC,
      })
      .then((r) => r);
    // The participation pools are untouched: these answer while the export waits.
    const started = Date.now();
    await pgQuery.queryP("SELECT 1");
    await pgQuery.queryP_readOnly("SELECT 1");
    expect(Date.now() - started).toBeLessThan(2000);
    const refused = await exported;
    expect([refused.status, refused.body.code]).toEqual([
      503,
      "COLLECTIVE_STORAGE_UNAVAILABLE",
    ]);
  } finally {
    for (const client of held) client.release();
  }
  const after = await request(app)
    .get("/api/v3/delphi/collective/inputs")
    .set("Authorization", "Bearer uid-7101")
    .query({
      conversation_id: "agentexchange7101",
      report_id: "ragentexchange7101",
      section: TOPIC,
    });
  expect(after.status).toBe(200);
}, 60000);
