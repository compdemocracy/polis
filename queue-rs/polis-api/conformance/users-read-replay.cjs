"use strict";
// Raw HTTP fixture proof; no response normalization. Node source and fixture
// writers are unchanged. Boundary handoffs are counted separately.
const fs = require("node:fs");
const net = require("node:net");
const zlib = require("node:zlib");

const NODE = { host: "server", port: 5000 };
const RUST = { host: "polis-api", port: 5100 };
const ARCHIVE = "/app/characterization/artifacts/baseline.json.gz";

function exchange(target, bytes, headOnly) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error("response deadline")), 10000);
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (b) => {
      chunks.push(b);
      const all = Buffer.concat(chunks);
      const end = complete(all, headOnly);
      if (end !== null) finish(null, all.subarray(0, end));
    });
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
    socket.on("error", (e) => finish(e));
  });
}

// Offset just past one complete response in `buf`, or null if more is needed.
function complete(buf, headOnly) {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const head = buf.subarray(0, headEnd).toString("latin1");
  const status = Number(head.split(" ")[1]);
  const header = (name) => {
    const line = head
      .split("\r\n")
      .slice(1)
      .find((l) => l.toLowerCase().startsWith(name + ":"));
    return line === undefined ? undefined : line.slice(name.length + 1).trim();
  };
  let at = headEnd + 4;
  if (headOnly || status === 204 || status === 304 || (status >= 100 && status < 200)) return at;
  if ((header("transfer-encoding") || "").toLowerCase() === "chunked") {
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", at);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.subarray(at, lineEnd).toString("latin1"), 16);
      at = lineEnd + 2 + size + 2;
      if (at > buf.length) return null;
      if (size === 0) return at;
    }
  }
  const length = header("content-length");
  if (length !== undefined) {
    const end = at + Number(length);
    return end <= buf.length ? end : null;
  }
  return null; // delimited by close
}

function requestBytes(method, target, headers, body) {
  let text = `${method} ${target} HTTP/1.1\r\n`;
  for (const [name, value] of headers) text += `${name}: ${value}\r\n`;
  return Buffer.concat([Buffer.from(text + "\r\n", "latin1"), body]);
}

