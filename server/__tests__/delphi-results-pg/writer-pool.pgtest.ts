/** Server-side result edits issued together must not fill the read-write pool
 * that votes and comments use. The narrative-cache prune deletes a whole scan
 * page at once; each delete is one pd_result_mutate on the read-write pool,
 * and the conversation's writer lock serializes them. If each edit took a
 * pooled connection and then queued for that lock, a large prune would hold
 * every connection: a vote's query would wait behind it, and the edits that
 * could not get a connection within the acquire bound would fail, leaving
 * entries behind. One at a time per process, the edits hold at most one
 * connection, all of them commit, and a query issued meanwhile is served at
 * once.
 *
 * The acquire bound is short here, so an edit or a query that has to queue for
 * a connection fails instead of passing on a fast machine. Generated data
 * only; see scripts/test-delphi-result-reads.sh. */

// db/pg-query.ts reads this when it builds its pools, so it is set before any
// module under test is required (below, in beforeAll).
process.env.SERVER_DB_ACQUIRE_TIMEOUT_MS = "250";

import { CreateTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { Client } from "pg";
import { asRequest, conversation, dynamo, postgres, ENV, SCOPE } from "./support";

const ZID = 411, RID = "r411generatedprune0000", ENTRIES = 45;
const ACQUIRE_TIMEOUT_MS = 250;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let pg: Client;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pgQuery: any, Storage: any;
/** Result edits running on a read-write connection now, and the most at once. */
let editsInFlight = 0, mostEditsInFlight = 0;

beforeAll(async () => {
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  pgQuery = require("../../src/db/pg-query").default;
  Storage = require("../../src/utils/storage").default;
  const queryP = pgQuery.queryP;
  jest.spyOn(pgQuery, "queryP").mockImplementation(async (sql: unknown, ...args: unknown[]) => {
    const edit = typeof sql === "string" && sql.includes("pd_result_mutate");
    if (edit) mostEditsInFlight = Math.max(mostEditsInFlight, ++editsInFlight);
    try { return await queryP(sql, ...args); } finally { if (edit) editsInFlight--; }
  });
  pg = await postgres();
  await conversation(pg, ZID, [RID]);
  const client = dynamo();
  if (!((await client.send(new ListTablesCommand({}))).TableNames || []).includes("report_narrative_store")) {
    await client.send(new CreateTableCommand({TableName: "report_narrative_store", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{AttributeName: "rid_section_model", AttributeType: "S"}, {AttributeName: "timestamp", AttributeType: "S"}],
      KeySchema: [{AttributeName: "rid_section_model", KeyType: "HASH"}, {AttributeName: "timestamp", KeyType: "RANGE"}]}));
  }
});
afterAll(async () => { await pg?.end(); });

test("a prune's edits hold at most one read-write connection, all commit, and a query meanwhile is served at once", async () => {
  const storage = new Storage("report_narrative_store");
  for (let i = 0; i < ENTRIES; i++) {
    const r = await storage.putItem({rid_section_model: `${RID}#section_${String(i).padStart(3, "0")}#openai`,
      timestamp: "2020-01-01T00:00:00.000Z", report_id: RID, model: "openai", report_data: "x".repeat(30000)});
    if (!r.success) throw new Error("put failed " + JSON.stringify(r.error));
  }
  mostEditsInFlight = 0;

  const prune = asRequest(async () => storage.deleteAllByReportID(RID));
  // While the prune's edits run, a query on the same pool (a vote's insert
  // takes the same path) needs a connection.
  const deadline = Date.now() + 10000;
  while (editsInFlight === 0) {
    if (Date.now() > deadline) throw new Error("the prune never started an edit");
    await sleep(5);
  }
  const started = Date.now();
  const probe = await pgQuery.queryP("SELECT 1 AS ok", []).then(
    (rows: any[]) => ({ms: Date.now() - started, ok: rows[0]?.ok}),
    (error: Error) => ({ms: Date.now() - started, error: error.message}));
  const pruned = await prune;
  const remaining = await asRequest(async () => storage.getAllByReportID(RID));
  process.stdout.write(`${JSON.stringify({entries: ENTRIES, most_edits_in_flight: mostEditsInFlight,
    deleted: pruned.deletedCount, remaining: remaining.data?.length, probe})}\n`);

  expect(mostEditsInFlight).toBe(1);
  expect({success: pruned.success, deleted: pruned.deletedCount, remaining: remaining.data?.length})
    .toEqual({success: true, deleted: ENTRIES, remaining: 0});
  expect(probe).toMatchObject({ok: 1});
  expect(probe.ms).toBeLessThan(ACQUIRE_TIMEOUT_MS);
}, 300000);
