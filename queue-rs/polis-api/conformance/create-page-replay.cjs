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
    const unexpectedFallback=!!c.served&&(fallback||status!==(c.status||302));
    if(!fallback&&!node.equals(rust)&&sameButDate(node,rust)){dateRetries++;continue;}
    const equal=node.equals(rust);
    records.push({id:c.id,method:c.method||"GET",target:c.target,seed:c.seed,expectedServed:c.served,node:node.toString("base64"),rust:rust.toString("base64"),fallback,equal,unexpectedFallback});
    return {id:c.id,fallback,equal,unexpectedFallback,...(!fallback&&!equal?{node:node.toString(),rust:rust.toString()}:{}),...(!c.served&&!fallback?{unexpectedServe:true}:{})};
  }
  throw Error(`${c.id}: Date differed five times`);
}
async function main(){
  const base="/conversation/create", cases=[], timeoutCases=[];
  function add(id,headers=[],target=base,method="GET",body="",served=true,status=302) {
    cases.push({id,seed:"7ac001000001",target,method,body:Buffer.from(body),served,status,
      headers:[["Host","localhost"],["Connection","close"],["User-Agent","MSIE 8.0"],...headers]});
  }
  add("plain"); add("head",[],base,"HEAD");add("empty-query",[],base+"?");
  add("zero-body",[["Content-Length","0"]]);
  for(const encoding of ["gzip","deflate","identity","gzip, deflate","*","gzip;q=0"])
    add(`encoding/${encoding}`,[["Accept-Encoding",encoding]]);
  add("fresh",[["If-None-Match","*"]]);add("fresh-head",[["If-None-Match","*"]],base,"HEAD");
  add("origin",[["Origin","https://example.invalid"]]);
  add("forwarded-http",[["X-Forwarded-Proto","http"]]);add("forwarded-https",[["X-Forwarded-Proto","https"]]);
  add("nested",[],base+"/step");add("prefix",[],base+"Suffix");add("trailing-slash",[],base+"/");
  add("query",[],base+"?unknown=1","GET","",false);
  add("encoded",[],base+"/%20","GET","",false);
  add("cookie",[["Cookie","fixture=1"]],base,"GET","",false);
  add("authorization",[["Authorization","Bearer fixture.invalid"]],base,"GET","",false);
  add("post",[["Content-Length","0"]],base,"POST","",false);
  add("options",[],base,"OPTIONS","",false);
  add("body",[["Content-Type","application/json"],["Content-Length","2"]],base,"GET","{}",false);
  // Replace the first User-Agent, since Node keeps the first repeated value.
  for(const [id,ua,served] of [["ie9","MSIE 9.0",true],["prefix-version","MSIE 80",true],["modern","Mozilla/5.0",false],["ie10","MSIE 10.0",false],["lowercase","msie 8.0",false],["unsupported","MSIE 7.0",false],["mixed","MSIE 8.0 MSIE 6.0",false],["absent","",false]]) {
    add(id,[],base,"GET","",served);cases[cases.length-1].headers[2][1]=ua;
    if(["modern","ie10","lowercase","absent"].includes(id))timeoutCases.push(cases.pop());
  }
  const results=[];
  for(const c of cases)results.push(await compare(c));
  fs.writeFileSync("/artifacts/create-page-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handler; generated requests",records},null,2));
  // These unchanged Node HTML branches never answer in this fixture: Express's
  // next callback is passed as the file-service port. Keep the failed initial
  // replay evidence; do not treat a timeout as a recorded/equal response.
  const nodeTimeouts=[];
  for(const c of timeoutCases) {
    const bytes=requestBytes(c.method,c.target,c.headers,c.body);
    const rust=await exchange(RUST,bytes,false);
    if(!rust.toString("latin1",0,16).startsWith("HTTP/1.1 502"))throw Error(`${c.id}: expected Rust handoff`);
    await reset(c.seed,c.id);
    try {await exchange(NODE,bytes,false);throw Error(`${c.id}: Node now responds; re-characterize HTML`);}
    catch(e) {if(e.message!=="response deadline")throw e;}
    nodeTimeouts.push({id:c.id,method:c.method,target:c.target,nodeOutcome:"no response before unchanged 10000ms deadline",rust:rust.toString("base64"),byteEquality:false});
  }
  fs.writeFileSync("/artifacts/create-page-node-timeouts.json",JSON.stringify({cases:nodeTimeouts},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={attempted:cases.length+nodeTimeouts.length,unrecordedNodeTimeouts:nodeTimeouts.length,recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters};
  if(counters.createPageServed!==summary.servedByRust+dateRetries||counters.createPageFallback!==summary.handedToNode+nodeTimeouts.length)summary.counterMismatch=true;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
