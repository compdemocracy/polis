'use strict';
// Generated-data characterization through the unchanged application. Provider
// pages and explicit SQL faults are controls, identified in each observation.
require('ts-node/register/transpile-only');
require('dotenv').config();
const fs=require('node:fs'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const {Pool}=require('pg');
const request=require('supertest');
const jwt=require('jsonwebtoken');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.JWT_PRIVATE_KEY=keys.privateKey;
process.env.JWT_PUBLIC_KEY=keys.publicKey;
process.env.NODE_ENV='production';
process.env.DEV_MODE='true';
process.env.SERVER_LOG_LEVEL='error';
const {default:Config}=require('../../src/config.ts');
const {default:pg}=require('../../src/db/pg-query.ts');
const snapshots=require('../../src/utils/delphiResultSnapshot.ts');
const {DynamoDBDocumentClient}=require('@aws-sdk/lib-dynamodb');
const {issueParticipantJWT}=require('../../src/auth/jwt-utils.ts');
const {default:app,appReady}=require('../../app.ts');
const db=new Pool({connectionString:process.env.DATABASE_URL});
const Z=8700101, U=8700201, CID='2selectionfixture';
const net=require('node:net');
const connect=net.Socket.prototype.connect;
const allowedPorts=new Set([58950,58951,58952,58953,58954,58955]);
const outbound=[];
net.Socket.prototype.connect=function(...args){
 const options=Array.isArray(args[0])?args[0][0]:net._normalizeArgs(args)[0];
 if((options.path && !options.port) || !['localhost','127.0.0.1','::1'].includes(options.host||'localhost') || !allowedPorts.has(Number(options.port))){
  outbound.push({host:options.host,port:options.port}); throw new Error('Unadmitted characterization connection '+JSON.stringify(outbound.at(-1)));
 }
 return connect.apply(this,args);
};
let server;
const selection=[{topic_id:'generated-topic',priority:1}];
const cases=[];
function add(name,method='POST',auth='anonymous',extra={}){cases.push({name,method,auth,...extra});}
for(const method of ['POST','PUT','DELETE']){
 for(const auth of ['anonymous','pid0','standard','xid','owner','oidc','none','malformed','expired','signature','foreign','cookie','nonmember','oidc-existing','xid-new','lowercase','wrong-issuer','wrong-audience','future','xid-first']) add(method.toLowerCase()+'-'+auth,method,auth);
 for(const actor of ['pid0','standard','owner']) add(method.toLowerCase()+'-existing-'+actor,method,actor,{setup:'existing'});
 for(const setup of ['present','closed','treevite','xid-required','whitelist']) add(method.toLowerCase()+'-'+setup,method,'anonymous',{setup});
 add(method.toLowerCase()+'-missing-conversation',method,'anonymous',{body:{conversation_id:null}});
 add(method.toLowerCase()+'-unknown-conversation',method,'anonymous',{body:{conversation_id:'2selectionmissing'}});
 add(method.toLowerCase()+'-query-precedence',method,'anonymous',{query:'?conversation_id='+CID,body:{conversation_id:'2selectionmissing'}});
 add(method.toLowerCase()+'-existing-sql-failure',method,'anonymous',{setup:'present',fault:'write'});
 add(method.toLowerCase()+'-treevite-first',method,'none',{setup:'treevite'});
 add(method.toLowerCase()+'-treevite-owner',method,'owner',{setup:'treevite'});
 add(method.toLowerCase()+'-whitelist-member',method,'xid',{setup:'whitelist'});
 add(method.toLowerCase()+'-explicit-xid',method,'anonymous',{body:{xid:'generated-other'}});
 add(method.toLowerCase()+'-sql-failure',method,'anonymous',{fault:'write'});
 if(method!=='DELETE'){
  for(const [suffix,selections] of [['missing',null],['false',false],['zero',0],['empty-string',''],['string','🗳'],['object',{}],['length-object',{length:2}],['zero-string-length',{length:'0'}],['negative-length',{length:-1}],['fractional-length',{length:1.5}],['true',true],['empty-array',[]],['untyped-array',[null,false,3]],['many',Array.from({length:300},(_,i)=>({topic_id:'generated-'+i}))]]) add(method.toLowerCase()+'-'+suffix,method,'anonymous',{body:{selections}});
  for(const publication of ['pg-present','pg-missing','pg-ambiguous','pg-scoped','pg-error','dynamo-empty-page','dynamo-cap','dynamo-error','dynamo-missing']) add(method.toLowerCase()+'-'+publication,method,'anonymous',{publication,setup:'present'});
  add(method.toLowerCase()+'-malformed-json',method,'anonymous',{raw:'{'});
  add(method.toLowerCase()+'-charset',method,'anonymous',{contentType:'application/json; charset=iso-8859-1'});
 }
}
add('post-first-error','POST','none',{body:{selections:null}});
add('post-first-sql-error','POST','none',{fault:'write'});
add('post-first-then-tokenless-retry','POST','none');
let providerCalls=0, active;
const originalQuery=pg.queryP.bind(pg);
pg.queryP=async function(sql,args){
 if(active?.fault==='write' && /(?:INSERT INTO|UPDATE|DELETE FROM) topic_agenda_selections/i.test(sql)){
  active.faultFired++; throw Object.assign(new Error('generated selection write fault'),{code:'XX000'});
 }
 if(active?.beforeQuery) await active.beforeQuery(sql,args);
 const result=await originalQuery(sql,args);
 if(active?.afterQuery) await active.afterQuery(sql,args,result);
 return result;
};
snapshots.resultQuery=async function(sql,args){
 assert.match(sql,/public.delphi_result_publications/); providerCalls++;
 if(active?.publicationEntered) active.publicationEntered();
 if(active?.publicationWait) await active.publicationWait;
 const scope=process.env.DELPHI_RESULT_SCOPE||null;
 assert.deepEqual(args,scope?['generated-selection',Z,scope]:['generated-selection',Z]);
 assert.equal(/scope_key=\$3/.test(sql),scope!==null);
 if(active.publicationQueries) active.publicationQueries.push({sql,args,scope});
 if(active.publication==='pg-error') throw new Error('generated publication failure');
 if(['pg-ambiguous','pg-scoped'].includes(active.publication)) {
  // Distinct scope keys satisfy the publication view's uniqueness constraint.
  // Apply the captured query and bound parameters to these reachable rows.
  const rows=(await db.query(sql.replace('public.delphi_result_publications',
   "(VALUES ('generated-selection',8700101,'first','generated-a'),('generated-selection',8700101,'second','generated-b')) AS publications(env,zid,scope_key,job_id)"),args)).rows;
  assert.equal(rows.length,scope?1:2);
  return rows;
 }
 return active.publication==='pg-present'?[{job_id:'generated-job'}]:[];
};
DynamoDBDocumentClient.prototype.send=async function(command){
 if(active?.topicProvider) return active.topicProvider(command.input);
 assert.equal(command.input.TableName,'Delphi_JobQueue');
 assert.equal(command.input.Limit,25); providerCalls++;
 if(active.publication==='dynamo-missing') return {Items:[]};
 if(active.publication==='dynamo-error') throw new Error('generated page failure');
 if(active.publication==='dynamo-cap' || providerCalls===1) return {Items:[],LastEvaluatedKey:{job_id:'generated-page-'+providerCalls}};
 return {Items:[{job_id:'generated-job'}]};
};
async function seed(){
 await db.query('DELETE FROM zinvites WHERE zid=$1',[Z]);
 await db.query('DELETE FROM xids WHERE owner=$1 OR zid=$2',[U,Z]);
 await db.query('DELETE FROM xid_whitelist WHERE owner=$1',[U]);
 await db.query('DELETE FROM comments WHERE zid=$1',[Z]);
 await db.query('DELETE FROM participants_extended WHERE zid=$1',[Z]);
 await db.query('DELETE FROM participants WHERE zid=$1',[Z]);
 await db.query('DELETE FROM conversations WHERE zid=$1',[Z]);
 await db.query("DELETE FROM oidc_user_mappings WHERE oidc_sub='generated-selection-account'");
 await db.query("DELETE FROM users WHERE email='generated-selection@example.invalid'");
 await db.query('DELETE FROM users WHERE uid BETWEEN $1 AND $2',[U,U+5]);
 for(let i=0;i<6;i++) await db.query('INSERT INTO users(uid,hname,site_id) VALUES($1,$2,$3)',[U+i,'Generated selection participant','generated-site-'+i]);
 await db.query("INSERT INTO conversations(zid,owner,topic,is_active) VALUES($1,$2,'Generated selection fixture',true)",[Z,U]);
 await db.query('INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)',[Z,CID]);
 for(let i=0;i<5;i++) await db.query('INSERT INTO participants(zid,uid) VALUES($1,$2)',[Z,U+i]);
 await db.query('INSERT INTO xids(owner,uid,xid,zid,pid) VALUES($1,$2,$3,$4,3)',[U,U+3,'generated-member',Z]);
 await db.query("INSERT INTO participants_extended(zid,uid,permanent_cookie) VALUES($1,$2,'generated-cookie')",[Z,U+1]);
 await db.query('INSERT INTO xid_whitelist(owner,xid) VALUES($1,$2)',[U,'generated-member']);
}
async function snapshot(){
 const rows=(await db.query('SELECT zid,pid,archetypal_selections,delphi_job_id,total_selections FROM topic_agenda_selections WHERE zid=$1 ORDER BY pid',[Z])).rows;
 const members=(await db.query('SELECT pid,uid FROM participants WHERE zid=$1 ORDER BY pid',[Z])).rows;
 const uids=(await db.query('SELECT uid FROM users ORDER BY uid')).rows.map(x=>x.uid);
 const mappings=(await db.query("SELECT oidc_sub,uid FROM oidc_user_mappings WHERE oidc_sub='generated-selection-account'")).rows.map(x=>({...x,uid:x.uid>=U&&x.uid<=U+5?x.uid:'generated-account'}));
 const result={rows,mappings,members:members.map(x=>({...x,uid:x.uid>=U&&x.uid<=U+5?x.uid:'generated-new-'+x.pid}))};
 Object.defineProperty(result,'uids',{value:uids});
 return result;
}
async function main(){
 assert.ok(new URL(process.env.DATABASE_URL).hostname==='localhost' || new URL(process.env.DATABASE_URL).hostname==='127.0.0.1');
 assert.equal(new URL(process.env.DATABASE_URL).pathname,'/polis-test');
 await appReady;
 server=app.listen(58955,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const out=process.argv[2]; assert.ok(out);
 const oidc=process.env.SELECTION_PROVIDER_TOKEN_FILE?JSON.parse(fs.readFileSync(process.env.SELECTION_PROVIDER_TOKEN_FILE,'utf8')):null;
 assert.ok(oidc,'provider-signed generated credentials required');
 const records=[];
 for(const spec of cases){
  await seed(); active={...spec,faultFired:0,publicationQueries:[]};
  if(spec.auth==='oidc-existing') await db.query("INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES('generated-selection-account',$1)",[U+2]); providerCalls=0;
  process.env.DELPHI_RESULT_BACKEND=spec.publication?.startsWith('dynamo')?'dynamodb':'postgres';
  process.env.DELPHI_RESULT_ENV='generated-selection'; process.env.DELPHI_RESULT_SCOPE=spec.publication==='pg-scoped'?'first':'generated-scope';
  if(spec.publication==='pg-ambiguous') delete process.env.DELPHI_RESULT_SCOPE;
  await db.query('UPDATE conversations SET is_active=$2,treevite_enabled=$3,xid_required=$4,use_xid_whitelist=$5 WHERE zid=$1',[Z,spec.setup!=='closed',spec.setup==='treevite',spec.setup==='xid-required',spec.setup==='whitelist']);
  if(spec.setup==='present' || spec.setup==='existing') await db.query("INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,delphi_job_id,total_selections) VALUES($1,$2,'[]','generated-old',0)",[Z,spec.auth==='pid0'||spec.auth==='owner'?0:spec.auth==='standard'?2:1]);
  const tokens={anonymous:issueParticipantJWT('anonymous',CID,U+1,1),pid0:issueParticipantJWT('anonymous',CID,U,0),standard:issueParticipantJWT('standard_user',CID,U+2,2,'generated-standard'),xid:issueParticipantJWT('xid',CID,U+3,3,'generated-member'),owner:issueParticipantJWT('standard_user',CID,U,0,'generated-owner'),foreign:issueParticipantJWT('anonymous','2selectionforeign',U+1,1),nonmember:issueParticipantJWT('anonymous',CID,U+5,5),oidc:oidc.valid,'oidc-existing':oidc.valid,'xid-new':issueParticipantJWT('xid',CID,U+5,-1,'generated-new-member'),'xid-first':issueParticipantJWT('xid','2selectionforeign',U+5,-1,'generated-first-member'),malformed:'generated-invalid'};
  const claims=jwt.decode(tokens.anonymous); tokens.expired=jwt.sign({...claims,exp:1},keys.privateKey,{algorithm:'RS256'}); tokens.signature=tokens.anonymous.slice(0,tokens.anonymous.lastIndexOf('.')+1)+'invalid';
  tokens.lowercase=tokens.anonymous;
  for(const [name,field,value] of [['wrong-issuer','iss','generated-invalid'],['wrong-audience','aud','generated-invalid'],['future','nbf',Math.floor(Date.now()/1000)+86400]]) tokens[name]=jwt.sign({...claims,[field]:value},keys.privateKey,{algorithm:'RS256'});
  const before=await snapshot();
  const body={conversation_id:CID,...(spec.method==='DELETE'?{}:{selections:selection}),...spec.body};
  let req=request('http://127.0.0.1:58955')[spec.method.toLowerCase()]('/api/v3/topicAgenda/selections'+(spec.query||''))
   .set('accept-encoding','identity').set('content-type',spec.contentType||'application/json').set('x-forwarded-proto','https');
  if(tokens[spec.auth]) req=req.set('Authorization',(spec.auth==='lowercase'?'bearer ':'Bearer ')+tokens[spec.auth]);
  if(spec.auth==='cookie') req=req.set('Cookie','pc=generated-cookie');
  const response=await req.timeout({response:10000,deadline:15000}).send(spec.raw??JSON.stringify(body));
  let bytes=response.text;
  let issued=null;
  if(response.body?.auth?.token){
   const verified=jwt.verify(response.body.auth.token,keys.publicKey,{algorithms:['RS256'],issuer:Config.polisJwtIssuer,audience:Config.polisJwtAudience});
   assert.equal(verified.conversation_id,CID);
   assert.ok((await db.query('SELECT 1 FROM participants WHERE zid=$1 AND uid=$2 AND pid=$3',[Z,verified.uid,verified.pid])).rowCount===1);
   issued={uid:verified.uid>=U&&verified.uid<=U+5?verified.uid:'generated-new-'+verified.pid,pid:verified.pid,conversation_id:verified.conversation_id,kind:verified.anonymous_participant?'anonymous':verified.xid_participant?'xid':'standard',token_type:response.body.auth.token_type,expires_in:response.body.auth.expires_in};
   bytes=bytes.replace(response.body.auth.token,'$verified-issued-token');
  }
  if(spec.publication?.startsWith('pg-')) {
   assert.equal(providerCalls,1);
   assert.equal(active.publicationQueries.length,1,'SQL parameter assertions must have completed');
   if(spec.publication==='pg-scoped') assert.equal(response.body.data.job_id,'generated-a');
   if(spec.publication==='pg-ambiguous') assert.equal(response.body.data.job_id,'generated-old');
  }
  const after=await snapshot();
  const addedIds=after.uids.filter(uid=>!before.uids.includes(uid));
  const addedUsers=addedIds.length?(await db.query('SELECT uid,hname,username,email,is_owner FROM users WHERE uid=ANY($1::int[]) ORDER BY uid',[addedIds])).rows.map((row,i)=>({...row,uid:'generated-created-'+i})):[];
  assert.equal(outbound.length,0,JSON.stringify(outbound));
  const headers=[];
  for(let h=0;h<response.res.rawHeaders.length;h+=2){
   const key=response.res.rawHeaders[h], value=response.res.rawHeaders[h+1];
   if(['date','connection','keep-alive'].includes(key.toLowerCase())) continue;
   if(key.toLowerCase()==='content-length') {assert.equal(Number(value),Buffer.byteLength(response.text)); headers.push([key,String(Buffer.byteLength(bytes))]);}
   else if(key.toLowerCase()==='etag') {
    const tag=body=>'W/"'+Buffer.byteLength(body).toString(16)+'-'+crypto.createHash('md5').update(body).digest('base64').replace(/=+$/,'')+'"';
    assert.equal(value,tag(response.text)); headers.push([key,tag(bytes)]);
   } else headers.push([key,value]);
  }
  records.push({configuration:{backend:process.env.DELPHI_RESULT_BACKEND,env:process.env.DELPHI_RESULT_ENV,scope:process.env.DELPHI_RESULT_SCOPE||null},publicationQueries:active.publicationQueries,name:spec.name,method:spec.method,auth:spec.auth,setup:spec.setup||null,publication:spec.publication||'pg-missing',fault:spec.fault||null,request:body,query:spec.query||'',raw:spec.raw||null,contentType:spec.contentType||'application/json',status:response.status,headers,body:bytes,issued,addedUsers,before,after,providerCalls,faultFired:active.faultFired});
  fs.writeFileSync(out+'.partial.json',JSON.stringify(records,null,2)+'\n');
  console.log(JSON.stringify({case:spec.name,status:response.status,issued:!!issued}));
  if(spec.publication==='dynamo-cap') assert.equal(providerCalls,20);
 }
 fs.writeFileSync(out,JSON.stringify(records,null,2)+'\n');
 if(process.argv[3]) assert.deepEqual(records,JSON.parse(fs.readFileSync(process.argv[3],'utf8')));
 console.log(JSON.stringify({cases:records.length,differences:process.argv[3]?0:null}));
 await seed(); await db.end(); await new Promise(resolve=>server.close(resolve));
}
module.exports={app,appReady,db,seed,snapshot:async()=>{const s=await snapshot();delete s.mappings;return s;},keys,CID,Z,U,issueParticipantJWT,selection,activate(spec){active=spec;providerCalls=0;},setServer(s){server=s;}};
if(require.main===module) main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
