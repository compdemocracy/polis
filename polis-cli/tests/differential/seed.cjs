'use strict';
// Generated fixtures only, never a recorded corpus or provider call.
const fs=require('node:fs');
const {Pool}=require('/app/node_modules/pg');
(async()=>{
 if(new URL(process.env.DATABASE_URL).pathname!='/p027')throw Error('disposable database required');
 const p=new Pool({connectionString:process.env.DATABASE_URL});
 const tables=(await p.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('vote_convention','schema_migrations') ORDER BY tablename")).rows;
 await p.query('TRUNCATE '+tables.map(x=>'"'+x.tablename.replaceAll('"','""')+'"').join(',')+' RESTART IDENTITY CASCADE');
 await p.query(fs.readFileSync('/app/characterization/fixture.sql','utf8'));
 await p.query("UPDATE zinvites SET uuid='00000000-0000-4000-8000-000000000027'");
 // SQL defaults for generated invitation receipts use the same fixture instant
 // as now_as_millis and Node's clock. No production migration is changed.
 for(const table of ['treevite_waves','treevite_invites','treevite_login_codes'])
  for(const col of ['created_at','updated_at'])
   await p.query(`ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT '2023-11-14T22:13:20Z'::timestamptz`);
 const tokens=JSON.parse(fs.readFileSync(0,'utf8'));
 for(const [role,uid] of [['owner',1],['admin',2]]){
  const claims=JSON.parse(Buffer.from(tokens[role].split('.')[1],'base64url'));
  await p.query('INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES($1,$2,1700000000000)',[claims.sub,uid]);
 }
 await p.query("INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,math_tick) VALUES(1,'p027',$1,1700000000000,1700000000000)",[JSON.stringify({math_tick:1700000000000,pca:{},'group-clusters':[],'base-clusters':{id:[],members:[]},tids:[0,1],n:3,'n-cmts':2})]);
 await p.query("INSERT INTO math_bidtopid(zid,math_env,math_tick,data) VALUES(1,'p027',1700000000000,$1)",[JSON.stringify({bidToPid:[]})]);
 await p.end();
 console.log('generated fixture installed');
})().catch(error=>{console.error(JSON.stringify({stage:'generated-fixture',code:error.code,table:error.table,column:error.column}));process.exit(1)});
