/** Long requests that read results and then wait on a model call must not hold
 * result connections, so nextComment's topical routing is never starved. */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "pg";
import { sendPostgresResult } from "../../src/utils/delphiResults";
import { getTidsForParticipantTopicAgenda } from "../../src/nextComment";
import { asRequest, conversation, postgres, publish, ENV, SCOPE } from "./support";
import { assignments, JOBS, topicNames } from "./dataset";

const ZID = 301, PID = 7, LONG_REQUESTS = 6, MODEL_WAIT_MS = 4000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let pg: Client;

beforeAll(async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  await conversation(pg, ZID);
  await publish(pg, {zid: ZID, families: {
    Delphi_CommentClustersLLMTopicNames: topicNames(ZID),
    Delphi_CommentHierarchicalClusterAssignments: assignments(ZID, 2000),
  }});
  await pg.query("SET session_replication_role = replica");
  await pg.query(`INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,total_selections) VALUES($1,$2,$3,3)
    ON CONFLICT(zid,pid) DO UPDATE SET archetypal_selections=EXCLUDED.archetypal_selections`,
    [ZID, PID, JSON.stringify([`${JOBS[0]}#1#2`, `${JOBS[0]}#0#3`, `${JOBS[1]}#2#1`].map(topic_key => ({topic_key})))]);
  await pg.query("SET session_replication_role = origin");
});
afterAll(async () => { await pg?.end(); });

const topics = () => sendPostgresResult(new QueryCommand({TableName: "Delphi_CommentClustersLLMTopicNames",
  KeyConditionExpression: "conversation_id = :cid", ExpressionAttributeValues: {":cid": String(ZID)}}));

test("topical nextComment answers promptly while long result requests wait on a model", async () => {
  const baseline = Date.now();
  const expected = await asRequest(() => getTidsForParticipantTopicAgenda(ZID, PID));
  const quiet = Date.now() - baseline;
  expect(expected.length).toBeGreaterThan(0);

  const long = Array.from({length: LONG_REQUESTS}, () => asRequest(async () => {
    await topics();
    await sleep(MODEL_WAIT_MS);
    return (await topics()).Items.length;
  }));
  await sleep(300);
  const held = (await pg.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND state LIKE 'idle in transaction%'`)).rows[0].n;
  const started = Date.now();
  const tids = await asRequest(() => getTidsForParticipantTopicAgenda(ZID, PID));
  const busy = Date.now() - started;
  const longResults = await Promise.all(long);
  process.stdout.write(`${JSON.stringify({quiet_ms: quiet, busy_ms: busy, held_snapshots: held, long_requests: LONG_REQUESTS, model_wait_ms: MODEL_WAIT_MS})}\n`);
  expect(longResults.every(n => n === topicNames(ZID).length)).toBe(true);
  expect(tids.sort()).toEqual(expected.sort());
  expect(held).toBe(0);
  expect(busy).toBeLessThan(1000);
}, 120000);
