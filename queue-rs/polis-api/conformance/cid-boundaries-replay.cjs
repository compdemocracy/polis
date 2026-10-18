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
  const oidc=await fetch("http://server:5001/tokens").then(r=>r.json());
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const fixture=fixtures.find(f=>f.shape==="content-edges");
  const {Pool}=require("/app/node_modules/pg");const pool=new Pool({connectionString:process.env.DATABASE_URL});
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable fixture database required");
  const codes=["a".repeat(100),"b".repeat(101),"c".repeat(300)];
  for(const code of codes) {
    if((await pool.query("SELECT 1 FROM zinvites WHERE zinvite=$1",[code])).rows.length)throw Error("boundary code already exists");
    await pool.query("INSERT INTO zinvites(zid,zinvite,created) VALUES($1,$2,1700000000000)",[fixture.zid,code]);
  }
  const cases=[];
  function add(id,path,cid,auth,served,method="GET") {
    cases.push({id,seed:"7ac001000001",target:path+"?conversation_id="+cid,method,body:Buffer.alloc(0),served,status:200,
      headers:[["Host","localhost"],["Connection","close"],...(auth?[["Authorization",`Bearer ${oidc.owner}`]]:[])]});
  }
  const paths=["/api/v3/metadata/questions", "/api/v3/metadata/answers", "/api/v3/metadata", "/api/v3/metadata/choices", "/api/v3/treevite/waves", "/api/v3/treevite/invites", "/api/v3/treevite/invites/csv", "/api/v3/participation", "/api/v3/reports", "/api/v3/bidToPid", "/api/v3/conversationStats", "/api/v3/topicAgenda/selections", "/api/v3/participation/topicPrioritize", "/api/v3/treevite/myInvites", "/api/v3/treevite/me"];
  for(const path of paths)for(const length of [101,300])for(const method of ["GET","HEAD"])
    add(`oversize/${path}/${length}/${method}`,path,length===101?codes[1]:codes[2],true,false,method);
  for(const path of ["/api/v3/participation/topicPrioritize","/api/v3/topicAgenda/selections","/api/v3/metadata/questions"])
    for(const [name,cid,served] of [["hundred",codes[0],true],["encoded-hundred","%61".repeat(100),true],["hundred-one",codes[1],false],["encoded-hundred-one","%62".repeat(101),false]])
      for(const method of ["GET","HEAD"])add(`boundary/${path}/${name}/${method}`,path,cid,false,served,method);
  const results=[];for(const c of cases)results.push(await compare(c));
  for(const code of codes)await pool.query("DELETE FROM zinvites WHERE zinvite=$1",[code]);
  await pool.end();
  fs.writeFileSync("/artifacts/cid-boundaries-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handler; generated requests",records},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters};
  if(counters.served!==summary.servedByRust+dateRetries||counters.failed!==summary.handedToNode)summary.counterMismatch=true;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
