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
    const off=await exchange({host:"polis-api-off",port:5100},bytes,c.method==="HEAD");
    if(!off.toString("latin1",0,16).startsWith("HTTP/1.1 502"))throw Error(`${c.id}: disabled route served`);
    const fallback=rust.toString("latin1",0,16).startsWith("HTTP/1.1 502");
    const status=Number(node.toString("latin1").split(" ")[1]);
    const unexpectedFallback=!!c.served&&(fallback||status!==(c.status||200));
    if(!fallback&&!node.equals(rust)&&sameButDate(node,rust)){dateRetries++;continue;}
    const equal=node.equals(rust);
    records.push({id:c.id,method:c.method||"GET",target:c.target,seed:c.seed,expectedServed:c.served,off:off.toString("base64"),node:node.toString("base64"),rust:rust.toString("base64"),fallback,equal,unexpectedFallback});
    return {id:c.id,fallback,equal,unexpectedFallback,...(!fallback&&!equal?{node:node.toString(),rust:rust.toString()}:{}),...(!c.served&&!fallback?{unexpectedServe:true}:{})};
  }
  throw Error(`${c.id}: Date differed five times`);
}
async function main(){
  const base="/api/v3/query_participants_by_metadata";
  const tokens=await fetch("http://server:5001/participant-read-tokens").then(r=>r.json());
  const oidc=await fetch("http://server:5001/tokens").then(r=>r.json());
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const f=fixtures.find(f=>f.shape==="content-edges");
  const {Pool}=require("/app/node_modules/pg");
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable database required");
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const cases=[],results=[];
  async function add(id,pmaids=[],extra={},served=true) {
    const body=Buffer.from(extra.raw??JSON.stringify({conversation_id:extra.cid??f.capability,pmaids}));
    const headers=[["Host","localhost"],["Connection","close"],["Content-Type",extra.type??"application/json"],["Content-Length",String(body.length)]];
    if(extra.token!==null)headers.push(["Authorization",`Bearer ${extra.token??tokens[`anonymous-${f.zid}`]}`]);
    headers.push(...(extra.headers||[]));
    const c={id,seed:"7ac001000001",method:extra.method??"POST",target:extra.target??base,body,headers,served};
    cases.push(c);results.push(await compare(c));
  }
  await add("empty");
  for(const token of [tokens[`standard-${f.zid}`],oidc.owner,oidc.admin,oidc["comments-moderator"]])await add(`empty-auth-${cases.length}`,[],{token});
  for(const encoding of ["identity","gzip","deflate","gzip, deflate","*"])await add(`encoding-${encoding}`,[],{headers:[["Accept-Encoding",encoding]]});
  await add("origin",[],{headers:[["Origin","http://localhost"]]});
  await add("post-fresh-still-200",[],{headers:[["If-None-Match","*"]]});
  await add("empty-no-token",[],{token:null},false);
  for(const name of ["missing","wrongPid","expired","future","wrongIssuer","wrongAudience","tampered"])await add(`auth-${name}`,[],{token:tokens[name]},false);
  await add("auth-xid",[],{token:tokens[`xid-${f.zid}`]},false);
  const other=fixtures.find(x=>x.zid!==f.zid);
  await add("auth-cross-conversation",[],{token:tokens[`anonymous-${other.zid}`]},false);
  for(const [id,extra] of [
    ["query",{target:base+"?extra=1"}],["get",{method:"GET"}],["options",{method:"OPTIONS"}],
    ["cookie",{headers:[["Cookie","fixture=1"]]}],["unknown-cid",{cid:"absentfixture"}],
    ["long-cid",{cid:"a".repeat(101)}],["form",{raw:"conversation_id="+f.capability+"&pmaids=1,2",type:"application/x-www-form-urlencoded"}],
    ["missing-pmaids",{raw:JSON.stringify({conversation_id:f.capability})}],
    ["scalar-pmaids",{raw:JSON.stringify({conversation_id:f.capability,pmaids:"1,2"})}],
    ["fraction-pmaids",{raw:JSON.stringify({conversation_id:f.capability,pmaids:[1.5]})}],
    ["duplicate-field",{raw:`{"conversation_id":"${f.capability}","pmaids":[],"pmaids":[1]}`}],
    ["trailing-slash",{target:base+"/"}],
  ])await add(id,[],extra,false);
  await add("too-many-choices",Array.from({length:257},(_,i)=>i),{},false);
  const q=await pool.query("INSERT INTO participant_metadata_questions(zid,key,alive) VALUES($1,'generated query selection',true) RETURNING pmqid",[f.zid]);
  const qid=q.rows[0].pmqid;
  const a=await pool.query("INSERT INTO participant_metadata_answers(zid,pmqid,value,alive) VALUES($1,$2,'left',true),($1,$2,'right',true),($1,$2,'dead',false) RETURNING pmaid",[f.zid,qid]);
  const [left,right,dead]=a.rows.map(r=>r.pmaid);
  await pool.query("INSERT INTO participant_metadata_choices(zid,pid,pmqid,pmaid,alive) VALUES($1,0,$2,$3,true),($1,1,$2,$4,true),($1,2,$2,$5,true)",[f.zid,qid,left,right,dead]);
  for(const [id,choices] of [["left",[left]],["right",[right]],["both",[left,right]],["neither",[0]],["negative",[-7]],["duplicates",[left,left]],["empty-populated",[]]]){
    await add(id,choices);
    await add(id+"-oidc-nonmember",choices,{token:oidc.owner});
  }
  await pool.query("UPDATE participant_metadata_choices SET alive=false WHERE zid=$1 AND pmaid=$2",[f.zid,right]);
  await add("inactive-choice",[left]);
  // A choice in another conversation can still eliminate the same pid. This
  // intentionally retains the legacy query's missing choice-zid filter.
  await pool.query("INSERT INTO participant_metadata_choices(zid,pid,pmqid,pmaid,alive) VALUES($1,1,$2,$3,true)",[other.zid,qid,right]);
  await add("cross-conversation-choice",[left]);
  await pool.query("INSERT INTO participant_metadata_choices(zid,pid,pmqid,pmaid,alive) VALUES($1,NULL,$2,$3,true)",[other.zid,qid,right]);
  await add("null-excluded-pid",[left]);
  await pool.end();
  fs.writeFileSync("/artifacts/metadata-query-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handler; generated requests",records},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={recorded:cases.length,off:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters};
  if(counters.metadataQueryServed!==summary.servedByRust+dateRetries||counters.metadataQueryFallback!==summary.handedToNode-1)summary.counterMismatch=true;
  const proxyRecords=[];
  for(const [id,body,type] of [
    ["canonical-cookie",JSON.stringify({conversation_id:f.capability,pmaids:[]}),"application/json"],
    ["form-cookie",`conversation_id=${f.capability}&pmaids=${left}`,"application/x-www-form-urlencoded"],
  ]) {
    const bytes=requestBytes("POST",base,[["Host","localhost"],["Connection","close"],["Content-Type",type],["Content-Length",String(Buffer.byteLength(body))],["Cookie","fixture=1"],["Authorization",`Bearer ${tokens[`anonymous-${f.zid}`]}`]],Buffer.from(body));
    const response=await exchange({host:"metadata-query-proxy",port:80},bytes,false);
    if(!response.toString("latin1").startsWith("HTTP/1.1 200 "))throw Error(`${id}: proxy failed to replay POST body: ${response}`);
    proxyRecords.push({id,response:response.toString("base64")});
  }
  fs.writeFileSync("/artifacts/metadata-query-proxy-recordings.json",JSON.stringify(proxyRecords,null,2));
  summary.proxyHandoffs=proxyRecords.length;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
