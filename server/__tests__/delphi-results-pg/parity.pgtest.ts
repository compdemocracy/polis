/** Every server reader's DynamoDB command, sent to DynamoDB Local and to the
 * PostgreSQL adapter holding the same items: same pages, same items, same
 * order, same counts, same continuation keys. */
import { GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "pg";
import { sendPostgresResult } from "../../src/utils/delphiResults";
import { conversation, cursorKey, dynamoDocument, pages, postgres, publish, putDynamo, resetDynamo, ENV, SCOPE } from "./support";
import { dataset, JOBS, OTHER_REPORT, OTHER_ZID, REPORT, ZID } from "./dataset";

let pg: Client;
const doc = dynamoDocument();
const data = dataset();
const cid = String(ZID);

beforeAll(async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  await conversation(pg, ZID, [REPORT]);
  await conversation(pg, OTHER_ZID, [OTHER_REPORT]);
  const first = await publish(pg, {zid: ZID, families: data.first});
  await publish(pg, {zid: ZID, families: data.second, previous: first});
  await publish(pg, {zid: OTHER_ZID, families: data.other});
  const final: Record<string, any[]> = {...data.first, ...data.second};
  await resetDynamo(Object.keys(final));
  for (const [family, items] of Object.entries(final)) {
    await putDynamo(family, [...items, ...((data.other as any)[family] || [])]);
  }
}, 600000);
afterAll(async () => { await pg?.end(); });

/** DynamoDB applies the 1 MB page bound to the items it reads, before the
 * FilterExpression (AWS Query/Scan documentation). DynamoDB Local instead
 * bounds the filtered output, so a filtered read is compared with DynamoDB
 * Local's unfiltered pages, filtered here: the documented service behaviour. */
