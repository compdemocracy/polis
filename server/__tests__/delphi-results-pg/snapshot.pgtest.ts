/** A read that follows a write sees it, as on DynamoDB: the report narrative
 * cache prune followed by its re-read (reportNarrative's stale-cache path). */
import { CreateTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { Client } from "pg";
import DynamoStorageService from "../../src/utils/storage";
import { asRequest, conversation, dynamo, postgres, ENV, SCOPE } from "./support";

let pg: Client;
beforeAll(async () => {
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  await conversation(pg, 201, ["r201generatedcache0000", "r202generatedcache0000"]);
  const client = dynamo();
  if (!((await client.send(new ListTablesCommand({}))).TableNames || []).includes("report_narrative_store")) {
    await client.send(new CreateTableCommand({TableName: "report_narrative_store", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{AttributeName: "rid_section_model", AttributeType: "S"}, {AttributeName: "timestamp", AttributeType: "S"}],
      KeySchema: [{AttributeName: "rid_section_model", KeyType: "HASH"}, {AttributeName: "timestamp", KeyType: "RANGE"}]}));
  }
});
afterAll(async () => { await pg?.end(); });

test.each([["dynamodb", "r201generatedcache0000"], ["postgres", "r202generatedcache0000"]])(
  "%s: a pruned cache is not served by the re-read in the same request", async (backend, rid) => {
  process.env.DELPHI_RESULT_BACKEND = backend;
  const storage = new DynamoStorageService("report_narrative_store");
  for (const section of ["group_informed_consensus", "topics", "uncertainty"]) {
    expect((await storage.putItem({rid_section_model: `${rid}#${section}#openai`, timestamp: "2020-01-01T00:00:00.000Z",
      report_id: rid, model: "openai", report_data: JSON.stringify({section})})).success).toBe(true);
  }
  const seen = await asRequest(async () => {
    const cached = await storage.getAllByReportID(rid);
    const pruned = await storage.deleteAllByReportID(rid);
    const reread = await storage.queryItemsByRidSectionModel(`${rid}#topics#openai`);
    const all = await storage.getAllByReportID(rid);
    return {cached: cached.data?.length, deleted: pruned.deletedCount, reread: reread.data, all: all.data};
  });
  expect(seen).toEqual({cached: 3, deleted: 3, reread: [], all: []});
}, 60000);
