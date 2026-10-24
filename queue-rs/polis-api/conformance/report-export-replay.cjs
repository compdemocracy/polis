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
async function reset(seed,id,clock) {
  const r=await fetch(`http://server:5001/begin?seed=${seed}&case=${encodeURIComponent(id)}&clock=${clock}`);
  if (!r.ok) throw Error("entropy reset failed");
}
async function compare(c) {
  const bytes=requestBytes(c.method||"GET",c.target,c.headers,c.body||Buffer.alloc(0));
  for(let attempt=0;attempt<5;attempt++) {
    await reset(c.seed,c.id,c.clock);
    const node=await exchange(NODE,bytes,c.method==="HEAD");
    const rust=await exchange(RUST,bytes,c.method==="HEAD");
    const off=await exchange({host:"polis-api-off",port:5100},bytes,c.method==="HEAD");
    if(!off.toString("latin1",0,16).startsWith("HTTP/1.1 502"))throw Error(`${c.id}: disabled route served`);
    const fallback=rust.toString("latin1",0,16).startsWith("HTTP/1.1 502");
    const status=Number(node.toString("latin1").split(" ")[1]);
    const unexpectedFallback=!!c.served&&(fallback||status!==(c.status||200));
    if(!fallback&&!node.equals(rust)&&sameButDate(node,rust)){dateRetries++;continue;}
    const equal=node.equals(rust);
    records.push({id:c.id,method:c.method||"GET",target:c.target,seed:c.seed,clock:c.clock,expectedServed:c.served,off:off.toString("base64"),node:node.toString("base64"),rust:rust.toString("base64"),fallback,equal,unexpectedFallback});
    return {id:c.id,fallback,equal,unexpectedFallback,...(!fallback&&!equal?{node:node.toString(),rust:rust.toString()}:{}),...(!c.served&&!fallback?{unexpectedServe:true}:{})};
  }
  throw Error(`${c.id}: Date differed five times`);
}
async function main(){
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const chosen=[fixtures.find(f=>f.shape==="empty"),fixtures.find(f=>f.shape==="content-edges"),fixtures.find(f=>f.shape==="velocity-mix")];
  const {Pool}=require("/app/node_modules/pg");
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable database required");
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  for(const f of chosen)await pool.query("UPDATE conversations SET description=$2 WHERE zid=$1",[f.zid,'Generated café "description"\nsecond line']);
  const types=["format.json","summary.csv","comments.csv","votes.csv","participant-votes.csv","participant-importance.csv","comment-groups.csv"];
  const streams=new Set(["votes.csv","participant-votes.csv","participant-importance.csv","comment-groups.csv"]);
  const cases=[],results=[];
  let now=1700000000000;
  async function add(id,f,type,extra={},served=true){
    const c={id,seed:"7ac001000001",clock:extra.clock??now,method:extra.method||"GET",target:extra.target||`/api/v3/reportExport/${f.report}/${type}`,body:Buffer.from(extra.body||""),headers:[["Host","localhost"],["Connection","close"],["X-Polis-Fixture-Clock",String(extra.clock??now)],...(extra.headers||[])],served,status:extra.status||200};
    cases.push(c);results.push(await compare(c));
  }
  for(const f of chosen)for(const type of types){
    const name=`${f.key}/${type}`;
    await add(name,f,type);
    await add(name+"/head",f,type,{method:"HEAD"});
    await add(name+"/identity",f,type,{headers:[["Accept-Encoding","identity"]]});
    await add(name+"/gzip",f,type,{headers:[["Accept-Encoding","gzip"]]},!streams.has(type));
    await add(name+"/fresh",f,type,{headers:[["If-None-Match","*"]],status:streams.has(type)?200:304});
  }
  const f=chosen[1];
  for(const type of types){
    await add(type+"/query",f,type,{target:`/api/v3/reportExport/${f.report}/${type}?extra=1`},false);
    await add(type+"/cookie",f,type,{headers:[["Cookie","fixture=1"]]},false);
    await add(type+"/authorization",f,type,{headers:[["Authorization","Bearer invalid.fixture"]]},false);
    await add(type+"/post",f,type,{method:"POST",headers:[["Content-Length","0"]]},false);
    await add(type+"/absent-report",f,type,{target:`/api/v3/reportExport/absentfixture/${type}`},false);
  }
  // Report IDs containing extra path segments and unknown subtypes stay Node work.
  await add("unknown-subtype",f,"unknown.csv",{},false);
  await add("encoded-report",f,"format.json",{target:`/api/v3/reportExport/%${f.report.charCodeAt(0).toString(16)}${f.report.slice(1)}/format.json`},false);
  await pool.query("UPDATE comments SET mod=0 WHERE zid=$1 AND tid=(SELECT min(tid) FROM comments WHERE zid=$1)",[f.zid]);
  await add("summary/cached-count",f,"summary.csv",{clock:1700000002999});
  now=1700000003000;
  await add("summary/expired-count",f,"summary.csv");
  // Importance is exported even when the conversation has it disabled.
  await pool.query("UPDATE votes SET high_priority=true WHERE zid=$1",[f.zid]);
  for(const type of ["comments.csv","votes.csv","participant-votes.csv","participant-importance.csv"])await add("importance/"+type,f,type);
  // Deliberately invalid stored values only; valid votes are installed by the
  // unchanged seed-vote convention helper used by seed-comments.
  async function corruptVoteFixture(value) {
    if(value!==null&&value!==2&&value!==-2)throw Error("invalid fixture values only");
    await pool.query("UPDATE votes SET vote=$2 WHERE zid=$1",[f.zid,value]);
  }
  for(const invalid of [null,2,-2]) {
    await corruptVoteFixture(invalid);
    for(const type of ["comments.csv","votes.csv","participant-votes.csv","participant-importance.csv"])await add(`invalid-${invalid}/`+type,f,type);
  }
  await pool.query("UPDATE votes SET created=NULL WHERE zid=$1",[f.zid]);
  await pool.query("UPDATE comments SET created=NULL WHERE zid=$1",[f.zid]);
  await add("null-date/comments",f,"comments.csv");
  await add("null-date/votes",f,"votes.csv");
  // An uninitialized row uses the schema default tick. Any stored math is a
  // deliberate boundary for the process-local cached exports.
  await pool.query("INSERT INTO math_main(zid,math_env,data,last_vote_timestamp) VALUES($1,'p027','{}',0)",[f.zid]);
  for(const type of ["summary.csv","participant-votes.csv","participant-importance.csv","comment-groups.csv"])await add("math-row/"+type,f,type,{},false);
  await add("math-row/format",f,"format.json");
  await add("math-row/comments",f,"comments.csv");
  await add("math-row/votes",f,"votes.csv");
  await pool.end();
  fs.writeFileSync("/artifacts/report-export-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handler; generated requests",records},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={recorded:cases.length,off:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters};
  if(counters.reportExportServed!==summary.servedByRust+dateRetries||counters.reportExportFallback!==summary.handedToNode)summary.counterMismatch=true;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{fs.writeFileSync("/artifacts/report-export-partial.json",JSON.stringify({error:e.stack,records},null,2));console.error(e.stack);process.exitCode=2;});
