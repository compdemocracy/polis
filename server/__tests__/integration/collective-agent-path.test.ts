/**
 * The collective-statement agent path through the real app: real routes,
 * real hybridAuth with OIDC bearer tokens, the import body bound before the
 * shared parser, and the exact requests `polis collective export` and
 * `polis collective import` send (polis-cli/crates/polis/src/collective.rs),
 * checked the way the CLI checks the answers. DynamoDB result backend (the
 * test stack's default); the Postgres backend is covered by
 * __tests__/delphi-results-pg/agent-exchange.pgtest.ts.
 *
 * No votes are written: the consensus gate reads the group votes in
 * math_main, which this test stores directly.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { createHash } from "crypto";
import {
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
  setupAuthAndConvo,
  type TestUser,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";
import Config from "../../src/config";
import {
  createDelphiTopicCluster,
  dynamoClient,
} from "../setup/dynamodb-test-helpers";

const JOB = "00000000-0000-4000-8000-00000000c012";
const TOPIC = `${JOB}#0#1`;

async function ensureTable(params: any) {
  try {
    await dynamoClient.send(
      new DescribeTableCommand({ TableName: params.TableName })
    );
  } catch (e: any) {
    if (e.name !== "ResourceNotFoundException") throw e;
    try {
      await dynamoClient.send(new CreateTableCommand(params));
    } catch (c: any) {
      if (c.name !== "ResourceInUseException") throw c;
    }
  }
}
const statementTables = async () => {
  await ensureTable({
    TableName: "Delphi_CollectiveStatement",
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [{ AttributeName: "zid_topic_jobid", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "zid_topic_jobid", AttributeType: "S" },
      { AttributeName: "zid", AttributeType: "S" },
      { AttributeName: "created_at", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "zid-created_at-index",
        KeySchema: [
          { AttributeName: "zid", KeyType: "HASH" },
          { AttributeName: "created_at", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });
  await ensureTable({
    TableName: "Delphi_NarrativeReports",
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      { AttributeName: "rid_section_model", KeyType: "HASH" },
      { AttributeName: "timestamp", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "rid_section_model", AttributeType: "S" },
      { AttributeName: "timestamp", AttributeType: "S" },
      { AttributeName: "report_id", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "ReportIdTimestampIndex",
        KeySchema: [
          { AttributeName: "report_id", KeyType: "HASH" },
          { AttributeName: "timestamp", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });
};

/** The CLI's acceptance of an answer: JSON, 2xx, no error marker; for an
 * export, the manifest checks it makes before writing any file. */
function cliAccepts(
  res: any,
  kind: "export" | "import",
  ids: { conversation: string; report: string }
) {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  expect(res.headers["content-type"]).toMatch(/application\/json/);
  expect(res.body.ok).not.toBe(false);
  expect(res.body.success).not.toBe(false);
  expect([undefined, null, false, ""]).toContain(res.body.error);
  expect(["error", "failed"]).not.toContain(res.body.status);
  if (kind === "export") {
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections.length).toBeGreaterThanOrEqual(1);
    expect(res.body.sections.length).toBeLessThanOrEqual(99);
    expect(res.body.conversation_id).toBe(ids.conversation);
    expect(res.body.report_id).toBe(ids.report);
    expect(typeof res.body.result_schema).toBe("object");
  }
}

