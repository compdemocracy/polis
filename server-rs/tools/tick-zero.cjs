'use strict';
// A committed generation zero is additional source-backed evidence, not one of
// the 336 immutable recordings. Deliberately disagree with the blob-local tick.
const cp=require('node:child_process'),path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
const {Client}=require('pg');const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const url=new URL(process.env.DATABASE_URL);
 const min=Number(process.env.P032_PORT_MIN||55720),max=Number(process.env.P032_PORT_MAX||55739);
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/p027');assert.ok(Number(url.port)>=min&&Number(url.port)<=max);
 const pg=new Client({connectionString:process.env.DATABASE_URL});await pg.connect();
 const fixtures=require('../../server/characterization/pca2-fixtures.json');const f=fixtures.find(f=>f.shape==='populated');
 const old=(await pg.query('select data::text,math_tick from math_main where zid=$1 and math_env=$2',[f.zid,'p027'])).rows[0];
 let child,ready=false,errors=[];
 try{
  await pg.query("update math_main set math_tick=0,data=jsonb_set(data,'{math_tick}','34567'::jsonb) where zid=$1 and math_env=$2",[f.zid,'p027']);
  child=cp.spawn(path.resolve(__dirname,'../target/debug/polis-api'),[],{env:{...process.env,P032_FIXTURE_CLOCK:'1700000000000'},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',b=>{for(const s of b.toString().split('\n').filter(Boolean)){if(s.startsWith('polis-api listening'))ready=true;else errors.push(s);}});
  for(let i=0;i<100&&!ready;i++)await wait(50);assert.ok(ready);
  const base=process.env.P027_BASE_URL+'/api/v3/math/pca2?conversation_id='+f.capability;
  const latest=await fetch(base);assert.equal(latest.status,200);assert.equal(latest.headers.get('etag'),'"0"');const full=await latest.json();assert.equal(full.math_tick,0);assert.ok(full.n>0);
  const subset=await fetch(base+'&keys=math_tick,n');assert.equal(subset.status,200);assert.deepEqual(await subset.json(),{math_tick:0,n:full.n});
  const equal=await fetch(base,{headers:{'if-none-match':'"0"'}});assert.equal(equal.status,304);assert.equal((await equal.arrayBuffer()).byteLength,0);
  const explicit=await fetch(base+'&math_tick=0');assert.equal(explicit.status,304);
  const latestSentinel=await fetch(base+'&math_tick=-1');assert.equal(latestSentinel.status,200);assert.equal((await latestSentinel.json()).math_tick,0);
  const mismatch=fixtures.find(f=>f.shape==='env-mismatch');const noRow=await fetch(process.env.P027_BASE_URL+'/api/v3/math/pca2?conversation_id='+mismatch.capability);const empty=await noRow.json();assert.equal(empty.n,0);assert.equal(empty.math_tick,0);assert.ok(empty.tids.length>0);
  assert.deepEqual(errors,[]);
  const result={passed:6,total:6,checks:['committed zero beats blob tick','typed zero subset','equal ETag 304','explicit zero 304','latest sentinel serves zero','foreign env row stays empty']};
  fs.writeFileSync(path.resolve(__dirname,'../evidence/tick-zero.json'),JSON.stringify(result,null,2)+'\n');console.log('tick-zero/scope HTTP checks 6/6');
 }finally{
  if(child){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}
  await pg.query('update math_main set math_tick=$1,data=$2::jsonb where zid=$3 and math_env=$4',[old.math_tick,old.data,f.zid,'p027']);await pg.end();
 }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
