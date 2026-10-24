"use strict";
// Queue two real HTTP writers behind the real transaction-scoped allocator.
// The requests overlap; the observed wait order makes assigned tids replayable.
require("ts-node/register/transpile-only");
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {Pool}=require("pg"),recorder=require("../cli.cjs");
const {delta,canonical}=require("../core.cjs"),{Normalizer}=require("../normalize.cjs");
const {comparable}=require("../compare.cjs"),{records,put}=require("../recording.cjs");
const {assertCommentsAttempts}=require("./admission.cjs");
const {artifactDirectory}=require("./artifact-path.cjs");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function get(p){const r=await fetch(process.env.P027_CONTROL_URL+p);assert.equal(r.status,200);return r.json();}
async function until(predicate){for(let n=0;n<200;n++){if(await predicate())return;await wait(25);}throw Error("allocator waiter not observed");}
async function main(){
 const out=process.argv[2];assert.ok(out.startsWith("/artifacts/comments-"));fs.mkdirSync(out,{recursive:true});
 const tokens={...await get("/tokens"),...await get("/votes-tokens")};
 const tables=[...new Set((await recorder.schema()).map(r=>r.table_name))];
 await pool.query("UPDATE conversations SET is_active=true,strict_moderation=false,treevite_enabled=false,xid_required=false,use_xid_whitelist=false WHERE zid=1");
 const results=[];
 for(const duplicate of [false,true]){
  const name=duplicate?"concurrent-duplicate":"concurrent-unique";
  await get("/comments-fault?kind=none&language=null-fallback");
  await get("/begin?seed=001122334455&case=post-comments/"+name);
  const before=await recorder.snapshot(tables),obsBefore=await get("/state");
  const client=await pool.connect(); const pending=[];
  try{
   await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(873791984,1)");
   for(const [i,actor] of ["participant","pid0"].entries()){
    const request={method:"POST",path:"/api/v3/comments",query:{},headers:{"content-type":"application/json","x-forwarded-proto":"https",authorization:"$auth:"+actor},body:{conversation_id:"2p027generated",txt:"Generated "+name+" "+(duplicate?0:i)}};
    pending.push({request,response:recorder.send(request,tokens)});
    // A duplicate's second request also reaches INSERT: both pre-checks read
    // before the first writer commits. No route, SQL or timeout is replaced.
    await until(async()=>Number((await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=873791984 AND objid=1 AND NOT granted")).rows[0].count)===i+1);
   }
   await client.query("COMMIT");
  }finally{await client.query("ROLLBACK");client.release();}
  const responses=await Promise.all(pending.map(x=>x.response));
  await until(async()=>{const s=await get("/state");return !s.work.pending.length&&!s.work.late.length;});
  assert.equal((await get("/barrier")).name,"request-effects-drained");
  const after=await recorder.snapshot(tables),obs=await get("/state");
  const effects={db:delta(before,after),files:{},outbound:obs.outbound.slice(obsBefore.outbound.length),participantCreated:0,participants:[],jwtIssued:0,jwts:[],jwtMinted:0};
  assertCommentsAttempts(effects.outbound,{template:"comment-moderation",count:0,recipients:[],pending:0,conversationId:"2p027generated"});
  assert.deepEqual(obs.process.slice(obsBefore.process.length),[]);
  const rows=effects.db["pg:comments"].added;
  assert.equal(rows.length,duplicate?1:2);
  assert.equal(effects.db["pg:votes"],undefined);
  const normalized=[];
  for(const [i,response] of responses.entries()){
   assert.equal(response.status,i===1&&duplicate?409:200);
   const wire=response.wire;delete response.wire;
   wire.response.process_alive_at_end=true;
   const c={caseId:"post-comments/"+name+"/"+i,case:name+"/"+i,auth:i?"pid0":"participant",request:pending[i].request,response,wire,effects,process:[],routeHits:[],oracle:{pass:true,failures:[],flag:null}};
   const n=new Normalizer();wire.response.headers=require("../headers.cjs").headers(wire.response.headers);
   c.response=n.normalize(c.response,"$.response"); // no new credentials in these cases
   if(response.status===200){const row=rows.find(r=>r.pid===(i?0:2));assert.ok(row);assert.equal(response.body.tid,row.tid);assert.equal(response.body.currentPid,row.pid);}
   const dir=path.join(out,artifactDirectory(name+"-"+i));fs.mkdirSync(dir,{recursive:true});
   put(dir,"comparison.json",c);
   for(const [key,value] of Object.entries(records(c)))put(dir,key+".json",value);
   normalized.push(comparable(c));
  }
  results.push({case:name,responses:normalized,comments:rows});put(out,"concurrent.json",results);
  console.log(JSON.stringify({case:name,requests:2,comments:rows.length,statuses:responses.map(r=>r.status)}));
 }
 if(process.argv[3])assert.equal(canonical(results),canonical(JSON.parse(fs.readFileSync(path.join(process.argv[3],"concurrent.json")))));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await pool.end();await recorder.close()});
