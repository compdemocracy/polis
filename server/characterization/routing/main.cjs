const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const cases=require('./cases.cjs');
const {runtime}=require('./runtime.cjs');
const {compare}=require('./compare.cjs');
const dir=__dirname;
async function seed(client,f) {
  await client.query('TRUNCATE conversations,comments,votes,votes_latest_unique,topic_agenda_selections,math_main,comment_translations,participants,zinvites,event_ptpt_no_more_comments');
  await client.query('INSERT INTO conversations(zid,strict_moderation,prioritize_seed) VALUES (1,$1,$2)',[!!f.strict,!!f.seedFirst]);
  await client.query("INSERT INTO participants(zid,pid,uid) VALUES (1,0,100),(1,7,107); INSERT INTO zinvites VALUES(1,'generated-conversation')");
  const count=f.count??6;
  await client.query(`INSERT INTO comments SELECT 1,i,0,0,1700000000000+i,'Generated statement '||i,1,true,CASE WHEN i%2=0 THEN 1 ELSE 0 END,null,false,false,'en',null FROM generate_series(0,$1::integer-1) i`,[count]);
  for(const [ids,set] of [[f.banned,`mod=${require('./fixture.cjs').MOD_BAN}`],[f.inactive,'active=false'],[f.muted,'velocity=0'],[f.seeds,'is_seed=true']]) if(ids) await client.query(`UPDATE comments SET ${set} WHERE tid=ANY($1)`,[ids]);
  const voted=f.allVoted?Array.from({length:count},(_,i)=>i):(f.voted??[]);
  // Only existence is used by this routing fixture; 0 is the declared pass wire.
  if(voted.length) await client.query('INSERT INTO votes_latest_unique SELECT 1,$2,unnest($1::integer[]),0',[voted,f.pid??7]);
  if(f.picks!==null) await client.query('INSERT INTO topic_agenda_selections VALUES(1,$3,$1,$2)',[JSON.stringify((f.picks??['job#0#1']).map(topic_key=>({topic_key}))),f.picks?.[0]?.split('#')[0]??'job',f.pid??7]);
  if(f.math!==false) {
    const priorities=Object.fromEntries(Array.from({length:count},(_,i)=>[i,f.zero?0:i+1]));
    if(f.unscored) delete priorities[count-1];
    await client.query('INSERT INTO math_main VALUES(1,$1,$2,1,$3)', ['python',f.tick??(f.stale?1:10),JSON.stringify({'comment-priorities':priorities,math_tick:f.tick??10,n:0,'base-clusters':{id:[],x:[],y:[],count:[],members:[]},'group-clusters':[],tids:[],pca:{comps:[],center:[]},padding:'x'.repeat(f.paddingBytes??8192)})]);
  }
  if(f.translation) await client.query("INSERT INTO comment_translations SELECT 1,tid,'Recorded translation','fr',0,1700000000000,1700000000000 FROM comments");
}
async function run(client,mutation=null) {
  const results={};
  for(const f of cases) {
    await seed(client,f);
    const rt=runtime(client,f,mutation);
    if(f.warm) {await rt.next.getNextComment(1,f.pid??7,f.without,f.lang); rt.reset();}
    if(f.newerDb) await client.query("UPDATE math_main SET math_tick=11,data=jsonb_set(data::jsonb,'{comment-priorities}', '{\"0\":999,\"1\":1,\"2\":1,\"3\":1,\"4\":1,\"5\":1}'::jsonb)::json");
    if(f.expire) rt.expire();
    const value=f.http?await require('./http.cjs').request(rt,f):await rt.next.getNextComment(1,f.pid??7,f.without,f.lang);
    const obs=rt.observation();
    results[f.name]={value:JSON.parse(JSON.stringify(value??null)),...obs,postgresStatements:obs.sql.length,dynamoCalls:obs.dynamo.length};
  }
  return results;
}
async function main() {
  const mode=process.argv[2]??'replay';
  assert.ok(['record','replay','mutations'].includes(mode));
  // Deliberately no DATABASE_URL support, remote host, arbitrary database or schema.
  const port=Number(process.env.POLIS_RECOVERY_PG_PORT);
  assert.ok(Number.isInteger(port)&&port>=55432&&port<=65535,'set isolated local Postgres port');
  const client=new Client({host:'127.0.0.1',port,user:'postgres',password:'generatedlocal',database:'routing_recordings'});
  await client.connect();
  try {
    const schema=`routing_${process.pid}`;
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    await client.query(fs.readFileSync(path.join(dir,'schema.sql'),'utf8'));
    const migration=fs.readFileSync(path.resolve(dir,'../../postgres/migrations/000000_initial.sql'),'utf8');
    const visible=migration.match(/CREATE FUNCTION get_visible_comments\([\s\S]*?\$\$ LANGUAGE SQL;/)[0];
    await client.query(visible);
    try {
      if(mode==='mutations') {
        const mutations=require('./mutations.cjs'); const golden=JSON.parse(fs.readFileSync(path.join(dir,'golden.json')));
        for(const m of mutations) {
          let killed=false;
          let actual;
          try {actual=await run(client,m);} catch(e) {
            if(e.name==='TypeError'&&e.stack.includes('nextComment.ts')&&e.message.includes("setting 'remaining'")) {killed=true;console.log(`KILLED ${m.name}: product selection threw ${e.message}`);continue;}
            throw e;
          }
          try {compare(golden,actual,{entries:[]});} catch(e) {if(e.code!=='ERR_ASSERTION') throw e;killed=true;}
          assert.ok(killed,`mutation survived: ${m.name}`); console.log(`KILLED ${m.name}`);
        }
        console.log(`${mutations.length}/${mutations.length} mutations killed`);
      } else {
        if(mode==='record') {
          const pins=require('./baseline-source.json');
          for(const [file,hash] of Object.entries(pins)) assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(dir,'../../src',file))).digest('hex'),hash,`baseline source changed: ${file}`);
        }
        const actual=await run(client);
        if(mode==='record') {
          assert.equal(process.env.ROUTING_RECORD_BASE,'456516172f5b05dc74f892047a270333a807b3ca','explicit baseline acknowledgment required');
          fs.writeFileSync(path.join(dir,'golden.json'),JSON.stringify(actual,null,2)+'\n');
        } else compare(JSON.parse(fs.readFileSync(path.join(dir,'golden.json'))),actual,JSON.parse(fs.readFileSync(path.join(dir,'expected-differences.json'))));
        console.log(`${mode}: ${Object.keys(actual).length} routing cases PASS`);
      }
    } finally {await client.query(`DROP SCHEMA ${schema} CASCADE`);}
  } finally {await client.end();}
}
module.exports={seed,run};
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;});
