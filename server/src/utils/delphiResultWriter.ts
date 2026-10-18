import {randomUUID} from "crypto";
import Config from "../config";
import pg from "../db/pg-query";
import {canonicalNumber} from "./delphiStorageCodec";

function tag(value:any):any {
  if (value === null) return {NULL:true};
  if (typeof value === "string") return {S:value};
  if (typeof value === "boolean") return {BOOL:value};
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("Unsafe result integer");
    return {N:canonicalNumber(String(value))};
  }
  if (Buffer.isBuffer(value)) return {B:value.toString("base64")};
  if (Array.isArray(value)) return {L:value.map(tag)};
  if (value && typeof value === "object" && !(value instanceof Set)) return {M:tagItem(value)};
  throw new Error("Unsupported result value");
}
function tagItem(value:any):any {
  return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v])=>[k,tag(v)]));
}
/** Use a primary autocommit connection: request read snapshots are READ ONLY. */
export async function mutatePostgresResult(command:any):Promise<any> {
  const operation = command.constructor.name;
  const input = command.input;
  if (!Config.delphiResultEnv || !Config.delphiResultScope) throw new Error("Postgres writer env and scope required");
  if (input.ConditionExpression || input.UpdateExpression) throw new Error("Unsupported synchronous result condition");
  const item = operation === "DeleteItemCommand" ? input.Key : tagItem(input.Item || input.Key);
  const rows = await pg.queryP<{value:any}>(`SELECT public.pd_result_mutate(
    $1::text,$2::text,$3::text,$4::uuid,$5::text,$6::text,$7::jsonb) AS value`,
    [Config.delphiResultEnv,Config.delphiResultScope,"server-result-edit",randomUUID(),input.TableName,
      operation === "PutCommand" ? "put" : "delete",JSON.stringify(item)]);
  if (rows[0]?.value?.outcome !== "succeeded") throw new Error("Result mutation was not committed");
  return {producer_job_id:rows[0].value.job_id};
}

export type ResultPut = {TableName:string; Item:Record<string,any>};
export type AtomicPublication =
  | {outcome:"published"; producerJobIds:string[]}
  | {outcome:"exists"; index:number; previous:any};

/** Publish several items as one unit, each as a new item. Every put goes
 * through pd_result_mutate on one primary transaction: the first call takes
 * the conversation's writer lock, so the existence checks below and the writes
 * are serialized against other writers until COMMIT. If any key already holds
 * an item, nothing is written and the stored (tagged) item is returned.
 * The connection comes from the agent-exchange pool (db/pg-query.ts), never a
 * participation pool. */
export async function publishPostgresResultsAtomically(puts:ResultPut[], actor:string):Promise<AtomicPublication> {
  if (!Config.delphiResultEnv || !Config.delphiResultScope) throw new Error("Postgres writer env and scope required");
  if (!puts.length) throw new Error("No results to publish");
  const client = await pg.connectAgentExchange();
  let failure: Error | undefined;
  // A dropped socket emits on the client; capture it rather than crash.
  const onError = (error: Error) => { failure = failure || error; };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const producerJobIds:string[] = [];
    for (const [index,put] of puts.entries()) {
      const rows = (await client.query(`SELECT public.pd_result_mutate(
        $1::text,$2::text,$3::text,$4::uuid,$5::text,'put',$6::jsonb) AS value`,
        [Config.delphiResultEnv,Config.delphiResultScope,actor,randomUUID(),put.TableName,JSON.stringify(tagItem(put.Item))])).rows;
      const value = rows[0]?.value;
      if (value?.outcome !== "succeeded") throw new Error("Result mutation was not committed");
      if (value.previous !== null && value.previous !== undefined) {
        await client.query("ROLLBACK");
        return {outcome:"exists",index,previous:value.previous};
      }
      producerJobIds.push(value.job_id);
    }
    if (failure) throw failure;
    await client.query("COMMIT");
    return {outcome:"published",producerJobIds};
  } catch (error) {
    failure = failure || error as Error;
    try { await client.query("ROLLBACK"); } catch { /* the connection is discarded below */ }
    throw error;
  } finally {
    if (!failure) client.removeListener("error", onError);
    client.release(failure);
  }
}
