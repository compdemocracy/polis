import Config from "../config";
/** Published Delphi results. Backend choice is explicit and never falls back. */
import { resultQuery } from "./delphiResultSnapshot";
import { FAMILIES, decodeFamily, canonicalNumber } from "./delphiStorageCodec";

export function postgresResults(): boolean {
  const value = Config.delphiResultBackend || "dynamodb";
  if (!["postgres", "dynamodb"].includes(value)) throw new Error("invalid DELPHI_RESULT_BACKEND");
  return value === "postgres";
}
export function decodeAttribute(value: any): any {
  if ("S" in value) return value.S;
  if ("N" in value) {
    const n = Number(value.N);
    if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
      throw new Error("result numeric value exceeds reader precision");
    }
    return n;
  }
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(decodeAttribute);
  if ("M" in value) return decodeItem(value.M);
  if ("SS" in value) return new Set(value.SS);
  if ("NS" in value) return new Set(value.NS.map((n: string) => decodeAttribute({N:n})));
  if ("B" in value) return Buffer.from(value.B, "base64");
  if ("BS" in value) return new Set(value.BS.map((b: string) => Buffer.from(b,"base64")));
  throw new Error("invalid stored AttributeValue");
}
export function decodeItem(item: any): Record<string, any> {
  return Object.fromEntries(Object.entries(item).map(([k,v]) => [k, decodeAttribute(v)]));
}

/** Historical controls are display-only. Preserve exact values even when JS
 * cannot represent a legacy decimal; the raw tagged item remains available. */
export function decodeArchivedItem(tagged: any): Record<string,any> {
  let reason: string | undefined;
  const value = (av:any):any => {
    if ("N" in av) {
      const n=Number(av.N);
      if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n)) || canonicalNumber(String(n)) !== av.N) {
        reason="legacy numeric metadata exceeds JavaScript precision; exact decimal retained as text";
        return av.N;
      }
    }
    if ("L" in av) return av.L.map(value);
    if ("M" in av) return Object.fromEntries(Object.entries(av.M).map(([k,v])=>[k,value(v)]));
    if ("NS" in av) return new Set(av.NS.map((n:string)=>value({N:n})));
    return decodeAttribute(av);
  };
  const item=Object.fromEntries(Object.entries(tagged).map(([k,v])=>[k,value(v)]));
  return {...item,archived:true,...(reason ? {unreadable_metadata_reason:reason,legacy_control_item:tagged} : {})};
}

