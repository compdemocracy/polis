"use strict";
// Raw HTTP fixture proof; no response normalization. Node source and fixture
// writers are unchanged. Boundary handoffs are counted separately.
const fs = require("node:fs");
const net = require("node:net");
const zlib = require("node:zlib");

const REJECTED_PARAMETER_ID = -1;
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
    const unexpectedFallback=fallback&&c.served&&status===200;
    if(!fallback&&!node.equals(rust)&&sameButDate(node,rust)){dateRetries++;continue;}
    const equal=node.equals(rust);
    records.push({id:c.id,method:c.method||"GET",target:c.target,seed:c.seed,expectedServed:c.served,node:node.toString("base64"),rust:rust.toString("base64"),fallback,equal,unexpectedFallback});
    return {id:c.id,fallback,equal,unexpectedFallback,...(!fallback&&!equal?{node:node.toString(),rust:rust.toString()}:{}),...(!c.served&&!fallback?{unexpectedServe:true}:{})};
  }
  throw Error(`${c.id}: Date differed five times`);
}
async function main(){
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const math=require("/app/characterization/pca2-fixtures.json");
  const {createHash}=require("node:crypto");
  const tokens=await fetch("http://server:5001/tokens").then(r=>r.json());
  const cases=[];
  function add(id,cid,suffix="",extra={}) {
    const seed=createHash("sha256").update(id).digest("hex").slice(0,12);
    cases.push({id,seed,target:`/api/v3/nextComment?conversation_id=${cid}${suffix}`,served:true,headers:[["Host","localhost"],["Connection","close"],["X-Polis-Fixture-Seed",seed]],...extra});
  }
  for(const f of fixtures){
    for(const [name,suffix] of [["plain",""],["without","&without=0,1,2"],["initial","&initial_tid=0"],["unavailable","&initial_tid=2147483647"],["initial-without","&initial_tid=0&without=0"]]) add(`${f.key}/${name}`,f.capability,suffix);
    add(`${f.key}/head`,f.capability,"",{method:"HEAD"});
  }
  // Real engine outputs, including generation zero and non-uniform priorities.
  for(const f of math) add(`math/${f.zid}/${f.shape}`,f.capability);
  const cid=fixtures.find(f=>f.shape==="content-edges").capability;
  for(const suffix of ["&lang=en","&pid=1","&not_voted_by_pid=0","&xid=demo",`&initial_tid=${REJECTED_PARAMETER_ID}`,"&initial_tid=bad","&unknown=1"]) add(`boundary/${suffix}`,cid,suffix,{served:false});
  for(const [name,value] of [["Authorization",`Bearer ${tokens['comments-owner-1']}`],["Cookie","polis=invalid"],["Content-Length","0"]]) {
    add(`boundary/${name}`,cid,"",{served:false});cases[cases.length - 1].headers.push([name,value]);
  }
  for(const method of ["POST","OPTIONS"])add(`boundary/${method}`,cid,"",{served:false,method});
  add("boundary/missing","missing-capability","",{served:false});
  const results=[];
  for(const c of cases)results.push(await compare(c));
  fs.writeFileSync("/artifacts/next-comment-recordings.json",JSON.stringify({format:1,source:"unchanged Node source; generated fixture inputs",records},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const summary={recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences};
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
