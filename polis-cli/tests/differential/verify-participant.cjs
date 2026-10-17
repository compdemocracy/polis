'use strict';
require('/app/node_modules/ts-node/register/transpile-only');
const {Pool}=require('/app/node_modules/pg');
const {storageToSemantic}=require('/app/src/votes/convention.ts');
(async()=>{
 const p=new Pool({connectionString:process.env.DATABASE_URL});
 const votes=(await p.query('SELECT pid,vote FROM votes WHERE zid=1')).rows;
 const comments=(await p.query('SELECT pid FROM comments WHERE zid=1 AND txt=$1',['Generated participant statement'])).rows;
 console.log(JSON.stringify({votes:votes.map(v=>({pid:v.pid,choice:storageToSemantic(v.vote)})),comments}));
 await p.end();
})().catch(()=>process.exit(1));
