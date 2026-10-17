"use strict";
// Generated fixtures and real HTTP handlers. Predictions are supplied by the
// Rust contract example; this observer never derives expected admission.
const fs=require('node:fs'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {storageToSemantic}=require('../src/votes/convention.ts');
const predictions=JSON.parse(fs.readFileSync('/artifacts/setup-predictions.json','utf8'));
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
const base='http://127.0.0.1:5000';
async function api(method,path,body,token,cookie){
 const headers={'content-type':'application/json'};
 if(token)headers.authorization='Bearer '+token;
 if(cookie)headers.cookie='pc='+cookie;
 const r=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
 const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{data=null}
 return {status:r.status,data,code:typeof data?.error==='string'?data.error:null};
}
const q=async(sql,args=[]) => (await pool.query(sql,args)).rows;
const one=async(sql,args=[]) => (await q(sql,args))[0];
const uid=async()=>+(await one('INSERT INTO users DEFAULT VALUES RETURNING uid')).uid;
async function conversation(owner){
 const zid=+(await one("INSERT INTO conversations(owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter) VALUES($1,'Generated admission proof',true,false,true,false,false) RETURNING zid",[owner])).zid;
 const id='2'+crypto.randomBytes(10).toString('hex');
 await q('INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)',[zid,id]);
 const pid=+(await one('INSERT INTO participants(zid,uid) VALUES($1,$2) RETURNING pid',[zid,owner])).pid;
 const tids=[];
 for(let i=0;i<3;i++)tids.push(+(await one("INSERT INTO comments(zid,pid,uid,txt,mod,active,is_seed,lang) VALUES($1,$2,$3,$4,1,true,true,'en') RETURNING tid",[zid,pid,owner,'Generated seed '+i])).tid);
 return {zid,id,tids};
}
async function vote(c,token,xid,tid=c.tids[0]){
 const r=await api('POST','/api/v3/votes',{conversation_id:c.id,tid,vote:predictions.wire_agree,...(xid?{xid}:{})},token);
 if(r.status!==200)throw Error('fixture enrollment failed '+r.status+' '+r.code);
 return r.data.auth?.token||token;
}
async function invite(c){
 const wave=+(await one('INSERT INTO treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size) VALUES($1,1,0,0,1,1) RETURNING id',[c.zid])).id;
 const code=crypto.randomBytes(16).toString('hex');
 await q('INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES($1,$2,$3)',[c.zid,wave,code]);return code;
}
function claims(t){return JSON.parse(Buffer.from(t.split('.')[1],'base64url'));}
async function run(){
 const tokens=await (await fetch('http://127.0.0.1:5001/tokens')).json();
 const ownerToken=tokens.owner,otherToken=tokens.admin;
 for(const token of [ownerToken,otherToken]){
  const r=await api('GET','/api/v3/users',null,token);if(r.status!==200)throw Error('OIDC bootstrap failed');
 }
 const owner=+(await one('SELECT uid FROM oidc_user_mappings WHERE oidc_sub=$1',[claims(ownerToken).sub])).uid;
 const other=+(await one('SELECT uid FROM oidc_user_mappings WHERE oidc_sub=$1',[claims(otherToken).sub])).uid;
 const originalSite=(await one('SELECT site_id FROM users WHERE uid=$1',[other])).site_id;
 const rows=[],mismatches=[];let index=0;fs.writeFileSync('/artifacts/setup-admission-results.jsonl','');
 for(const c of predictions.cases){
  const conv=await conversation(owner);let token,xid,cookie,code;
  // Unique XIDs prevent another case from changing a fresh identity's class.
  const allowed='allow-'+crypto.randomBytes(10).toString('hex');
  const denied='deny-'+crypto.randomBytes(10).toString('hex');
  await q('INSERT INTO xid_whitelist(owner,zid,xid) VALUES($1,$2,$3)',[owner,conv.zid,allowed]);
  switch(c.entry){
   case 'anonymous_member_xid':token=await vote(conv);xid=denied;break;
   case 'anonymous_other_xid':token=await vote(await conversation(owner));xid=allowed;break;
   case 'signed_in_xid':token=otherToken;xid=denied;break;
   case 'cookie_member_xid':{
    const t=await vote(conv);cookie=crypto.randomBytes(16).toString('hex');xid=denied;
    await q('UPDATE participants_extended SET permanent_cookie=$1 WHERE zid=$2 AND uid=$3',[cookie,conv.zid,claims(t).uid]);break;
   }
   case 'xid_member_changed_xid':token=await vote(conv,null,allowed);xid=denied;break;
   case 'xid_other_owner_known_xid':
    await vote(await conversation(owner),null,denied);
    token=await vote(await conversation(await uid()),null,allowed);xid=denied;break;
   case 'xid_same_owner_unknown_xid':token=await vote(await conversation(owner),null,allowed);xid=denied;break;
   case 'anonymous_member':token=await vote(conv);break;
   case 'anonymous_other_conversation':token=await vote(await conversation(owner));break;
   case 'new_xid_allowed':xid=allowed;break;
   case 'new_xid_denied':xid=denied;break;
   case 'known_xid_member':await vote(conv,null,denied);xid=denied;break;
   case 'known_xid_nonmember':await vote(await conversation(owner),null,denied);xid=denied;break;
   case 'xid_token_member':token=await vote(conv,null,denied);break;
   case 'xid_token_same_owner':token=await vote(await conversation(owner),null,denied);break;
   case 'xid_token_other_owner':token=await vote(await conversation(await uid()),null,denied);break;
   case 'signed_in_new':token=otherToken;break;
   case 'signed_in_member':token=otherToken;await vote(conv,token);break;
   case 'owner':token=ownerToken;break;
   case 'site_moderator_new':token=otherToken;await q('UPDATE users SET site_id=(SELECT site_id FROM users WHERE uid=$1) WHERE uid=$2',[owner,other]);break;
   case 'invite':case 'returning_invite':code=await invite(conv);break;
   case 'legacy_cookie_member':{
    const t=await vote(conv);cookie=crypto.randomBytes(16).toString('hex');
    await q('UPDATE participants_extended SET permanent_cookie=$1 WHERE zid=$2 AND uid=$3',[cookie,conv.zid,claims(t).uid]);break;
   }
   case 'legacy_cookie_missing':cookie=crypto.randomBytes(16).toString('hex');break;
  }
  await q('UPDATE conversations SET treevite_enabled=$1,xid_required=$2,use_xid_whitelist=$3,is_active=$4,strict_moderation=$5 WHERE zid=$6',[c.tree,c.xid===1||c.xid===2,c.xid>=2,c.active,c.strict,conv.zid]);
  let login;
  if(c.entry==='returning_invite' || (c.entry==='invite' && c.action!=='join')){
   const accept=await api('POST','/api/v3/treevite/acceptInvite',{conversation_id:conv.id,invite_code:code});
   if(accept.status!==201)throw Error('fixture invite failed');token=accept.data.auth.token;login=accept.data.login_code;
  }
  if(c.entry==='returning_invite' && c.action!=='join'){
   const r=await api('POST','/api/v3/treevite/login',{conversation_id:conv.id,login_code:login});
   if(r.status!==200)throw Error('fixture login failed');token=r.data.auth.token;
  }
  let actual;
  if(c.action==='join'){
   if(c.entry==='invite')actual=await api('POST','/api/v3/treevite/acceptInvite',{conversation_id:conv.id,invite_code:code});
   else if(c.entry==='returning_invite')actual=await api('POST','/api/v3/treevite/login',{conversation_id:conv.id,login_code:login});
   else actual=await api('GET','/api/v3/participationInit?conversation_id='+conv.id+'&includePCA=false'+(xid?'&xid='+encodeURIComponent(xid):''),null,token,cookie);
  }else{
   const body={conversation_id:conv.id,...(xid?{xid}:{})};
   if(c.action==='vote')Object.assign(body,{tid:conv.tids[1],vote:predictions.wire_agree});
   else body.txt='Generated matrix statement '+crypto.randomBytes(10).toString('hex');
   actual=await api('POST','/api/v3/'+(c.action==='vote'?'votes':'comments'),body,token,cookie);
  }
  const row={...c,actual:{status:actual.status,code:actual.code},matches:c.prediction.status===actual.status&&c.prediction.code===actual.code};
  if(c.action==='vote' && actual.status===200){
   const v=await one('SELECT v.vote,v.pid,p.uid FROM votes v JOIN participants p ON p.zid=v.zid AND p.pid=v.pid WHERE v.zid=$1 AND v.tid=$2',[conv.zid,conv.tids[1]]);
   row.vote_matches=!!v&&storageToSemantic(v.vote)==='agree'&&v.pid===actual.data.currentPid;
   if(!row.vote_matches)throw Error('stored vote identity or semantic mismatch');
  }
  if(c.action==='comment' && actual.status===200){
   const r=await one('SELECT c.pid,c.uid,c.mod,c.is_seed,p.uid AS participant_uid FROM comments c JOIN participants p ON p.zid=c.zid AND p.pid=c.pid WHERE c.zid=$1 AND c.tid=$2',[conv.zid,actual.data.tid]);
   row.comment_matches=r.pid===actual.data.currentPid&&r.uid===r.participant_uid&&!r.is_seed;
   if(!row.comment_matches)throw Error('stored comment identity mismatch');
   row.moderation=r.mod;
   const next=await api('GET','/api/v3/nextComment?conversation_id='+conv.id+'&initial_tid='+actual.data.tid);
   row.visible=next.status===200&&next.data.tid===actual.data.tid;
   const expectedVisible=!c.strict || ['owner','site_moderator_new'].includes(c.entry);
   if(row.visible!==expectedVisible)throw Error('comment visibility mismatch');
  }
  if(c.entry==='site_moderator_new')await q('UPDATE users SET site_id=$1 WHERE uid=$2',[originalSite,other]);
  rows.push(row);fs.appendFileSync('/artifacts/setup-admission-results.jsonl',JSON.stringify(row)+'\n');if(!row.matches)mismatches.push(row);
  if(++index%54===0)process.stderr.write('observed '+index+' cases; mismatches '+mismatches.length+'\n');
 }
 const result={cases:rows.length,mismatches:mismatches.length,rows};
 fs.writeFileSync('/artifacts/setup-admission-results.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({cases:rows.length,mismatches:mismatches.length}));
 await pool.end();if(mismatches.length)process.exitCode=1;
}
run().catch(async e=>{console.error(e.message);await pool.end();process.exitCode=1});
