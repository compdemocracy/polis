import Config from "../config";
import { mutatePostgresResult } from "./delphiResultWriter";
/** Published Delphi results. Backend choice is explicit and never falls back. */
import { ResultQuery, withResultSnapshot } from "./delphiResultSnapshot";
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

type Clause =
  | {kind:"equal"; left:string; right:string}
  | {kind:"prefix"; field:string; value:string};
function clauses(expression: string): Clause[] {
  return expression.split(/\s+AND\s+/i).map(part => {
    const equal = part.trim().match(/^([#\w]+)\s*=\s*([:#\w]+)$/);
    if (equal) return {kind:"equal", left:equal[1], right:equal[2]} as Clause;
    const prefix = part.trim().match(/^begins_with\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/);
    if (prefix) return {kind:"prefix", field:prefix[1], value:prefix[2]} as Clause;
    throw new Error(`unsupported result expression: ${part}`);
  });
}

/** Only the expression grammar used by the audited Delphi readers is accepted. */
export function predicate(expression: string | undefined, input: any): (item: any) => boolean {
  if (!expression) return () => true;
  const resolve = (token: string, item: any) => token.startsWith(":")
    ? input.ExpressionAttributeValues?.[token]
    : item[input.ExpressionAttributeNames?.[token] || token];
  const tests = clauses(expression).map(clause => clause.kind === "equal"
    ? (item: any) => resolve(clause.left,item) === resolve(clause.right,item)
    : (item: any) => String(resolve(clause.field,item) ?? "").startsWith(String(resolve(clause.value,item))));
  return item => tests.every(test => test(item));
}

/** A query value as the stored AttributeValue it must equal. */
function tagged(value: any): any {
  return typeof value === "string" ? {S:value} : typeof value === "number" && Number.isFinite(value)
    ? {N:canonicalNumber(String(value))} : typeof value === "boolean" ? {BOOL:value} : undefined;
}

/** Bound parameters only: fields and values never become SQL identifiers. */
export function sqlPredicate(expression: string | undefined, input: any, values: any[]): string {
  if (!expression) return "TRUE";
  const bind = (value: any) => { values.push(value); return `$${values.length}`; };
  const field = (name: string) => `item->${bind(input.ExpressionAttributeNames?.[name] || name)}::text`;
  const operand = (token: string): string => {
    if (!token.startsWith(":")) return field(token);
    const value = tagged(input.ExpressionAttributeValues?.[token]);
    if (!value) throw new Error("unsupported result expression value");
    return `${bind(JSON.stringify(value))}::jsonb`;
  };
  return clauses(expression).map(clause => {
    if (clause.kind === "equal") return `${field(clause.left)} = ${operand(clause.right)}`;
    const value = input.ExpressionAttributeValues?.[clause.value];
    if (typeof value !== "string") throw new Error("begins_with requires a string");
    return `starts_with(${field(clause.field)}->>'S',${bind(value)})`;
  }).join(" AND ");
}

/** DynamoDB ends a Query or Scan page with the item that brings the data read
 * (before any FilterExpression) to 1 MB, or with the Limit-th item, and then
 * returns LastEvaluatedKey even if nothing follows. Item sizes follow DynamoDB's
 * rules; the parity suite pins them against DynamoDB Local. */
export const DYNAMO_PAGE_BYTES = 1024 * 1024;
const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** Numbers are stored as base-100 digit pairs aligned on the decimal point,
 * without leading or trailing zero pairs, plus one byte (two if negative). */
function numberBytes(n: string): number {
  let [whole, fraction = ""] = n.replace(/^-/, "").split(".");
  if (whole.length % 2) whole = "0" + whole;
  if (fraction.length % 2) fraction += "0";
  const pairs = (whole + fraction).match(/../g) || [];
  while (pairs.length && pairs[0] === "00") pairs.shift();
  while (pairs.length && pairs[pairs.length - 1] === "00") pairs.pop();
  return 1 + pairs.length + (n.startsWith("-") ? 1 : 0);
}
/** Size of a stored (tagged) AttributeValue under DynamoDB's item-size rules. */
export function attributeBytes(value: any): number {
  if ("S" in value) return utf8Bytes(value.S);
  if ("N" in value) return numberBytes(value.N);
  if ("B" in value) return Buffer.from(value.B, "base64").length;
  if ("BOOL" in value || "NULL" in value) return 1;
  if ("SS" in value) return value.SS.reduce((n: number, s: string) => n + utf8Bytes(s), 0);
  if ("NS" in value) return value.NS.reduce((n: number, s: string) => n + numberBytes(s), 0);
  if ("BS" in value) return value.BS.reduce((n: number, s: string) => n + Buffer.from(s, "base64").length, 0);
  if ("L" in value) return 3 + value.L.reduce((n: number, v: any) => n + 1 + attributeBytes(v), 0);
  if ("M" in value) return 3 + Object.entries(value.M).reduce((n, [k, v]) => n + 1 + utf8Bytes(k) + attributeBytes(v), 0);
  throw new Error("invalid stored AttributeValue");
}
export function itemBytes(item: any): number {
  return Object.entries(item).reduce((n, [k, v]) => n + utf8Bytes(k) + attributeBytes(v), 0);
}
/** A plain JS value as the AttributeValue DynamoDB would hold for it. */
function marshal(value: any): any {
  if (value === null || value === undefined) return {NULL:true};
  if (typeof value === "string") return {S:value};
  if (typeof value === "boolean") return {BOOL:value};
  if (typeof value === "number") return {N:String(value)};
  if (Buffer.isBuffer(value)) return {B:value.toString("base64")};
  if (value instanceof Set) {
    const members = [...value];
    return typeof members[0] === "number" ? {NS:members.map(String)} : Buffer.isBuffer(members[0])
      ? {BS:members.map(b => b.toString("base64"))} : {SS:members};
  }
  if (Array.isArray(value)) return {L:value.map(marshal)};
  return {M:Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v]) => [k, marshal(v)]))};
}

