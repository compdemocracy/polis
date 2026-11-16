/** Narrative jobs (migration 000046) on a migrated database: the SQL
 * functions, the two routes `polis delphi narrative export` and `import` call
 * (polis-cli/crates/polis/src/narrative.rs), their refusals and rate limits,
 * publication as a pointer, immutability, and the participation pools staying
 * clear while the agent-exchange pool is exhausted. With POLIS_CLI_BIN set
 * (scripts/test-delphi-result-reads.sh sets it), the real CLI binary exports
 * and imports against these routes end to end.
 *
 * Authentication is a stand-in that assigns req.p.uid where hybridAuth does;
 * everything after it is the real handler chain. Generated data only. No vote
 * is written: the pack's counts are generated, as Delphi's narrative step
 * would have read them, and the checks read only those counts. */
import { createHash } from "crypto";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Server } from "http";
import { Client, PoolClient } from "pg";
import request from "supertest";
import { conversation, postgres, publish, ENV, SCOPE } from "./support";

const S = (s: string) => ({ S: s });
const N = (n: number) => ({ N: String(n) });
const MATH_ENV = "narrativejobs";
const LABEL = "00000000-0000-4000-8000-00000000e011";
// Each conversation's pack has its own id, which names its global sections.
const packOf = (zid: number) => `00000000-0000-4000-8000-0000000${String(zid).padStart(5, "0")}`;
const globalOf = (zid: number) => `${packOf(zid)}_global_groups`;
const CODE = "a".repeat(64);
const STRANGER = 7399;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const UNLIMITED = { account_per_day: 1000, conversation_per_day: 1000, unpublished_per_report: 1000 };

let pg: Client;
let pgQuery: typeof import("../../src/db/pg-query").default;
let app: Server;

async function buildApp() {
  const express = (await import("express")).default as any;
  const { collectiveBody } = await import("../../src/routes/delphi/collectiveBody");
  const jobs = await import("../../src/routes/delphi/narrativeJobs");
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
  a.get("/api/v3/delphi/narrative/inputs", moveToBody, auth, jobs.handle_GET_narrative_inputs);
  a.post("/api/v3/delphi/narrative/results", moveToBody, auth, jobs.handle_POST_narrative_results);
  return a;
}

const comment = (id: number, text: string, agrees: number) => ({
  id,
  text,
  votes: 20,
  agrees,
  disagrees: 20 - agrees - 2,
  passes: 2,
  groups: {
    "0": { votes: 10, agrees: Math.min(10, agrees), disagrees: 0, passes: 0 },
    "1": { votes: 10, agrees: Math.max(0, agrees - 10), disagrees: 0, passes: 2 },
  },
});
const TEXTS = [
  "Generated evidence 0 about longer library hours",
  "Generated evidence 1 about weekend opening",
  "Generated evidence 2 about quiet study rooms",
  "Generated evidence 3 about children's reading",
  "Generated evidence 4 about the bus route",
  "Generated evidence 5 about parking",
];
function section(name: string, kind: string, topicKey: string | null, topicName: string, ids: number[]) {
  const req = {
    system: "<generated-system/>",
    messages: [{ role: "user", content: `Generated prompt for ${name}` }],
    max_tokens: 8000,
  };
  const comments = ids.map((id) => comment(id, TEXTS[id], 15));
  return {
    section: name,
    kind,
    topic_key: topicKey,
    topic_name: topicName,
    request: req,
    prompt_sha256: sha256(`${req.system}\0${req.messages[0].content}`),
    comments_xml: `<polis-comments>${ids.map((id) => `<comment id="${id}"/>`).join("")}</polis-comments>`,
    comments_csv: `comment_id,comment_text\n${ids.map((id) => `${id},${TEXTS[id]}`).join("\n")}\n`,
    citation_ids: ids,
    comments,
  };
}
const TOPIC_SECTION = `${LABEL}_0_1`;

async function sourceState(zid: number) {
  return (await pg.query("SELECT public.pd_narrative_source_state($1,$2) AS v", [zid, MATH_ENV])).rows[0].v;
}
async function putPack(zid: number, report: string, packId = packOf(zid)) {
  const pack = {
    schema: "polis-narrative-pack/1",
    pack_id: packId,
    zid: String(zid),
    report_id: report,
    prompt_version: "narrative/1",
    prompt_files_sha256: "b".repeat(64),
    code_version: CODE,
    inputs: await sourceState(zid),
    clustering: { labels: [LABEL] },
    settings: { include_moderation: true },
    model_called: false,
    sections: [
      section(TOPIC_SECTION, "topic", `${LABEL}#0#1`, "Generated library hours", [0, 1, 2, 3]),
      section(`${packId}_global_groups`, "global", null, "groups", [4, 5]),
    ],
  };
  return (await pg.query("SELECT public.pd_narrative_pack_put($1,$2,$3,$4::jsonb,$5) AS v", [
    ENV,
    zid,
    report,
    JSON.stringify(pack),
    CODE,
  ])).rows[0].v;
}