describe("collective-statement agent path", () => {
  let owner: any;
  let stranger: any;
  let anonymous: any;
  let ids: { conversation: string; report: string };
  let zid: number;

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 4,
    });
    ids = { conversation: convo.conversationId, report: "" };
    ({ agent: owner } = await getJwtAuthenticatedAgent(convo.testUser));
    const pooled = getPooledTestUser(2);
    const { token } = await getJwtAuthenticatedAgent({
      email: pooled.email,
      hname: pooled.name,
      password: pooled.password,
    } as TestUser);
    stranger = await newAgent();
    setAgentJwt(stranger, token);
    anonymous = await newAgent();

    await owner
      .post("/api/v3/reports")
      .send({ conversation_id: ids.conversation });
    const reports = JSON.parse(
      (await owner.get(`/api/v3/reports?conversation_id=${ids.conversation}`))
        .text
    );
    ids.report = reports[0].report_id;
    zid = (
      await pool.query("SELECT zid FROM zinvites WHERE zinvite=$1", [
        ids.conversation,
      ])
    ).rows[0].zid;

    const tids = convo.commentIds;
    await createDelphiTopicCluster(zid, TOPIC, tids, 0, 1);
    await statementTables();
    const votes = Object.fromEntries(
      tids.map((tid) => [tid, { A: 18, D: 0, S: 20 }])
    );
    await pool.query(
      `INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,math_tick) VALUES($1,$2,$3,0,5)
       ON CONFLICT(zid,math_env) DO UPDATE SET data=EXCLUDED.data,math_tick=EXCLUDED.math_tick`,
      [
        zid,
        Config.mathEnv,
        JSON.stringify({
          "group-votes": {
            0: { "n-members": 20, votes },
            1: { "n-members": 20, votes },
          },
        }),
      ]
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM math_main WHERE zid=$1", [zid]);
  });

  // Exactly what `polis collective export CONV --report R --topic T` sends.
  const exportRequest = (agent: any, section = TOPIC) =>
    agent
      .get("/api/v3/delphi/collective/inputs")
      .query({
        conversation_id: ids.conversation,
        report_id: ids.report,
        section,
      })
      .set("Accept", "application/json")
      .set("User-Agent", "polis-cli/0.1.0");
  // Exactly what `polis collective import CONV FILE --report R` sends.
  const importRequest = (agent: any, body: any) =>
    agent
      .post("/api/v3/delphi/collective/results")
      .set("Accept", "application/json")
      .set("User-Agent", "polis-cli/0.1.0")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(body));
  const authored = (m: any, model: string) => ({
    schema_version: m.schema_version,
    conversation_id: m.conversation_id,
    report_id: m.report_id,
    export_id: m.export_id,
    input_digest: m.input_digest,
    section: m.section,
    model,
    prompt_sha256: createHash("sha256")
      .update(m.sections[0].instructions)
      .digest("hex"),
    runner: "integration-runner",
    results: [
      {
        section: m.sections[0].section,
        report_data: {
          id: "collective_statement",
          title: "Candidate",
          paragraphs: [
            {
              id: "p",
              title: "Common ground",
              sentences: [
                {
                  clauses: [
                    {
                      text: "We support the cited proposals.",
                      citations: m.sections[0].citation_ids.slice(0, 2),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });

  test("the owner exports, imports and retries; the topic page's reader and the versions list serve it", async () => {
    const exported = await exportRequest(owner);
    cliAccepts(exported, "export", ids);
    const manifest = exported.body;
    expect(manifest.section).toBe(TOPIC);
    expect(manifest.sections[0].citation_ids.length).toBeGreaterThanOrEqual(3);

    const body = authored(manifest, "integration-model");
    const imported = await importRequest(owner, body);
    cliAccepts(imported, "import", ids);
    expect(imported.body).toMatchObject({
      id: `${zid}#${TOPIC}#${manifest.export_id}`,
      imported: 1,
      deduplicated: false,
      provenance: {
        provenance: "external agent",
        model: "integration-model",
        runner: "integration-runner",
        math_tick: "5",
        prompt_sha256: body.prompt_sha256,
      },
    });
    const retry = await importRequest(owner, body);
    cliAccepts(retry, "import", ids);
    expect(retry.body.deduplicated).toBe(true);

    const page = await anonymous
      .get("/api/v3/collectiveStatement")
      .query({ report_id: ids.report });
    expect(page.status).toBe(200);
    const shown = page.body.statements.find((s: any) => s.topic_key === TOPIC);
    expect(shown).toMatchObject({
      provenance: "external agent",
      model: "integration-model",
      runner: "integration-runner",
      math_tick: "5",
    });
    expect(shown.statement_data).toEqual(body.results[0].report_data);
    expect(JSON.stringify(page.body)).not.toContain("imported_by");

    const listed = await anonymous
      .get("/api/v3/delphi/collective/results")
      .query({ report_id: ids.report, section: TOPIC });
    expect(listed.status).toBe(200);
    expect(listed.body.statements.map((s: any) => s.model)).toContain(
      "integration-model"
    );
  });

  test("only the conversation owner may export or import; refusals are never 404", async () => {
    expect((await exportRequest(anonymous)).status).toBe(401);
    const strangerExport = await exportRequest(stranger);
    expect([strangerExport.status, strangerExport.body.code]).toEqual([
      403,
      "OWNER_REQUIRED",
    ]);
    const manifest = (await exportRequest(owner)).body;
    const strangerImport = await importRequest(
      stranger,
      authored(manifest, "integration-model-2")
    );
    expect([strangerImport.status, strangerImport.body.code]).toEqual([
      403,
      "OWNER_REQUIRED",
    ]);
    expect(
      (
        await importRequest(
          anonymous,
          authored(manifest, "integration-model-2")
        )
      ).status
    ).toBe(401);

    const unknown = await exportRequest(owner, `${JOB}#0#9`);
    expect([unknown.status, unknown.body.code]).toEqual([
      422,
      "TOPIC_NOT_FOUND",
    ]);
    const form = await owner
      .post("/api/v3/delphi/collective/results")
      .type("form")
      .send({ a: "b" });
    expect(form.status).toBe(415);
    const big = await importRequest(owner, {
      ...authored(manifest, "integration-model-2"),
      padding: "x".repeat(1024 * 1024),
    });
    expect(big.status).toBe(413);
    const listed = await anonymous
      .get("/api/v3/delphi/collective/results")
      .query({ report_id: ids.report });
    expect(listed.body.statements.map((s: any) => s.model)).not.toContain(
      "integration-model-2"
    );
  });
});
