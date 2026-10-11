/** The replacement view and page function serve exactly the rows the M28
 * bundle function serves; scoped job reads equal unscoped reads filtered. */
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "pg";
import { sendPostgresResult } from "../../src/utils/delphiResults";
import { conversation, postgres, publish, ENV, SCOPE } from "./support";
import { assignments, topicNames, umapGraph } from "./dataset";

const ZID = 401, REPORT = "r401generatedequivalence";
let pg: Client;
beforeAll(async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  await conversation(pg, ZID, [REPORT]);
  const first = await publish(pg, {zid: ZID, families: {Delphi_UMAPGraph: umapGraph(ZID, 40),
    Delphi_CommentHierarchicalClusterAssignments: assignments(ZID, 50), Delphi_CommentClustersLLMTopicNames: topicNames(ZID).slice(0, 60)}});
  const second = await publish(pg, {zid: ZID, previous: first, families: {Delphi_CommentClustersLLMTopicNames: topicNames(ZID).slice(100, 130)}});
  // An explicitly empty family in a newer generation shadows its ancestor's rows.
  await publish(pg, {zid: ZID, previous: second, families: {Delphi_CommentHierarchicalClusterAssignments: []}});
  await publish(pg, {zid: ZID, scope: "other", families: {Delphi_UMAPGraph: umapGraph(ZID, 5)}});
  // Real synchronous writes (pd_result_mutate) leave queue jobs for this conversation.
  for (const section of ["a", "b"]) {
    await sendPostgresResult(new PutCommand({TableName: "report_narrative_store", Item: {
      rid_section_model: `${REPORT}#${section}#openai`, timestamp: "2026-05-01T00:00:00.000Z", report_data: "{}"}}));
  }
}, 600000);
afterAll(async () => { await pg?.end(); });

const OLD = `SELECT s.env,s.zid,s.scope_key,s.generation,r.family,r.item_key,r.item
  FROM delphi_graph_served s CROSS JOIN LATERAL pd_result_bundle_rows(s.env,s.artifact_id) r`;
const NEW = "SELECT env,zid,scope_key,generation,family,item_key,item FROM delphi_result_current_rows";

test("the replacement view returns exactly the M28 bundle rows, for every served bundle", async () => {
  const count = async (sql: string) => Number((await pg.query(sql)).rows[0].count);
  expect(await count(`SELECT count(*) FROM (${OLD} EXCEPT ALL ${NEW}) d`)).toBe(0);
  expect(await count(`SELECT count(*) FROM (${NEW} EXCEPT ALL ${OLD}) d`)).toBe(0);
  expect(await count(`SELECT count(*) FROM (${NEW}) n`)).toBe(await count(`SELECT count(*) FROM (${OLD}) o`));
  const shadowed = await pg.query(`SELECT count(*)::int AS n FROM delphi_result_current_rows WHERE env=$1 AND zid=$2 AND scope_key=$3
    AND family='Delphi_CommentHierarchicalClusterAssignments'`, [ENV, ZID, SCOPE]);
  expect(shadowed.rows[0].n).toBe(0);
});

test("the page function returns each served family's rows, in DynamoDB key order", async () => {
  const families = await pg.query(`SELECT DISTINCT env,zid,scope_key,family FROM (${OLD}) o`);
  expect(families.rows.length).toBeGreaterThan(3);
  for (const {env, zid, scope_key, family} of families.rows) {
    const expected = await pg.query(`SELECT item FROM (${OLD}) o WHERE env=$1 AND zid=$2 AND scope_key=$3 AND family=$4`, [env, zid, scope_key, family]);
    const paged = await pg.query(`SELECT item,sort_n,sort_t FROM pd_result_page($1,ARRAY[$2::integer],$3,$4,NULL,NULL,NULL,NULL,false,NULL)`, [env, zid, scope_key, family]);
    const key = (r: any) => JSON.stringify(r.item);
    expect(paged.rows.map(key).sort()).toEqual(expected.rows.map(key).sort());
    const order = paged.rows.map(r => [Number(r.sort_n), Buffer.from(r.sort_t, "utf8")]);
    for (let i = 1; i < order.length; i++) {
      const [n0, t0] = order[i - 1] as [number, Buffer], [n1, t1] = order[i] as [number, Buffer];
      expect(n0 < n1 || (n0 === n1 && Buffer.compare(t0, t1) <= 0)).toBe(true);
    }
  }
});

test("job reads for a conversation equal the unscoped job read filtered to it", async () => {
  const scoped = await sendPostgresResult(new QueryCommand({TableName: "Delphi_JobQueue", IndexName: "ConversationIndex",
    KeyConditionExpression: "conversation_id = :c", ExpressionAttributeValues: {":c": String(ZID)}}));
  const all = await sendPostgresResult(new QueryCommand({TableName: "Delphi_JobQueue"}));
  const mine = all.Items.filter((job: any) => job.conversation_id === String(ZID))
    .sort((a: any, b: any) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.job_id < b.job_id ? -1 : 1);
  expect(scoped.Items.length).toBeGreaterThanOrEqual(2);
  expect(scoped.Items).toEqual(mine);
});
