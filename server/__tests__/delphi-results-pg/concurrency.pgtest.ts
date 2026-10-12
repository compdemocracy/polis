/** Long requests that read results and then wait on a model call must not hold
 * result connections, so nextComment's topical routing is never starved. */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Client, PoolClient } from "pg";
import pgQuery, { RESULT_SNAPSHOT_POOL_MAX } from "../../src/db/pg-query";
import { sendPostgresResult } from "../../src/utils/delphiResults";
import { getTidsForParticipantTopicAgenda } from "../../src/nextComment";
import { asRequest, conversation, postgres, publish, ENV, SCOPE } from "./support";
import { assignments, JOBS, topicNames } from "./dataset";

// As many waiting requests as the result pool has connections: if each kept
// its connection, nextComment would have none left.
const ZID = 301, PID = 7, LONG_REQUESTS = RESULT_SNAPSHOT_POOL_MAX;
let pg: Client;
/** Result connections checked out of the pool and not yet released. */
let checkedOut = 0;

beforeAll(async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  const connect = pgQuery.connectResultSnapshot;
  jest.spyOn(pgQuery, "connectResultSnapshot").mockImplementation(async () => {
    const client: PoolClient = await connect();
    checkedOut++;
    const release = client.release;
    client.release = (...args: Parameters<PoolClient["release"]>) => { checkedOut--; return release.apply(client, args); };
    return client;
  });
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

test("topical nextComment answers while long result requests wait on a model", async () => {
  const baseline = Date.now();
  const expected = await asRequest(() => getTidsForParticipantTopicAgenda(ZID, PID));
  const quiet = Date.now() - baseline;
  expect(expected.length).toBeGreaterThan(0);

  // The model answers only after nextComment has. Each request reads, then
  // reports that it is waiting on the model.
  let answer!: () => void;
  const model = new Promise<void>(resolve => { answer = resolve; });
  let waiting = 0, allWaiting!: () => void;
  const everyoneWaiting = new Promise<void>(resolve => { allWaiting = resolve; });
  const long = Array.from({length: LONG_REQUESTS}, () => asRequest(async () => {
    await topics();
    if (++waiting === LONG_REQUESTS) allWaiting();
    await model;
    return (await topics()).Items.length;
  }));
  // A request that fails before it waits fails the test here, not by timeout.
  await Promise.race([everyoneWaiting, Promise.all(long)]);

  // Every request has finished its read and is waiting on the model. Sampled
  // now, not after a fixed delay: a read still in flight is legitimately in
  // its transaction (idle in transaction between its statements).
  const inUse = checkedOut;
  const held = (await pg.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND state LIKE 'idle in transaction%'`)).rows[0].n;
  let tids: number[] = [], busy: number | undefined;
  try {
    expect(inUse).toBe(0);
    expect(held).toBe(0);
    // nextComment's topic reads need result connections while no model call
    // has returned: they can only come from the pool, never from a waiting request.
    const started = Date.now();
    tids = await asRequest(() => getTidsForParticipantTopicAgenda(ZID, PID));
    busy = Date.now() - started;
  } finally {
    answer();
    process.stdout.write(`${JSON.stringify({quiet_ms: quiet, busy_ms: busy, connections_in_use: inUse, held_snapshots: held, long_requests: LONG_REQUESTS})}\n`);
  }
  const longResults = await Promise.all(long);
  expect(tids.sort()).toEqual(expected.sort());
  expect(longResults.every(n => n === topicNames(ZID).length)).toBe(true);
  expect(checkedOut).toBe(0);
}, 120000);
