'use strict';
// Alternate runtime judgement. The unchanged P-027 sender, snapshot, normalizer,
// oracle and exact comparator own request and comparison semantics.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os'),assert=require('node:assert/strict'),zlib=require('node:zlib');
process.env.P027_MARKERS='0'; // Source-line dispatch markers are Node-only, explicitly excluded by P-025.
const harness=require('../../server/characterization/cli.cjs');
const {readRecording,delta,oracle,canonical}=require('../../server/characterization/core.cjs');
const {Normalizer}=require('../../server/characterization/normalize.cjs');
const {firstDifference}=require('../../server/characterization/compare.cjs');
const {bytes}=require('../../server/characterization/wire.cjs');
const {blob}=require('../../server/characterization/recording.cjs');
const {validate,requestKeys}=require('./validate.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'evidence');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let child;
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rpca2-baseline-'));
 let recording;
 try{require('../../server/characterization/baseline.cjs').unpack(dir);recording=readRecording(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 // Census comes from the archive's own manifest (index.meta.caseCount, set at
 // record time from results.length in server/characterization/cli.cjs), not a
 // literal here, so later recording rounds appended to the shared baseline
 // archive don't desync this pin. The pca2 selection count stays asserted
 // literally: this tool only ever replays the 336 pca2 cases and must still
 // fail loudly if that selection changes.
 assert.equal(recording.cases.length,recording.manifest.caseCount,'recording case count does not match archive manifest caseCount');
 const planned=recording.cases.filter(c=>c.caseId.includes('/pca2/'));assert.equal(planned.length,336);
 const full=new Map();
 const fixture=c=>c.request.query.conversation_id;
 for(const c of planned){if(c.response.status===200&&!requestKeys(c).length){full.set(fixture(c),JSON.parse(zlib.gunzipSync(bytes(c))));}}
 let baselineSchema=0;for(const c of planned){validate(c,full.get(fixture(c)));baselineSchema++;}
 console.log(`baseline schema ${baselineSchema}/336`);
 const tokens=await fetch(process.env.P027_CONTROL_URL+'/tokens').then(r=>r.json());tokens.moderator=tokens.admin;
 // Verify generated identities at the Node authority before delivering the actual
 // bearer credentials to Rust (which has no pca2 authentication middleware).
 const publicKey=await fetch(process.env.P027_CONTROL_URL+'/public-key').then(r=>r.json());
 for(const f of require('../../server/characterization/pca2-fixtures.json').filter(f=>f.auth==='participant')){
  require('../../server/characterization/jwt.cjs').verifyToken(tokens[`participant-${f.zid}`],{...publicKey,now:1700000000,issuer:'https://pol.is/',audience:'participants',ttl:31536000,conversation_id:f.capability,uid:3,pid:2,sub:'anon:3'});
 }
 const {Client}=require('pg');const pg=new Client({connectionString:process.env.DATABASE_URL});await pg.connect();
 const tables=(await pg.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r=>r.tablename);
 await pg.end();
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'rpca2-runtime-'));
 let errors=[],exited=false;
 child=cp.spawn(path.join(root,'target/debug/polis-api'),[],{cwd:runtime,env:{...process.env,P032_FIXTURE_CLOCK:'1700000000000'},stdio:['ignore','pipe','pipe']});
 child.on('exit',(code,signal)=>{exited=true;errors.push({kind:'exit',code,signal});});
 let ready=false;
 child.stderr.on('data',b=>{for(const line of b.toString().split('\n').filter(Boolean)){if(line.startsWith('polis-api listening '))ready=true;else errors.push({kind:'stderr',message:line});}});
 child.stdout.on('data',b=>errors.push({kind:'stdout',message:b.toString()}));
 for(let i=0;i<100&&!ready&&!exited;i++)await wait(50);assert.ok(ready,'Rust startup');
 const rows=[],actuals=[];let schemaPass=0,oracleFailures=0,control;
 const normalizer=new Normalizer();
 const initial=await harness.snapshot(tables);
 try{
 for(const [i,c] of planned.entries()){
  const startErrors=errors.length,before=await harness.snapshot(tables),filesBefore=fs.readdirSync(runtime);
  const response=await harness.send(c.request,tokens);
  await wait(200);
  const after=await harness.snapshot(tables),filesAfter=fs.readdirSync(runtime);
  const processErrors=errors.slice(startErrors);if(exited)processErrors.push({kind:'unavailable'});
  const wire=response.wire;delete response.wire;wire.response.process_alive_at_end=!exited;
  const effects={db:delta(before,after),files:delta({runtime:filesBefore},{runtime:filesAfter}),outbound:[],participantCreated:0,participants:[],jwtIssued:0,jwts:[],jwtMinted:0};
  // This binary has no external-service client or filesystem write path. PG is
  // independently snapshotted above; child errors/exits are never borrowed from Node.
  const actual={caseId:c.caseId,routeId:c.routeId,auth:c.auth,case:c.case,seed:c.seed,request:c.request,version:1,wire,response:normalizer.normalize(response,'$.response'),effects:normalizer.normalize(effects,'$.effects'),process:processErrors,oracle:oracle(response,processErrors),routeHits:[]};
  if(!actual.oracle.pass)oracleFailures++;
  let schemaError=null;try{validate(actual,full.get(fixture(c)));schemaPass++;}catch(e){schemaError=e.message;}
  const diff=firstDifference(c,actual);rows.push({caseId:c.caseId,difference:diff,schemaError});actuals.push(actual);
  if(!control&&c.case==='keys-pair'&&!diff&&!schemaError){
   const mutant=structuredClone(actual);const original=JSON.parse(bytes(actual));const reordered=Object.fromEntries(Object.entries(original).reverse());
   mutant.wire.response.body=[{sequence:0,at_ms:0,bytes:blob(JSON.stringify(reordered))}];
   validate(mutant,full.get(fixture(c)));const field=firstDifference(c,mutant);assert.ok(field&&field.includes('wireBody'));
   control={schema:'PASS',replay:'FAIL',field,caseId:c.caseId};
  }
  if(diff||schemaError)console.log(`${i+1}/336 ${c.case}: ${diff||''} ${schemaError||''}`);
  else if((i+1)%28===0)console.log(`replay ${i+1}/336`);
 }
 const final=await harness.snapshot(tables);assert.equal(canonical(initial),canonical(final),'whole-run state changed');
 assert.ok(control,'key-reorder control ran');
 const result={baselineSchema:{passed:baselineSchema,total:336},rustSchema:{passed:schemaPass,total:336},replay:{matched:rows.filter(r=>!r.difference).length,total:336},oracleFailures,keyReorderControl:control,rows,limitations:['Node dispatch markers disabled via pinned comparator switch','Outbound/filesystem absence is source capability inspection plus child lifecycle and runtime-directory observation, not syscall interception']};
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(out,'actual.jsonl'),actuals.map(c=>JSON.stringify(c)).join('\n')+'\n');
 console.log(JSON.stringify({...result,rows:undefined}));
 if(schemaPass!==336||result.replay.matched!==336||oracleFailures)process.exitCode=1;
 }finally{child.kill('SIGTERM');fs.rmSync(runtime,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(child)child.kill('SIGTERM');await harness.close();});