/** Only the expression grammar used by the audited Delphi readers is accepted. */
export function predicate(expression: string | undefined, input: any): (item: any) => boolean {
  if (!expression) return () => true;
  const resolve = (token: string, item: any) => token.startsWith(":")
    ? input.ExpressionAttributeValues?.[token]
    : item[input.ExpressionAttributeNames?.[token] || token];
  const clauses = expression.split(/\s+AND\s+/i).map(part => {
    const equal = part.trim().match(/^([#\w]+)\s*=\s*([:#\w]+)$/);
    if (equal) return (item: any) => resolve(equal[1],item) === resolve(equal[2],item);
    const prefix = part.trim().match(/^begins_with\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/);
    if (prefix) return (item: any) => String(resolve(prefix[1],item) ?? "").startsWith(String(resolve(prefix[2],item)));
    throw new Error(`unsupported result expression: ${part}`);
  });
  return item => clauses.every(clause => clause(item));
}

/** Bound parameters only: fields and values never become SQL identifiers. */
export function sqlPredicate(expression: string | undefined, input: any, values: any[]): string {
  if (!expression) return "TRUE";
  const bind = (value: any) => { values.push(value); return `$${values.length}`; };
  const field = (name: string) => `item->${bind(input.ExpressionAttributeNames?.[name] || name)}::text`;
  const operand = (token: string): string => {
    if (!token.startsWith(":")) return field(token);
    const value = input.ExpressionAttributeValues?.[token];
    const tagged = typeof value === "string" ? {S:value} : typeof value === "number" && Number.isFinite(value)
      ? {N:String(value)} : typeof value === "boolean" ? {BOOL:value} : undefined;
    if (!tagged) throw new Error("unsupported result expression value");
    return `${bind(JSON.stringify(tagged))}::jsonb`;
  };
  return expression.split(/\s+AND\s+/i).map(part => {
    const equal = part.trim().match(/^([#\w]+)\s*=\s*([:#\w]+)$/);
    if (equal) return `${field(equal[1])} = ${operand(equal[2])}`;
    const prefix = part.trim().match(/^begins_with\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/);
    if (prefix) {
      const value = input.ExpressionAttributeValues?.[prefix[2]];
      if (typeof value !== "string") throw new Error("begins_with requires a string");
      return `starts_with(${field(prefix[1])}->>'S',${bind(value)})`;
    }
    throw new Error(`unsupported result expression: ${part}`);
  }).join(" AND ");
}

export async function sendPostgresResult(command: any): Promise<any> {
  const input = command.input;
  const operation = command.constructor.name;
  const env = Config.delphiResultEnv;
  if (!env) throw new Error("DELPHI_RESULT_ENV is required for Postgres results");
  if (operation === "ListTablesCommand") return {TableNames: Object.keys(FAMILIES)};
  const family = input.TableName;
  if (!(family in FAMILIES)) {
    const error = new Error(`Unknown Delphi result family: ${family}`);
    error.name = "ResourceNotFoundException";
    throw error;
  }
  if (operation === "DescribeTableCommand") {
    await resultQuery("SELECT 1 FROM public.delphi_result_current_rows LIMIT 0");
    return {Table:{TableName:family,TableStatus:"ACTIVE"}};
  }
  if (!["QueryCommand","ScanCommand","GetCommand"].includes(operation)) {
    throw new Error("Published Delphi results are immutable; submit a new run");
  }
  let items: any[];
  let generations: Record<string,string> = {};
  if (family === "Delphi_JobQueue") {
    const scope = Config.delphiResultScope;
    const rows = await resultQuery<any>(`SELECT * FROM public.delphi_result_jobs WHERE env=$1
      ${scope ? "AND scope_key=$2" : ""}`,scope ? [env,scope] : [env]) as any[];
    const archives = await resultQuery<any>(`SELECT zid,scope_key,generation::text,codec_wire
      FROM public.delphi_result_legacy_controls WHERE env=$1 AND family='Delphi_JobQueue'
      ${scope ? "AND scope_key=$2" : ""} ORDER BY zid,scope_key`,scope ? [env,scope] : [env]) as any[];
    const activeIds = new Set(rows.map(row => row.job_id));
    const archived = new Map<string,any>();
    for (const archive of archives) {
      generations[`${archive.zid}:${archive.scope_key}`] = archive.generation;
      const decoded = decodeFamily(Buffer.from(archive.codec_wire,"utf8"));
      if (decoded.family !== family) throw new Error("legacy control family mismatch");
      for (const tagged of decoded.items) {
        const item = decodeArchivedItem(tagged);
        if (activeIds.has(item.job_id)) continue;
        const prior = archived.get(item.job_id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw new Error("Ambiguous archived job scopes; configure DELPHI_RESULT_SCOPE");
        archived.set(item.job_id,item);
      }
    }
    items = [...archived.values(),...rows];
  } else {
    const values: any[] = [env,family];
    let where = "env=$1 AND family=$2";
    const scope = Config.delphiResultScope;
    if (scope) { values.push(scope); where += ` AND scope_key=$${values.length}`; }
    where += " AND (" + sqlPredicate(input.KeyConditionExpression,input,values) + ")";
    for (const [name,value] of Object.entries(input.Key || {})) {
      where += " AND (" + sqlPredicate("#key = :value", {ExpressionAttributeNames:{"#key":name},ExpressionAttributeValues:{":value":value}}, values) + ")";
    }
    const rows = await resultQuery<any>(`SELECT zid,scope_key,generation::text,item FROM public.delphi_result_current_rows
      WHERE ${where} ORDER BY zid,scope_key,item_key::text`,values) as any[];
    const seen = new Map<string,any>();
    items = [];
    for (const row of rows) {
      generations[`${row.zid}:${row.scope_key}`] = row.generation;
      const item = decodeItem(row.item);
      const key = JSON.stringify(FAMILIES[family].key.map(([name]) => item[name]));
      if (seen.has(key)) {
        if (JSON.stringify(seen.get(key)) !== JSON.stringify(row.item)) throw new Error("Ambiguous result scopes; configure DELPHI_RESULT_SCOPE");
        continue;
      }
      seen.set(key,row.item); items.push(item);
    }
  }
  const cursorGenerations = input.ExclusiveStartKey?._polisPgGenerations;
  if (input.ExclusiveStartKey && JSON.stringify(cursorGenerations) !== JSON.stringify(generations)) {
    throw new Error("result generation changed; restart pagination");
  }
  // Existing HTTP handlers perform authorization before reaching this adapter.
  const matches = predicate(input.KeyConditionExpression,input);
  items = items.filter(matches);
  if (input.Key) items = items.filter(item => Object.entries(input.Key).every(([k,v]) => item[k] === v));
  const keys = FAMILIES[family].key.map(([k]) => k);
  const key = (item: any) => Object.fromEntries(keys.map(k => [k,item[k]]));
  const indexOrder: Record<string,string> = {ConversationIndex:"created_at",StatusCreatedIndex:"created_at",ReportIdTimestampIndex:"timestamp","zid-created_at-index":"created_at"};
  if (input.IndexName && !indexOrder[input.IndexName]) throw new Error("unsupported result index");
  const order = input.IndexName ? indexOrder[input.IndexName] : keys[keys.length-1];
  if (input.IndexName) items = items.filter(item => item[order] !== undefined && item[order] !== null);
  const compare = (a:any,b:any,fields:string[]) => {
    for (const field of fields) { if(a[field]<b[field])return -1;if(a[field]>b[field])return 1; }
    return 0;
  };
  items.sort((a,b) => compare(a,b,[order,...keys]));
  if (input.ScanIndexForward === false) items.reverse();
  if (input.ExclusiveStartKey) {
    const offset = items.findIndex(item => Object.entries(input.ExclusiveStartKey).filter(([k]) => k !== "_polisPgGenerations").every(([k,v]) => item[k] === v));
    if (offset < 0) throw new Error("stale result cursor");
    items = items.slice(offset+1);
  }
  const limit = input.Limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid result limit");
  const page = items.slice(0,limit);
  const filtered = page.filter(predicate(input.FilterExpression,input));
  if (operation === "GetCommand") {
    const item=filtered[0];
    if (family === "Delphi_JobQueue" && item && item.archived !== true) {
      const status=await resultQuery<{value:any}>("SELECT public.pq_job_status($1::text,$2::uuid) AS value",[env,item.job_id]);
      const attempt=status[0]?.value?.attempt_id;
      const entries=attempt ? await resultQuery<any>(`SELECT
        to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,
        CASE stream WHEN 'stderr' THEN 'ERROR' ELSE 'INFO' END AS level,line AS message
        FROM public.pq_attempt_logs($1::text,$2::uuid,NULL,1000)
        WHERE stream IN ('stdout','stderr')`,[env,attempt]) : [];
      return {Item:{...item,logs:{entries},log_attempt_id:attempt || null}};
    }
    return {Item:item};
  }
  return {Items:filtered, Count:filtered.length, ScannedCount:page.length,
    ...(items.length > limit ? {LastEvaluatedKey:{...key(page[page.length-1]),_polisPgGenerations:generations}} : {})};
}

export function resultClient<T extends {send: (...args: any[]) => any}>(factory: () => T): T {
  let legacy: T | undefined;
  return {send: (command: any) => postgresResults()
    ? sendPostgresResult(command)
    : (legacy ||= factory()).send(command)} as T;
}
