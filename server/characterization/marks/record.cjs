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
process.env.ADMIN_UIDS='[8710205]';
const {default:Config}=require('../../src/config.ts');
const {default:pg}=require('../../src/db/pg-query.ts');
const snapshots=require('../../src/utils/delphiResultSnapshot.ts');
const {DynamoDBDocumentClient}=require('@aws-sdk/lib-dynamodb');
const {issueParticipantJWT}=require('../../src/auth/jwt-utils.ts');
const {default:app,appReady}=require('../../app.ts');
const db=new Pool({connectionString:process.env.DATABASE_URL});
const Z=8710101, U=8710201, CID='2markfixture';
const net=require('node:net');
const connect=net.Socket.prototype.connect;
const allowedPorts=new Set([59040,59041,59042,59043,59044,59045]);
const outbound=[];
net.Socket.prototype.connect=function(...args){
 const options=Array.isArray(args[0])?args[0][0]:net._normalizeArgs(args)[0];
 if((options.path && !options.port) || !['localhost','127.0.0.1','::1'].includes(options.host||'localhost') || !allowedPorts.has(Number(options.port))){
  outbound.push({host:options.host,port:options.port}); throw new Error('Unadmitted characterization connection '+JSON.stringify(outbound.at(-1)));
 }
 return connect.apply(this,args);
};
let server;
const cases=[];
function add(route,suffix,auth='anonymous',extra={}){cases.push({name:route+'-'+suffix,route,method:'POST',auth,...extra});}
for(const route of ['stars','trashes']){
 const field=route==='stars'?'starred':'trashed';
 for(const auth of ['anonymous','pid0','standard','owner','moderator','marked-participant','admin','xid','oidc','oidc-existing','none','malformed','expired','signature','foreign','cookie','nonmember','lowercase','wrong-issuer','wrong-audience','future','stale-pid']) add(route,auth,auth);
 for(const setup of ['closed','treevite','xid-required','whitelist','repeat']) add(route,setup,'anonymous',{setup});
 for(const [suffix,value] of [['zero',0],['missing',null],['negative',-1],['large',2],['fractional',0.5],['true',true],['false',false],['string','1'],['prefix','1hello'],['empty',''],['array',[1]],['object',{}]]) add(route,'value-'+suffix,'anonymous',{body:{[field]:value}});
 for(const [suffix,tid] of [['missing',null],['negative',-1],['unknown',9999],['string','0'],['prefix','0hello'],['fractional',0.5],['array',[0]],['overflow',2147483648]]) add(route,'tid-'+suffix,'anonymous',{body:{tid}});
 add(route,'missing-conversation','anonymous',{body:{conversation_id:null}});
 add(route,'unknown-conversation','anonymous',{body:{conversation_id:'2markmissing'}});
 add(route,'query-only','anonymous',{query:'?conversation_id=2markfixture&tid=0&'+field+'=1',body:{conversation_id:null,tid:null,[field]:null}});
 add(route,'query-ignored','anonymous',{query:'?tid=9999&'+field+'=0'});
 add(route,'extra-field','anonymous',{body:{xid:'generated-other'}});
 add(route,'malformed-json','anonymous',{raw:'{'});
 add(route,'charset','anonymous',{contentType:'application/json; charset=iso-8859-1'});
 for(const fault of ['write','duplicate','after-commit']) add(route,fault,'anonymous',{fault});
}
let active;
const originalQueryP=pg.queryP.bind(pg),originalQuery=pg.query.bind(pg);
function isWrite(sql){return /INSERT INTO (stars|trashes)/i.test(sql);}
function fault(){active.faultFired++;return Object.assign(new Error('generated mark write fault'),{code:active.fault==='duplicate'?'23505':'XX000'});}
pg.queryP=async function(sql,args){
 if(isWrite(sql)&&active?.fault&&active.fault!=='after-commit') throw fault();
 const result=await originalQueryP(sql,args);
 if(isWrite(sql)&&active?.fault==='after-commit') throw fault();
 return result;
};
pg.query=function(sql,args,callback){
 if(isWrite(sql)&&active?.fault&&active.fault!=='after-commit') return callback(fault());
 return originalQuery(sql,args,(err,result)=>{
  if(!err&&isWrite(sql)&&active?.fault==='after-commit') return callback(fault());
  callback(err,result);
 });
};
async function seed(){
 await db.query('DELETE FROM stars WHERE zid=$1',[Z]);
 await db.query('DELETE FROM trashes WHERE zid=$1',[Z]);
 await db.query('DELETE FROM zinvites WHERE zid=$1',[Z]);
 await db.query('DELETE FROM xids WHERE owner=$1 OR zid=$2',[U,Z]);
 await db.query('DELETE FROM xid_whitelist WHERE owner=$1',[U]);
 await db.query('DELETE FROM comments WHERE zid=$1',[Z]);
 await db.query('DELETE FROM participants_extended WHERE zid=$1',[Z]);
 await db.query('DELETE FROM participants WHERE zid=$1',[Z]);
 await db.query('DELETE FROM conversations WHERE zid=$1',[Z]);
 await db.query("DELETE FROM oidc_user_mappings WHERE oidc_sub='generated-mark-account'");
 await db.query("DELETE FROM users WHERE email='generated-mark@example.invalid'");
 await db.query('DELETE FROM users WHERE uid BETWEEN $1 AND $2',[U,U+5]);
 for(let i=0;i<6;i++) await db.query('INSERT INTO users(uid,hname,site_id) VALUES($1,$2,$3)',[U+i,'Generated mark participant','generated-site-'+i]);
 await db.query("INSERT INTO conversations(zid,owner,topic,is_active) VALUES($1,$2,'Generated mark fixture',true)",[Z,U]);
 await db.query('INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)',[Z,CID]);
 for(let i=0;i<5;i++) await db.query('INSERT INTO participants(zid,uid) VALUES($1,$2)',[Z,U+i]);
 await db.query('INSERT INTO xids(owner,uid,xid,zid,pid) VALUES($1,$2,$3,$4,3)',[U,U+3,'generated-member',Z]);
 await db.query("INSERT INTO participants_extended(zid,uid,permanent_cookie) VALUES($1,$2,'generated-cookie')",[Z,U+1]);
 await db.query('INSERT INTO xid_whitelist(owner,xid) VALUES($1,$2)',[U,'generated-member']);
}
async function snapshot(){
 const stars=(await db.query('SELECT zid,pid,tid,starred FROM stars WHERE zid=$1 ORDER BY pid,tid,starred',[Z])).rows;
 const trashes=(await db.query('SELECT zid,pid,tid,trashed FROM trashes WHERE zid=$1 ORDER BY pid,tid,trashed',[Z])).rows;
 const members=(await db.query('SELECT pid,uid FROM participants WHERE zid=$1 ORDER BY pid',[Z])).rows;
 const uids=(await db.query('SELECT uid FROM users ORDER BY uid')).rows.map(x=>x.uid);
 const mappings=(await db.query("SELECT oidc_sub,uid FROM oidc_user_mappings WHERE oidc_sub='generated-mark-account'")).rows.map(x=>({...x,uid:x.uid>=U&&x.uid<=U+5?x.uid:'generated-account'}));
 const modified=(await db.query('SELECT modified FROM conversations WHERE zid=$1',[Z])).rows[0].modified;
 const result={stars,trashes,mappings,members,modified:modified==='1'?'initial':'advanced'};
 Object.defineProperty(result,'uids',{value:uids});return result;
}
async function main(){
 assert.ok(new URL(process.env.DATABASE_URL).hostname==='localhost' || new URL(process.env.DATABASE_URL).hostname==='127.0.0.1');
 assert.equal(new URL(process.env.DATABASE_URL).pathname,'/polis-test');
 await appReady;
 server=app.listen(59045,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const out=process.argv[2]; assert.ok(out);
 const oidc=process.env.MARK_PROVIDER_TOKEN_FILE?JSON.parse(fs.readFileSync(process.env.MARK_PROVIDER_TOKEN_FILE,'utf8')):null;
 assert.ok(oidc,'provider-signed generated credentials required');
 const records=[];
 for(const spec of cases){
  await seed(); active={...spec,faultFired:0};
  if(spec.auth==='oidc-existing') await db.query("INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES('generated-mark-account',$1)",[U+2]); await db.query('UPDATE conversations SET modified=1 WHERE zid=$1',[Z]);
  await db.query('UPDATE conversations SET is_active=$2,treevite_enabled=$3,xid_required=$4,use_xid_whitelist=$5 WHERE zid=$1',[Z,spec.setup!=='closed',spec.setup==='treevite',spec.setup==='xid-required',spec.setup==='whitelist']);
  if(spec.setup==='repeat') await db.query('INSERT INTO '+spec.route+'(zid,pid,tid,'+(spec.route==='stars'?'starred':'trashed')+') VALUES($1,1,0,1)',[Z]);
  const tokens={anonymous:issueParticipantJWT('anonymous',CID,U+1,1),pid0:issueParticipantJWT('anonymous',CID,U,0),standard:issueParticipantJWT('standard_user',CID,U+2,2,'generated-standard'),xid:issueParticipantJWT('xid',CID,U+3,3,'generated-member'),owner:issueParticipantJWT('standard_user',CID,U,0,'generated-owner'),foreign:issueParticipantJWT('anonymous','2markforeign',U+1,1),nonmember:issueParticipantJWT('anonymous',CID,U+5,5),oidc:oidc.valid,'oidc-existing':oidc.valid,'xid-new':issueParticipantJWT('xid',CID,U+5,-1,'generated-new-member'),'xid-first':issueParticipantJWT('xid','2markforeign',U+5,-1,'generated-first-member'),malformed:'generated-invalid'};
  tokens.admin=issueParticipantJWT('standard_user',CID,U+4,4,'generated-admin'); tokens.moderator=tokens.standard; tokens['marked-participant']=tokens.standard;
  if(spec.auth==='moderator') await db.query('UPDATE users SET site_id=(SELECT site_id FROM users WHERE uid=$1) WHERE uid=$2',[U,U+2]);
  if(spec.auth==='marked-participant') await db.query('UPDATE participants SET mod=1 WHERE zid=$1 AND pid=2',[Z]);
  const claims=jwt.decode(tokens.anonymous); tokens['stale-pid']=jwt.sign({...claims,pid:4},keys.privateKey,{algorithm:'RS256'}); tokens.expired=jwt.sign({...claims,exp:1},keys.privateKey,{algorithm:'RS256'}); tokens.signature=tokens.anonymous.slice(0,tokens.anonymous.lastIndexOf('.')+1)+'invalid';
  tokens.lowercase=tokens.anonymous;
  for(const [name,field,value] of [['wrong-issuer','iss','generated-invalid'],['wrong-audience','aud','generated-invalid'],['future','nbf',Math.floor(Date.now()/1000)+86400]]) tokens[name]=jwt.sign({...claims,[field]:value},keys.privateKey,{algorithm:'RS256'});
  const before=await snapshot();
  const body={conversation_id:CID,tid:0,[spec.route==='stars'?'starred':'trashed']:1,...spec.body};
  let req=request('http://127.0.0.1:59045')[spec.method.toLowerCase()]('/api/v3/'+spec.route+(spec.query||''))
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
  await new Promise(r=>setTimeout(r,180));
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
  records.push({name:spec.name,route:spec.route,method:spec.method,auth:spec.auth,setup:spec.setup||null,fault:spec.fault||null,request:body,query:spec.query||'',raw:spec.raw||null,contentType:spec.contentType||'application/json',status:response.status,headers,body:bytes,issued,addedUsers,before,after,faultFired:active.faultFired});
  fs.writeFileSync(out+'.partial.json',JSON.stringify(records,null,2)+'\n');
  console.log(JSON.stringify({case:spec.name,status:response.status,issued:!!issued}));

 }
 fs.writeFileSync(out,JSON.stringify(records,null,2)+'\n');
 if(process.argv[3]) assert.deepEqual(records,JSON.parse(fs.readFileSync(process.argv[3],'utf8')));
 console.log(JSON.stringify({cases:records.length,differences:process.argv[3]?0:null}));
 await seed(); await db.end(); await new Promise(resolve=>server.close(resolve));
}
module.exports={app,appReady,db,seed,keys,CID,Z,U,issueParticipantJWT};
if(require.main===module) main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