async function seed(zid: number, opts: { pack?: boolean } = {}) {
  const conversationId = `narrativejobs${zid}`;
  const reportId = `rnarrativejobs${zid}`;
  await conversation(pg, zid, [reportId]);
  await pg.query("INSERT INTO users(uid,hname,email) VALUES($1,'generated stranger',$2) ON CONFLICT(uid) DO NOTHING", [
    STRANGER,
    `generated-${STRANGER}@example.invalid`,
  ]);
  await pg.query("INSERT INTO zinvites(zid,zinvite) VALUES($1,$2) ON CONFLICT DO NOTHING", [zid, conversationId]);
  await pg.query("SET session_replication_role = replica");
  for (const [tid, txt] of TEXTS.entries()) {
    await pg.query(
      `INSERT INTO comments(zid,tid,pid,uid,txt,mod,active) VALUES($1,$2,0,$1,$3,0,true)
      ON CONFLICT(zid,tid) DO UPDATE SET txt=EXCLUDED.txt`,
      [zid, tid, txt]
    );
  }
  await pg.query(
    `INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,math_tick) VALUES($1,$2,'{}',0,7)
    ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=EXCLUDED.math_tick`,
    [zid, MATH_ENV]
  );
  await pg.query("SET session_replication_role = origin");
  await publish(pg, {
    zid,
    families: {
      Delphi_CommentClustersLLMTopicNames: [
        {
          conversation_id: S(String(zid)),
          topic_key: S(`${LABEL}#0#1`),
          layer_id: N(0),
          cluster_id: N(1),
          topic_name: S("Generated library hours"),
          job_id: S(LABEL),
        },
      ],
    },
  });
  if (opts.pack !== false) await putPack(zid, reportId);
  return { conversation: conversationId, report: reportId, owner: `Bearer uid-${zid}` };
}

/** A writer's results for an export, as an outside agent would write them. */
function authored(manifest: any, model: string, text = "People want longer library hours.") {
  return {
    schema_version: manifest.schema_version,
    conversation_id: manifest.conversation_id,
    report_id: manifest.report_id,
    export_id: manifest.export_id,
    input_digest: manifest.input_digest,
    section: manifest.section,
    model,
    prompt_sha256: manifest.prompt_sha256,
    runner: "generated-runner",
    results: manifest.sections.map((s: any) => ({
      section: s.section,
      report_data: {
        id: "topic_overview_and_consensus",
        title: "Overview",
        paragraphs: [
          {
            id: "topic_overview",
            title: "Overview of Topic",
            sentences: [
              {
                clauses: [
                  { text, citations: [s.citation_ids[0]] },
                  { text: "Most of every group agreed.", citations: s.citation_ids.slice(1, 2) },
                ],
              },
            ],
          },
        ],
      },
    })),
  };
}

beforeAll(async () => {
  process.env.MATH_ENV = MATH_ENV;
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.NARRATIVE_JOBS_ENABLED = "true";
  pg = await postgres();
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
  process.env.NARRATIVE_JOBS_ENABLED = "true";
});

const exportFor = (ids: any, query: any = {}) =>
  request(app)
    .get("/api/v3/delphi/narrative/inputs")
    .query({ conversation_id: ids.conversation, report_id: ids.report, ...query })
    .set("Accept", "application/json")
    .set("User-Agent", "polis-cli/0.1.0")
    .set("Authorization", ids.owner);
const importFor = (ids: any, body: any, token = ids.owner, agent = "polis-cli/0.1.0") =>
  request(app)
    .post("/api/v3/delphi/narrative/results")
    .set("Accept", "application/json")
    .set("User-Agent", agent)
    .set("Authorization", token)
    .set("Content-Type", "application/json")
    .send(JSON.stringify(body));
const jobRows = async (job: string) =>
  Number(
    (
      await pg.query(
        `SELECT count(*) FROM delphi_result_rows r JOIN delphi_result_batches b USING(env,batch_id)
         WHERE b.env=$1 AND b.job_id=$2`,
        [ENV, job]
      )
    ).rows[0].count
  );

test("the comment set digest is the run record's (census) digest", async () => {
  const zid = 7390;
  await conversation(pg, zid, []);
  await pg.query("SET session_replication_role = replica");
  for (const [tid, mod, active] of [
    [0, 0, true],
    [1, 0, true],
    [2, 1, false],
  ] as const)
    await pg.query("INSERT INTO comments(zid,tid,pid,uid,txt,mod,active) VALUES($1,$2,0,$1,$3,$4,$5)", [
      zid,
      tid,
      `Generated evidence ${tid}`,
      mod,
      active,
    ]);
  await pg.query("SET session_replication_role = origin");
  // delphi/tests/test_narrative_pack.py pins census.comment_set_sha256 of the
  // same three comments to this value.
  expect((await sourceState(zid)).comment_set_sha256).toBe(
    "7dec5fc5677bfd39ec3e23c103db022a8cc9eb3e01e8d46b3b9cb6d6d7c6f5fb"
  );
  expect(await sourceState(zid)).toMatchObject({ math_env: MATH_ENV, math_tick: null, vote_hwm: null });
});

