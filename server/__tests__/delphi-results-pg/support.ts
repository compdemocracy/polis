/** Shared setup for the PostgreSQL result-read suites: the same tagged items
 * go to DynamoDB Local (as tables) and to PostgreSQL (as a served bundle).
 * Generated data only. Needs DATABASE_URL (superuser, migrated) and
 * DYNAMODB_ENDPOINT; see scripts/test-delphi-result-reads.sh. */
import { createHash, randomUUID } from "crypto";
import { EventEmitter } from "events";
import { Client } from "pg";
import {
  BatchWriteItemCommand, CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { FAMILIES, encodeFamily } from "../../src/utils/delphiStorageCodec";

export type Tagged = Record<string, any>;
export const ENV = "parity";
export const SCOPE = "delphi";

export function dynamo(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT, region: "us-east-1",
    credentials: {accessKeyId: "generated", secretAccessKey: "generated"},
  });
}
export function dynamoDocument(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(dynamo());
}
export async function postgres(): Promise<Client> {
  const client = new Client({connectionString: process.env.DATABASE_URL});
  await client.connect();
  return client;
}

/** Index definitions the server's readers query. */
const INDEXES: Record<string, Array<[string, string, string]>> = {
  Delphi_NarrativeReports: [["ReportIdTimestampIndex", "report_id", "timestamp"]],
  Delphi_CollectiveStatement: [["zid-created_at-index", "zid", "created_at"]],
};

export async function resetDynamo(families: string[]): Promise<void> {
  const client = dynamo();
  const existing = (await client.send(new ListTablesCommand({}))).TableNames || [];
  for (const family of families) {
    if (existing.includes(family)) await client.send(new DeleteTableCommand({TableName: family}));
    const key = FAMILIES[family].key;
    const indexes = INDEXES[family] || [];
    const attributes = new Map<string, string>(key.map(([name, type]) => [name, type]));
    for (const [, hash, range] of indexes) { attributes.set(hash, "S"); attributes.set(range, "S"); }
    await client.send(new CreateTableCommand({
      TableName: family, BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [...attributes].map(([AttributeName, AttributeType]) => ({AttributeName, AttributeType: AttributeType as any})),
      KeySchema: key.map(([AttributeName], i) => ({AttributeName, KeyType: i === 0 ? "HASH" : "RANGE"})),
      ...(indexes.length ? {GlobalSecondaryIndexes: indexes.map(([IndexName, hash, range]) => ({
        IndexName, Projection: {ProjectionType: "ALL"},
        KeySchema: [{AttributeName: hash, KeyType: "HASH"}, {AttributeName: range, KeyType: "RANGE"}],
      }))} : {}),
    }));
  }
}

export async function putDynamo(family: string, items: Tagged[]): Promise<void> {
  const client = dynamo();
  for (let i = 0; i < items.length; i += 25) {
    let pending: any = {[family]: items.slice(i, i + 25).map(Item => ({PutRequest: {Item}}))};
    while (pending && Object.keys(pending).length) {
      const reply = await client.send(new BatchWriteItemCommand({RequestItems: pending}));
      pending = reply.UnprocessedItems;
    }
  }
}

export async function conversation(pg: Client, zid: number, reports: string[] = []): Promise<void> {
  await pg.query("INSERT INTO users(uid,hname,email) VALUES($1,'generated owner',$2) ON CONFLICT(uid) DO NOTHING", [zid, `generated-${zid}@example.invalid`]);
  await pg.query("INSERT INTO conversations(zid,owner,topic) VALUES($1,$1,'generated') ON CONFLICT(zid) DO NOTHING", [zid]);
  for (const report of reports) {
    await pg.query("INSERT INTO reports(report_id,zid) SELECT $1::text,$2 WHERE NOT EXISTS(SELECT 1 FROM reports WHERE report_id=$1::text)", [report, zid]);
  }
}

export type Publication = {jobId: string; artifactId: string; sha: string; generation: number};
/** Publish families as one generation of a conversation's served bundle.
 * Rows go through the release's own validating insert (pd_result_insert_family)
 * and seal; only the graph scaffolding around them is written directly, with
 * triggers and foreign keys off for this session, as a queue run would leave it.
 * With `previous`, the new artifact consumes the previous one, so families it
 * does not carry are served from the ancestor. */
