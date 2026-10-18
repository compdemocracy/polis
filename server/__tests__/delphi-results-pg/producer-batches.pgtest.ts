/** A writer batch holds only the families its run produced; a family it did
 * not produce is served from the earlier batch that did. Every server read
 * returns the same reply as when each writer batch carried a full copy of the
 * publication, after each step of: full run, narrative batch, collective
 * statement save, second full run. Generated data only. */
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "pg";
import { sendPostgresResult } from "../../src/utils/delphiResults";
import { FAMILIES } from "../../src/utils/delphiStorageCodec";
import { conversation, pages, postgres, publish, Publication, Tagged, SCOPE } from "./support";
import { collectiveStatements, narrativeReports } from "./dataset";

const ZID = 501, REPORT = "r501generatedproducer00";
const COPY = "producer-batches-copy", OWN = "producer-batches-own";
const RESULTS = Object.keys(FAMILIES).filter(f => !["Delphi_JobQueue", "Delphi_JobActiveGuard"].includes(f));
const KEPT = ["Delphi_NarrativeReports", "report_narrative_store", "Delphi_CollectiveStatement", "Delphi_TopicAgendaSelections"];
const COMPUTE = RESULTS.filter(f => !KEPT.includes(f));
const EMPTIED = ["Delphi_CommentExtremity", "Delphi_KMeansClusters"];

/** Rows for every family a full run clears, distinct per run; EMPTIED families get none. */
function computeRows(run: number, count: number, emptied: string[] = []): Record<string, Tagged[]> {
  const special: Record<string, string> = {zid: String(ZID), conversation_id: String(ZID), zid_tick: `${ZID}:${run}`,
    zid_tick_gid: `${ZID}:${run}:0`};
  return Object.fromEntries(COMPUTE.map(family => {
    const rows = new Map<string, Tagged>();
    for (let i = 0; i < (emptied.includes(family) ? 0 : count); i++) {
      const key = Object.fromEntries(FAMILIES[family].key.map(([k, t]) => [k, t === "N" ? {N: String(i)}
        : {S: special[k] ?? `g${run}-${String(i).padStart(3, "0")}`}]));
      rows.set(JSON.stringify(key), {...key, label: {S: `run ${run} row ${i}`}, value: {N: `${run}.${i}1`},
        names: {SS: ["a", `g${run}`]}, nested: {M: {list: {L: [{N: String(i)}, {BOOL: true}]}}}});
    }
    return [family, [...rows.values()]];
  }));
}

/** What the writer used to emit: every family, untouched ones copied, absent ones empty. */
const everyFamily = (families: Record<string, Tagged[]>) =>
  Object.fromEntries(RESULTS.map(f => [f, families[f] ?? []]));

/** The server's reads of every family: a full Scan, the conversation Query
 * where the table is keyed by conversation, and the two index reads. */
function reads(): Array<[any, any]> {
  const cid = String(ZID);
  const out: Array<[any, any]> = RESULTS.map(f => [ScanCommand, {TableName: f}]);
  for (const f of RESULTS) {
    const hash = FAMILIES[f].key[0][0];
    if (hash === "conversation_id" || hash === "zid") {
      out.push([QueryCommand, {TableName: f, KeyConditionExpression: `${hash} = :v`, ExpressionAttributeValues: {":v": cid}}]);
    }
  }
  out.push([QueryCommand, {TableName: "Delphi_NarrativeReports", IndexName: "ReportIdTimestampIndex",
    KeyConditionExpression: "report_id = :rid", ExpressionAttributeValues: {":rid": REPORT}}]);
  out.push([QueryCommand, {TableName: "Delphi_CollectiveStatement", IndexName: "zid-created_at-index",
    KeyConditionExpression: "zid = :zid", ExpressionAttributeValues: {":zid": cid}, ScanIndexForward: false}]);
  return out;
}

async function served(pg: Client, env: string): Promise<any> {
  process.env.DELPHI_RESULT_ENV = env;
  const replies = [];
  for (const [Command, input] of reads()) replies.push(await pages(sendPostgresResult, Command, {...input, Limit: 7}));
  const bundle = (await pg.query("SELECT pd_result_served_bundle($1,$2,$3)::text AS v", [env, ZID, SCOPE])).rows[0].v;
  return {replies, bundle};
}

let pg: Client;
beforeAll(async () => {
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  pg = await postgres();
  await conversation(pg, ZID, [REPORT]);
});
afterAll(async () => { await pg?.end(); });

test("every server read is unchanged when batches hold only their own families", async () => {
  const run1 = computeRows(1, 12), run2 = computeRows(2, 9, EMPTIED);
  const narratives = narrativeReports(REPORT, 3), statement = collectiveStatements(ZID, 1);
  const steps: Array<[string, Record<string, Tagged[]>, Record<string, Tagged[]>]> = [
    ["full run", everyFamily(run1), run1],
    ["narrative batch", everyFamily({...run1, Delphi_NarrativeReports: narratives}), {Delphi_NarrativeReports: narratives}],
    // A statement save was already one family (pd_result_mutate), on both sides.
    ["statement save", {Delphi_CollectiveStatement: statement}, {Delphi_CollectiveStatement: statement}],
    ["second full run", everyFamily({...run2, Delphi_NarrativeReports: narratives, Delphi_CollectiveStatement: statement}), run2],
  ];
  let copy: Publication | undefined, own: Publication | undefined;
  for (const [step, copied, produced] of steps) {
    copy = await publish(pg, {env: COPY, zid: ZID, families: copied, previous: copy});
    own = await publish(pg, {env: OWN, zid: ZID, families: produced, previous: own});
    const [before, after] = [await served(pg, COPY), await served(pg, OWN)];
    expect({step, ...after}).toEqual({step, ...before});
  }
  const last = await served(pg, OWN);
  const scan = (family: string) => last.replies[RESULTS.indexOf(family)].flatMap((r: any) => r.Items);
  for (const family of EMPTIED) expect(scan(family)).toEqual([]);
  expect(scan("Delphi_UMAPGraph").map((i: any) => i.label)).toEqual(run2.Delphi_UMAPGraph.map(i => i.label.S));
  expect(scan("Delphi_CollectiveStatement")).toHaveLength(1);
  const stored = async (env: string) => (await pg.query(`SELECT count(*)::int AS families,
    COALESCE(sum(row_count),0)::int AS rows FROM delphi_result_families WHERE env=$1`, [env])).rows[0];
  const [copied, owned] = [await stored(COPY), await stored(OWN)];
  expect(owned.families).toBe(14 + 1 + 1 + 14);
  expect(copied.families).toBe(18 * 3 + 1);
  expect(owned.rows).toBeLessThan(copied.rows);
  process.stdout.write(`${JSON.stringify({copied, owned})}\n`);
}, 120000);