describe("the routes", () => {
  let ids: any;
  const zid = 7301;
  beforeAll(async () => {
    ids = await seed(zid);
  }, 60000);

  test("switched off, both routes answer 404 (the CLI reads it as not served)", async () => {
    process.env.NARRATIVE_JOBS_ENABLED = "";
    expect((await exportFor(ids)).status).toBe(404);
    expect((await importFor(ids, {})).status).toBe(404);
    const plain = await request(app)
      .post("/api/v3/delphi/narrative/results")
      .set("Authorization", ids.owner)
      .set("Content-Type", "text/plain")
      .send("{}");
    expect(plain.status).toBe(404);
  });

  test("export, import, retry: one job per narrative, holding only its rows, published by nobody", async () => {
    const participation = [
      jest.spyOn(pgQuery, "queryP"),
      jest.spyOn(pgQuery, "queryP_readOnly"),
      jest.spyOn(pgQuery, "connect"),
      jest.spyOn(pgQuery, "query_readOnly"),
      jest.spyOn(pgQuery, "withTransaction"),
    ];
    const servedBefore = (await pg.query("SELECT count(*) FROM delphi_graph_served WHERE zid=$1", [zid])).rows[0].count;
    const exported = await exportFor(ids);
    expect(exported.status).toBe(200);
    expect(exported.headers["cache-control"]).toBe("no-store");
    const manifest = exported.body;
    // What the CLI checks before writing any file (narrative.rs).
    expect(manifest.conversation_id).toBe(ids.conversation);
    expect(manifest.report_id).toBe(ids.report);
    expect(typeof manifest.result_schema).toBe("object");
    expect(manifest.sections.length).toBe(2);
    for (const s of manifest.sections) {
      expect(typeof s.request.system).toBe("string");
      expect(typeof s.request.messages[0].content).toBe("string");
      expect(typeof s.comments_xml).toBe("string");
      expect(typeof s.comments_csv).toBe("string");
      expect(s.comments).toBeUndefined();
    }
    expect(manifest.export_id).toMatch(/^external_/);
    expect(manifest.input_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest).toMatchObject({ prompt_version: "narrative/1", pack_id: packOf(zid), inputs: { math_tick: 7 } });
    expect(manifest.model_label).toBe("as stated by its runner, not verified by Polis");

    const body = authored(manifest, "generated-model-a");
    const imported = await importFor(ids, body);
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({
      status: "success",
      imported: 2,
      deduplicated: false,
      published: false,
      provenance: {
        model: "generated-model-a",
        model_known: "declared",
        model_label: "generated-model-a, as stated by its runner, not verified by Polis",
        runner: "generated-runner",
        channel: "cli",
        prompt_version: "narrative/1",
        export_id: manifest.export_id,
      },
    });
    const job = imported.body.job_id;
    expect(job).toMatch(/^[0-9a-f-]{36}$/);
    // One job, its own two rows, no served pointer moved.
    expect(await jobRows(job)).toBe(2);
    const servedAfter = (await pg.query("SELECT count(*) FROM delphi_graph_served WHERE zid=$1", [zid])).rows[0].count;
    expect(servedAfter).toBe(servedBefore);
    const dj = (await pg.query("SELECT kind,status,report_id,origin FROM delphi_jobs WHERE env=$1 AND job_id=$2", [ENV, job]))
      .rows[0];
    expect(dj).toEqual({ kind: "narrative", status: "succeeded", report_id: ids.report, origin: "queued" });
    // The run record names the declared model and the pack's inputs.
    const record = (await pg.query("SELECT public.pd_run_record($1,$2) AS v", [ENV, job])).rows[0].v;
    expect(record.manifest.models).toEqual({ embed: null, topic: null, narrative: "generated-model-a" });
    expect(record.manifest.inputs).toMatchObject({ math_env: MATH_ENV, math_tick: 7 });
    expect(record.families.map((f: any) => [f.family, f.row_count, f.job_id])).toEqual([
      ["Delphi_NarrativeReports", 2, job],
    ]);
    // The stored provenance never carries the importing account.
    const listed = (await pg.query("SELECT public.pd_narrative_jobs_list($1,$2) AS v", [ENV, ids.report])).rows[0].v;
    expect(listed[0]).toMatchObject({ job_id: job, model: "generated-model-a", published: false, channel: "cli" });
    expect(JSON.stringify(listed)).not.toContain("submitted_by");

    const retry = await importFor(ids, body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ job_id: job, deduplicated: true });
    const conflicting = await importFor(ids, { ...body, model: "generated-model-b" });
    expect([conflicting.status, conflicting.body.code]).toEqual([409, "IMPORT_CONFLICT"]);
    for (const spy of participation) expect(spy).not.toHaveBeenCalled();
  }, 60000);

  test("checks are recorded with the job and never refuse", async () => {
    const manifest = (await exportFor(ids)).body;
    const body = authored(manifest, "generated-model-checks");
    const topic = body.results.find((r: any) => r.section === TOPIC_SECTION);
    topic.report_data.paragraphs[0].sentences[0].clauses = [
      // A true quotation of comment 0, and a share it matches (15 of 20 = 75%).
      { text: 'Participants wrote "longer library hours" and 75% agreed.', citations: [0] },
      // An invented quotation, a share nothing matches, a citation outside the section.
      { text: 'Some said "close every library tomorrow" and 12 of 13 agreed.', citations: [1, 4] },
      { text: "An uncited claim; see comment 3.", citations: [] },
    ];
    const imported = await importFor(ids, body);
    expect(imported.status).toBe(200);
    const read = (await pg.query("SELECT public.pd_narrative_job_read($1,$2) AS v", [ENV, imported.body.job_id])).rows[0].v;
    const checks = read.checks.sections[TOPIC_SECTION];
    expect(checks).toMatchObject({
      clauses: 3,
      clauses_cited: { passed: 2, total: 3 },
      citations_exist: { passed: 3, total: 3, unknown: [] },
      quoted_text_found: { passed: 1, total: 2, not_found: ["close every library tomorrow"] },
      quoted_shares_match: { passed: 1, total: 2, unmatched: ["12 of 13"] },
      rules: { percentages: 1, comment_numbers: 1, links_or_contacts: 0 },
      grounded: false,
    });
    // Comment 4 exists in the pack but in another section.
    expect(checks.citations_in_section).toMatchObject({ passed: 2, total: 3, outside: [4] });
    expect(read.checks.sections[globalOf(zid)].grounded).toBe(true);
    expect(read.checks.prompt_sha256_matches_export).toBe(true);
    expect(read.rows).toHaveLength(2);
  }, 60000);

  test("refusals: who may import, what is bounded, freshness, and never a 404", async () => {
    const anonymous = await request(app)
      .get("/api/v3/delphi/narrative/inputs")
      .query({ conversation_id: ids.conversation, report_id: ids.report });
    expect([anonymous.status, anonymous.body.code]).toEqual([401, "AUTH_REQUIRED"]);
    const stranger = await exportFor({ ...ids, owner: `Bearer uid-${STRANGER}` });
    expect([stranger.status, stranger.body.code]).toEqual([403, "OWNER_REQUIRED"]);
    const manifest = (await exportFor(ids)).body;
    const strangerImport = await importFor(ids, authored(manifest, "generated-model-e"), `Bearer uid-${STRANGER}`);
    expect([strangerImport.status, strangerImport.body.code]).toEqual([403, "OWNER_REQUIRED"]);
    const unknown = await exportFor(ids, { section: `${LABEL}_0_9` });
    expect([unknown.status, unknown.body.code]).toEqual([422, "SECTION_NOT_FOUND"]);
    const one = await exportFor(ids, { section: TOPIC_SECTION });
    expect(one.status).toBe(200);
    expect(one.body.sections.map((s: any) => s.section)).toEqual([TOPIC_SECTION]);

    const wrongType = await request(app)
      .post("/api/v3/delphi/narrative/results")
      .set("Authorization", ids.owner)
      .set("Content-Type", "text/plain")
      .send("{}");
    expect([wrongType.status, wrongType.body.code]).toEqual([415, "INVALID_NARRATIVE"]);
    const large = await importFor(ids, { ...authored(manifest, "generated-model-e"), padding: "x".repeat(1024 * 1024) });
    expect(large.status).toBe(413);
    const extra = await importFor(ids, { ...authored(manifest, "generated-model-e"), submitted_by: 1 });
    expect([extra.status, extra.body.code]).toEqual([400, "INVALID_NARRATIVE"]);
    const badModel = await importFor(ids, { ...authored(manifest, "generated-model-e"), model: "<script>" });
    expect(badModel.status).toBe(400);
    const partial = authored(manifest, "generated-model-e");
    partial.results = partial.results.slice(0, 1);
    expect((await importFor(ids, partial)).status).toBe(400);
    const twice = authored(manifest, "generated-model-e");
    twice.results[1].section = twice.results[0].section;
    expect((await importFor(ids, twice)).status).toBe(400);
    const section250 = authored(manifest, "generated-model-e");
    section250.results[0].report_data.paragraphs = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      title: "t",
      sentences: Array.from({ length: 4 }, () => ({ clauses: [{ text: "y".repeat(3200), citations: [] }] })),
    }));
    const sectionRefused = await importFor(ids, section250);
    expect([sectionRefused.status, sectionRefused.body.message]).toEqual([400, "Section exceeds 250 KB"]);
    const noChannel = await importFor(ids, authored(manifest, "generated-model-e"), ids.owner, "generated-agent/1");
    expect([noChannel.status, noChannel.body.message]).toEqual([400, "channel is required (cli, mcp or browser)"]);
    const mcp = await importFor(
      ids,
      { ...authored(manifest, "generated-model-mcp"), channel: "mcp" },
      ids.owner,
      "generated-agent/1"
    );
    expect([mcp.status, mcp.body.provenance?.channel]).toEqual([200, "mcp"]);
    const retargeted = { ...authored(manifest, "generated-model-e"), input_digest: "0".repeat(64) };
    expect((await importFor(ids, retargeted)).body.code).toBe("STALE_NARRATIVE_INPUTS");

    // A report with no prompt pack: 409, not 404.
    const bare = await seed(7302, { pack: false });
    const missing = await exportFor(bare);
    expect([missing.status, missing.body.code]).toEqual([409, "NARRATIVE_PACK_MISSING"]);

    // The conversation changed after the pack was built: stale both ways.
    await pg.query("UPDATE comments SET txt='Generated evidence 0, edited' WHERE zid=$1 AND tid=0", [zid]);
    try {
      const staleExport = await exportFor(ids);
      expect([staleExport.status, staleExport.body.code]).toEqual([409, "NARRATIVE_PACK_STALE"]);
      expect(staleExport.body.moved).toEqual(["comment_set_sha256"]);
      const staleImport = await importFor(ids, authored(manifest, "generated-model-e"));
      expect([staleImport.status, staleImport.body.code]).toEqual([409, "STALE_NARRATIVE_INPUTS"]);
    } finally {
      await pg.query("UPDATE comments SET txt=$2 WHERE zid=$1 AND tid=0", [zid, TEXTS[0]]);
    }
    const listed = (await pg.query("SELECT public.pd_narrative_jobs_list($1,$2) AS v", [ENV, ids.report])).rows[0].v;
    expect(listed.map((j: any) => j.model)).not.toContain("generated-model-e");
  }, 60000);
});