type Candidate = { item: Record<string,any>; bytes: number; after?: any };
/** Whether the page is full once these items are on it. */
const pageFull = (count: number, bytes: number, limit: number | undefined) =>
  (limit !== undefined && count >= limit) || bytes >= DYNAMO_PAGE_BYTES;
/** Cut one DynamoDB page from items in read order; `full` means DynamoDB
 * would return LastEvaluatedKey. */
function cutPage(candidates: Candidate[], limit: number | undefined): {page: Candidate[]; full: boolean} {
  let bytes = 0;
  const page: Candidate[] = [];
  for (const candidate of candidates) {
    if (pageFull(page.length, bytes, limit)) break;
    page.push(candidate);
    bytes += candidate.bytes;
  }
  return {page, full: pageFull(page.length, bytes, limit)};
}

const indexOrder: Record<string,string> = {ConversationIndex:"created_at",StatusCreatedIndex:"created_at",ReportIdTimestampIndex:"timestamp","zid-created_at-index":"created_at"};
const indexHash: Record<string,string> = {ConversationIndex:"conversation_id",StatusCreatedIndex:"status",ReportIdTimestampIndex:"report_id","zid-created_at-index":"zid"};
/** An index page's LastEvaluatedKey carries the index key and the table key. */
const indexKey = (input: any, item: any) => input.IndexName
  ? {[indexHash[input.IndexName]]: item[indexHash[input.IndexName]], [indexOrder[input.IndexName]]: item[indexOrder[input.IndexName]]} : {};

/** The conversations a read can touch, as a SQL integer[] expression (NULL: any).
 * Result writers bind every row to its producing conversation by these
 * attributes (M28 pd_result_insert_family), so narrowing never drops a row the
 * read would have returned. */
