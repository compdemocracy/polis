/* Per-request cost of each server reader on the PostgreSQL result path, as the
 * reader issues it (following pages when the reader does). Prints one JSON line
 * per reader and conversation: median wall time of 5 runs after one warm-up.
 * Usage: DATABASE_URL=... DELPHI_RESULT_BACKEND=postgres DELPHI_RESULT_ENV=bench
 *   DELPHI_RESULT_SCOPE=delphi npx ts-node --transpile-only bench/delphi-result-reads/timing.ts */
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import path from "path";
// The adapter of the checkout this runs in (so a previous release can be timed).
const {sendPostgresResult} = require(path.join(process.cwd(), "src/utils/delphiResults"));

const conversations = [100001, 100010, 100100, 102500];
const report = (zid: number) => `rbench${String(zid - 100000).padStart(8, "0")}`;
const readers: Record<string, (zid: number) => [any, any, boolean]> = {
  "topicMod proximity": zid => [QueryCommand, {TableName: "Delphi_UMAPGraph", KeyConditionExpression: "conversation_id = :cid",
    FilterExpression: "source_id = target_id", ExpressionAttributeValues: {":cid": String(zid)}}, false],
  "cluster assignments (all pages)": zid => [QueryCommand, {TableName: "Delphi_CommentHierarchicalClusterAssignments",
    KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": String(zid)}}, true],
  "topic names (all pages)": zid => [QueryCommand, {TableName: "Delphi_CommentClustersLLMTopicNames",
    KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": String(zid)}}, true],
  "nextComment one topic": zid => [QueryCommand, {TableName: "Delphi_CommentClustersLLMTopicNames",
    KeyConditionExpression: "conversation_id = :cid AND topic_key = :tk", ExpressionAttributeValues: {":cid": String(zid), ":tk": "absent#0#0"}}, false],
  "narrative reports index (all pages)": zid => [QueryCommand, {TableName: "Delphi_NarrativeReports", IndexName: "ReportIdTimestampIndex",
    KeyConditionExpression: "report_id = :rid", ExpressionAttributeValues: {":rid": report(zid)}}, true],
  "narrative cache section": zid => [QueryCommand, {TableName: "report_narrative_store",
    KeyConditionExpression: "rid_section_model = :r", ExpressionAttributeValues: {":r": `${report(zid)}#section_1#openai`}}, false],
  "narrative cache scan by report (all pages)": zid => [ScanCommand, {TableName: "report_narrative_store",
    FilterExpression: "begins_with(rid_section_model, :p)", ExpressionAttributeValues: {":p": report(zid)}}, true],
  "collective statements index (all pages)": zid => [QueryCommand, {TableName: "Delphi_CollectiveStatement", IndexName: "zid-created_at-index",
    KeyConditionExpression: "zid = :zid", ExpressionAttributeValues: {":zid": String(zid)}}, true],
  "job queue by conversation (all pages)": zid => [QueryCommand, {TableName: "Delphi_JobQueue", IndexName: "ConversationIndex",
    KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": String(zid)}}, true],
};

async function run(Command: any, input: any, paginate: boolean) {
  let start: any, items = 0, pages = 0;
  do {
    const reply = await sendPostgresResult(new Command({...input, ...(start ? {ExclusiveStartKey: start} : {})}));
    items += reply.Items.length; pages += 1;
    start = paginate ? reply.LastEvaluatedKey : undefined;
  } while (start);
  return {items, pages};
}

(async () => {
  for (const zid of conversations) {
    for (const [name, make] of Object.entries(readers)) {
      const [Command, input, paginate] = make(zid);
      let shape: any;
      try { shape = await run(Command, input, paginate); } catch (error: any) {
        process.stdout.write(`${JSON.stringify({reader: name, zid, error: error.message})}\n`);
        continue;
      }
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = process.hrtime.bigint();
        await run(Command, input, paginate);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      times.sort((a, b) => a - b);
      process.stdout.write(`${JSON.stringify({reader: name, zid, ...shape, median_ms: Number(times[2].toFixed(1)), max_ms: Number(times[4].toFixed(1))})}\n`);
    }
  }
  process.exit(0);
})();