test("the checks of a body at the import's bounds are bounded work on the event loop", async () => {
  const { checkNarrative, MAX_QUOTES_PER_SECTION, MAX_SHARES_PER_SECTION, MAX_EXAMPLES } = await import(
    "../../src/routes/delphi/narrativeChecks"
  );
  // Four sections of a hundred comments; each about 240 KB of uncited clauses
  // of 4,000 characters, so every quotation leans on every comment shown.
  const text = "Generated comment text about library opening hours and the bus route, ".repeat(5);
  const sections = Array.from({ length: 4 }, (_, s) => ({
    section: `s${s}`,
    citation_ids: Array.from({ length: 100 }, (_, i) => s * 1000 + i),
    comments: Array.from({ length: 100 }, (_, i) => ({ ...comment(s * 1000 + i, text, 10), text: `${text}${i}` })),
  }));
  const body = (unit: string) =>
    sections.map((s) => ({
      section: s.section,
      report_data: {
        paragraphs: Array.from({ length: 2 }, () => ({
          sentences: [{ clauses: Array.from({ length: 30 }, () => ({ text: unit.repeat(Math.floor(3900 / unit.length)), citations: [] })) }],
        })),
      },
    }));
  const { checkSection } = await import("../../src/routes/delphi/narrativeChecks");
  const contacts = checkSection(
    { paragraphs: [{ sentences: [{ clauses: [{ text: "Write to jane.doe@example.org, see https://example.org/x or call +1 555 123 4567.", citations: [] }] }] }] },
    { section: "s", citation_ids: [], comments: [] },
    new Map()
  );
  expect(contacts.rules.links_or_contacts).toBe(3);
  for (const unit of ['"a b c"', "1% ", "a.a."]) {
    const started = Date.now();
    const checks = checkNarrative(body(unit), sections as any, sections as any);
    // Unbounded, the quotations took about 17 s on a 14-core work box.
    expect(Date.now() - started).toBeLessThan(2000);
    for (const c of Object.values(checks.sections)) {
      expect(c.quoted_text_found.total).toBeLessThanOrEqual(MAX_QUOTES_PER_SECTION);
      expect(c.quoted_shares_match.total).toBeLessThanOrEqual(MAX_SHARES_PER_SECTION);
      expect(c.quoted_text_found.not_found.length).toBeLessThanOrEqual(MAX_EXAMPLES);
      expect(c.quoted_shares_match.unmatched.length).toBeLessThanOrEqual(MAX_EXAMPLES);
      if (unit !== "a.a.") {
        expect(c.quoted_text_found.unchecked + c.quoted_shares_match.unchecked).toBeGreaterThan(0);
        expect(c.grounded).toBe(false);
      }
    }
  }
});

