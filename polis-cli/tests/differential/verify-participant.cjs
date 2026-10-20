'use strict';
require('/app/node_modules/ts-node/register/transpile-only');
const {Pool}=require('/app/node_modules/pg');
const {storageToSemantic}=require('/app/src/votes/convention.ts');
(async()=>{
 const p=new Pool({connectionString:process.env.DATABASE_URL});
 if(process.argv[2]==='important'){
  // The stored importance mark beside each vote's semantic choice.
  const votes=(await p.query('SELECT pid,tid,vote,high_priority FROM votes WHERE zid=1 ORDER BY tid')).rows;
  console.log(JSON.stringify({votes:votes.map(v=>({pid:v.pid,tid:v.tid,choice:storageToSemantic(v.vote),high_priority:v.high_priority}))}));
  await p.end();
  return;
 }
 const votes=(await p.query('SELECT pid,vote FROM votes WHERE zid=1')).rows;
 const comments=(await p.query('SELECT pid FROM comments WHERE zid=1 AND txt=$1',['Generated participant comment'])).rows;
 console.log(JSON.stringify({votes:votes.map(v=>({pid:v.pid,choice:storageToSemantic(v.vote)})),comments}));
 await p.end();
})().catch(()=>process.exit(1));
