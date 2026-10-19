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


const {performance}=require("node:perf_hooks");
const proxyOn={host:"next-proxy-on",port:80},proxyOff={host:"next-proxy-off",port:80},proxyStall={host:"next-proxy-stall",port:80};
function percentile(values,p){return [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];}
function stats(values){return {samples:values.length,p50_ms:percentile(values,.5),p95_ms:percentile(values,.95),p99_ms:percentile(values,.99),max_ms:Math.max(...values)};}
async function main(){
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const cid=fixtures.find(f=>f.shape==="content-edges").capability;
  const tokens=await fetch("http://server:5001/tokens").then(r=>r.json());
  const scenarios=[
    {name:"cookie",suffix:"",headers:[["Cookie","polis=invalid"]]},
    {name:"authorization",suffix:"",headers:[["Authorization",`Bearer ${tokens['comments-owner-1']}`]]},
    {name:"translation",suffix:"&lang=en",headers:[]},
    {name:"unknown-parameter",suffix:"&unknown=1",headers:[]},
  ];
  const summaries=[];
  for(const c of scenarios){
    const bytes=requestBytes("GET",`/api/v3/nextComment?conversation_id=${cid}&initial_tid=0${c.suffix}`,[["Host","localhost"],["Connection","close"],...c.headers],Buffer.alloc(0));
    const off=[],on=[],delta=[];
    for(let i=0;i<220;i++){
      const values={};const responses={};
      for(const [name,target] of (i%2?[["on",proxyOn],["off",proxyOff]]:[["off",proxyOff],["on",proxyOn]])){
        const t=performance.now();responses[name]=await exchange(target,bytes,false);values[name]=performance.now()-t;
      }
      if(!responses.on.equals(responses.off)&&!sameButDate(responses.on,responses.off))throw Error(`proxy bytes differ: ${c.name}`);
      if(i>=20){off.push(values.off);on.push(values.on);delta.push(values.on-values.off);}
    }
    summaries.push({case:c.name,nodeViaNginx:stats(off),rustFallbackViaNginx:stats(on),pairedAddedHop:stats(delta)});
  }
  // The same route template must give Node the request after its 100ms read
  // timeout when a Rust peer accepts but never sends response headers.
  const sockets=new Set();
  const slow=net.createServer(s=>{sockets.add(s);s.on("close",()=>sockets.delete(s));s.on("error",()=>{});s.on("data",()=>{});});
  await new Promise(r=>slow.listen(5101,"0.0.0.0",r));
  const times=[];
  const bytes=requestBytes("GET",`/api/v3/nextComment?conversation_id=${cid}&initial_tid=0&unknown=1`,[["Host","localhost"],["Connection","close"]],Buffer.alloc(0));
  for(let i=0;i<30;i++){
    const t=performance.now();const response=await exchange(proxyStall,bytes,false);times.push(performance.now()-t);
    if(!response.toString().startsWith("HTTP/1.1 200"))throw Error("stalled Rust hop did not fall back to Node");
  }
  for(const s of sockets)s.destroy();await new Promise(r=>slow.close(r));
  console.log(JSON.stringify({method:"alternating paired nginx off/on, 20 warmups then 200 samples per case; fresh TCP connections on one local Docker network",scenarios:summaries,stalledPeer:stats(times)},null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
