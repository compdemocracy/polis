/** Paginated reads that span a write, on DynamoDB Local and on PostgreSQL.
 * A cursor is a key position: a publication between two pages never fails the
 * read, and the narrative-cache prune deletes every matching entry. */
import { CreateTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "pg";
import DynamoStorageService from "../../src/utils/storage";
import { sendPostgresResult } from "../../src/utils/delphiResults";
import { asRequest, conversation, dynamo, postgres, publish, ENV, SCOPE } from "./support";

let pg: Client;
const big = (n: number) => "x".repeat(n);
beforeAll(async () => {
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  const client = dynamo();
  if (!((await client.send(new ListTablesCommand({}))).TableNames || []).includes("report_narrative_store")) {
    await client.send(new CreateTableCommand({TableName: "report_narrative_store", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{AttributeName: "rid_section_model", AttributeType: "S"}, {AttributeName: "timestamp", AttributeType: "S"}],
      KeySchema: [{AttributeName: "rid_section_model", KeyType: "HASH"}, {AttributeName: "timestamp", KeyType: "RANGE"}]}));
  }
});
afterAll(async () => { await pg?.end(); });

async function fill(storage: DynamoStorageService, rid: string, n: number, ts: string, size: number) {
  for (let i = 0; i < n; i++) {
    const r = await storage.putItem({rid_section_model: `${rid}#section_${String(i).padStart(3, "0")}#openai`, timestamp: ts,
      report_id: rid, model: "openai", report_data: big(size)});
    if (!r.success) throw new Error("put failed " + JSON.stringify(r.error));
  }
}

// Each delete on the first page publishes; the second page must still be read.
test.each([["dynamodb", 401, "r401generatedprune0000"], ["postgres", 402, "r402generatedprune0000"]])(
  "%s: the cache prune deletes a cache larger than one 1 MB page", async (backend, zid, rid) => {
  process.env.DELPHI_RESULT_BACKEND = backend as string;
  await conversation(pg, zid as number, [rid as string]);
  const storage = new DynamoStorageService("report_narrative_store");
  await fill(storage, rid as string, 45, "2020-01-01T00:00:00.000Z", 30000);
  const seen = await asRequest(async () => {
    const pruned = await storage.deleteAllByReportID(rid as string);
    const all = await storage.getAllByReportID(rid as string);
    return {success: pruned.success, deleted: pruned.deletedCount, remaining: all.data?.length};
  });
  expect(seen).toEqual({success: true, deleted: 45, remaining: 0});
}, 300000);

// The conversation's other report sorts first and fills a whole filtered page.
test.each([["dynamodb", 403, "r403generatedpruneA000", "r403generatedpruneB000"],
           ["postgres", 404, "r404generatedpruneA000", "r404generatedpruneB000"]])(
  "%s: the cache prune pages past another report's full page", async (backend, zid, ridA, ridB) => {
  process.env.DELPHI_RESULT_BACKEND = backend as string;
  await conversation(pg, zid as number, [ridA as string, ridB as string]);
  const storage = new DynamoStorageService("report_narrative_store");
  await fill(storage, ridB as string, 45, "2020-01-01T00:00:00.000Z", 30000);
  await fill(storage, ridA as string, 3, "2021-01-01T00:00:00.000Z", 1000);
  const seen = await asRequest(async () => {
    const pruned = await storage.deleteAllByReportID(ridA as string);
    const allA = await storage.getAllByReportID(ridA as string);
    const allB = await storage.getAllByReportID(ridB as string);
    return {success: pruned.success, deleted: pruned.deletedCount, remainingA: allA.data?.length, remainingB: allB.data?.length};
  });
  expect(seen).toEqual({success: true, deleted: 3, remainingA: 0, remainingB: 45});
}, 300000);

// A publication for the conversation lands between two pages of one request.
test("postgres: a publication between pages continues from the cursor's key", async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  const zid = 405;
  await conversation(pg, zid);
  const rows = (names: string) => Array.from({length: 20}, (_, i) => ({conversation_id: {S: String(zid)},
    topic_key: {S: `k${String(i).padStart(2, "0")}`}, topic_name: {S: `${names}${i}`}}));
  const first = await publish(pg, {zid, families: {Delphi_CommentClustersLLMTopicNames: rows("t")}});
  const input = {TableName: "Delphi_CommentClustersLLMTopicNames", KeyConditionExpression: "conversation_id = :c",
    ExpressionAttributeValues: {":c": String(zid)}, Limit: 5};
  const outcome = await asRequest(async () => {
    const p1 = await sendPostgresResult(new QueryCommand(input));
    // Another family: the topic names still resolve to the first publication.
    const second = await publish(pg, {zid, previous: first,
      families: {Delphi_CommentExtremity: [{conversation_id: {S: String(zid)}, comment_id: {S: "1"}}]}});
    const p2 = await sendPostgresResult(new QueryCommand({...input, ExclusiveStartKey: p1.LastEvaluatedKey}));
    // The same family, rewritten: later pages read the newer rows, as on DynamoDB.
    await publish(pg, {zid, previous: second, families: {Delphi_CommentClustersLLMTopicNames: rows("u")}});
    const p3 = await sendPostgresResult(new QueryCommand({...input, ExclusiveStartKey: p2.LastEvaluatedKey}));
    return [p1, p2, p3].map(p => p.Items.map((item: any) => item.topic_name));
  });
  expect(outcome).toEqual([["t0", "t1", "t2", "t3", "t4"], ["t5", "t6", "t7", "t8", "t9"], ["u10", "u11", "u12", "u13", "u14"]]);
}, 120000);