test("two imports at once at the conversation limit: one is stored, one refused", async () => {
  const ids = await seed(7312);
  for (let i = 0; i < 9; i++) {
    const manifest = (await exportFor(ids)).body;
    expect((await importFor(ids, authored(manifest, `generated-model-${i}`))).status).toBe(200);
  }
  const [a, b] = [(await exportFor(ids)).body, (await exportFor(ids)).body];
  const replies = await Promise.all([
    importFor(ids, authored(a, "generated-model-a")),
    importFor(ids, authored(b, "generated-model-b")),
  ]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 429]);
  const stored = (await pg.query("SELECT count(*) FROM delphi_narrative_jobs WHERE env=$1 AND zid=$2", [ENV, 7312])).rows[0].count;
  expect(stored).toBe("10");
}, 120000);

test("rate limits: ten jobs a conversation a day through the routes", async () => {
  const ids = await seed(7311);
  for (let i = 0; i < 10; i++) {
    const manifest = (await exportFor(ids)).body;
    const r = await importFor(ids, authored(manifest, `generated-model-${i}`));
    expect(r.status).toBe(200);
  }
  const manifest = (await exportFor(ids)).body;
  const refused = await importFor(ids, authored(manifest, "generated-model-10"));
  expect(refused.status).toBe(429);
  expect(refused.body).toMatchObject({ code: "RATE_LIMITED", limit: "conversation_per_day", max: 10 });
  expect(new Date(refused.body.reset_at).getTime()).toBeGreaterThan(Date.now());
}, 120000);

