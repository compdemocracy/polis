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
 const f=fixtures.find(f=>f.shape==="content-edges");
 const {Pool}=require("/app/node_modules/pg");const pool=new Pool({connectionString:process.env.DATABASE_URL});
 if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable fixture database required");
 const cases=[],results=[];let clock=1700000000000;
 async function run(id,kind,auth,tail="",served=true,method="GET",extra=[],body=""){
  const c={id,clock,seed:"7ac001000001",method,target:`/api/v3/${kind}?conversation_id=${f.capability}${kind==="locations"?"&gid=0":""}${tail}`,served,
   headers:[["Host","localhost"],["Connection","close"],["X-Polis-Fixture-Clock",String(clock)],...(auth?[["Authorization",auth]]:[]),...extra],body:Buffer.from(body)};
  cases.push(c);results.push(await compare(c));
 }
 async function seed(shape,tick=0,bid=42){
  for(const table of ["math_main","math_bidtopid","math_ptptstats","math_ticks"])await pool.query(`DELETE FROM ${table} WHERE zid=$1 AND math_env='p027'`,[f.zid]);
  await pool.query("DELETE FROM participant_locations WHERE zid=$1",[f.zid]);
  if(shape==="absent")return;
  const main={"math_tick":999,"base-clusters":{id:shape==="gap"?[]:[bid,99]},"group-clusters":[{members:shape==="multiple"?[bid,99]:[bid]}]};
  const mapping={math_tick:999,bidToPid:shape==="unplaced"?[[2]]:shape==="malformed"?[[f.participantPid],"invalid"]:[[f.participantPid],[2]]};
  await pool.query("INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,math_tick,caching_tick) VALUES($1,'p027',$2::jsonb,0,$3,$3)",[f.zid,JSON.stringify(main),tick]);
  await pool.query("INSERT INTO math_bidtopid(zid,math_env,data,math_tick) VALUES($1,'p027',$2::jsonb,$3)",[f.zid,JSON.stringify(mapping),shape==="incoherent"?tick+1:tick]);
  if(shape!=="missing-companion")await pool.query("INSERT INTO math_ptptstats(zid,math_env,data,math_tick) VALUES($1,'p027','{}',$2)",[f.zid,tick]);
  await pool.query("INSERT INTO math_ticks(zid,math_env,math_tick,caching_tick) VALUES($1,'p027',$2,$2)",[f.zid,tick]);
  await pool.query("INSERT INTO participant_locations(zid,uid,pid,lat,lng,source) VALUES($1,3,$2,0,1e21,1)",[f.zid,f.participantPid]);
  if(shape==="multiple")await pool.query("INSERT INTO participant_locations(zid,uid,pid,lat,lng,source) VALUES($1,2,2,10.125,-20.5,1)",[f.zid]);
 }
 try{
  for(const shape of ["absent","zero","gap","incoherent","missing-companion","unplaced","multiple","malformed"]){
   await seed(shape);clock+=4000;
   for(const kind of ["bid","locations"]){
    const served=shape!=="malformed"&&!(shape==="multiple"&&kind==="locations");
    for(const identity of ["anonymous","standard","admin"]){
     const auth=`Bearer ${identity==="admin"?oidc.admin:tokens[`${identity}-${f.zid}`]}`;
     await run(`${shape}/${kind}/${identity}`,kind,auth,"",served);
     await run(`${shape}/${kind}/${identity}/head`,kind,auth,"",served,"HEAD");
     await run(`${shape}/${kind}/${identity}/origin`,kind,auth,"",served,"GET",[["Origin","https://example.invalid"]]);
    }
    await run(`${shape}/${kind}/no-auth`,kind,null,"",served&&kind==="locations");
   }
   const auth=`Bearer ${tokens[`anonymous-${f.zid}`]}`;
   await run(`${shape}/bid/stale`,"bid",auth,"&math_tick=0",false);
  }
  const auth=`Bearer ${tokens[`anonymous-${f.zid}`]}`;
  await seed("zero",9,42);clock+=4000;
  await run("cache/cold/bid","bid",auth);await run("cache/cold/locations","locations",null);
  await seed("zero",10,55);clock+=1000;
  await run("cache/warm/bid","bid",auth);await run("cache/warm/locations","locations",null);
  clock+=2000;
  await run("cache/expired/bid","bid",auth);await run("cache/expired/locations","locations",null);
  for(const kind of ["bid","locations"]){
   for(const tail of ["&pid=0","&unknown=1","&conversation_id=other"])await run(`boundary/${kind}/${tail}`,kind,auth,tail,false);
   for(const method of ["POST","OPTIONS"])await run(`boundary/${kind}/${method}`,kind,auth,"",false,method);
   await run(`boundary/${kind}/cookie`,kind,auth,"",false,"GET",[["Cookie","x=y"]]);
   await run(`boundary/${kind}/body`,kind,auth,"",false,"GET",[["Content-Length","2"]],"{}");
   await run(`boundary/${kind}/bad-auth`,kind,"Bearer malformed","",false);
   await run(`boundary/${kind}/xid`,kind,`Bearer ${tokens[`xid-${f.zid}`]}`,"",false);
  }
  let off=0;for(const c of cases){const response=await exchange({host:"polis-api-off",port:5100},requestBytes(c.method,c.target,c.headers,c.body),c.method==="HEAD");if(!response.toString("latin1").startsWith("HTTP/1.1 502"))throw Error(`off switch served ${c.id}`);off++;}
  const failed=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
  fs.writeFileSync("/artifacts/math-membership-recordings.json",JSON.stringify({records},null,2)+"\n");
  console.log(JSON.stringify({cases:cases.length,exact:results.filter(r=>r.equal).length,handbacks:results.filter(r=>r.fallback).length,off,dateRetries,failed},null,2));if(failed.length)process.exitCode=1;
 }finally{await pool.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
