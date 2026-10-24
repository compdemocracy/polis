"use strict";
const fs=require("node:fs"),path=require("node:path");
exports.start=async function(context) {
  const prior=await require("./delphi-topics-pg-check.cjs").start(context);
  const {request,serialize,keys,database,oidc}=context;
  const port=Number(process.env.P2ZERO_RUST_PORT||5100),captures=[],handoffs=[];
  async function compare(c,token,node) {
    const rust=serialize(c,await request(c.path,token,port));
    captures.push({case:c.id,node:JSON.parse(node),rust:JSON.parse(rust),equal:node===rust});
    fs.writeFileSync(path.join(keys,"reports-captures.json"),JSON.stringify(captures,null,2)+"\n");
  }
  return {
    matches(c){return prior.matches(c)||c.route==="GET /api/v3/delphi/reports";},
    async compare(c,token,node){if(c.route==="GET /api/v3/delphi/reports")await compare(c,token,node);else await prior.compare(c,token,node);},
    async finish(){
      await prior.finish();
      const priorResults=JSON.parse(fs.readFileSync(path.join(keys,"results.json")));
      const {createRequire}=require("node:module"),{Client}=createRequire(path.resolve(process.cwd(),"package.json"))("pg");
      const {publish}=require(path.resolve(process.cwd(),"__tests__/delphi-results-pg/support.ts"));
      const db=new Client({connectionString:database});await db.connect();
      const query="/api/v3/delphi/reports?report_id=r2p2zero105",family="Delphi_NarrativeReports";
      async function check(id,url,token,verify){
        const c={id:`reports/${id}`,state:"supplemental",route:"GET /api/v3/delphi/reports",path:url,auth:token?"other":"none"};
        const n=await request(url,token);if(n.status!==200)throw Error(`${id}: Node ${n.status}`);
        if(verify)verify(JSON.parse(n.body));await compare(c,token,serialize(c,n));
      }
      const narrative=(section,job,ts,model="m")=>({report_id:{S:"r2p2zero105"},rid_section_model:{S:`r2p2zero105#${section}#${model}`},job_id:{S:job},timestamp:{S:ts},model:{S:model},report_data:{S:"generated narrative"}});
      let rows=[narrative("global_old","old","2023-11-14T00:00:00Z"),narrative("10","new","2023-11-15T00:00:00Z"),narrative("2","new","2023-11-15T00:00:01Z"),narrative("10","new","2023-11-15T00:00:02Z","second")];
      rows[3].errors={NULL:true};rows[3].metadata={M:{nested:{L:[{BOOL:true},{N:"0.25"},{S:"generated"}]},"10":{S:"ten"},"2":{S:"two"}}};
      let previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,families:{[family]:rows}});
      await check("latest-collisions-order",query,null,b=>{if(b.current_job_id!=="new"||Object.keys(b.reports).join()!=="2,10"||b.reports[10].model!=="second"||b.available_runs[0].sectionCount!==3||b.reports[10].errors!==null)throw Error("group fixture");});
      await check("auth-ignored",query,oidc("p2zero|other","other@example.invalid"));
      await check("old-job",query+"&job_id=old",null,b=>{if(b.current_job_id!=="old")throw Error("old job");});
      await check("missing-job",query+"&job_id=missing",null,b=>{if(Object.keys(b.reports).length||b.available_runs.some(r=>r.isCurrent))throw Error("missing job");});
      await check("section-substring",query+"&job_id=old&section=global",null,b=>{if(!b.reports.global)throw Error("substring");});
      await check("section-missing",query+"&section=absent",null,b=>{if(Object.keys(b.reports.absent).length)throw Error("section missing");});
      await check("topic-wrapper-data",query+"&section=10&topic_key=metadata",null,b=>{if(b.data.nested[1]!==0.25)throw Error("topic wrapper");});
      await check("topic-missing",query+"&section=10&topic_key=absent",null,b=>{if(b.message!=="Topic report not found")throw Error("missing topic");});
      rows=[narrative("undefined","current","2023-11-15T00:00:00Z")];
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:rows}});
      await check("unmatched-section-undefined",query+"&section=zzz",null,b=>{if(b.reports.zzz.section!=="undefined"||b.reports.zzz.report_data!=="generated narrative")throw Error("undefined section fallback");});
      await check("unmatched-topic-no-undefined-fallback",query+"&section=zzz&topic_key=report_data",null,b=>{if(b.message!=="Topic report not found")throw Error("topic direct lookup");});
      for(const value of ["%", "%FF", "a%zz%41", "%C3"]){
        const url=query+"&section="+value,n=await request(url,null),r=await request(url,null,port);
        if(n.status!==200||r.status!==502)throw Error(`query decoding handback ${value}: ${n.status}/${r.status}`);
        const body=JSON.parse(n.body);
        if(!Object.prototype.hasOwnProperty.call(body.reports,value))throw Error("Node raw query decoding");
        handoffs.push({case:`reports-query-decoding-${value}`,nodeStatus:n.status,rustStatus:r.status,nodeBytes:n.body.length});
      }
      rows=[narrative("a","2","2023-11-15T00:00:00Z"),narrative("b","1","2023-11-15T00:00:00Z")];delete rows[0].job_id;rows[0].report_data={BOOL:false};rows[0].metadata={NULL:true};
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:rows}});
      await check("missing-job-and-falsy",query+"&job_id=unknown_job_2023-11-15",null,b=>{if(b.reports.a.report_data!==""||"job_id" in b.reports.a)throw Error("falsy");});
      // Narrative timestamps are strings throughout the adapter and handler.
      // This catches Date conversion, millisecond truncation, offset rewriting,
      // and accidentally using byte order for localeCompare's timezone signs.
      const timestamps=["2023-11-14T19:51:01-01:00","2023-11-14T19:51:01+01:00","2023-11-14T19:51:01.000001+00:00","2023-11-14T19:51:01.000008+00:00","2023-11-14T19:51:01Z"];
      if([..."-:.+0123456789TZ"].sort((a,b)=>a.localeCompare(b)).join("")!=="-:.+0123456789TZ")throw Error("Node timestamp collation changed");
      rows=timestamps.map((ts,i)=>narrative(`s${i}`,`j${i}`,ts));
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:rows}});
      await check("timestamp-string-run-order",query,null,b=>{
        if(b.available_runs.map(r=>r.job_id).join()!=="j4,j1,j3,j2,j0")throw Error("timestamp collation order");
        for(const run of b.available_runs)if(run.latest_timestamp!==timestamps[Number(run.job_id.slice(1))])throw Error("timestamp spelling");
      });
      await check("timestamp-microseconds",query+"&job_id=j2",null,b=>{if(b.reports.s2.timestamp!==timestamps[2])throw Error("timestamp precision");});
      await check("timestamp-wrapper",query+"&job_id=j3&section=s3&topic_key=timestamp",null,b=>{if(b.data!==timestamps[3])throw Error("timestamp wrapper spelling");});
      rows=[narrative("a","same",timestamps[0]),narrative("b","same",timestamps[1])];
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:rows}});
      await check("timestamp-within-run-maximum",query,null,b=>{if(b.available_runs[0].latest_timestamp!==timestamps[0])throw Error("timestamp byte maximum");});
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:[]}});
      await check("empty-publication",query,null,b=>{if("available_runs" in b)throw Error("empty shape");});
      rows=Array.from({length:1001},(_,i)=>narrative(`section_${String(i).padStart(4,"0")}`,"generated-bounded","2023-11-15T00:00:00Z"));
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:rows}});
      async function handoff(id){const n=await request(query,null),r=await request(query,null,port);if(n.status!==200||r.status!==502)throw Error(`${id}: bounded handback ${n.status}/${r.status}`);handoffs.push({case:id,nodeStatus:n.status,rustStatus:r.status,nodeBytes:n.body.length});}
      await handoff("reports-row-bound");
      rows=[narrative("oversized","generated-bounded","2023-11-15T00:00:00Z")];rows[0].report_data={S:"x".repeat(600000)};
      await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:rows}});
      await handoff("reports-input-byte-bound");
      await db.end();
      const counters=JSON.parse((await request("/health",null,port)).body),all=[...priorResults.captures,...captures],failures=all.filter(c=>!c.equal);
      fs.writeFileSync(path.join(keys,"results.json"),JSON.stringify({cases:all.length,equal:all.length-failures.length,failures:failures.length,reports:captures.length,counters,captures:all,handoffs:[...priorResults.handoffs,...handoffs]},null,2)+"\n");
      console.log(`Rust Delphi reports: ${captures.length} cases; combined ${all.length} cases, ${failures.length} differences`);
      if(failures.length)throw Error(`Rust reports byte differences: ${failures.map(c=>c.case).join(", ")}`);
    }
  };
};
