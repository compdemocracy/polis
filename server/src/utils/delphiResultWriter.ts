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
// Result edits run on the read-write pool, which votes and comments use, and
// pd_result_mutate serializes them on the conversation's writer lock. Issued
// together (the narrative-cache prune deletes a whole scan page at once), each
// would take a pooled connection only to wait on that lock, and enough of them
// fill the pool: votes then wait behind them, and the edits that cannot get a
// connection within the pool's acquire bound fail. One at a time per process,
// they hold at most one read-write connection; the others wait here, holding
// none.
let previousMutation: Promise<unknown> = Promise.resolve();
function afterPreviousMutation<T>(work: () => Promise<T>): Promise<T> {
  const turn = previousMutation.then(work);
  previousMutation = turn.catch(() => undefined);
  return turn;
}

/** Use a primary autocommit connection: request read snapshots are READ ONLY. */
export async function mutatePostgresResult(command:any):Promise<any> {
  const operation = command.constructor.name;
  const input = command.input;
  if (!Config.delphiResultEnv || !Config.delphiResultScope) throw new Error("Postgres writer env and scope required");
  if (input.ConditionExpression || input.UpdateExpression) throw new Error("Unsupported synchronous result condition");
  const item = operation === "DeleteItemCommand" ? input.Key : tagItem(input.Item || input.Key);
  const rows = await afterPreviousMutation(() => pg.queryP<{value:any}>(`SELECT public.pd_result_mutate(
    $1::text,$2::text,$3::text,$4::uuid,$5::text,$6::text,$7::jsonb) AS value`,
    [Config.delphiResultEnv,Config.delphiResultScope,"server-result-edit",randomUUID(),input.TableName,
      operation === "PutCommand" ? "put" : "delete",JSON.stringify(item)]));
  if (rows[0]?.value?.outcome !== "succeeded") throw new Error("Result mutation was not committed");
  return {producer_job_id:rows[0].value.job_id};
}
