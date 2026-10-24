"use strict";
// Uses the characterization recorder's real transport, snapshots, effect drain,
// JWT verification, exact byte comparator and egress admission. The votes
// profile separately classifies completed idle TLS sockets at the drain barrier.
require('ts-node/register/transpile-only');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const recorder=require('../cli.cjs');
const {Normalizer}=require('../normalize.cjs');
const {hash}=require('../core.cjs');
const {records,put,pin}=require('../recording.cjs');
const {firstDifference}=require('../compare.cjs');
const convention=require('../../src/votes/convention.ts');
const {MOD_BAN}=require('../routing/fixture.cjs');
const control=process.env.P027_CONTROL_URL;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const out=process.argv[2];
async function get(p){const r=await fetch(control+p,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();}
const cases=[];
function add(name,auth='participant',body={},status=200,setup=null,fault=null,headers={}){
 cases.push({name,auth,body,status,setup,fault,headers});
}
add('anonymous-first','unauthenticated');
for(const [index,actor] of ['pid0','participant','standard','xid','owner','admin'].entries()) {
 const tid=3+index;
 add(actor+'-new',actor,{tid});
 add(actor+'-changed',actor,{tid,vote:convention.semanticToWire('disagree')});
 add(actor+'-repeated',actor,{tid,vote:convention.semanticToWire('disagree')});
 add(actor+'-moderated-out',actor,{tid:2});
 add(actor+'-missing-comment',actor,{tid:999});
 add(actor+'-closed',actor,{},403,'closed');
}
add('foreign-conversation-token','foreign');
add('expired-token','expired',{},401);
add('invalid-token-format','bad',{},401);
add('invalid-signature','signature',{},401);
add('treevite-member','participant',{},200,'treevite');
add('treevite-owner','owner',{},200,'treevite');
add('treevite-new-anonymous','unauthenticated',{},401,'treevite');
add('xid-required','unauthenticated',{},403,'required');
add('xid-first-contact','unauthenticated',{xid:'generated-new-member'});
add('xid-allowed','xid',{},200,'whitelist');
add('xid-denied','unauthenticated',{xid:'generated-denied'},403,'whitelist');
add('star-true','participant',{starred:true});
add('star-false','participant',{starred:false});
add('star-repeat','participant',{starred:false});
add('star-null','participant',{starred:null});
add('star-numeric','participant',{starred:2,high_priority:'ON'});
add('star-string','participant',{starred:'off',high_priority:true});
add('star-invalid','participant',{starred:'yes'},400);
add('priority-invalid','participant',{high_priority:'yes'},400);
add('prefix-integers','participant',{tid:'0suffix',vote:String(convention.semanticToWire('pass'))+'suffix'});
add('fractional-tid','participant',{tid:1.5},400);
add('missing-tid','unauthenticated',{tid:null},400);
add('missing-vote','participant',{vote:null},400);
add('invalid-vote','participant',{vote:2},400);
add('invalid-conversation','participant',{conversation_id:'2generatedmissing'},400);
add('missing-conversation','participant',{conversation_id:null},400);
add('invalid-xid','participant',{xid:3},400);
add('invalid-lang','participant',{lang:'abcdefghijkl'},400);
add('lang-empty','participant',{lang:''});
add('no-next-comment','participant',{tid:1},200,'no-next');
add('vote-failure','participant',{},500,null,'vote');
add('duplicate-sqlstate','participant',{},406,null,'duplicate');
add('star-failure-after-commit','participant',{starred:true},500,null,'star');
add('next-failure-after-commit','participant',{},500,null,'next');
add('retry-after-next-failure','participant');
const additional = require('./additional.cjs');
additional.cases(add, convention);
if(process.env.P027_VOTES_DEFERRED_FAILURE) {
 const selected=cases.filter(c=>c.fault===process.env.P027_VOTES_DEFERRED_FAILURE);
 assert.equal(selected.length,1,'select exactly one deferred failure');
 cases.splice(0,cases.length,...selected);
}
async function setup(kind){
 await pool.query('UPDATE comments SET mod=$1 WHERE zid=1 AND tid<>2',[kind==='no-next'?MOD_BAN:0]);
 await pool.query('UPDATE conversations SET is_active=$1, treevite_enabled=$2, xid_required=$3, use_xid_whitelist=$4 WHERE zid=1',[kind!=='closed',kind==='treevite',kind==='required',kind==='whitelist']);
}
async function main(){
 assert.equal(new URL(process.env.DATABASE_URL).pathname,'/p027');
 assert.ok(out && out.startsWith('/artifacts/votes-'));
 fs.mkdirSync(out,{recursive:true});
 const tokens={...await get('/tokens'),...await get('/votes-tokens')};
 await pool.query("INSERT INTO comments(zid,pid,uid,txt,lang,created,modified,mod) VALUES (1,0,1,'Generated moderated statement','en',1700000000000,1700000000000,$1)",[MOD_BAN]);
 await pool.query("INSERT INTO xids(owner,uid,xid,zid,pid) VALUES(1,3,'generated-member',1,2)");
 await pool.query("INSERT INTO xid_whitelist(owner,xid) VALUES(1,'generated-member')");
 await pool.query("INSERT INTO conversations(zid,owner,topic,is_active) VALUES(2,1,'Generated foreign conversation',true)");
 await pool.query("INSERT INTO zinvites(zid,zinvite) VALUES(2,'2p027foreign')");
 for(let i=0;i<6;i++) await pool.query("INSERT INTO comments(zid,pid,uid,txt,lang,created,modified,mod) VALUES (1,0,1,$1,'en',1700000000000,1700000000000,0)",['Generated identity statement '+i]);
 const tables=[...new Set((await recorder.schema()).map(r=>r.table_name))];
 const initial=await recorder.snapshot(tables);
 const ready=await get('/ready');
 const route=ready.routes.find(r=>r.path==='/api/v3/votes' && r.method==='POST');
 assert.ok(route);
 const normalizer=new Normalizer();
 const actual=[];
 for(const spec of cases){
  if(actual.length===72) {
   const ids=await additional.initialize(pool);
   Object.assign(tokens,await get('/votes-tokens?'+new URLSearchParams(ids)));
  }
  await setup(spec.setup);
  if(actual.length>=72) await additional.setup(spec.setup,pool,get);
  await get('/votes-fault?kind='+(spec.fault||'none'));
  if(spec.auth!=='unauthenticated') assert.ok(tokens[spec.auth],spec.auth+' credential fixture');
  const c={caseId:'post-votes/'+spec.name,case:spec.name,auth:spec.auth,
   seed:hash(spec.name).slice(0,12),routeId:undefined,
   request:{method:'POST',path:'/api/v3/votes',query:{},headers:{'content-type':'application/json','x-forwarded-proto':'https',...(spec.auth==='unauthenticated'?{}:{authorization:'$auth:'+spec.auth}),...spec.headers},
    body:{conversation_id:'2p027generated',tid:0,vote:convention.semanticToWire('agree'),...spec.body}}};
  if(actual.length>=72 && tokens[spec.auth]?.includes('.')) {
   const claims=JSON.parse(Buffer.from(tokens[spec.auth].split('.')[1],'base64url'));
   c.credentialBinding={zid:spec.body.conversation_id==='2generatedempty'?4:1,oidcSub:claims.oidc_sub||claims.sub,
    xid:typeof spec.body.xid==='string'&&spec.body.xid.trim()?spec.body.xid:claims.xid};
  }
  const r=await recorder.runCase(c,tokens,tables,normalizer);
  const fault=await get('/votes-fault-state');
  const after=await recorder.snapshot(tables);
  const inserted=r.effects.db['pg:votes']?.added||[];
  r.voteProof={historyAdded:inserted.length,storedMeanings:inserted.map(v=>convention.storageToSemantic(v.vote)),latest:after['pg:votes_latest_unique'],stars:after['pg:stars'],fault};
  const dest=path.join(out,String(actual.length).padStart(3,'0')+'-'+spec.name);
  fs.mkdirSync(dest,{recursive:true});
  put(dest,'comparison.json',r);
  const projected=records(r);
  for(const [name,value] of Object.entries(projected))put(dest,name+'.json',value);
  actual.push(r);
  put(out,'partial.json',{completed:actual.length,total:cases.length});
  assert.equal(r.response.status,spec.status,spec.name+' status');
  assert.equal(r.oracle.pass,true,JSON.stringify(r.oracle));
  assert.equal(fault.fired,spec.fault?1:0,spec.name+' fault witness');
  const commits=spec.status===200 || spec.fault==='star' || spec.fault==='next';
  assert.equal(inserted.length,commits?1:0,spec.name+' durable history count');
  if(commits){
   const row=inserted[0];
   const parsed=Number.parseInt(String(c.request.body.vote),10);
   assert.equal(convention.storageToSemantic(row.vote),convention.wireToSemantic(parsed));
   const latest=after['pg:votes_latest_unique'].filter(v=>v.zid===row.zid&&v.pid===row.pid&&v.tid===row.tid);
   if(spec.name.endsWith('-new')) {
    const replaced=r.effects.db['pg:votes_latest_unique']?.removed||[];
    assert.equal(replaced.filter(v=>v.zid===row.zid&&v.pid===row.pid&&v.tid===row.tid).length,0,spec.name+' first insert');
   }
   if(spec.name==='no-next-comment')assert.equal(Object.hasOwn(r.response.body,'nextComment'),false);
   assert.equal(latest.length,1);assert.equal(latest[0].vote,row.vote);
   assert.equal(latest[0].modified,row.created);
   if(typeof r.response.body==='object' && r.response.body.currentPid!==undefined)assert.equal(r.response.body.currentPid,row.pid);
  }
  if(actual.length>72) additional.check(spec,r,after);
  console.log(JSON.stringify({case:spec.name,status:r.response.status,votes:inserted.length,oracle:r.oracle.pass}));
 }
 const corpus={format:'post-votes-recordings/1',source_commit:process.env.P027_SOURCE_COMMIT,
  cases:actual.map(r=>({case:r.case,status:r.response.status,historyAdded:r.voteProof.historyAdded})),
  convention:{wire_agree:convention.WIRE_AGREE,storage_agree:convention.currentStorageConvention().agreeValue},
  serialization:ready.serialization,initial,final:await recorder.snapshot(tables)};
 put(out,'corpus.json',corpus);
 put(out,'cases.json',actual);
 if(process.argv[3]){
  const before=JSON.parse(fs.readFileSync(path.join(process.argv[3],'cases.json')));
  assert.equal(before.length,actual.length);
  const differences=actual.flatMap((r,i)=>{const d=firstDifference(before[i],r);return d?[{case:r.case,difference:d}]:[];});
  put(out,'replay.json',{cases:actual.length,differences});assert.deepEqual(differences,[]);
 }
 const files=[];
 function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())visit(f);else files.push(pin(out,path.relative(out,f)));}}
 visit(out);put(out,'index.json',{format:corpus.format,source_commit:corpus.source_commit,files});
 console.log(JSON.stringify({cases:actual.length,failed:0,replay:!!process.argv[3]}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await pool.end();await recorder.close();});
