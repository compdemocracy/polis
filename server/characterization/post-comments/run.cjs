"use strict";
require("ts-node/register/transpile-only");
const fs=require("node:fs"), path=require("node:path"), assert=require("node:assert/strict");
const {Pool}=require("pg");
const recorder=require("../cli.cjs");
const {Normalizer}=require("../normalize.cjs");
const {hash}=require("../core.cjs");
const {records,put,pin}=require("../recording.cjs");
const {firstDifference,comparable}=require("../compare.cjs");
const {canonical}=require("../core.cjs");
const {applyExpectedDifferences}=require("../collective-statement/expected.cjs");
const convention=require("../../src/votes/convention.ts");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const out=process.argv[2];
async function get(p){const r=await fetch(process.env.P027_CONTROL_URL+p,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();}
const cases=[];
function add(name,auth="participant",body={},status=200,setup=null,fault=null){cases.push({name,auth,body,status,setup,fault});}
add("anonymous-first","unauthenticated");
for(const actor of ["pid0","participant","standard","xid","owner","admin","site-moderator"]) {
 add(actor+"-no-vote",actor);
 for(const meaning of ["agree","disagree","pass"]) add(actor+"-"+meaning,actor,{vote:convention.semanticToWire(meaning)});
 add(actor+"-seed",actor,{is_seed:true});
 add(actor+"-seed-explicit-vote",actor,{is_seed:true,vote:convention.semanticToWire("agree")});
 add(actor+"-closed",actor,{},403,"closed");
 add(actor+"-strict",actor,{},200,"strict");
}
add("oidc-first-use","comments-owner-1");
add("oidc-repeat","comments-owner-1");
add("xid-first-use","unauthenticated",{xid:"generated-new-comment-member"});
add("xid-existing-bare","unauthenticated",{xid:"generated-member"});
add("xid-request-precedence","xid",{xid:"generated-comment-override"});
add("xid-required","unauthenticated",{},403,"required");
add("xid-whitelisted","xid",{},200,"whitelist");
add("xid-refused","unauthenticated",{xid:"generated-denied"},403,"whitelist");
for(const actor of ["pid0","participant","standard","xid","owner"]) add("treevite-"+actor,actor,{},200,"treevite");
add("treevite-anonymous-refused","unauthenticated",{},401,"treevite");
add("treevite-xid-refused","unauthenticated",{xid:"generated-treevite-new"},401,"treevite");
add("treevite-oidc-first-refused","comments-owner-2",{},401,"treevite");
add("foreign-token","foreign");
for(const actor of ["expired","bad","signature"]) add("auth-"+actor,actor,{},401);
for(const [name,txt] of [["empty",""],["spaces","   "]]) add("text-"+name,"unauthenticated",{txt},400);
for(const [name,txt] of [["null",null],["number",7],["boolean",false],["array",[]],["object",{}],["too-long","x".repeat(998)],["utf16-too-long","😀".repeat(499)]]) add("text-"+name,"unauthenticated",{txt},400);
add("text-max-length","participant",{txt:"x".repeat(997)});
add("text-utf16-boundary","participant",{txt:"😀".repeat(498)+"x"});
add("text-tab","participant",{txt:"\t"});
add("text-trim","participant",{txt:"  Generated trimmed text  "});
add("text-trim-duplicate","participant",{txt:"Generated trimmed text"},409);
add("duplicate-before-closed","participant",{txt:"Generated statement A"},409,"closed");
add("duplicate-exact","participant",{txt:"Generated statement A"},409);
add("duplicate-case-sensitive","participant",{txt:"generated statement A"});
add("vote-null","participant",{vote:null});
add("vote-prefix","participant",{vote:String(convention.semanticToWire("pass"))+"suffix"});
add("vote-fraction-string","participant",{vote:"0.9"});
for(const vote of [2,0.5,true,"bad",[],{}]) add("vote-invalid-"+JSON.stringify(vote),"participant",{vote},400);
for(const [name,value] of [["number",2],["off","OFF"],["null",null]]) add("seed-"+name,"owner",{is_seed:value});
add("seed-invalid","participant",{is_seed:" true "},400);
add("ignored-fields","participant",{pid:999,uid:999,tid:999,lang:"fr",weight:123,nextComment:true});
add("missing-conversation","unauthenticated",{conversation_id:null},400);
add("unknown-conversation","participant",{conversation_id:"2generatedmissing"},400);
add("invalid-xid","unauthenticated",{xid:3},400);
for(const [name,status] of [["insert",500],["participant",500],["foreign",500],["duplicate",409],["allocator",500]]) add("sql-"+name,"unauthenticated",{},status,null,name);
add("author-vote-failure-after-commit","participant",{txt:"Generated durable before vote",vote:convention.semanticToWire("agree")},500,null,"vote");
add("retry-after-vote-failure","participant",{txt:"Generated durable before vote",vote:convention.semanticToWire("agree")},409);
for (const mode of ["success", "error", "malformed", "timeout"]) {
 add("language-"+mode,"participant"); cases[cases.length - 1].language=mode;
}
add("notification-task-failure","participant",{},200,null,"notification");
add("notification-interaction-failure","participant",{},200,null,"interaction");
add("moderation-count-failure","participant",{},200,"strict","moderation");
// Append coverage cases so existing serial observations keep their fixture order.
add("standard-first-join","standard-nonmember");
add("standard-repeat-join","standard-nonmember");
add("text-absent","unauthenticated",{},400);
add("site-moderator-recipient","participant",{},200,"strict");

if(process.env.COMMENTS_ADDITIONAL === "1") {
 cases.splice(0,cases.length);
 for(const actor of ["pid0","participant","standard","xid","owner","admin","site-moderator"])
  for(const meaning of ["disagree","pass"])
   add(actor+"-seed-"+meaning,actor,{is_seed:true,vote:convention.semanticToWire(meaning)});
 for(const [fault,status] of [["account",500],["account-conflict",429],["account-load",429]]) {
  add("oidc-"+fault,"comments-owner-2",{},status);cases[cases.length - 1].accountFault=fault;
 }
 add("oidc-missing-email","oidc-missing-email",{},400);
 for(const kind of ["expired","issuer","audience","signature","unknown-key"])
  add("oidc-"+kind,"oidc-"+kind,{},401);
}
if(process.env.COMMENTS_LANGUAGE_DISABLED === "1") {
 cases.splice(0,cases.length,{name:"language-disabled",auth:"participant",body:{},status:200,language:"disabled"});
}
async function main(){
 assert.equal(new URL(process.env.DATABASE_URL).pathname,"/p027");
 assert.ok(out && out.startsWith("/artifacts/comments-"));
 fs.mkdirSync(out,{recursive:true});
 await pool.query("INSERT INTO users(uid,hname,site_id) VALUES(100004,'Generated moderator','p027-owner')");
 const moderator=await pool.query("INSERT INTO participants(zid,uid,created) VALUES(1,100004,1700000000000) RETURNING pid");
 await pool.query("INSERT INTO xids(owner,uid,xid,zid,pid) VALUES(1,3,'generated-member',1,2)");
 await pool.query("INSERT INTO xid_whitelist(owner,xid) VALUES(1,'generated-member')");
 const tokens={...await get("/tokens"),...await get("/votes-tokens?moderatorPid="+moderator.rows[0].pid)};
 const tables=[...new Set((await recorder.schema()).map(r=>r.table_name))];
 const normalizer=new Normalizer(), actual=[], failures=[];
 let firstStandardPid;
 for(const spec of cases){
  if(spec.name === "standard-first-join") {
   await pool.query("INSERT INTO users(uid,hname,site_id) VALUES(100005,'Generated first standard','generated-first-standard')");
   assert.equal((await pool.query("SELECT pid FROM participants WHERE zid=1 AND uid=100005")).rowCount,0);
  }
  if(spec.name === "site-moderator-recipient") {
   await pool.query("UPDATE users SET email='moderator@example.invalid' WHERE uid=100004");
   await pool.query("INSERT INTO page_ids(site_id,page_id,zid) VALUES('p027-owner','generated-comments-page',1)");
   // The owner belongs to both recipient SELECTs; UNION must send it only once.
   const siteUsers=await pool.query("SELECT uid FROM users WHERE site_id=(SELECT site_id FROM page_ids WHERE zid=1) ORDER BY uid");
   assert.deepEqual(siteUsers.rows.map(r=>r.uid),[1,100004]);
  }
  await pool.query("UPDATE conversations SET is_active=$1,strict_moderation=$2,treevite_enabled=$3,xid_required=$4,use_xid_whitelist=$5 WHERE zid=1",[spec.setup!=="closed",spec.setup==="strict",spec.setup==="treevite",spec.setup==="required",spec.setup==="whitelist"]);
  if(process.env.COMMENTS_ADDITIONAL === "1")await get("/votes-fault?kind="+(spec.accountFault||"none"));
  await get("/comments-fault?kind="+(spec.fault||"none")+"&language="+(spec.language||"null-fallback"));
  const c={caseId:"post-comments/"+spec.name,case:spec.name,auth:spec.auth,seed:hash(spec.name).slice(0,12),
   request:{method:"POST",path:"/api/v3/comments",query:{},headers:{"content-type":"application/json","x-forwarded-proto":"https",...(spec.auth==="unauthenticated"?{}:{authorization:"$auth:"+spec.auth})},body:{conversation_id:"2p027generated",txt:"Generated comment "+spec.name,...spec.body}}};
  if(spec.name === "text-absent") delete c.request.body.txt;
  if(tokens[spec.auth]?.includes(".")) {
   const claims=JSON.parse(Buffer.from(tokens[spec.auth].split(".")[1],"base64url"));
   c.credentialBinding={zid:1,oidcSub:claims.oidc_sub||claims.sub,xid:typeof spec.body.xid==="string"&&spec.body.xid.trim()?spec.body.xid:claims.xid};
  }
  if(spec.language === "timeout")
    c.observationProfile = require("./observation.cjs").PROVIDER_TIMEOUT;
  assert.ok(spec.auth === "unauthenticated" || tokens[spec.auth], spec.name+" fixture token");
  const pending=Number((await pool.query("SELECT count(*) FROM comments WHERE zid=1 AND mod=0")).rows[0].count);
  const moderator=["pid0","owner","admin","site-moderator"].includes(spec.auth);
  const willCommit=spec.status===200||spec.fault==="vote";
  const waiting=pending+(willCommit&&!moderator?1:0);
  c.notificationPolicy={template:"comment-moderation",conversationId:"2p027generated",pending:waiting,
    count:spec.setup==="strict" && spec.fault!=="moderation" && waiting>0?1:0,
    recipients:spec.setup==="strict" && spec.fault!=="moderation" && waiting>0?[{class:"owner",address:"Generated Owner <owner@example.invalid>"}]:[]};
  if(spec.name === "site-moderator-recipient") {
   c.notificationPolicy.recipients.push({class:"site-moderator",address:"Generated moderator <moderator@example.invalid>"});
   c.notificationPolicy.count=2;
  }
  let r;
  try { r=await recorder.runCase(c,tokens,tables,normalizer); }
  catch(error) {
    failures.push({case:spec.name,phase:"recorder",error:String(error)});
    put(out,"failures.json",failures); console.error(JSON.stringify(failures[failures.length - 1])); continue;
  }
  const after=await recorder.snapshot(tables), fault=await get("/comments-fault-state");
  const comments=r.effects.db["pg:comments"]?.added||[], votes=r.effects.db["pg:votes"]?.added||[];
  r.commentProof={commentsAdded:comments.length,votesAdded:votes.length,storedMeanings:votes.map(v=>convention.storageToSemantic(v.vote)),fault};
  const dest=path.join(out,String(actual.length).padStart(3,"0")+"-"+spec.name);
  fs.mkdirSync(dest,{recursive:true});put(dest,"comparison.json",r);
  for(const [name,value] of Object.entries(records(r)))put(dest,name+".json",value);
  actual.push(r);put(out,"cases.json",actual);
  console.log(JSON.stringify({case:spec.name,status:r.response.status,comments:comments.length,votes:votes.length,oracle:r.oracle}));
  try {
  assert.equal(r.response.status,spec.status,spec.name+" status");
  assert.equal(r.oracle.pass,true,JSON.stringify(r.oracle));
  if(["text-absent","text-null"].includes(spec.name)) {
   assert.equal(r.response.body,"Bad Request\n");
   assert.equal(r.response.headers["content-type"],"text/html; charset=utf-8");
   assert.equal(r.effects.participantCreated,1);
   assert.equal(r.effects.jwtIssued,0);
  }
  if(["standard-first-join","standard-repeat-join"].includes(spec.name)) {
   assert.equal(r.effects.participantCreated,spec.name === "standard-first-join"?1:0);
   const memberships=await pool.query("SELECT pid FROM participants WHERE zid=1 AND uid=100005");
   assert.equal(memberships.rowCount,1);
   assert.deepEqual(r.response.body,{tid:comments[0].tid,currentPid:memberships.rows[0].pid});
   assert.equal(r.effects.jwtIssued,0);
   if(spec.name === "standard-first-join") firstStandardPid=r.response.body.currentPid;
   else assert.equal(r.response.body.currentPid,firstStandardPid);
  }
  assert.equal(fault.fired,spec.fault?1:0);
  if(spec.accountFault)assert.equal((await get("/votes-fault-state")).fired,1);
  const committed=spec.status===200||spec.fault==="vote";
  assert.equal(comments.length,committed?1:0,spec.name+" comment durability");
  const suppliedVote=spec.body.vote!==undefined&&spec.body.vote!==null;
  assert.equal(votes.length,spec.status===200&&suppliedVote?1:0,spec.name+" explicit-only author vote");
  if(committed) {
   const row=comments[0];
   assert.equal(row.txt,c.request.body.txt.replace(/^ */,"").replace(/ *$/,""));
   assert.equal(row.active,true); assert.equal(row.anon,false); assert.equal(row.velocity,1);
   const moderator=["pid0","owner","admin","site-moderator"].includes(spec.auth);
   assert.equal(row.mod,moderator?1:0);
   assert.equal(row.is_seed,moderator&&[true,2].includes(spec.body.is_seed));
   assert.equal(row.lang,spec.language==="success"?"fr":null); assert.equal(row.lang_confidence,spec.language==="success"?0.5:null);
   if(spec.status===200){assert.equal(r.response.body.tid,row.tid);assert.equal(r.response.body.currentPid,row.pid);assert.equal(Object.hasOwn(r.response.body,"nextComment"),false);}
   assert.equal(after["pg:comments"].filter(x=>x.zid===row.zid&&x.tid===row.tid).length,1);
   for(const v of votes) {
    assert.equal(v.tid,row.tid);assert.equal(v.pid,row.pid);
    assert.equal(convention.storageToSemantic(v.vote),convention.wireToSemantic(Number.parseInt(String(spec.body.vote),10)));
    assert.equal(v.weight_x_32767,0); assert.equal(v.high_priority,false);
    const latest=after["pg:votes_latest_unique"].filter(x=>x.zid===v.zid&&x.tid===v.tid&&x.pid===v.pid);
    assert.equal(latest.length,1);assert.equal(latest[0].vote,v.vote);assert.equal(latest[0].modified,v.created);
   }
  }
  } catch(error) {
   failures.push({case:spec.name,phase:"assertion",error:String(error)});
   put(out,"failures.json",failures); console.error(JSON.stringify(failures[failures.length - 1]));
  }
 }
 put(out,"failures.json",failures);
 if(process.argv[3]){
  const before=JSON.parse(fs.readFileSync(path.join(process.argv[3],"cases.json")));
  assert.equal(before.length,actual.length);
  const entries=JSON.parse(fs.readFileSync(path.join(__dirname,"expected-differences.json"))).entries;
  const baseline=Object.fromEntries(before.map(r=>[r.case,canonical(comparable(r))]));
  const expected=applyExpectedDifferences(baseline,entries);
  assert.deepEqual(expected.problems,[]);
  const differences=actual.flatMap((r,i)=>{const value=canonical(comparable(r));return expected.expected[r.case]===value?[]:[{case:r.case,difference:firstDifference(before[i],r)}];});
  put(out,"replay.json",{cases:actual.length,differences});assert.deepEqual(differences,[]);
 }
 const files=[];
 function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())visit(f);else files.push(pin(out,path.relative(out,f)));}}
 visit(out);put(out,"index.json",{format:"post-comments-recordings/1",source_commit:process.env.P027_SOURCE_COMMIT,files});
 console.log(JSON.stringify({cases:actual.length,failed:failures.length,replay:!!process.argv[3]}));
 if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await pool.end();await recorder.close();});