const dateLine = /\r\nDate: [^\r]*\r\n/;
function sameButDate(a, b) {
  const ma = a.toString("latin1").match(dateLine);
  const mb = b.toString("latin1").match(dateLine);
  if (!ma || !mb || ma[0] === mb[0]) return false;
  return a.toString("latin1").replace(dateLine, "\r\n") === b.toString("latin1").replace(dateLine, "\r\n");
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function show(buf) {
  const head = buf.subarray(0, Math.max(0, buf.indexOf("\r\n\r\n"))).toString("latin1");
  return { head: head.split("\r\n"), bodyBytes: buf.length - head.length - 4 };
}


let dateRetries=0;
const records=[];
async function reset(seed,id) {
  const r=await fetch(`http://server:5001/begin?seed=${seed}&case=${encodeURIComponent(id)}`);
  if (!r.ok) throw Error("entropy reset failed");
}
async function compare(c) {
  const bytes=requestBytes(c.method||"GET",c.target,c.headers,c.body||Buffer.alloc(0));
  for(let attempt=0;attempt<5;attempt++) {
    await reset(c.seed,c.id);
    const node=await exchange(NODE,bytes,c.method==="HEAD");
    const rust=await exchange(RUST,bytes,c.method==="HEAD");
    const fallback=rust.toString("latin1",0,16).startsWith("HTTP/1.1 502");
    const status=Number(node.toString("latin1").split(" ")[1]);
    const unexpectedFallback=!!c.served&&(fallback||status!==(c.status||200));
    if(!fallback&&!node.equals(rust)&&sameButDate(node,rust)){dateRetries++;continue;}
    const equal=node.equals(rust);
    records.push({id:c.id,method:c.method||"GET",target:c.target,seed:c.seed,expectedServed:c.served,node:node.toString("base64"),rust:rust.toString("base64"),fallback,equal,unexpectedFallback});
    return {id:c.id,fallback,equal,unexpectedFallback,...(!fallback&&!equal?{node:node.toString(),rust:rust.toString()}:{}),...(!c.served&&!fallback?{unexpectedServe:true}:{})};
  }
  throw Error(`${c.id}: Date differed five times`);
}
async function main(){
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const fixture=fixtures.find(f=>f.shape==="content-edges");
  const oidc=await fetch("http://server:5001/tokens").then(r=>r.json());
  const participants=await fetch("http://server:5001/participant-read-tokens").then(r=>r.json());
  const xidTokens=await fetch("http://server:5001/users-read-tokens").then(r=>r.json());
  const second=fixtures.find(f=>f.shape==="content-edges"&&f.owner!==fixture.owner);
  const owner=oidc["comments-owner-1"];
  if(!owner)throw Error("generated owner token required");
  const {Pool}=require("/app/node_modules/pg");
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable fixture database required");
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const xid="user-profile-雪";
  await pool.query("INSERT INTO xids(owner,uid,xid,x_name,zid,pid) VALUES($1,3,$2,'Snow 雪',$3,$4)",[fixture.owner,xid,fixture.zid,fixture.participantPid]);
  await pool.query("INSERT INTO xids(owner,uid,xid,zid,pid) VALUES($1,4,$2,$3,4)",[second.owner,xid,second.zid]);
  for(const malformed of ["%E9","%ZZ%41"])
    await pool.query("INSERT INTO xids(owner,uid,xid) VALUES($1,3,$2)",[fixture.owner,malformed]);
  const base="/api/v3/users",pair=base+"?owner_uid="+fixture.owner+"&xid="+encodeURIComponent(xid);
  const missing=base+"?owner_uid="+fixture.owner+"&xid=missing";
  const cases=[],results=[];
  function add(id,target=pair,token=owner,status=200,served=true,method="GET",headers=[]) {
    cases.push({id,seed:"7ac001000001",target,method,body:Buffer.alloc(0),served,status,
      headers:[["Host","localhost"],["Connection","close"],...headers,...(token===null?[]:[["Authorization","Bearer "+token]])]});
  }
  for(const method of ["GET","HEAD"]){
    for(const [role,token] of [["owner",owner],["admin",oidc.admin],["self",participants["anonymous-"+fixture.zid]],["standard-self",participants["standard-"+fixture.zid]]])add(role+"/"+method,pair,token,200,true,method);
    for(const target of [pair,missing])add("stranger/"+target+"/"+method,target,oidc.owner,403,true,method);
    add("missing-owner/"+method,missing,owner,200,true,method);add("missing-admin/"+method,missing,oidc.admin,200,true,method);
    for(const suffix of ["","?owner_uid="+fixture.owner,"?xid="+encodeURIComponent(xid)])add("caller/"+suffix+"/"+method,base+suffix,owner,200,true,method);
    add("anonymous/"+method,pair,null,401,true,method);
    for(const malformed of ["%E9","%ZZ%41"])
      add("malformed-query/"+malformed+"/"+method,base+"?owner_uid="+fixture.owner+"&xid="+malformed,owner,200,false,method);
    add("xid-self/"+method,pair,xidTokens.self,200,false,method);
    add("xid-other-owner/"+method,pair,xidTokens.other,403,false,method);
    add("xid-other-owner-implicit/"+method,base+"?owner_uid="+fixture.owner,xidTokens.other,403,false,method);
    add("xid-self-unscoped/"+method,base,xidTokens.self,200,false,method);
    add("xid-token/"+method,pair,participants["xid-"+fixture.zid],200,false,method);
    add("xid-token-owner-only/"+method,base+"?owner_uid="+fixture.owner,participants["xid-"+fixture.zid],403,false,method);
    add("invalid/"+method,pair,"fixture.invalid",401,false,method);
  }
  for(const encoding of ["gzip","deflate","identity","gzip, deflate","*","gzip;q=0"])add("encoding/"+encoding,pair,owner,200,true,"GET",[["Accept-Encoding",encoding]]);
  add("fresh",pair,owner,304,true,"GET",[["If-None-Match","*"]]);
  add("origin",pair,owner,200,true,"GET",[["Origin","http://localhost"]]);
  add("cookie",pair,owner,200,false,"GET",[["Cookie","fixture=1"]]);
  for(const suffix of ["?uid=3","?xid=a&xid=b","?owner_uid=01"])add("boundary/"+suffix,base+suffix,owner,200,false);
  const off=process.env.USERS_READ_EXPECT_OFF === "1";
  if(off)for(const c of cases)c.served=false;
  for(const c of cases)results.push(await compare(c));
  await pool.query("DELETE FROM xids WHERE owner=ANY($1::int[]) AND xid=$2",[[fixture.owner,second.owner],xid]);
  await pool.query("DELETE FROM xids WHERE owner=$1 AND xid=ANY($2::text[])",[fixture.owner,["%E9","%ZZ%41"]]);
  await pool.end();
  for(const record of records.filter(r=>r.id.startsWith("malformed-query/"))){
    const node=Buffer.from(record.node,"base64");
    if(Number(node.toString("latin1").split(" ")[1])!==200)throw Error("Node malformed-query response status: "+record.id);
    if(record.method==="GET"){
      const body=JSON.parse(node.subarray(node.indexOf("\r\n\r\n")+4));
      const expected=record.id.split("/")[1];
      if(body.uid!==3||body.xInfo?.xid!==expected)throw Error("Node malformed-query response lost the verbatim XID: "+record.id);
    }
  }
  for(const record of records.filter(r=>/^xid-(self|other-owner)/.test(r.id))){
    const c=cases.find(c=>c.id===record.id);
    const node=Buffer.from(record.node,"base64");
    if(Number(node.toString("latin1").split(" ")[1])!==c.status)throw Error("Node recorded response status: "+record.id);
    if(c.status===403 && c.method!=="HEAD"){
      const body=JSON.parse(node.subarray(node.indexOf("\r\n\r\n")+4));
      if(body.error!=="polis_err_get_user_not_authorized"||["uid","email","hname","site_ids","xInfo","hasXid"].some(k=>k in body))throw Error("Node recorded response leaked a profile");
    }
  }
  fs.writeFileSync("/artifacts/users-read"+(off?"-off":"")+"-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handler; generated requests",records},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const summary={recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences};
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||(!off&&!summary.servedByRust)||(off&&summary.servedByRust))process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
