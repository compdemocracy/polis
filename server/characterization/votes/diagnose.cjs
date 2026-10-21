'use strict';
require('ts-node/register/transpile-only');
const fs=require('node:fs');
const recorder=require('../cli.cjs');
const {Normalizer}=require('../normalize.cjs');
const {semanticToWire}=require('../../src/votes/convention.ts');
async function get(p){return (await fetch(process.env.P027_CONTROL_URL+p)).json();}
async function main(){
 const tokens={...await get('/tokens'),...await get('/votes-tokens')};
 const tables=[...new Set((await recorder.schema()).map(r=>r.table_name))];
 const r=await recorder.runCase({caseId:'post-votes/owner-cold-diagnostic',case:'owner-cold-diagnostic',auth:'owner',seed:'abcdef123456',request:{method:'POST',path:'/api/v3/votes',query:{},headers:{'content-type':'application/json','x-forwarded-proto':'https',authorization:'$auth:owner'},body:{conversation_id:'2p027generated',tid:0,vote:semanticToWire('agree')}}},tokens,tables,new Normalizer());
 fs.writeFileSync('/artifacts/votes-owner-diagnostic.json',JSON.stringify(r,null,2)+'\n');
 console.log(JSON.stringify({status:r.response.status,oracle:r.oracle,work:r.unsettledWork}));
 if(!r.oracle.pass)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(recorder.close);