type Case = {reader: string; Command: any; input: any; paginates: boolean; filter?: (item: any) => boolean};
const cases: Case[] = [
  {reader: "topicMod proximity (UMAP map; one call)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_UMAPGraph", KeyConditionExpression: "conversation_id = :cid",
    FilterExpression: "source_id = target_id", ExpressionAttributeValues: {":cid": cid}},
    filter: item => item.source_id === item.target_id},
  {reader: "topicMod proximity layer filter (one call)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_CommentHierarchicalClusterAssignments", KeyConditionExpression: "conversation_id = :cid",
    FilterExpression: "layer_id = :lid", ExpressionAttributeValues: {":cid": cid, ":lid": 1}},
    filter: item => item.layer_id === 1},
  {reader: "topicStats / topicMod topics (one call)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_CommentClustersLLMTopicNames", KeyConditionExpression: "conversation_id = :cid",
    ExpressionAttributeValues: {":cid": cid}}},
  {reader: "topicMod topics for a job (one call)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_CommentClustersLLMTopicNames", KeyConditionExpression: "conversation_id = :cid AND begins_with(topic_key, :job_id)",
    ExpressionAttributeValues: {":cid": cid, ":job_id": `${JOBS[1]}#`}}},
  {reader: "topicMod hierarchy (one call)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_CommentClustersStructureKeywords", KeyConditionExpression: "conversation_id = :cid",
    ExpressionAttributeValues: {":cid": cid}}},
  {reader: "consensus RSS (one call on the report index)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_NarrativeReports", IndexName: "ReportIdTimestampIndex", KeyConditionExpression: "report_id = :rid",
    ExpressionAttributeValues: {":rid": REPORT}}},
  {reader: "delphi runs / feeds directory (Limit 1 on the report index)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_NarrativeReports", IndexName: "ReportIdTimestampIndex", KeyConditionExpression: "report_id = :report_id",
    ExpressionAttributeValues: {":report_id": REPORT}, Limit: 1}},
  {reader: "delphi topics / topics RSS / ops topic names (paginated)", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_CommentClustersLLMTopicNames", KeyConditionExpression: "conversation_id = :cid",
    ExpressionAttributeValues: {":cid": cid}}},
  {reader: "delphi reports (paginated report index)", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_NarrativeReports", IndexName: "ReportIdTimestampIndex", KeyConditionExpression: "report_id = :rid",
    ExpressionAttributeValues: {":rid": REPORT}}},
  {reader: "collective statements by conversation (paginated index)", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_CollectiveStatement", IndexName: "zid-created_at-index", KeyConditionExpression: "zid = :zid",
    ExpressionAttributeValues: {":zid": cid}, ScanIndexForward: false}},
  {reader: "comment cluster assignments (paginated; nextComment, topicStats, CSV)", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_CommentHierarchicalClusterAssignments", KeyConditionExpression: "conversation_id = :cid",
    ExpressionAttributeValues: {":cid": cid}}},
  {reader: "UMAP graph, every page (key order across 1 MB pages)", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_UMAPGraph", KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": cid}}},
  {reader: "UMAP graph, backward with a Limit", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_UMAPGraph", KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": cid},
    ScanIndexForward: false, Limit: 700}},
  {reader: "hierarchy, every page (UTF-8 key order)", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_CommentClustersStructureKeywords", KeyConditionExpression: "conversation_id = :cid",
    ExpressionAttributeValues: {":cid": cid}}},
  {reader: "a Limit that ends exactly at the last item", Command: QueryCommand, paginates: true, input: {
    TableName: "Delphi_CommentClustersLLMTopicNames", KeyConditionExpression: "conversation_id = :cid AND begins_with(topic_key, :p)",
    ExpressionAttributeValues: {":cid": cid, ":p": "layer0_"}, Limit: 20}},
  {reader: "nextComment topical routing (one topic)", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_CommentClustersLLMTopicNames", KeyConditionExpression: "conversation_id = :cid AND topic_key = :tk",
    ExpressionAttributeValues: {":cid": cid, ":tk": `${JOBS[0]}#1#17`}}},
  {reader: "report narrative cache section (storage Query)", Command: QueryCommand, paginates: false, input: {
    TableName: "report_narrative_store", KeyConditionExpression: "rid_section_model = :rid_section_model",
    ExpressionAttributeValues: {":rid_section_model": `${REPORT}#section_0003#openai`}}},
  {reader: "an absent conversation", Command: QueryCommand, paginates: false, input: {
    TableName: "Delphi_UMAPGraph", KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": "999999"}}},
];

const strip = (reply: any) => ({Items: reply.Items, Count: reply.Count, ScannedCount: reply.ScannedCount,
  LastEvaluatedKey: cursorKey(reply.LastEvaluatedKey)});

const service = (filter?: (item: any) => boolean) => async (command: any) => {
  if (!filter) return doc.send(command);
  const {FilterExpression: _filter, ...read} = command.input;
  read.ExpressionAttributeValues = Object.fromEntries(Object.entries(read.ExpressionAttributeValues)
    .filter(([name]) => read.KeyConditionExpression.includes(name)));
  const reply = await doc.send(new command.constructor(read));
  const Items = reply.Items.filter(filter);
  return {...reply, Items, Count: Items.length};
};

describe.each(cases)("$reader", ({Command, input, paginates, filter}) => {
  test("PostgreSQL pages equal DynamoDB pages", async () => {
    const send = service(filter);
    const expected = paginates ? await pages(send, Command, input) : [await send(new Command(input))];
    const actual = paginates ? await pages(sendPostgresResult, Command, input) : [await sendPostgresResult(new Command(input))];
    expect(actual.map(strip)).toEqual(expected.map(strip));
    process.stdout.write(`${JSON.stringify({reader: input.TableName, pages: actual.map(r => [r.ScannedCount, r.Count])})}\n`);
  }, 120000);
});

test("collective statement Get by key", async () => {
  const Key = {zid_topic_jobid: data.first.Delphi_CollectiveStatement[4].zid_topic_jobid.S};
  const expected = await doc.send(new GetCommand({TableName: "Delphi_CollectiveStatement", Key}));
  expect((await sendPostgresResult(new GetCommand({TableName: "Delphi_CollectiveStatement", Key}))).Item).toEqual(expected.Item);
  const missing = {zid_topic_jobid: `${ZID}#absent`};
  expect((await sendPostgresResult(new GetCommand({TableName: "Delphi_CollectiveStatement", Key: missing}))).Item)
    .toEqual((await doc.send(new GetCommand({TableName: "Delphi_CollectiveStatement", Key: missing}))).Item);
});

test("report narrative cache Scan by report prefix returns the same items over all pages", async () => {
  const input = {TableName: "report_narrative_store", FilterExpression: "begins_with(rid_section_model, :reportIdPrefix)",
    ExpressionAttributeValues: {":reportIdPrefix": REPORT}};
  const items = (replies: any[]) => replies.flatMap(r => r.Items).sort((a, b) => a.rid_section_model < b.rid_section_model ? -1 : 1);
  // Scan order is unspecified in DynamoDB, so pages may split differently; the
  // union a paginating reader assembles must be identical.
  expect(items(await pages(sendPostgresResult, ScanCommand, input))).toEqual(items(await pages(c => doc.send(c), ScanCommand, input)));
});

test("reads are confined to the conversation: SQL never reads another conversation's bundle", async () => {
  const reply = await sendPostgresResult(new QueryCommand({TableName: "Delphi_UMAPGraph",
    KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": String(OTHER_ZID)}}));
  expect(reply.Items.every((item: any) => item.conversation_id === String(OTHER_ZID))).toBe(true);
  expect(reply.Items).toHaveLength(data.other.Delphi_UMAPGraph.length);
});

/** The readers that never paginate, through their own handlers on each backend. */
describe("route responses are equal on both backends", () => {
  const {handle_GET_topicMod_proximity, handle_GET_topicMod_topics, handle_GET_topicMod_hierarchy} = require("../../src/routes/delphi/topicMod");
  const {handle_GET_topicStats} = require("../../src/routes/topicStats");
  const {handle_GET_consensus_feed} = require("../../src/routes/api/v3/feeds");
  const respond = async (handler: any, req: any, backend: string) => {
    process.env.DELPHI_RESULT_BACKEND = backend;
    const out: any = {status: 200};
    const res: any = {
      status(code: number) { out.status = code; return res; }, set() { return res; }, setHeader() { return res; },
      type() { return res; }, json(body: any) { out.body = body; return res; },
      send(body: any) { out.body = String(body).replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/g, ""); return res; },
    };
    try { await handler(req, res); } finally { process.env.DELPHI_RESULT_BACKEND = "postgres"; }
    return out;
  };
  const routes: Array<[string, any, any]> = [
    ["topicMod proximity (all layers, small graph)", handle_GET_topicMod_proximity, {p: {zid: OTHER_ZID}, query: {}}],
    ["topicMod proximity (one layer, small graph)", handle_GET_topicMod_proximity, {p: {zid: OTHER_ZID}, query: {layer_id: "1"}}],
    ["topicMod topics", handle_GET_topicMod_topics, {p: {zid: ZID}, query: {}}],
    ["topicMod topics for a job", handle_GET_topicMod_topics, {p: {zid: ZID}, query: {job_id: JOBS[1]}}],
    ["topicMod hierarchy", handle_GET_topicMod_hierarchy, {p: {zid: ZID}, query: {}}],
    ["topicStats", handle_GET_topicStats, {query: {report_id: REPORT}}],
    ["consensus RSS", handle_GET_consensus_feed, {params: {reportId: REPORT}, query: {}, protocol: "https", get: () => "example.invalid"}],
  ];
  test.each(routes)("%s", async (_name, handler, req) => {
    const dynamoReply = await respond(handler, req, "dynamodb");
    const postgresReply = await respond(handler, req, "postgres");
    expect(postgresReply).toEqual(dynamoReply);
    expect(JSON.stringify(dynamoReply.body).length).toBeGreaterThan(200);
  }, 120000);
});