function zidScope(equals: Record<string,any>, prefixes: Record<string,any>, values: any[]): string {
  const bind = (value: any) => { values.push(value); return `$${values.length}`; };
  const number = (value: any) => typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value)
    : typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
  const split: Array<[string,string]> = [["conversation_id",""],["zid",""],["zid_tick",":"],["zid_tick_gid",":"],["zid_topic_jobid","#"]];
  for (const [name, separator] of split) {
    if (!(name in equals)) continue;
    const value = equals[name];
    const zid = number(separator && typeof value === "string" ? value.split(separator)[0] : value);
    return `${bind(zid === undefined ? [] : [zid])}::integer[]`;
  }
  for (const name of ["rid_section_model","report_id"]) {
    if (typeof equals[name] === "string") {
      return `ARRAY(SELECT zid FROM public.reports WHERE report_id=${bind(equals[name].split("#")[0])})`;
    }
  }
  const prefix = prefixes.rid_section_model ?? prefixes.report_id;
  if (typeof prefix === "string") {
    return prefix.includes("#")
      ? `ARRAY(SELECT zid FROM public.reports WHERE report_id=${bind(prefix.split("#")[0])})`
      : `ARRAY(SELECT zid FROM public.reports WHERE starts_with(report_id,${bind(prefix)}))`;
  }
  return "NULL::integer[]";
}

/** The `attribute = :value` and `begins_with(attribute, :value)` clauses. */
function conditions(expression: string | undefined, input: any) {
  const equals: Record<string,any> = {};
  const prefixes: Record<string,any> = {};
  let other = false;
  for (const clause of expression ? clauses(expression) : []) {
    if (clause.kind === "equal" && !clause.left.startsWith(":") && clause.right.startsWith(":")) {
      equals[input.ExpressionAttributeNames?.[clause.left] || clause.left] = input.ExpressionAttributeValues?.[clause.right];
    } else if (clause.kind === "prefix") {
      prefixes[input.ExpressionAttributeNames?.[clause.field] || clause.field] = input.ExpressionAttributeValues?.[clause.value];
    } else other = true;
  }
  return {equals, prefixes, other};
}
/** jsonb's text form of a tagged scalar, as PostgreSQL prints item_key->0. */
const jsonbText = (value: any) => {
  const [tag, body] = Object.entries(tagged(value) ?? {NULL:true})[0];
  return `{${JSON.stringify(tag)}: ${JSON.stringify(body)}}`;
};

const PAGE_CHUNK = 500;

