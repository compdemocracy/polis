"use strict";
// Additional cases run after the original corpus so its inputs and ordering stay
// unchanged. All response evidence comes from the real HTTP recorder.
const assert = require('node:assert/strict');
let moderatorPid;
exports.cases = (add, convention) => {
  for (const outcome of ['new','changed','repeated','moderated-out','missing-comment','closed']) {
    add('moderator-'+outcome,'site-moderator',{
      tid:outcome==='moderated-out'?2:outcome==='missing-comment'?999:9,
      ...(['changed','repeated'].includes(outcome)?{vote:convention.semanticToWire('disagree')}:{})
    },outcome==='closed'?403:200,outcome==='closed'?'closed':null);
  }
  add('lost-first-reply','unauthenticated');
  add('lost-first-reply-retry-without-token','unauthenticated');
  add('fresh-parser-refusal','unauthenticated',{starred:'yes'},400);
  add('parser-refusal-retry-without-token','unauthenticated');
  add('fresh-handler-error-auth','unauthenticated',{},500,null,'vote');
  add('fresh-star-error-auth','unauthenticated',{starred:true},500,null,'star');
  add('fresh-next-error-auth','unauthenticated',{},500,null,'next');
  add('missing-membership-valid-token','missing-member');
  add('revoked-membership-valid-token','revoked-member',{},200,'revoked-member');
  add('foreign-standard-token','foreign-standard');
  add('foreign-xid-same-owner','foreign-xid');
  add('foreign-xid-different-owner','foreign-xid-other-owner');
  add('xid-request-overrides-token','xid',{xid:'generated-override'});
  add('xid-blank-preserves-token','xid',{xid:''});
  add('xid-whitespace-preserves-token','xid',{xid:'  '});
  add('xid-tab-preserves-token','xid',{xid:'\t'});
  add('anonymous-blank-xid','unauthenticated',{xid:' '});
  add('signed-xid-removed-from-list','xid',{},403,'removed-whitelist');
  add('bare-xid-existing-member','unauthenticated',{xid:'generated-member'});
  add('treevite-lookup-without-pid','standard-no-pid',{},200,'treevite');
  add('treevite-foreign-standard-member','foreign-standard',{},200,'treevite');
  add('treevite-foreign-xid-member','foreign-xid',{},200,'treevite');
  add('treevite-pid-zero','pid0',{},200,'treevite');
  add('treevite-new-xid','unauthenticated',{xid:'generated-treevite-new'},401,'treevite');
  add('treevite-new-standard','standard-nonmember',{},401,'treevite');
  add('treevite-new-oidc','comments-owner-1',{},401,'treevite');
  add('oidc-first-contact','comments-owner-2');
  add('oidc-account-failure','comments-owner-2',{},500,null,'account');
  add('oidc-account-conflict','comments-owner-2',{},429,null,'account-conflict');
  add('oidc-account-load','comments-owner-2',{},429,null,'account-load');
  for(const kind of ['anonymous','standard','xid']) for(const fault of ['expired','signature','issuer','audience'])
    add(kind+'-'+fault,kind+'-'+fault,{},401);
  add('star-saved-before-next-failure','participant',{starred:true},500,null,'next');
  add('ignored-caller-pid-weight','participant',{pid:80,weight:123,weight_x_32767:123});
  add('backdated-latest-replacement','participant',{},200,'backdated');
  add('retained-latest-weight','participant',{},200,'latest-weight');
  add('translated-next-comment','unauthenticated',{lang:'fr'},200,'translations');
  add('translation-read-fallback','unauthenticated',{lang:'fr'},200,null,'translation-read');
  add('topical-next-comment','site-moderator',{},200,'topical');
  add('topical-empty-agenda-fallback','participant',{},200,'topical-empty');
  add('topical-exhausted-fallback','participant',{},200,'topical-exhausted');
  // Deliberately red on this source pin: each returns HTTP 200 and commits one
  // vote, then deferred bookkeeping writes emit an unhandledRejection. The
  // vote-path work fixes these writes; run.cjs:128's oracle assertion stays intact.
  if(process.env.P027_VOTES_DEFERRED_FAILURE) {
    add('deferred-conversation-failure','participant',{},200,null,'deferred-conversation');
    add('deferred-participant-failure','participant',{},200,null,'deferred-participant');
    add('deferred-count-failure','participant',{},200,null,'deferred-count');
  }
  add('treevite-owner-without-membership','owner',{conversation_id:'2generatedempty'},200,'treevite-cold-owner');
  add('fresh-admin-join','admin',{conversation_id:'2generatedempty'},200,'cold-admin');
  add('oidc-missing-email','oidc-missing-email',{},400);
  for(const kind of ['expired','issuer','audience','signature','unknown-key']) add('oidc-'+kind,'oidc-'+kind,{},401);
  // Real parser rejection; the input exceeds the server's 50 MiB limit.
  add('parser-body-too-large','participant',{padding:' '.repeat(50*1024*1024)},413);
  add('parser-unsupported-charset','participant',{},415,null,null,{'content-type':'application/json; charset=iso-8859-1'});
  add('parser-unsupported-content-encoding','participant',{},415,null,null,{'content-encoding':'unsupported'});
};
exports.initialize = async (pool) => {
  await pool.query("INSERT INTO users(uid,hname,site_id) VALUES(100004,'Generated moderator','p027-owner'),(100005,'Generated nonmember','generated-site'),(100006,'Generated removed member','generated-site')");
  const moderator=await pool.query('INSERT INTO participants(zid,uid,created) VALUES(1,100004,1700000000000) RETURNING pid');
  moderatorPid=moderator.rows[0].pid;
  const removed=await pool.query('INSERT INTO participants(zid,uid,created) VALUES(1,100006,1700000000000) RETURNING pid');
  await pool.query("INSERT INTO comments(zid,pid,uid,txt,lang,created,modified,mod) VALUES(1,0,1,'Generated moderator statement','en',1700000000000,1700000000000,0)");
  await pool.query("INSERT INTO conversations(zid,owner,topic,is_active) VALUES(3,100004,'Generated other owner',true),(4,1,'Generated no members',true)");
  await pool.query("INSERT INTO zinvites(zid,zinvite) VALUES(3,'2generatedotherowner'),(4,'2generatedempty')");
  return {moderatorPid,removedPid:removed.rows[0].pid};
};
exports.setup = async (kind, pool, get) => {
  await get('/votes-mode?topical='+(kind?.startsWith('topical')?'1':'0'));
  if (kind==='removed-whitelist') {
    await pool.query('UPDATE conversations SET use_xid_whitelist=true WHERE zid=1');
    await pool.query("DELETE FROM xid_whitelist WHERE owner=1 AND xid='generated-member'");
  }
  if(kind==='revoked-member') {
    await pool.query('DELETE FROM participants WHERE zid=1 AND uid=100006');
  }
  if(kind==='treevite-cold-owner'||kind==='cold-admin') await pool.query('UPDATE conversations SET treevite_enabled=$1 WHERE zid=4',[kind==='treevite-cold-owner']);
  if (kind==='backdated') await pool.query('UPDATE votes_latest_unique SET modified=1700000001000 WHERE zid=1 AND pid=2 AND tid=0');
  if (kind==='latest-weight') await pool.query('UPDATE votes_latest_unique SET weight_x_32767=7 WHERE zid=1 AND pid=2 AND tid=0');
  if (kind==='translations') await pool.query("INSERT INTO comment_translations(zid,tid,txt,lang,src,created,modified) SELECT zid,tid,'Texte traduit','fr',0,1700000000000,1700000000000 FROM comments WHERE zid=1");
  if (kind?.startsWith('topical')) {
    const {DynamoDBClient,CreateTableCommand,PutItemCommand}=require('@aws-sdk/client-dynamodb');
    const client=new DynamoDBClient({endpoint:process.env.DYNAMODB_ENDPOINT,region:'us-east-1',credentials:{accessKeyId:'generatedlocal',secretAccessKey:'generatedlocal'}});
    try {
      for(const table of ['Delphi_CommentClustersLLMTopicNames','Delphi_CommentHierarchicalClusterAssignments']) {
        try { await client.send(new CreateTableCommand({TableName:table,...require('../dynamo-schema.json').tables[table]})); }
        catch(e) { if(e.name!=='ResourceInUseException') throw e; }
      }
      await client.send(new PutItemCommand({TableName:'Delphi_CommentClustersLLMTopicNames',Item:{conversation_id:{S:'1'},topic_key:{S:'generated-topic'},layer_id:{N:'0'},cluster_id:{N:'1'}}}));
      await client.send(new PutItemCommand({TableName:'Delphi_CommentHierarchicalClusterAssignments',Item:{conversation_id:{S:'1'},comment_id:{N:kind==='topical-exhausted'?'0':'1'},layer0_cluster_id:{N:'1'}}}));
      // The existing moderator has an unvoted statement in this topic.
      const pid=kind==='topical' ? moderatorPid : 2;
      await pool.query('INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,delphi_job_id) VALUES(1,$1,$2,$3) ON CONFLICT(zid,pid) DO UPDATE SET archetypal_selections=EXCLUDED.archetypal_selections',[pid,JSON.stringify(kind==='topical-empty'?[]:[{topic_key:'generated-topic'}]),'generated-job']);
    } finally { client.destroy(); }
  }
};
exports.check = (spec,r,after) => {
  if(spec.status===415) {
    assert.equal(r.response.body,'Unsupported Media Type\n');
    assert.equal(r.voteProof.historyAdded,0);
    assert.equal(r.effects.participantCreated,0);
  }
  if(spec.name.startsWith('moderator-')&&spec.status===200) {
    assert.equal(r.response.body.currentPid,moderatorPid);
    assert.ok(after['pg:participants'].some(p=>p.zid===1&&p.pid===moderatorPid&&p.uid===100004));
  }
  if(spec.name==='topical-next-comment') {
    assert.equal(r.response.body.nextComment.tid,1);
    assert.equal(r.response.body.nextComment.zid,1);
    for(const key of ['remaining','total','randomN']) assert.equal(Object.hasOwn(r.response.body.nextComment,key),false);
  }
  if(spec.name.startsWith('topical-')&&spec.name.endsWith('fallback')) assert.equal(typeof r.response.body.nextComment.remaining,'number');
  if(spec.name==='translated-next-comment') assert.ok(r.response.body.nextComment.translations.length>0);
  if(spec.name.startsWith('fresh-')&&spec.name.endsWith('-auth')) assert.ok(r.response.body.auth);
  if(spec.name==='fresh-parser-refusal') assert.equal(r.effects.participantCreated,1);
  if(spec.name==='star-saved-before-next-failure') assert.equal(r.effects.db['pg:stars'].added.length,1);
  if(spec.name==='retained-latest-weight') assert.equal(after['pg:votes_latest_unique'].find(v=>v.zid===1&&v.pid===2&&v.tid===0).weight_x_32767,7);
  if(spec.name==='ignored-caller-pid-weight') {
    assert.equal(r.voteProof.historyAdded,1);
    assert.equal(r.effects.db['pg:votes'].added[0].pid,2);
    assert.equal(r.effects.db['pg:votes'].added[0].weight_x_32767,0);
  }
};
