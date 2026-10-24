'use strict';
// Companion for forced cross-method schedules against unchanged Node handlers.
// Control endpoints and ephemeral keys exist only on this loopback test server.
const http=require('node:http'), assert=require('node:assert/strict');
const f=require('./record.cjs');
let gate=null;
async function main(){
 await f.appReady;await f.seed();
 process.env.DELPHI_RESULT_BACKEND='postgres';process.env.DELPHI_RESULT_ENV='generated-selection';process.env.DELPHI_RESULT_SCOPE='generated-scope';
 f.activate({publication:'pg-missing',beforeQuery:async sql=>{
  if(gate && gate.phase==='before' && !gate.entered && /(?:INSERT INTO|UPDATE|DELETE FROM) topic_agenda_selections/i.test(sql)){
   gate.entered=true;gate.sql=sql;await gate.promise;
  }
 },afterQuery:async (sql,args,rows)=>{
  if(gate && gate.phase==='empty-put' && !gate.entered && /UPDATE topic_agenda_selections/.test(sql) && rows.length===0){gate.entered=true;gate.sql=sql;await gate.promise;}
 }});
 const token=f.issueParticipantJWT('anonymous',f.CID,f.U+1,1);
 const server=http.createServer((req,res)=>{
  const reply=body=>{const text=JSON.stringify(body);res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(text),'connection':'close'});res.end(text);};
  if(req.url==='/fixture'){reply({publicKey:f.keys.publicKey,token,conversation_id:f.CID});return;}
  if(req.url==='/fixture/arm' || req.url==='/fixture/arm-empty-put'){
   assert.ok(!gate || gate.released);let release;const promise=new Promise(r=>release=r);
   gate={phase:req.url.endsWith('empty-put')?'empty-put':'before',entered:false,released:false,promise,release};reply({armed:true});return;
  }
  if(req.url==='/fixture/status'){reply({entered:gate?.entered||false,sql:gate?.sql||null});return;}
  if(req.url==='/fixture/release'){assert.ok(gate?.entered);gate.released=true;gate.release();reply({released:true});return;}
  f.app(req,res);
 });
 server.listen(58955,'127.0.0.1',()=>console.log('generated Node mixed-writer fixture ready'));
 async function close(){if(gate)gate.release();await new Promise(r=>server.close(r));await f.db.end();process.exit(0);}
 process.on('SIGTERM',close);process.on('SIGINT',close);
}
main().catch(e=>{console.error(e);process.exit(1);});