async function readResults(query: ResultQuery, command: any, operation: string): Promise<any> {
  const input = command.input;
  const family = input.TableName;
  const scope = Config.delphiResultScope;
  const keys = FAMILIES[family].key.map(([k]) => k);
  const key = (item: any) => Object.fromEntries(keys.map(k => [k,item[k]]));
  if (input.IndexName && !indexOrder[input.IndexName]) throw new Error("unsupported result index");
  const limit = operation === "GetCommand" ? undefined : input.Limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("invalid result limit");
  const start = input.ExclusiveStartKey;
  const scan = operation === "ScanCommand";
  const condition = conditions(scan ? input.FilterExpression : input.KeyConditionExpression, input);
  const equals: Record<string,any> = {...condition.equals, ...(input.Key || {})};
  const values: any[] = [Config.delphiResultEnv, family];
  if (scope) values.push(scope);
  const zids = zidScope(equals, condition.prefixes, values);
  const base = values.slice();
  const scopeSql = scope ? "$3" : "NULL";
  // A cursor is a key position, never a publication: like a DynamoDB
  // ExclusiveStartKey, a later page reads what is served when it runs and
  // continues after that position, even if a publication landed in between.
  const [hashName, rangeName] = keys;
  const rangeType = FAMILIES[family].key[keys.length - 1][1];
  const unusualKeyCondition = !scan && (condition.other || Object.keys(condition.equals).some(k => !keys.includes(k))
    || Object.keys(condition.prefixes).some(k => k !== rangeName));
  const seen = new Map<string,any>();
  const accept = (row: any): boolean => {
    const id = JSON.stringify(row.item_key);
    if (seen.has(id)) {
      if (JSON.stringify(seen.get(id)) !== JSON.stringify(row.item)) throw new Error("Ambiguous result scopes; configure DELPHI_RESULT_SCOPE");
      return false;
    }
    seen.set(id, row.item);
    return true;
  };
  const pageSql = (rest: string) => `SELECT zid,scope_key,item_key,item,sort_n::text,sort_t,hash_t
    FROM public.pd_result_page($1,${zids},${scopeSql},$2,${rest})`;
  const keyMatches = (item: any) => Object.entries(input.Key || {}).every(([k,v]) => item[k] === v);
  const keyPredicate = scan ? () => true : predicate(input.KeyConditionExpression, input);
  let page: Candidate[] = [];
  let more = false;
  if (!input.IndexName && !unusualKeyCondition && (scan || hashName in equals)) {
    // Base-table reads walk the family in DynamoDB key order, one bounded
    // keyset chunk at a time, and stop at the first item past the page.
    const backward = !scan && input.ScanIndexForward === false;
    const bind = (value: any) => { values.push(value); return `$${values.length}`; };
    const hash = scan ? "NULL" : `${bind(JSON.stringify(tagged(equals[hashName]) ?? null))}::jsonb`;
    const sortEq = rangeName && rangeName in equals ? `${bind(JSON.stringify(tagged(equals[rangeName]) ?? null))}::jsonb` : "NULL";
    const sortPrefix = !scan && rangeName && rangeName in condition.prefixes ? bind(String(condition.prefixes[rangeName])) : "NULL";
    const last = keys[keys.length-1];
    let after = start ? (start._polisPgAfter ?? {
      n: rangeType === "N" ? String(start[last]) : undefined, t: rangeType === "N" ? "" : start[last],
      h: jsonbText(start[hashName]), z: backward ? -2147483648 : 2147483647, s: backward ? "" : "\u{10FFFF}",
    }) : null;
    const afterParam = values.push(null);
    const limitParam = values.push(null);
    const sql = pageSql(`${hash},${sortEq},${sortPrefix},$${afterParam}::jsonb,${backward},$${limitParam}::integer`);
    let bytes = 0;
    for (;;) {
      const want = limit === undefined ? PAGE_CHUNK : Math.min(PAGE_CHUNK, limit - page.length);
      values[afterParam - 1] = after ? JSON.stringify(after) : null;
      values[limitParam - 1] = want;
      const rows = await query<any>(sql, values);
      for (const row of rows) {
        after = {n: row.sort_n, t: row.sort_t, h: row.hash_t, z: row.zid, s: row.scope_key};
        if (!accept(row)) continue;
        const item = decodeItem(row.item);
        if (!keyMatches(item) || !keyPredicate(item)) continue;
        const size = itemBytes(row.item);
        page.push({item, bytes: size, after});
        bytes += size;
        if (pageFull(page.length, bytes, limit)) { more = true; break; }
      }
      if (more || rows.length < want) break;
    }
  } else {
    // Index reads: the conversation's rows of this family, in index order.
    let candidates: Candidate[] = [];
    for (const row of await query<any>(pageSql("NULL,NULL,NULL,NULL,false,NULL"), base)) {
      if (!accept(row)) continue;
      const item = decodeItem(row.item);
      if (!keyMatches(item) || !keyPredicate(item)) continue;
      candidates.push({item, bytes: itemBytes(row.item)});
    }
    candidates = afterStart(orderedCandidates(candidates, input, keys), start, input, keys);
    ({page, full: more} = cutPage(candidates, limit));
  }
  const filtered = page.map(c => c.item).filter(predicate(input.FilterExpression,input));
  if (operation === "GetCommand") return {Item: filtered[0]};
  let lastKey: any;
  if (more) {
    const last = page[page.length-1];
    // Without a configured scope, copies of the last key in other scopes are
    // the same item (or refused as ambiguous above): resume past all of them.
    const after = last.after && !scope ? {...last.after, ...(input.ScanIndexForward === false && !scan
      ? {z: -2147483648, s: ""} : {z: 2147483647, s: "\u{10FFFF}"})} : last.after;
    lastKey = {...key(last.item), ...indexKey(input, last.item), ...(after ? {_polisPgAfter: after} : {})};
  }
  return {Items:filtered, Count:filtered.length, ScannedCount:page.length, ...(lastKey ? {LastEvaluatedKey:lastKey} : {})};
}

