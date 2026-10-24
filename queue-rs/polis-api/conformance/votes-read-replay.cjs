"use strict";
// Raw HTTP fixture proof; no response normalization. Node source and fixture
// writers are unchanged. Boundary handoffs are counted separately.
const fs = require("node:fs");
const net = require("node:net");
const zlib = require("node:zlib");

const NODE = { host: "server", port: 5000 };
const RUST = { host: "polis-api", port: 5100 };


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
  const tokens=await fetch("http://server:5001/participant-read-tokens").then(r=>r.json());
  const oidc=await fetch("http://server:5001/tokens").then(r=>r.json());
  const {fixtures}=require("/app/characterization/comments-cases.cjs");
  const {seedVote}=require("/app/characterization/seed-vote.cjs");
  const {Pool}=require("/app/node_modules/pg");
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable fixture database required");
  const zero=fixtures.find(f=>f.shape==="content-edges");
  const nonzero=fixtures.find(f=>f.participantPid>0);
  const chosen=[zero,nonzero];
  const cases=[],results=[];
  function add(id,fixture,mine,auth,tail="",served=true,method="GET",extra=[],body="") {
    const c={id,seed:"7ac001000001",method,target:`/api/v3/votes${mine?"/me":""}?conversation_id=${fixture.capability}${tail}`,served,
      headers:[["Host","localhost"],["Connection","close"],...(auth?[["Authorization",auth]]:[]),...extra],body:Buffer.from(body)};
    cases.push(c);return c;
  }
  async function run(...args){const c=add(...args);results.push(await compare(c));}
  for(const f of chosen) {
    await pool.query("DELETE FROM votes WHERE zid=$1",[f.zid]);
    await pool.query("DELETE FROM votes_latest_unique WHERE zid=$1",[f.zid]);
    // Make each OIDC identity an existing member, while leaving its token without
    // a PID. /me must preserve the difference between lookup and auth parameters.
    let next=40;
    for(const uid of [1,2,200001,200004]) {
      await pool.query("INSERT INTO participants(zid,pid,uid) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM participants WHERE zid=$1 AND uid=$3)",[f.zid,next++,uid]);
    }
  }
  for(const phase of ["empty","single","multiple"]) {
    if(phase!=="empty") for(const f of chosen) {
      const tid=phase==="single"?700:701;
      const meaning=phase==="single"?"agree":"disagree";
      await pool.query("INSERT INTO votes(zid,pid,tid,vote,weight_x_32767,created,high_priority) VALUES($1,$2,$3,$4,$5,$6,$7)",[f.zid,f.participantPid,tid,seedVote(meaning),123,"1700000000123",true]);
    }
    for(const f of chosen) for(const mine of [false,true]) {
      const label=`${phase}/${f===zero?"pid-zero":"pid-nonzero"}/${mine?"mine":"list"}`;
      const memberServed=phase!=="multiple";
      await run(label+"/unauthenticated",f,mine,null,"",!mine);
      for(const kind of ["anonymous","standard"]) {
        const auth=`Bearer ${tokens[`${kind}-${f.zid}`]}`;
        await run(label+`/${kind}`,f,mine,auth,"",memberServed);
        await run(label+`/${kind}/head`,f,mine,auth,"",memberServed,"HEAD");
        await run(label+`/${kind}/pid-override`,f,mine,auth,"&pid=999",!mine&&(f.participantPid===0||memberServed));
      }
      for(const role of ["owner","admin","comments-owner-1","comments-moderator"]) {
        const auth=`Bearer ${oidc[role]}`;
        await run(label+`/oidc-${role}`,f,mine,auth,"",true);
        if(!mine) await run(label+`/oidc-${role}/self`,f,false,auth,"&pid=-1",true);
      }
      await run(label+"/xid",f,mine,`Bearer ${tokens[`xid-${f.zid}`]}`,"",false);
      if(!mine) {
        await run(label+"/public-pid",f,false,null,`&pid=${f.participantPid}`,memberServed);
        await run(label+"/public-filter",f,false,null,`&pid=${f.participantPid}&tid=700`,true);
        await run(label+"/public-missing-filter",f,false,null,`&pid=${f.participantPid}&tid=999`,true);
        await run(label+"/pid-self-no-auth",f,false,null,"&pid=-1",true);
      }
      for(const suffix of ["&limit=1","&offset=1","&page=2","&tid=bad","&tid=700suffix","&pid=0&pid=1","&conversation_id=other"]) await run(label+"/parameter/"+suffix,f,mine,null,suffix,false);
    }
  }
  // Admission boundaries under a populated conversation; malformed auth never
  // becomes anonymous. Node remains the authority for these statuses and bytes.
  for(const mine of [false,true]) {
    const label=`boundary/${mine?"mine":"list"}`;
    for(const name of ["missing","wrongPid","expired","future","wrongIssuer","wrongAudience","tampered"]) await run(label+"/"+name,zero,mine,`Bearer ${tokens[name]}`,"",false);
    await run(label+"/foreign-conversation",zero,mine,`Bearer ${tokens[`anonymous-${nonzero.zid}`]}`,"",false);
    await run(label+"/bad-token",zero,mine,"Bearer invalid","",false);
    await run(label+"/cookie",zero,mine,null,"",false,"GET",[["Cookie","fixture=1"]]);
    await run(label+"/body",zero,mine,null,"",false,"GET",[["Content-Type","application/json"],["Content-Length","2"]],"{}");
    await run(label+"/unknown-conversation",{...zero,capability:"absentfixture"},mine,null,"",false);
    const c=add(label+"/missing-conversation",zero,mine,null,"",false);c.target=`/api/v3/votes${mine?"/me":""}`;results.push(await compare(c));
  }
  for(const mine of [false,true]) {
    const auth=`Bearer ${oidc["comments-moderator"]}`;
    const label=`authenticated-boundary/${mine?"mine":"list"}`;
    await run(label+"/unknown-conversation",{...zero,capability:"absentfixture"},mine,auth,"",false);
    const c=add(label+"/missing-conversation",zero,mine,auth,"",false);c.target=`/api/v3/votes${mine?"/me":""}`;results.push(await compare(c));
    const unjoined=fixtures.find(f=>!chosen.includes(f));
    const claims=JSON.parse(Buffer.from(oidc.owner.split(".")[1],"base64url"));
    const memberships=await pool.query("SELECT p.pid FROM participants p JOIN oidc_user_mappings m ON m.uid=p.uid WHERE p.zid=$1 AND m.oidc_sub=$2",[unjoined.zid,claims.sub]);
    if(memberships.rowCount!==0)throw Error("no-membership control must have no membership");
    await run(label+"/no-membership",unjoined,mine,`Bearer ${oidc.owner}`,"",!mine);
  }
  // Deliberately invalid storage values exercise Node's preserved-invalid policy.
  // Valid intentions above and below always pass through the fixture convention.
  async function corruptVoteFixture(f) {
    await pool.query("UPDATE votes SET vote=$1 WHERE zid=$2",[7,f.zid]);
    await pool.query("UPDATE votes_latest_unique SET vote=$1 WHERE zid=$2",[7,f.zid]);
  }
  // Single-row values use the same fixture writer and Node's real conversion.
  await pool.query("DELETE FROM votes WHERE zid=$1",[zero.zid]);
  await pool.query("DELETE FROM votes_latest_unique WHERE zid=$1",[zero.zid]);
  for(const meaning of ["agree","disagree","pass",null,"invalid"]) {
    await pool.query("DELETE FROM votes WHERE zid=$1",[zero.zid]);
    await pool.query("DELETE FROM votes_latest_unique WHERE zid=$1",[zero.zid]);
    await pool.query("INSERT INTO votes(zid,pid,tid,vote,weight_x_32767,created) VALUES($1,$2,700,$3,NULL,$4)",[zero.zid,zero.participantPid,meaning===null||meaning==="invalid"?null:seedVote(meaning),"9223372036854775807"]);
    if(meaning==="invalid")await corruptVoteFixture(zero);
    for(const mine of [false,true]) await run(`values/${meaning}/${mine?"mine":"list"}`,zero,mine,`Bearer ${tokens[`anonymous-${zero.zid}`]}`);
  }
  for(const mine of [false,true]) {
    const auth=`Bearer ${tokens[`anonymous-${zero.zid}`]}`;
    for(const encoding of ["gzip","deflate","identity","gzip, deflate","*"]) await run(`encoding/${mine}/${encoding}`,zero,mine,auth,"",true,"GET",[["Accept-Encoding",encoding]]);
    const c=add(`fresh/${mine}`,zero,mine,auth,"",true,"GET",[["If-None-Match","*"]]);c.status=304;results.push(await compare(c));
    await run(`head/${mine}`,zero,mine,auth,"",true,"HEAD");
  }
  await pool.query("UPDATE conversations SET is_active=false WHERE zid=$1",[zero.zid]);
  for(const mine of [false,true]) await run(`closed/${mine}`,zero,mine,`Bearer ${tokens[`anonymous-${zero.zid}`]}`);
  await pool.end();
  fs.writeFileSync("/artifacts/votes-read-recordings.json",JSON.stringify({format:1,source:"direct unchanged Node listener; generated fixtures; complete HTTP bytes",records},null,2));
  if(new Set(records.map(r=>r.id)).size!==records.length)throw Error("recording names must be unique");
  const differences=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  const counters=await fetch("http://polis-api:5100/health").then(r=>r.json());
  const summary={recorded:cases.length,servedByRust:results.filter(r=>r.equal).length,handedToNode:results.filter(r=>r.fallback&&!r.unexpectedFallback).length,dateRetries,differences,counters};
  if(counters.votesReadServed!==summary.servedByRust+dateRetries||counters.votesReadFallback!==summary.handedToNode)summary.counterMismatch=true;
  console.log(JSON.stringify(summary,null,2));
  if(differences.length||summary.counterMismatch||!summary.servedByRust)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
