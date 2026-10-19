// Real SQL: an imported result set (a private receipt plus results) publishes
// atomically through pd_result_mutate, on the agent-exchange pool. The
// collective-statement import is its caller; the narrative-family items here
// exercise more than one put per family. Runs only with DELPHI_WRITER_PROOF=1
// against a migrated database; generated rows only, no votes.
import {randomUUID} from "crypto";
import {GetCommand,QueryCommand} from "@aws-sdk/lib-dynamodb";

const campaign = process.env.DELPHI_WRITER_PROOF === "1" ? describe : describe.skip;
campaign("Postgres atomic import publication, real SQL",()=>{
  let pg: typeof import("../../src/db/pg-query").default;
  let publish: typeof import("../../src/utils/delphiResultWriter").publishPostgresResultsAtomically;
  let sendPostgresResult: typeof import("../../src/utils/delphiResults").sendPostgresResult;
  const env = "exchange-node-proof";
  const served = async()=>(await pg.queryP<{generation:string}>(
    "SELECT generation::text FROM delphi_result_publications WHERE env=$1 AND zid=1 AND scope_key='delphi'",[env]))[0]?.generation ?? "0";
  const narratives = async()=>(await sendPostgresResult(new QueryCommand({TableName:"Delphi_NarrativeReports",IndexName:"ReportIdTimestampIndex",
    KeyConditionExpression:"report_id = :rid",ExpressionAttributeValues:{":rid":"rlocalwriter"}}))).Items;
  const receipt = async(key:string)=>(await sendPostgresResult(new GetCommand({TableName:"Delphi_NarrativeReports",Key:{rid_section_model:key,timestamp:"receipt"}}))).Item;
  const statement = async(key:string)=>(await sendPostgresResult(new GetCommand({TableName:"Delphi_CollectiveStatement",Key:{zid_topic_jobid:key}}))).Item;
  const receiptPut = (exportId:string,digest:string)=>({TableName:"Delphi_NarrativeReports",
    Item:{rid_section_model:`rlocalwriter#external-import#${exportId}`,timestamp:"receipt",metadata:{result_digest:digest,imported_by:1}}});
  const runPut = (exportId:string,section:string)=>({TableName:"Delphi_NarrativeReports",
    Item:{rid_section_model:`rlocalwriter#${section}#external-writer#${exportId}`,report_id:"rlocalwriter",section,model:"external-writer",
      timestamp:new Date().toISOString(),job_id:exportId,report_data:JSON.stringify({id:section}),metadata:{provenance:"external agent",export_id:exportId}}});
  beforeAll(async()=>{
    process.env.DELPHI_RESULT_BACKEND="postgres";
    process.env.DELPHI_RESULT_ENV=env;
    process.env.DELPHI_RESULT_SCOPE="delphi";
    pg = (await import("../../src/db/pg-query")).default;
    ({publishPostgresResultsAtomically:publish} = await import("../../src/utils/delphiResultWriter"));
    ({sendPostgresResult} = await import("../../src/utils/delphiResults"));
    await pg.queryP("INSERT INTO users(uid,hname) VALUES(1,'generated writer owner') ON CONFLICT DO NOTHING");
    await pg.queryP("INSERT INTO conversations(zid,owner,topic) VALUES(1,1,'generated writer conversation') ON CONFLICT DO NOTHING");
    await pg.queryP("INSERT INTO reports(zid,report_id) SELECT 1,'rlocalwriter' WHERE NOT EXISTS(SELECT 1 FROM reports WHERE report_id='rlocalwriter')");
  });
  test("receipt, narrative run and statement publish together and are read back by the report readers",async()=>{
    const exportId=`external_${randomUUID()}`;
    const before=Number(await served());
    const result=await publish([receiptPut(exportId,"d1"),runPut(exportId,"topic_a"),
      {TableName:"Delphi_CollectiveStatement",Item:{zid_topic_jobid:`1#job#0#1#${exportId}`,zid:"1",created_at:new Date().toISOString(),model:"external-writer",provenance:"external agent"}}],
      "external-result-import");
    expect(result.outcome).toBe("published");
    expect(Number(await served())).toBe(before+3);
    expect((await narratives()).filter((n:any)=>n.job_id===exportId).map((n:any)=>n.section)).toEqual(["topic_a"]);
    expect((await narratives()).some((n:any)=>n.timestamp==="receipt")).toBe(false);
    expect((await receipt(`rlocalwriter#external-import#${exportId}`)).metadata).toEqual({result_digest:"d1",imported_by:1});
    expect((await statement(`1#job#0#1#${exportId}`)).provenance).toBe("external agent");
    const actors=await pg.queryP<{actor:string}>("SELECT DISTINCT actor FROM delphi_writer_runs WHERE env=$1",[env]);
    expect(actors.map(a=>a.actor)).toEqual(["external-result-import"]);
  });
  test("an existing key at any position rolls back every put",async()=>{
    const exportId=`external_${randomUUID()}`;
    await publish([receiptPut(exportId,"d1"),runPut(exportId,"topic_a")],"external-result-import");
    const generation=await served();
    const artifacts=(await pg.queryP<{n:string}>("SELECT count(*)::text n FROM delphi_artifacts WHERE env=$1",[env]))[0].n;
    const again=await publish([receiptPut(exportId,"d2"),runPut(exportId,"topic_b")],"external-result-import");
    expect(again).toMatchObject({outcome:"exists",index:0});
    expect((again as any).previous.metadata.M.result_digest).toEqual({S:"d1"});
    const second=`external_${randomUUID()}`;
    const clash=await publish([receiptPut(second,"d3"),{...runPut(exportId,"topic_a"),Item:(await narratives()).find((n:any)=>n.job_id===exportId&&n.section==="topic_a")}],"external-result-import");
    expect(clash).toMatchObject({outcome:"exists",index:1});
    expect(await receipt(`rlocalwriter#external-import#${second}`)).toBeUndefined();
    expect(await served()).toBe(generation);
    expect((await pg.queryP<{n:string}>("SELECT count(*)::text n FROM delphi_artifacts WHERE env=$1",[env]))[0].n).toBe(artifacts);
    expect((await narratives()).filter((n:any)=>n.job_id===exportId).map((n:any)=>n.section)).toEqual(["topic_a"]);
  });
  test("concurrent imports serialize: distinct exports both land, one export lands once",async()=>{
    const [a,b,c]=[randomUUID(),randomUUID(),randomUUID()].map(u=>`external_${u}`);
    const distinct=await Promise.all([a,b].map(e=>publish([receiptPut(e,"d"),runPut(e,"topic_a"),runPut(e,"topic_b")],"external-result-import")));
    expect(distinct.map(r=>r.outcome)).toEqual(["published","published"]);
    for(const e of [a,b])expect((await narratives()).filter((n:any)=>n.job_id===e)).toHaveLength(2);
    const same=await Promise.all([1,2,3].map(()=>publish([receiptPut(c,"d"),runPut(c,"topic_a")],"external-result-import")));
    expect(same.filter(r=>r.outcome==="published")).toHaveLength(1);
    expect(same.filter(r=>r.outcome==="exists")).toHaveLength(2);
  });
  test("families outside the audited set are refused and nothing is published",async()=>{
    const generation=await served();
    await expect(publish([receiptPut(`external_${randomUUID()}`,"d"),{TableName:"Delphi_CommentClustersLLMTopicNames",Item:{conversation_id:"1",topic_key:"x"}}],"external-result-import")).rejects.toThrow();
    expect(await served()).toBe(generation);
  });
  afterAll(async()=>{ await new Promise(r=>setTimeout(r,50)); });
});