/** Index order: the index's range attribute, then the table key. */
function compareFor(input: any, keys: string[]) {
  const order = input.IndexName ? indexOrder[input.IndexName] : keys[keys.length-1];
  return (a:any,b:any) => {
    for (const field of [order,...keys]) { if(a[field]<b[field])return -1;if(a[field]>b[field])return 1; }
    return 0;
  };
}
function orderedCandidates(candidates: Candidate[], input: any, keys: string[]): Candidate[] {
  const order = input.IndexName ? indexOrder[input.IndexName] : keys[keys.length-1];
  if (input.IndexName) candidates = candidates.filter(c => c.item[order] !== undefined && c.item[order] !== null);
  const compare = compareFor(input, keys);
  candidates.sort((a,b) => compare(a.item,b.item));
  if (input.ScanIndexForward === false) candidates.reverse();
  return candidates;
}
/** The items strictly after the cursor's key position in read order. As on
 * DynamoDB, the cursor item itself need not still exist. */
function afterStart(candidates: Candidate[], start: any, input: any, keys: string[]): Candidate[] {
  if (!start) return candidates;
  const compare = compareFor(input, keys);
  const position = Object.fromEntries(Object.entries(start).filter(([k]) => !k.startsWith("_polisPg")));
  const backward = input.ScanIndexForward === false;
  return candidates.filter(c => backward ? compare(c.item, position) < 0 : compare(c.item, position) > 0);
}

