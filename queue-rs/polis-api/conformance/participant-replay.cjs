"use strict";
// Raw HTTP fixture proof; no response normalization. Node source and fixture
// writers are unchanged. Boundary handoffs are counted separately.
const fs = require("node:fs");
const net = require("node:net");
const zlib = require("node:zlib");

const REJECTED_COMMENT_MOD = -1;
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
    const unexpectedFallback=!!c.served&&(fallback||status!==200);
    let coverageMismatch=false;
    if(c.expectedInitial||c.anonymousOnNode) {
      const body=JSON.parse(node.subarray(node.indexOf("\r\n\r\n")+4).toString());
      coverageMismatch=status!==200 || (c.expectedInitial
        ? body.tid!==c.expectedInitial.tid || body.currentPid!==c.expectedInitial.pid || body.initialStatus!=="eligible"
        : Object.hasOwn(body,"currentPid"));
    }
    if(!fallback&&!node.equals(rust)&&sameButDate(node,rust)){dateRetries++;continue;}
    const equal=node.equals(rust);
    records.push({id:c.id,method:c.method||"GET",target:c.target,seed:c.seed,expectedServed:c.served,node:node.toString("base64"),rust:rust.toString("base64"),fallback,equal,unexpectedFallback,coverageMismatch,expectedInitial:c.expectedInitial,authorizationScheme:c.scheme});
    return {id:c.id,fallback,equal,unexpectedFallback,coverageMismatch,...(!fallback&&!equal?{node:node.toString(),rust:rust.toString()}:{}),...(!c.served&&!fallback?{unexpectedServe:true}:{})};
  }
  throw Error(`${c.id}: Date differed five times`);
}
async function main(){
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const {createHash}=require("node:crypto");
  const tokens=await fetch("http://server:5001/participant-read-tokens").then(r=>r.json());
  const cases=[];
  function add(id,route,f,suffix,token,served=true,method="GET",scheme="Bearer") {
    const seed=createHash("sha256").update(id).digest("hex").slice(0,12);
    cases.push({id,seed,target:`/api/v3/${route}?conversation_id=${f.capability}${suffix}`,served,method,scheme,
      headers:[["Host","localhost"],["Connection","close"],["X-Polis-Fixture-Seed",seed],["Authorization",`${scheme} ${token}`]]});
  }
  for(const f of fixtures) for(const kind of ["anonymous","standard"]) {
    const t=tokens[`${kind}-${f.zid}`];
    for(const [name,suffix] of [["plain",""],["page","&limit=2&offset=1"]])add(`${kind}/${f.key}/comments/${name}`,"comments",f,suffix,t);
    for(const [name,suffix] of [["plain",""],["without","&without=0,1,2"],["unavailable","&initial_tid=2147483647"]])add(`${kind}/${f.key}/next/${name}`,"nextComment",f,suffix,t);
    add(`${kind}/${f.key}/head`,"nextComment",f,"",t,true,"HEAD");
  }
  const f=fixtures.find(f=>f.shape==="content-edges");
  const other=fixtures.find(x=>x.capability!==f.capability);
  for(const route of ["comments","nextComment"]) {
    for(const name of ["missing","wrongPid","expired","future","wrongIssuer","wrongAudience","tampered"])
      add(`${route}/${name}`,route,f,"",tokens[name],false);
    for(const kind of ["anonymous","standard"]) for(const scheme of ["bearer","BEARER"]) {
      add(`${route}/${kind}/${scheme}`,route,f,"",tokens[`${kind}-${f.zid}`],false,"GET",scheme);
      if(route==="nextComment") cases.at(-1).anonymousOnNode=true;
    }
    add(`${route}/xid`,route,f,"",tokens[`xid-${f.zid}`],false);
    add(`${route}/other-conversation`,route,f,"",tokens[`anonymous-${other.zid}`],false);
    for(const suffix of ["&xid=fixture","&pid=1","&unknown=1"])
      add(`${route}/boundary/${suffix}`,route,f,suffix,tokens[`anonymous-${f.zid}`],false);
  }
  const pg=require("/app/node_modules/pg");
  const db=new pg.Client({host:"postgres",user:"postgres",database:"p027"});await db.connect();
  // Reuse unchanged sign-aware vote fixtures, without adding vote rows.
  const voted=await db.query("select v.tid,v.zid from votes_latest_unique v join participants p on p.zid=v.zid and p.pid=v.pid where p.uid=3 and v.zid>=1000 and v.zid<1100 limit 1");
  if(voted.rows.length) {
    const row=voted.rows[0], vf=fixtures.find(f=>f.zid===row.zid);
    if(vf)add("initial-already-voted","nextComment",vf,`&initial_tid=${row.tid}`,tokens[`anonymous-${vf.zid}`],false);
  }
  // Select an existing unvoted eligible statement; fail instead of silently
  // dropping this coverage if the fixture no longer supplies one.
  const eligible=await db.query(`select c.zid,c.tid,p.pid from comments c
    join conversations conv on conv.zid=c.zid
    join participants p on p.zid=c.zid and p.uid=2 and p.pid=2
    where c.zid=any($1::integer[]) and c.active=true and c.velocity>0
      and ((conv.strict_moderation is true and c.mod=1)
        or (conv.strict_moderation is not true and c.mod != ${REJECTED_COMMENT_MOD}))
      and not exists(select 1 from votes_latest_unique v
        where v.zid=c.zid and v.pid=p.pid and v.tid=c.tid)
    order by c.zid,c.created,c.tid limit 1`,[fixtures.map(f=>f.zid)]);
  if(eligible.rows.length!==1) {
    await db.end();
    throw Error("missing eligible initial statement fixture");
  }
  const initialFixture=fixtures.find(f=>f.zid===eligible.rows[0].zid);
  for(const kind of ["anonymous","standard"]) {
    add(`${kind}/initial-eligible`,"nextComment",initialFixture,`&initial_tid=${eligible.rows[0].tid}`,tokens[`unvoted-${kind}-${initialFixture.zid}`]);
    cases[cases.length - 1].expectedInitial=eligible.rows[0];
  }
  const results=[];
  for(const c of cases) results.push(await compare(c));
  await db.query("update conversations set treevite_enabled=true where zid=$1",[f.zid]);
  for(const route of ["comments","nextComment"]) {
    const n=cases.length;add(`${route}/treevite`,route,f,"",tokens[`anonymous-${f.zid}`],false);
    results.push(await compare(cases[n]));
  }
  await db.end();
  fs.writeFileSync("/artifacts/participant-recordings.json",JSON.stringify({format:1,source:"unchanged Node product handlers and issuers; generated fixtures",records},null,2));
  const differences=results.filter(r=>r.coverageMismatch||r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters,initialEligibleCases:cases.filter(c=>c.expectedInitial).length,caseVariantBearerCases:cases.filter(c=>c.scheme!=="Bearer").length};
  if(counters.participantServed!==results.filter(r=>!r.fallback).length+dateRetries) {
    // A date retry makes another served request; handoffs are never retried.
    summary.counterMismatch=true;
  }
  if(counters.participantFallback!==results.filter(r=>r.fallback).length)summary.counterMismatch=true;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
