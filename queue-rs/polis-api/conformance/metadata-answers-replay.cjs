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
  let base;
  const cases=[];
  const tokens=await fetch("http://server:5001/participant-read-tokens").then(r=>r.json());
  const oidc=await fetch("http://server:5001/tokens").then(r=>r.json());
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const fixture=fixtures.find(f=>f.shape==="content-edges");
  base="/api/v3/metadata/answers?conversation_id="+fixture.capability;
  function add(id,headers=[],target=base,method="GET",body="",served=true,status=200) {
    cases.push({id,seed:"7ac001000001",target,method,body:Buffer.from(body),served,status,
      headers:[["Host","localhost"],["Connection","close"],...headers]});
  }
  add("plain");add("head",[],base,"HEAD");add("encoded-id",[],base.replace("conversation_id=2","conversation_id=%32"));
  add("zero-body",[["Content-Length","0"]]);
  for(const encoding of ["gzip","deflate","identity","gzip, deflate","*","gzip;q=0"])
    add(`encoding/${encoding}`,[["Accept-Encoding",encoding]]);
  add("fresh",[["If-None-Match","*"]],base,"GET","",true,304);
  add("fresh-head",[["If-None-Match","*"]],base,"HEAD","",true,304);
  add("no-cache",[["If-None-Match","*"],["Cache-Control","no-cache"]]);
  add("stale",[["If-None-Match",'"different"']]);
  add("allowed-origin",[["Origin","http://localhost"]]);
  add("forwarded-http",[["X-Forwarded-Proto","http"]]);
  add("forwarded-https",[["X-Forwarded-Proto","https"]]);
  add("accept-text",[["Accept","text/plain"]]);
  add("query",[],base+"&unknown=1","GET","",false);
  add("cookie",[["Cookie","fixture=1"]],base,"GET","",false);
  add("authorization",[["Authorization","Bearer fixture.invalid"]],base,"GET","",false);
  add("post",[["Content-Length","0"]],base,"POST","",false);
  add("options",[],base,"OPTIONS","",false);
  add("body",[["Content-Type","application/json"],["Content-Length","2"]],base,"GET","{}",false);
  add("trailing-slash",[],"/api/v3/metadata/answers/?conversation_id="+fixture.capability,"GET","",false);
  for(const kind of ["anonymous","standard"]) {
    add(`auth/${kind}`,[["Authorization",`Bearer ${tokens[`${kind}-${fixture.zid}`]}`]]);
    add(`auth/${kind}/head`,[["Authorization",`Bearer ${tokens[`${kind}-${fixture.zid}`]}`]],base,"HEAD");
  }
  for(const role of ["owner","admin","comments-owner-1","comments-moderator"]) {
    add(`auth/oidc/${role}`,[["Authorization",`Bearer ${oidc[role]}`]]);
    add(`auth/oidc/${role}/head`,[["Authorization",`Bearer ${oidc[role]}`]],base,"HEAD");
  }
  for(const name of ["missing","wrongPid","expired","future","wrongIssuer","wrongAudience","tampered"])
    add(`auth/fallback/${name}`,[["Authorization",`Bearer ${tokens[name]}`]],base,"GET","",false);
  add("auth/fallback/xid",[["Authorization",`Bearer ${tokens[`xid-${fixture.zid}`]}`]],base,"GET","",false);
  for(const scheme of ["bearer","BEARER"])
    add(`auth/fallback/${scheme}`,[["Authorization",`${scheme} ${tokens[`anonymous-${fixture.zid}`]}`]],base,"GET","",false);
  add("auth/fallback/mismatched-query",[["Authorization",`Bearer ${tokens[`anonymous-${fixture.zid}`]}`]],base.replace(fixture.capability,"different"),"GET","",false);
  const {Pool}=require("/app/node_modules/pg");const pool=new Pool({connectionString:process.env.DATABASE_URL});
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable fixture database required");
  add("missing-id",[],"/api/v3/metadata/answers","GET","",false);
  add("unknown-id",[],"/api/v3/metadata/answers?conversation_id=absentfixture","GET","",false);
  add("duplicate-id",[],base+"&conversation_id=other","GET","",false);
  add("zinvite",[],base+"&zinvite=fixture","GET","",false);
  add("suzinvite",[],base+"&suzinvite=fixture","GET","",false);
  const other=fixtures.find(f=>f.zid!==fixture.zid);
  add("auth/other-conversation",[["Authorization",`Bearer ${tokens[`anonymous-${other.zid}`]}`]],base,"GET","",false);
  add("pmqid-empty",[],base+"&pmqid=1");
  add("pmqid-zero-empty",[],base+"&pmqid=0");
  add("pmqid-malformed",[],base+"&pmqid=invalid","GET","",false);
  add("pmqid-duplicate",[],base+"&pmqid=1&pmqid=2","GET","",false);
  const results=[];
  for(const c of cases)results.push(await compare(c));
  const parent=await pool.query("INSERT INTO participant_metadata_questions(zid,key,alive) VALUES($1,'answer parent',false) RETURNING pmqid",[fixture.zid]);
  const pmqid=parent.rows[0].pmqid;
  await pool.query("INSERT INTO participant_metadata_answers(zid,pmqid,value,alive) VALUES($1,$2,'fixture answer',true)",[fixture.zid,pmqid]);
  for(const [id,token] of [["public",null],["participant",tokens[`anonymous-${fixture.zid}`]],["oidc",oidc.owner]]) {
    for(const method of ["GET","HEAD"]) {add(`populated/${id}/${method}`,token?[["Authorization",`Bearer ${token}`]]:[],base,method,"",false);results.push(await compare(cases[cases.length-1]));}
  }
  for(const [id,value,served] of [["filter/missing",pmqid+999,true],["filter/present",pmqid,false],["filter/zero",0,false]]) {
    add(id,[],base+"&pmqid="+value,"GET","",served);results.push(await compare(cases[cases.length-1]));
  }
  await pool.query("UPDATE participant_metadata_answers SET alive=false WHERE zid=$1",[fixture.zid]);
  add("inactive-only");results.push(await compare(cases[cases.length-1]));
  await pool.end();
  fs.writeFileSync("/artifacts/metadata-answers-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handler; generated requests",records},null,2));
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters};
  // An unrecognised path does not enter the route-specific counters.
  if(counters.metadataAnswersServed!==summary.servedByRust+dateRetries||counters.metadataAnswersFallback!==summary.handedToNode-1)summary.counterMismatch=true;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