/** Delphi_JobQueue: queue rows plus archived legacy controls of the served bundles. */
async function readJobs(query: ResultQuery, command: any, operation: string): Promise<any> {
  const input = command.input;
  const env = Config.delphiResultEnv as string;
  const family = input.TableName;
  const scope = Config.delphiResultScope;
  const keys = FAMILIES[family].key.map(([k]) => k);
  const {equals} = conditions(input.KeyConditionExpression, input);
  const conversation = typeof equals.conversation_id === "string" ? equals.conversation_id : undefined;
  const jobId = typeof input.Key?.job_id === "string" ? input.Key.job_id : undefined;
  const values: any[] = scope ? [env,scope] : [env];
  const narrow = conversation !== undefined ? ` AND conversation_id=$${values.push(conversation)}`
    : jobId !== undefined ? ` AND job_id=$${values.push(jobId)}` : "";
  const rows = await query<any>(`SELECT job_id,conversation_id,report_id,status,job_type,job_config,created_at,completed_at,error,env,scope_key
    FROM public.delphi_result_jobs WHERE env=$1 ${scope ? "AND scope_key=$2" : ""}${narrow}`,values);
  const activeIds = new Set(rows.map(row => row.job_id));
  const archived = new Map<string,any>();
  const tags = new Map<any,any>();
  // A job id found among queue rows hides any archived copy, so only a Get of
  // an id with no queue row (an imported historical job) reads every archive.
  if (!(jobId !== undefined && activeIds.has(jobId))) {
    const archiveValues: any[] = scope ? [env,scope] : [env];
    const zid = conversation !== undefined && /^\d{1,9}$/.test(conversation) ? Number(conversation) : undefined;
    const archiveNarrow = conversation === undefined ? "" : zid === undefined ? " AND FALSE"
      : ` AND zid=$${archiveValues.push(zid)}`;
    const archives = await query<any>(`SELECT zid,scope_key,codec_wire
      FROM public.delphi_result_legacy_controls WHERE env=$1 AND family='Delphi_JobQueue'
      ${scope ? "AND scope_key=$2" : ""}${archiveNarrow} ORDER BY zid,scope_key`,archiveValues);
    for (const archive of archives) {
      const decoded = decodeFamily(Buffer.from(archive.codec_wire,"utf8"));
      if (decoded.family !== family) throw new Error("legacy control family mismatch");
      for (const tag of decoded.items) {
        const item = decodeArchivedItem(tag);
        if (activeIds.has(item.job_id)) continue;
        const prior = archived.get(item.job_id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw new Error("Ambiguous archived job scopes; configure DELPHI_RESULT_SCOPE");
        archived.set(item.job_id,item);
        tags.set(item,tag);
      }
    }
  }
  // As for results: the cursor is a key position, not a publication.
  const start = input.ExclusiveStartKey;
  const matches = predicate(input.KeyConditionExpression,input);
  let candidates: Candidate[] = [...archived.values(),...rows].filter(matches)
    .filter(item => !input.Key || Object.entries(input.Key).every(([k,v]) => item[k] === v))
    .map(item => ({item, bytes: itemBytes(tags.get(item) ?? marshal(item).M)}));
  candidates = afterStart(orderedCandidates(candidates, input, keys), start, input, keys);
  const limit = operation === "GetCommand" ? undefined : input.Limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("invalid result limit");
  const {page, full} = cutPage(candidates, limit);
  const filtered = page.map(c => c.item).filter(predicate(input.FilterExpression,input));
  if (operation === "GetCommand") {
    const item=filtered[0];
    if (item && item.archived !== true) {
      const status=await query<{value:any}>("SELECT public.pq_job_status($1::text,$2::uuid) AS value",[env,item.job_id]);
      const attempt=status[0]?.value?.attempt_id;
      const entries=attempt ? await query<any>(`SELECT
        to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,
        CASE stream WHEN 'stderr' THEN 'ERROR' ELSE 'INFO' END AS level,line AS message
        FROM public.pq_attempt_logs($1::text,$2::uuid,NULL,1000)
        WHERE stream IN ('stdout','stderr')`,[env,attempt]) : [];
      return {Item:{...item,logs:{entries},log_attempt_id:attempt || null}};
    }
    return {Item:item};
  }
  const last = page[page.length-1]?.item;
  return {Items:filtered, Count:filtered.length, ScannedCount:page.length,
    ...(full ? {LastEvaluatedKey:{...Object.fromEntries(keys.map(k => [k,last[k]])),...indexKey(input, last)}} : {})};
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
    await withResultSnapshot(query => query("SELECT 1 FROM public.delphi_result_current_rows LIMIT 0"));
    return {Table:{TableName:family,TableStatus:"ACTIVE"}};
  }
  if (["PutCommand","DeleteCommand","DeleteItemCommand"].includes(operation)) return mutatePostgresResult(command);
  if (!["QueryCommand","ScanCommand","GetCommand"].includes(operation)) {
    throw new Error("Published Delphi results are immutable; submit a new run");
  }
  // Existing HTTP handlers perform authorization before reaching this adapter.
  // One call, one snapshot: like a DynamoDB call, it sees every committed write.
  return withResultSnapshot(query => family === "Delphi_JobQueue"
    ? readJobs(query, command, operation) : readResults(query, command, operation));
}

export function resultClient<T extends {send: (...args: any[]) => any}>(factory: () => T): T {
  let legacy: T | undefined;
  return {send: (command: any) => postgresResults()
    ? sendPostgresResult(command)
    : (legacy ||= factory()).send(command)} as T;
}