describe("the SQL functions", () => {
  const zid = 7321;
  let report: string;
  let pack: any;
  const submit = async (opts: {
    kind?: string;
    model: string;
    uid?: number;
    limits?: any;
    export_id?: string;
    items?: any[];
    client?: Client;
  }) => {
    const job = (await pg.query("SELECT gen_random_uuid() AS v")).rows[0].v;
    const run = (await pg.query("SELECT gen_random_uuid() AS v")).rows[0].v;
    const kind = opts.kind ?? "narrative";
    const items =
      opts.items ??
      (kind === "narrative"
        ? [TOPIC_SECTION, globalOf(zid)].map((section) => ({
            rid_section_model: S(`${report}#${section}#${opts.model}`),
            timestamp: S("2026-11-15T00:00:00.000Z"),
            report_id: S(report),
            section: S(section),
            model: S(opts.model),
            report_data: S(JSON.stringify({ id: "x", title: opts.model, paragraphs: [] })),
            job_id: S(job),
          }))
        : [
            {
              conversation_id: S(String(zid)),
              topic_key: S(`${LABEL}#0#1`),
              layer_id: N(0),
              cluster_id: N(1),
              topic_name: S(`Named by ${opts.model}`),
              job_id: S(job),
            },
          ]);
    const sub = {
      kind,
      channel: "cli",
      model: opts.model,
      model_known: "declared",
      runner: "generated-runner",
      prompt_version: "narrative/1",
      pack_id: pack.pack_id,
      pack_sha256: pack.pack_sha256,
      export_id: opts.export_id ?? `external_${job}`,
      input_digest: sha256(`input ${opts.model}`),
      result_sha256: sha256(`result ${opts.model}`),
      inputs: { math_env: MATH_ENV, math_tick: 7 },
      clustering: { labels: [LABEL] },
      checks: { sections: { [TOPIC_SECTION]: { grounded: opts.model.length % 2 === 0 } } },
      submitted_by: opts.uid ?? zid,
    };
    const reply = (
      await (opts.client ?? pg).query("SELECT public.pd_narrative_job_submit($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) AS v", [
        ENV,
        report,
        job,
        run,
        JSON.stringify(sub),
        JSON.stringify(items),
        JSON.stringify(opts.limits ?? UNLIMITED),
        CODE,
      ])
    ).rows[0].v;
    return { job, reply };
  };
  beforeAll(async () => {
    report = (await seed(zid, { pack: false })).report;
    pack = await putPack(zid, report);
  }, 60000);

  test("a pack is stored once per content; a mismatched pack is refused", async () => {
    expect(pack.outcome).toBe("stored");
    expect(await putPack(zid, report)).toMatchObject({ outcome: "existing", pack_id: packOf(zid) });
    await expect(putPack(7301, report, "00000000-0000-4000-8000-00000000e0a9")).rejects.toThrow(/invalid narrative pack|report conversation mismatch/);
    const current = (await pg.query("SELECT public.pd_narrative_pack_current($1,$2) AS v", [ENV, report])).rows[0].v;
    expect(current).toMatchObject({ pack_id: packOf(zid), prompt_version: "narrative/1", zid });
  });

  test("two models on the same inputs: two jobs, compared side by side; publication moves a pointer", async () => {
    const a = await submit({ model: "generated-opus" });
    const b = await submit({ model: "generated-fable" });
    expect(a.reply.outcome).toBe("created");
    expect(b.reply.outcome).toBe("created");
    expect(a.job).not.toBe(b.job);
    expect(await jobRows(a.job)).toBe(2);
    expect(await jobRows(b.job)).toBe(2);
    const compared = (await pg.query("SELECT public.pd_narrative_compare($1,$2,$3) AS v", [ENV, a.job, b.job])).rows[0].v;
    expect(compared).toMatchObject({
      same_report: true,
      same_kind: true,
      same_prompts: true,
      same_inputs: true,
      a_model: "generated-opus",
      b_model: "generated-fable",
    });
    expect(compared.sections).toEqual([
      { section: TOPIC_SECTION, a: { grounded: true }, b: { grounded: false } },
    ]);

    const first = (await pg.query("SELECT public.pd_narrative_publish($1,$2,$3,$4) AS v", [ENV, report, a.job, zid])).rows[0].v;
    expect(first).toMatchObject({ outcome: "published", generation: 1, scope: `narrative:${report}`, previous_job_id: null });
    const second = (await pg.query("SELECT public.pd_narrative_publish($1,$2,$3,$4) AS v", [ENV, report, b.job, zid])).rows[0].v;
    expect(second).toMatchObject({ outcome: "published", generation: 2, previous_job_id: a.job });
    const again = (await pg.query("SELECT public.pd_narrative_publish($1,$2,$3,$4) AS v", [ENV, report, b.job, zid])).rows[0].v;
    expect(again).toMatchObject({ outcome: "unchanged", generation: 2 });
    const pointer = (await pg.query("SELECT job_id,published_generation FROM delphi_current WHERE env=$1 AND zid=$2 AND scope=$3", [
      ENV,
      zid,
      `narrative:${report}`,
    ])).rows;
    expect(pointer).toEqual([{ job_id: b.job, published_generation: "2" }]);
    const moves = (await pg.query("SELECT generation,job_id,moved_by FROM delphi_narrative_publications WHERE env=$1 AND zid=$2 ORDER BY generation", [
      ENV,
      zid,
    ])).rows;
    expect(moves).toEqual([
      { generation: "1", job_id: a.job, moved_by: zid },
      { generation: "2", job_id: b.job, moved_by: zid },
    ]);
    // Nothing was overwritten: both jobs keep their rows.
    expect(await jobRows(a.job)).toBe(2);
    const listed = (await pg.query("SELECT public.pd_narrative_jobs_list($1,$2) AS v", [ENV, report])).rows[0].v;
    expect(listed.filter((j: any) => j.published).map((j: any) => j.job_id)).toEqual([b.job]);
  });

  test("a topic-name job is its own job too, of kind topic_name", async () => {
    const t = await submit({ kind: "topic_name", model: "generated-namer" });
    expect(t.reply.outcome).toBe("created");
    const dj = (await pg.query("SELECT kind,status FROM delphi_jobs WHERE env=$1 AND job_id=$2", [ENV, t.job])).rows[0];
    expect(dj).toEqual({ kind: "topic_name", status: "succeeded" });
    const record = (await pg.query("SELECT public.pd_run_record($1,$2) AS v", [ENV, t.job])).rows[0].v;
    expect(record.manifest.models).toEqual({ embed: null, topic: "generated-namer", narrative: null });
    expect(record.families.map((f: any) => f.family)).toEqual(["Delphi_CommentClustersLLMTopicNames"]);
    const published = (await pg.query("SELECT public.pd_narrative_publish($1,$2,$3,$4) AS v", [ENV, report, t.job, zid])).rows[0].v;
    expect(published.scope).toBe(`narrative:${report}:topic_names`);
    // The served topic names are untouched.
    const served = (await pg.query(
      "SELECT item->'topic_name'->>'S' AS name FROM delphi_result_current_rows WHERE env=$1 AND zid=$2 AND family='Delphi_CommentClustersLLMTopicNames'",
      [ENV, zid]
    )).rows;
    expect(served).toEqual([{ name: "Generated library hours" }]);
  });

  test("rate limits by account and unpublished candidates; the same export is idempotent", async () => {
    const limited = await submit({ model: "generated-limited", uid: 9001, limits: { ...UNLIMITED, account_per_day: 0 } });
    expect(limited.reply).toMatchObject({ outcome: "rate_limited", limit: "account_per_day", max: 0 });
    const capped = await submit({ model: "generated-capped", limits: { ...UNLIMITED, unpublished_per_report: 1 } });
    expect(capped.reply).toMatchObject({ outcome: "rate_limited", limit: "unpublished_per_report", max: 1 });
    const once = await submit({ model: "generated-once", export_id: "external_generated-once" });
    expect(once.reply.outcome).toBe("created");
    const dup = await submit({ model: "generated-once", export_id: "external_generated-once" });
    expect(dup.reply).toMatchObject({ outcome: "existing", job_id: once.job });
    const other = await submit({ model: "generated-other", export_id: "external_generated-once" });
    expect(other.reply).toMatchObject({ outcome: "conflict", job_id: once.job });
    // A refused or deduplicated submission leaves no job behind.
    for (const j of [limited.job, capped.job, dup.job, other.job])
      expect((await pg.query("SELECT count(*) FROM delphi_jobs WHERE env=$1 AND job_id=$2", [ENV, j])).rows[0].count).toBe("0");
  });

  test("submissions from two accounts wait on the conversation's lock, so its limit holds under concurrency", async () => {
    const today = Number(
      (
        await pg.query(
          "SELECT count(*) FROM delphi_narrative_jobs WHERE env=$1 AND zid=$2 AND submitted_by IS NOT NULL AND created_at>clock_timestamp()-interval '24 hours'",
          [ENV, zid]
        )
      ).rows[0].count
    );
    const limits = { ...UNLIMITED, conversation_per_day: today + 1 };
    const [holder, a, b] = [await postgres(), await postgres(), await postgres()];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:narrative-jobs',$1::text,$2::integer)::text,0))", [
        ENV,
        zid,
      ]);
      let settled = 0;
      const pending = [
        submit({ model: "generated-race-a", uid: 9101, limits, client: a }),
        submit({ model: "generated-race-b", uid: 9102, limits, client: b }),
      ].map((p) => p.finally(() => settled++));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(0);
      await holder.query("COMMIT");
      const outcomes = (await Promise.all(pending)).map((r) => r.reply.outcome).sort();
      expect(outcomes).toEqual(["created", "rate_limited"]);
    } finally {
      for (const c of [holder, a, b]) await c.end();
    }
  });

  test("rows bound to another report or job are refused, and nothing is stored", async () => {
    const before = (await pg.query("SELECT count(*) FROM delphi_narrative_jobs")).rows[0].count;
    await expect(
      submit({
        model: "generated-wrong",
        items: [{ rid_section_model: S(`rother#${TOPIC_SECTION}#m`), timestamp: S("t"), report_id: S("rother"), job_id: S("x") }],
      })
    ).rejects.toThrow(/narrative job row binding/);
    expect((await pg.query("SELECT count(*) FROM delphi_narrative_jobs")).rows[0].count).toBe(before);
  });

  test("immutability holds for jobs, rows, packs and publications", async () => {
    const { job } = await submit({ model: "generated-immutable" });
    for (const sql of [
      ["UPDATE delphi_narrative_jobs SET model='changed' WHERE env=$1 AND job_id=$2", [ENV, job]],
      ["DELETE FROM delphi_narrative_jobs WHERE env=$1 AND job_id=$2", [ENV, job]],
      ["DELETE FROM delphi_result_rows WHERE env=$1 AND batch_id IN (SELECT batch_id FROM delphi_result_batches WHERE env=$1 AND job_id=$2)", [ENV, job]],
      ["UPDATE delphi_narrative_packs SET prompt_version='narrative/9' WHERE env=$1 AND pack_id=$2", [ENV, packOf(zid)]],
      ["DELETE FROM delphi_narrative_publications WHERE env=$1 AND zid=$2", [ENV, zid]],
    ] as const)
      await expect(pg.query(sql[0], sql[1] as any)).rejects.toThrow(/immutable/);
  });
});