export async function publish(pg: Client, opts: {env?: string; scope?: string; zid: number;
  families: Record<string, Tagged[]>; previous?: Publication}): Promise<Publication> {
  const env = opts.env ?? ENV, scope = opts.scope ?? SCOPE;
  const jobId = randomUUID(), runId = randomUUID(), attempt = randomUUID(), artifactId = randomUUID();
  const generation = (opts.previous?.generation ?? 0) + 1;
  let sha = "";
  await pg.query("BEGIN");
  try {
    await pg.query("SET LOCAL session_replication_role = replica");
    await pg.query(`INSERT INTO delphi_graph_nodes(env,zid,graph_id,job_id,run_id,node_key,declared)
      VALUES($1,$2,$3,$4,$5,'generated','{}')`, [env, opts.zid, randomUUID(), jobId, runId]);
    for (const [family, items] of Object.entries(opts.families)) {
      await pg.query("SELECT pd_result_insert_family($1,$2,$3,$4,$5)", [env, jobId, attempt, family, encodeFamily(family, items).toString("utf8")]);
    }
    const seal = (await pg.query("SELECT pd_result_seal_internal($1,$2) AS v", [env, attempt])).rows[0].v;
    const payload = JSON.stringify({results: seal});
    sha = createHash("sha256").update(payload).digest("hex");
    await pg.query(`INSERT INTO delphi_artifacts(env,artifact_id,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
      VALUES($1,$2,$3,$4,$5,'result','generated/1',$6,$7,$8)`, [env, artifactId, jobId, runId, attempt, payload, sha, Buffer.byteLength(payload)]);
    await pg.query("UPDATE delphi_result_batches SET artifact_id=$2 WHERE env=$1 AND batch_id=$3", [env, artifactId, attempt]);
    if (opts.previous) {
      await pg.query(`INSERT INTO delphi_graph_edges(env,consumer,producer,input_role,expected_sha,artifact_id)
        VALUES($1,$2,$3,'previous',$4,$5)`, [env, jobId, opts.previous.jobId, opts.previous.sha, opts.previous.artifactId]);
    }
    await pg.query(`INSERT INTO delphi_graph_served(env,zid,scope_key,generation,artifact_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(env,zid,scope_key) DO UPDATE SET generation=EXCLUDED.generation,artifact_id=EXCLUDED.artifact_id`,
      [env, opts.zid, scope, generation, artifactId]);
    await pg.query("COMMIT");
  } catch (error) {
    await pg.query("ROLLBACK");
    throw error;
  }
  return {jobId, artifactId, sha, generation};
}

/** Strip the PostgreSQL cursor's private fields for comparison with DynamoDB. */
export function cursorKey(key: any): any {
  if (!key) return key;
  return Object.fromEntries(Object.entries(key).filter(([k]) => !k.startsWith("_polisPg")));
}

/** Every page of a read, following LastEvaluatedKey. */
export async function pages(send: (command: any) => Promise<any>, Command: any, input: any, max = 500): Promise<any[]> {
  const out: any[] = [];
  let start: any;
  do {
    const reply = await send(new Command({...input, ...(start ? {ExclusiveStartKey: start} : {})}));
    out.push(reply);
    start = reply.LastEvaluatedKey;
  } while (start && out.length < max);
  return out;
}

/** One HTTP request's lifetime: earlier releases opened a request-wide result
 * snapshot in middleware; when that export exists, run inside it. */
export async function asRequest<T>(work: () => Promise<T>): Promise<T> {
  const snapshot = require("../../src/utils/delphiResultSnapshot");
  if (!snapshot.delphiResultSnapshot) return work();
  const res = new EventEmitter();
  return new Promise<T>((resolve, reject) => snapshot.delphiResultSnapshot({}, res, () => {
    work().then(value => { res.emit("finish"); resolve(value); }, error => { res.emit("finish"); reject(error); });
  }));
}

