"use strict";
// Optional differential consumer of the immutable Node recordings profile.
// Credentials remain in memory; only checked counts and case names are saved.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { Pool } = require("pg");
const { verifyToken } = require("../jwt.cjs");
const { strings, bytes } = require("../wire.cjs");
const enabled = !!process.env.P027_TREEVITE_RUST_URL;
const tables = ["users", "conversations", "participants", "participants_extended", "xids", "xid_whitelist", "oidc_user_mappings", "zinvites", "treevite_waves", "treevite_invites", "treevite_login_codes"];
const sequenceTables = ["users", "treevite_waves", "treevite_invites", "treevite_login_codes"];
let rust;
function database() {
  if (!rust) {
    const url = new URL(process.env.P027_TREEVITE_RUST_DATABASE_URL);
    assert.equal(url.pathname, "/p027_rust", "isolated Rust replay database required");
    rust = new Pool({connectionString: url.toString()});
  }
  return rust;
}
async function capture(source, spec) {
  if (!enabled || !["acceptInvite","login"].includes(spec.route)) return null;
  const aliases = (await source.query("SELECT to_jsonb(t) AS row FROM zinvites t")).rows.map(r=>r.row);
  const sequences = {};
  for (const table of sequenceTables) {
    const seq = table === "users" ? "users_uid_seq" : table + "_id_seq";
    sequences[seq] = (await source.query(`SELECT last_value,is_called FROM ${seq}`)).rows[0];
  }
  return {aliases,sequences};
}
async function restore(before, captured) {
  const db=database();
  const c=await db.connect();
  try {
    await c.query("BEGIN");
    // This connection is exclusively the disposable p027_rust database.
    await c.query("SET LOCAL session_replication_role=replica");
    await c.query("TRUNCATE users CASCADE");
    for(const table of tables) {
      const rows=table==="zinvites" ? captured.aliases : before["pg:"+table];
      if(rows?.length) await c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(rows)]);
    }
    for(const [seq, value] of Object.entries(captured.sequences))
      await c.query("SELECT setval($1,$2,$3)",[seq,value.last_value,value.is_called]);
    await c.query("COMMIT");
  } catch(e) { await c.query("ROLLBACK"); throw e; }
  finally {c.release();}
}
function send(request,tokens) {
  return new Promise((resolve,reject)=>{
    const url=new URL(request.path,process.env.P027_TREEVITE_RUST_URL);
    for(const [k,v] of Object.entries(request.query)) url.searchParams.append(k,String(v));
    const headers={host:"localhost:5000",...request.headers};
    if(headers.authorization?.startsWith("$auth:")) headers.authorization="Bearer "+tokens[headers.authorization.slice(6)];
    const body=request.body===null ? null : JSON.stringify(request.body);
    if(body!==null) headers["content-length"]=Buffer.byteLength(body);
    const req=http.request(url,{method:request.method,headers},res=>{
      const parts=[];res.on("data",b=>parts.push(b));res.on("end",()=>{
        const raw=Buffer.concat(parts);let parsed;try {parsed=JSON.parse(raw);}catch{}
        resolve({status:res.statusCode,raw,body:parsed,headers:res.rawHeaders});
      });
    });
    req.setTimeout(15000,()=>req.destroy(Error("Rust replay deadline")));req.on("error",reject);req.end(body);
  });
}
function refusal(status,code) {return {status,body:`{"error":"${code}","message":"${code}","status":${status}}`};}
function expectedDelta(spec,before) {
  if(["accept-existing-xid-conversion","accept-standard-conversion","login-converted-xid"].includes(spec.name)) return {ruling:"TQ1",...refusal(403,"polis_err_treevite_identity_conversion")};
  if(spec.name === "accept-pid-zero-forks") return {ruling:"TQ1",...refusal(403,"polis_err_xid_owner_account")};
  if(spec.expired && !spec.revoke) return {ruling:"TQ3",...refusal(401,"polis_err_treevite_login_code_expired")};
  return null;
}
function normalizeBody(raw) {
  // Substitute only the verified credential string tokens and the explicitly
  // ruled expires_in scalar. All surrounding response bytes stay untouched.
  const text=raw.toString("utf8");
  if(!text.startsWith("{")) return text;
  return strings(text,(v,p,k)=> k==="token" ? "$verified-jwt" : k==="login_code" ? "$verified-login" : v).replace('"expires_in":31536000','"expires_in":86400');
}
function normalizeHeaders(headers,normalized) {
  const result=[];
  for(let i=0;i<headers.length;i+=2) {
    const name=headers[i], lower=name.toLowerCase();let value=headers[i+1];
    if(["date","connection","keep-alive"].includes(lower)) continue;
    if(lower==="content-length") value=String(Buffer.byteLength(normalized));
    if(lower==="etag") value=require("express/lib/utils").wetag(Buffer.from(normalized));
    result.push({name,value});
  }
  return result;
}
async function replay(spec,request,tokens,before,nodeResponses,captured) {
  if(!captured) return;
  await restore(before,captured);
  const responses=spec.race ? await Promise.all([send(request,tokens),send(request,tokens)]) : [await send(request,tokens)];
  const db=database();
  const participants=(await db.query("SELECT to_jsonb(t) AS row FROM participants t")).rows.map(r=>r.row);
  const users=Number((await db.query("SELECT count(*) AS n FROM users")).rows[0].n);
  const logins=(await db.query("SELECT * FROM treevite_login_codes")).rows;
  const invited=(await db.query("SELECT * FROM treevite_invites ORDER BY id")).rows;
  for(let i=0;i<responses.length;i++) {
    const r=responses[i],node=nodeResponses[i];
    const wireHeaders = new Map(Array.from({length:r.headers.length/2},(_,j)=>[r.headers[2*j].toLowerCase(),r.headers[2*j+1]]));
    if(wireHeaders.has("content-length")) assert.equal(wireHeaders.get("content-length"),String(r.raw.length),spec.name+" physical content length");
    if(wireHeaders.has("etag")) assert.equal(wireHeaders.get("etag"),require("express/lib/utils").wetag(r.raw),spec.name+" physical ETag");
    const checkChangedHeaders = reference => {
      const body=r.raw.toString("utf8");
      assert.deepEqual(normalizeHeaders(r.headers,body),normalizeHeaders(reference.wire.response.headers.flatMap(h=>[h.name,h.value]),body),spec.name+" changed-status headers");
      console.log("Changed-status headers passed: "+spec.name);
    };

    if(spec.race) {
      assert.deepEqual(responses.map(r=>r.status).sort(),[201,400]);
      if(r.status===400) {assert.equal(r.raw.toString(),refusal(400,"polis_err_treevite_invalid_or_used_invite").body);checkChangedHeaders(nodeResponses.find(n=>n.status===400));continue;}
    }
    const delta=expectedDelta(spec,before);
    if(delta) {
      assert.equal(r.status,delta.status,spec.name);assert.equal(r.raw.toString(),delta.body,spec.name);
      assert.equal(users,before["pg:users"].length,"refusal leaves no users");
      assert.equal(participants.length,before["pg:participants"].length,"refusal leaves no members");
      checkChangedHeaders(node);
      continue;
    }
    if(r.body?.auth) {
      const auth=r.body.auth;
      assert.equal(auth.expires_in,86400);
      const verified=verifyToken(auth.token,{publicKey:tokens.publicKey,now:1700000000,issuer:"https://pol.is/",audience:"participants",ttl:86400,conversation_id:request.body.conversation_id,zid:spec.zid||1,participants});
      assert.equal(verified.$jwt.anonymous_participant,true);
      const original = JSON.parse(Buffer.from((spec.race ? nodeResponses.find(n=>n.status===201) : node).body.auth.token.split(".")[1],"base64url"));
      const comparable = {...original}; delete comparable.exp; delete comparable.iat;
      if(spec.name === "accept-pid-zero-forks") {
        const source = JSON.parse(Buffer.from(tokens.pid0.split(".")[1],"base64url"));
        assert.equal(verified.$jwt.uid,source.uid); assert.equal(verified.$jwt.pid,0);
      } else if(spec.name === "accept-anonymous-other-conversation") {
        assert.notEqual(verified.$jwt.uid,original.uid,"Q14 keeps anonymous UIDs conversation-local");
        assert.deepEqual(verified.$jwt,{...comparable,uid:verified.$jwt.uid,sub:"anon:"+verified.$jwt.uid},"Q14 changes only UID and corresponding subject");
      } else assert.deepEqual(verified.$jwt,comparable,"exact verified claims except TQ3 expiry");
      assert.equal(Buffer.from(auth.token.split(".")[0],"base64url").toString(),'{"alg":"RS256","typ":"JWT"}');
      if(r.body.login_code) {
        const login=logins.find(l=>l.pid===verified.$jwt.pid && l.zid===(spec.zid||1));
        assert.match(login.login_code_hash,/^\$2[aby]\$10\$/);
        assert(await require("bcryptjs").compare(r.body.login_code,login.login_code_hash));
        assert.equal(login.login_code_lookup,crypto.createHash("sha256").update(r.body.login_code+"generated-treevite-pepper").digest("hex"));
        assert.equal(login.login_code_fingerprint,crypto.createHmac("sha256","generated-treevite-fingerprint").update(`${login.zid}:${login.pid}:${r.body.login_code}`).digest("hex"));
        assert.equal(login.fp_kid,1);assert(login.expires_at);
        assert(Math.abs(new Date(login.expires_at)-new Date(login.updated_at)-365*86400000)<=86400000,"one year credential");
        const consumed=invited.find(v=>v.id===r.body.invite_id);
        assert.equal(consumed.status,1);assert.equal(consumed.invite_used_by_pid,login.pid);
      }
    }
    const reference=spec.race ? nodeResponses.find(n=>n.status===201) : node;
    assert.equal(r.status,reference.status,spec.name);
    const left=normalizeBody(bytes(reference)),right=normalizeBody(r.raw);
    assert.equal(right,left,spec.name+" exact body except TQ3 credential lifetime");
    assert.deepEqual(normalizeHeaders(r.headers,right),normalizeHeaders(reference.wire.response.headers.flatMap(h=>[h.name,h.value]),left),spec.name+" headers");
  }
  if(!spec.race && !expectedDelta(spec,before)) {
    const success=responses[0].status<300;
    const accepted=success && spec.route==="acceptInvite";
    const userDelta=accepted ? (spec.name==="accept-anonymous-other-conversation" ? 1 : (spec.users||0)) : 0;
    assert.equal(users,before["pg:users"].length+userDelta,spec.name+" durable user count");
    assert.equal(participants.length,before["pg:participants"].length+(accepted ? (spec.participants||0) : 0),spec.name+" durable member count");
    assert.equal(invited.length,before["pg:treevite_invites"].length+(accepted ? (spec.children||0) : 0),spec.name+" child top-up count");
  }
  if(spec.race) {
    assert.equal(users,before["pg:users"].length+1,"F2 race loser leaves no users");
    assert.equal(participants.length,before["pg:participants"].length+1,"F2 race loser leaves no members");
  }
  console.log("Rust Treevite replay passed: "+spec.name);
}
async function close(){if(rust) await rust.end();}
module.exports={capture,replay,close};
