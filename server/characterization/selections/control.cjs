'use strict';
// Explicit fault and scheduling controls around unchanged handlers. No product
// handler, schema, guard assertion or source method is replaced.
const fs=require('node:fs'), assert=require('node:assert/strict'), http=require('node:http');
const request=require('supertest');
const fixture=require('./record.cjs');
const {db,app,appReady,seed,snapshot,CID,Z,U,issueParticipantJWT}=fixture;
const controls=[];
const active={publication:'pg-missing'};
const body=selections=>({conversation_id:CID,selections});
let server;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function main(){
 await appReady;
 server=app.listen(58955,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 fixture.setServer(server);
 const base='http://127.0.0.1:58955';
 const token=issueParticipantJWT('anonymous',CID,U+1,1);
 const send=(method,data,auth=token)=>{let q=request(base)[method]('/api/v3/topicAgenda/selections').set('x-forwarded-proto','https').set('accept-encoding','identity');if(auth)q=q.set('authorization','Bearer '+auth);return q.send(data).timeout({deadline:10000});};
 process.env.DELPHI_RESULT_BACKEND='postgres';process.env.DELPHI_RESULT_ENV='generated-selection';process.env.DELPHI_RESULT_SCOPE='generated-scope';
 await seed();fixture.activate(active);
 const first=await send('post',body(['first']),null), second=await send('post',body(['retry']),null);
 assert.equal(first.status,200);assert.equal(second.status,200);assert.notEqual(first.body.data.participant_id,second.body.data.participant_id);
 controls.push({name:'lost-first-credentials-tokenless-retry',statuses:[first.status,second.status],pids:[first.body.data.participant_id,second.body.data.participant_id],state:await snapshot(),sameIdentityRecovered:false});
 // Lose the socket after commit, before Express writes the first response.
 await seed();const committed=deferred(),release=deferred();
 fixture.activate({...active,afterQuery:async sql=>{if(/INSERT INTO topic_agenda_selections/.test(sql)){committed.resolve();await release.promise;}}});
 const lost=http.request(base+'/api/v3/topicAgenda/selections',{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https'}},()=>assert.fail('response must be lost'));
 lost.on('error',()=>{});lost.end(JSON.stringify(body(['lost-reply'])));
 await committed.promise;const lostState=await snapshot();assert.equal(lostState.rows.length,1);lost.destroy();release.resolve();
 await new Promise(r=>setTimeout(r,20));fixture.activate(active);
 const retry=await send('post',body(['retry-after-loss']),null);
 assert.equal(retry.status,200);assert.notEqual(Number(retry.body.data.participant_id),lostState.rows[0].pid);
 controls.push({name:'disconnect-after-selection-commit',committedBeforeDisconnect:lostState.rows.length,retryStatus:retry.status,identityRecovered:false,state:await snapshot()});
 // An unknown commit is not safe to replay: simulate transport completion loss
 // from the real query only after it has committed, without rolling it back.
 await seed();fixture.activate({...active,afterQuery:async sql=>{if(/INSERT INTO topic_agenda_selections/.test(sql))throw new Error('generated lost commit acknowledgement');}});
 const late=await send('post',body(['committed']));assert.equal(late.status,500);assert.equal((await snapshot()).rows.length,1);
 controls.push({name:'late-error-after-commit',status:late.status,body:late.text,state:await snapshot()});
 // Pin Node's non-atomic PUT gap. The concurrent POST wins the insert; PUT's
 // later INSERT fails with a duplicate, leaving the POST row intact.
 await seed();const empty=deferred(),continuePut=deferred();
 fixture.activate({...active,afterQuery:async (sql,args,rows)=>{if(/UPDATE topic_agenda_selections\s+SET/.test(sql)&&rows.length===0){empty.resolve();await continuePut.promise;}}});
 const put=send('put',body(['put'])).then(r=>r);await empty.promise;
 const post=await send('post',body(['post']));continuePut.resolve();const collided=await put;
 assert.equal(post.status,200);assert.equal(collided.status,500);assert.deepEqual((await snapshot()).rows[0].archetypal_selections,['post']);
 controls.push({name:'put-update-miss-post-insert-put-conflict',statuses:[post.status,collided.status],body:collided.text,state:await snapshot()});
 // DELETE after POST and PUT after DELETE record the sequential ends of the
 // same-key mixed-method ordering, including Node's created response branch.
 fixture.activate(active);const removed=await send('delete',body());const created=await send('put',body(['after-delete']));
 assert.equal(removed.status,200);assert.match(created.text,/created successfully/);
 controls.push({name:'post-delete-put',statuses:[removed.status,created.status],bodies:[removed.text,created.text],state:await snapshot()});
 // The lookup waits before any selection statement. While parked, the DB
 // sees no selection transaction; another connection still reads immediately.
 await seed();const lookup=deferred(),entered=deferred();fixture.activate({...active,publicationWait:lookup.promise,publicationEntered:entered.resolve});
 const waiting=send('post',body(['lookup'])).then(r=>r);await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('lookup not entered')),5000))]);
 assert.equal((await snapshot()).rows.length,0);
 const sessions=(await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query ILIKE '%topic_agenda_selections%'")).rows[0].n;
 assert.equal(sessions,0);lookup.resolve();assert.equal((await waiting).status,200);
 controls.push({name:'publication-network-wait-before-write',lookupEntered:true,openSelectionTransactions:sessions,state:await snapshot()});
 // A saved topic is visible to the very next topical HTTP read. Provider
 // results are local stand-ins; SQL selection and comment filtering are real.
 await seed();fixture.activate(active);
 await db.query("INSERT INTO comments(zid,pid,uid,txt,lang,mod,created,modified) VALUES($1,0,$2,'Generated topic comment','en',0,1700000000000,1700000000000)",[Z,U]);
 const tid=(await db.query('SELECT tid FROM comments WHERE zid=$1',[Z])).rows[0].tid;
 await db.query("INSERT INTO comments(zid,pid,uid,txt,lang,mod,created,modified) VALUES($1,0,$2,'Generated distractor comment','en',0,1700000000000,1700000000000)",[Z,U]);
 const distractor=(await db.query('SELECT tid FROM comments WHERE zid=$1 AND tid<>$2',[Z,tid])).rows[0].tid;
 const save=await send('post',body([{topic_key:'generated-topic',topic_id:'generated-topic',priority:1}]));assert.equal(save.status,200);
 process.env.DELPHI_RESULT_BACKEND='dynamodb';process.env.TOPICAL_COMMENT_RATIO='1';
 const topicCalls=[];
 fixture.activate({...active,topicProvider:input=>{
  topicCalls.push(input.TableName);
  if(input.TableName==='Delphi_CommentClustersLLMTopicNames'){assert.equal(input.ExpressionAttributeValues[':tk'],'generated-topic');assert.equal(input.ExpressionAttributeValues[':cid'],String(Z));return {Items:[{layer_id:'0',cluster_id:'1'}]};}
  if(input.TableName==='Delphi_CommentHierarchicalClusterAssignments')return {Items:[{comment_id:tid,layer0_cluster_id:'1'},{comment_id:distractor,layer0_cluster_id:'2'}]};
  throw new Error('unexpected topic provider table');
 }});
 const next=await request(base).get('/api/v3/nextComment').query({conversation_id:CID,pid:1}).set('authorization','Bearer '+token).set('x-forwarded-proto','https');
 assert.equal(next.status,200);assert.equal(next.body.tid,tid);assert.notEqual(next.body.tid,distractor);assert.equal(topicCalls.length,2);
 controls.push({name:'immediate-topical-next-comment',selectedTopic:'generated-topic',distractorTid:distractor,saveStatus:save.status,nextStatus:next.status,body:next.text,topicCalls});
 process.env.DELPHI_RESULT_BACKEND='postgres';delete process.env.TOPICAL_COMMENT_RATIO;
 // Wrapper controls are distinguished from reachable route outcomes: these
 // routes always return objects, but the middleware must leave arrays/text and
 // existing truthy auth alone even on an error status.
 const {attachAuthToken}=require('../../src/auth/attach-auth-token.ts');
 for(const [name,input] of [['object',{error:'generated'}],['array',[]],['existing',{auth:{token:'existing'}}],['false-auth',{auth:false}],['null',null]]){
  let observed;const req={p:{authToken:{token:'generated-control',token_type:'Bearer',expires_in:31536000}}};
  const res={statusCode:500,json(v){observed=JSON.stringify(v);return this;}};
  attachAuthToken()(req,res,()=>{});res.json(input);
  controls.push({name:'auth-wrapper-'+name,status:500,body:observed});
 }
 const textRes={json(){throw new Error('not JSON');},send(v){return v;}};attachAuthToken()({p:{authToken:{token:'generated-control'}}},textRes,()=>{});
 controls.push({name:'auth-wrapper-non-json',body:textRes.send('plain response')});
 fixture.activate(active);await seed();await db.end();await new Promise(r=>server.close(r));
 fs.writeFileSync(process.argv[2],JSON.stringify(controls,null,2)+'\n');
 if(process.argv[3])assert.deepEqual(controls,JSON.parse(fs.readFileSync(process.argv[3])));
 console.log(JSON.stringify({controls:controls.length,differences:process.argv[3]?0:null}));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
