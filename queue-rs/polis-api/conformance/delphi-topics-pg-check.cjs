"use strict";
const fs=require("node:fs"),path=require("node:path");
exports.start=async function(context) {
  const prior=await require("./delphi-visualizations-pg-check.cjs").start(context);
  const {request,serialize,keys,database,oidc}=context;
  const port=Number(process.env.P2ZERO_RUST_PORT||5100),captures=[],handoffs=[];
  async function compare(c,token,node) {
    const rust=serialize(c,await request(c.path,token,port));
    captures.push({case:c.id,node:JSON.parse(node),rust:JSON.parse(rust),equal:node===rust});
    fs.writeFileSync(path.join(keys,"topics-captures.json"),JSON.stringify(captures,null,2)+"\n");
  }
  return {
    matches(c) {return prior.matches(c)||c.route==="GET /api/v3/delphi";},
    async compare(c,token,node) {if(c.route==="GET /api/v3/delphi")await compare(c,token,node);else await prior.compare(c,token,node);},
    async finish() {
      await prior.finish();
      const priorResults=JSON.parse(fs.readFileSync(path.join(keys,"results.json")));
      const {createRequire}=require("node:module");
      const {Client}=createRequire(path.resolve(process.cwd(),"package.json"))("pg");
      const {publish}=require(path.resolve(process.cwd(),"__tests__/delphi-results-pg/support.ts"));
      const db=new Client({connectionString:database});await db.connect();
      const query="/api/v3/delphi?report_id=r2p2zero105";
      async function check(id,url,token,verify) {
        const c={id:`topics/${id}`,state:"supplemental",route:"GET /api/v3/delphi",path:url,auth:token?"other":"none"};
        const n=await request(url,token);if(n.status!==200)throw Error(`${id}: Node status ${n.status}`);
        if(verify)verify(JSON.parse(n.body));
        await compare(c,token,serialize(c,n));
      }
      await check("auth-is-ignored",query,oidc("p2zero|other","other@example.invalid"));
      const topic=(key,layer,cluster,name,model,date)=>({conversation_id:{S:"105"},topic_key:{S:key},layer_id:{N:String(layer)},cluster_id:{N:String(cluster)},topic_name:{S:name},model_name:{S:model},created_at:{S:date}});
      const family="Delphi_CommentClustersLLMTopicNames";
      const rows=[topic("a",0,10,"overwritten","alpha","2023-11-14T19:20:01.000000"),topic("b",0,2,"second","alpha","2023-11-14T19:20:01.000000"),topic("c",0,10,"winner","alpha","2023-11-14T19:20:01.000000"),topic("d",1,-1,"new run","beta","2023-11-15T19:20:01.000000")];
      let previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,families:{[family]:rows}});
      await check("collisions-and-date-order",query,null,b=>{const k=Object.keys(b.runs);if(k.join()!=="beta_2023-11-15,alpha_2023-11-14"||b.runs[k[1]].item_count!==3||b.runs[k[1]].topics_by_layer[0][10].topic_name!=="winner")throw Error("collision fixture");});
      const missing={conversation_id:{S:"105"},topic_key:{S:"a"},topic_name:{NULL:true}};
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:[missing]}});
      await check("missing-and-null",query,null,b=>{if(b.runs.unknown_.topics_by_layer.undefined.undefined.topic_name!==null||"model_name" in b.runs.unknown_)throw Error("missing fields fixture");});
      previous=await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:[]}});
      await check("empty-after-publication",query,null,b=>{if(Object.keys(b.runs).length)throw Error("empty publication");});
      // Large input stays on Node. No partial result is ever served by Rust.
      const large=Array.from({length:1001},(_,i)=>topic(`topic-${String(i).padStart(4,"0")}`,0,i,"generated","bounded","2023-11-14T19:20:01.000000"));
      await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:large}});
      const n=await request(query,null),r=await request(query,null,port);
      if(n.status!==200||r.status!==502||JSON.parse(n.body).runs["bounded_2023-11-14"].item_count!==1001)throw Error("bounded handback");
      handoffs.push({case:"topics-row-bound",nodeStatus:n.status,rustStatus:r.status,nodeRows:1001});
      await publish(db,{env:"p2zero",scope:"delphi",zid:105,previous,families:{[family]:[topic("large-item",0,0,"x".repeat(600000),"bounded","2023-11-14T19:20:01.000000")]}});
      const bigNode=await request(query,null),bigRust=await request(query,null,port);
      if(bigNode.status!==200||bigRust.status!==502||bigNode.body.length<600000)throw Error("byte-bounded handback");
      handoffs.push({case:"topics-input-byte-bound",nodeStatus:bigNode.status,rustStatus:bigRust.status,nodeBytes:bigNode.body.length});
      await db.end();
      const counters=JSON.parse((await request("/health",null,port)).body);
      const all=[...priorResults.captures,...captures],failures=all.filter(c=>!c.equal);
      fs.writeFileSync(path.join(keys,"results.json"),JSON.stringify({cases:all.length,equal:all.length-failures.length,failures:failures.length,topics:captures.length,counters,captures:all,handoffs:[...priorResults.handoffs,...handoffs]},null,2)+"\n");
      console.log(`Rust Delphi topics: ${captures.length} cases; combined ${all.length} cases, ${failures.length} differences`);
      if(failures.length)throw Error(`Rust topics byte differences: ${failures.map(c=>c.case).join(", ")}`);
    }
  };
};