test("with the exchange pool exhausted, participation pools answer and the narrative routes refuse", async () => {
  const ids = await seed(7331);
  const { AGENT_EXCHANGE_POOL_MAX } = await import("../../src/db/pg-query");
  const held: PoolClient[] = [];
  for (let i = 0; i < AGENT_EXCHANGE_POOL_MAX; i++) held.push(await pgQuery.connectAgentExchange());
  try {
    const exported = exportFor(ids).then((r) => r);
    const started = Date.now();
    await pgQuery.queryP("SELECT 1");
    await pgQuery.queryP_readOnly("SELECT 1");
    expect(Date.now() - started).toBeLessThan(2000);
    const refused = await exported;
    expect([refused.status, refused.body.code]).toEqual([503, "NARRATIVE_STORAGE_UNAVAILABLE"]);
  } finally {
    for (const client of held) client.release();
  }
  expect((await exportFor(ids)).status).toBe(200);
}, 60000);

const cli = process.env.POLIS_CLI_BIN;
(cli ? test : test.skip)("the CLI's export and import, end to end against these routes", async () => {
  const ids = await seed(7341);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-cli-"));
  try {
    const { port } = app.address() as any;
    fs.writeFileSync(
      path.join(dir, "profiles.json"),
      JSON.stringify({ default: "local", sites: { local: `http://127.0.0.1:${port}` } })
    );
    // Asynchronous: the routes answer from this same process.
    const run = (args: string[]) =>
      new Promise<any>((resolve, reject) =>
        execFile(
          cli as string,
          [...args, "--json", "--no-interactive"],
          {
            env: { PATH: process.env.PATH, HOME: dir, POLIS_CONFIG_DIR: dir, POLIS_SITE: "local", POLIS_TOKEN_LOCAL: "uid-7341" },
            encoding: "utf8",
          },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(JSON.parse(stdout))
        )
      );
    const exportDir = path.join(dir, "export");
    const exported = await run(["delphi", "narrative", "export", ids.conversation, "--report", ids.report, "--output", exportDir]);
    expect(JSON.stringify(exported)).toContain('"model_called":false');
    const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
    expect(fs.readFileSync(path.join(exportDir, "sections", "000", "prompt.txt"), "utf8")).toBe(
      manifest.sections[0].request.messages[0].content
    );
    const file = path.join(dir, "results.json");
    fs.writeFileSync(file, JSON.stringify(authored(manifest, "generated-cli-model")));
    const imported = await run(["delphi", "narrative", "import", ids.conversation, file, "--report", ids.report]);
    const text = JSON.stringify(imported);
    expect(text).toContain('"deduplicated":false');
    expect(text).toContain('"channel":"cli"');
    const listed = (await pg.query("SELECT public.pd_narrative_jobs_list($1,$2) AS v", [ENV, ids.report])).rows[0].v;
    expect(listed.map((j: any) => [j.model, j.channel, j.published])).toEqual([["generated-cli-model", "cli", false]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
