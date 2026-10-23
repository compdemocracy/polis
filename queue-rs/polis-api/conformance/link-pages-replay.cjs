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
async function main() {
  const { Pool } = require("/app/node_modules/pg");
  const pool = new Pool({connectionString:process.env.DATABASE_URL});
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027") throw Error("disposable fixture database required");
  const cases=[], results=[];
  const ids=["4linkplain","4linkempty","4linkmarkup","4linklarge","4linknull","4linkbigint"];
  try {
    await pool.query("INSERT INTO users(uid,hname,email,site_id,created) VALUES(280001,'Generated link owner','links@example.invalid','generated-link-site',1700000000000)");
    for (let i=0;i<ids.length;i++) {
      const topic=["Generated topic","","<b>Topic & 🙂</b>","Large description",null,""][i];
      const description=["Generated description",null,"<em>raw markup</em>","x".repeat(16385),"",null][i];
      await pool.query("INSERT INTO conversations(zid,owner,topic,description,created,modified) VALUES($1,280001,$2,$3,$4,1700000000000)",[280001+i,topic,description,i===4?null:i===5?"9223372036854775807":"1700000000000"]);
      await pool.query("INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)",[280001+i,ids[i]]);
    }
    function add(id,target,served=true,method="GET",extra=[],body="",status=200) {
      cases.push({id,seed:"7ac001000001",target,served,method,status,headers:[["Host","localhost"],["Connection","close"],...extra],body:Buffer.from(body)});
    }
    for(const route of ["iip","iim"]) {
      for(const cid of ids) {
        const served=route==="iip"||cid!=="4linklarge";
        const path=`/${route}/${cid}`;
        add(`${route}/${cid}`,path,served);
        add(`${route}/${cid}/head`,path,served,"HEAD");
        add(`${route}/${cid}/slash`,path+"/",served);
        add(`${route}/${cid}/origin`,path,served,"GET",[["Origin","https://example.invalid"]]);
        add(`${route}/${cid}/gzip`,path,served,"GET",[["Accept-Encoding","gzip"]]);
      }
      const path=`/${route}/4linkplain`;
      for(const suffix of ["?conversation_id=4linkempty","?other=1","/extra","%20","%2Fmore"]) add(`${route}/boundary/${suffix}`,path+suffix,false);
      add(`${route}/missing`,`/${route}/4linkmissing`,false);
      for(const method of ["POST","OPTIONS"]) add(`${route}/${method}`,path,false,method);
      add(`${route}/body`,path,false,"GET",[["Content-Length","2"]],"{}");
      add(`${route}/cookie`,path,false,"GET",[["Cookie","x=y"]]);
      add(`${route}/authorization`,path,false,"GET",[["Authorization","Bearer malformed"]]);
      // ETag is acquired from unchanged Node, then both responses are compared.
      const first=await exchange(NODE,requestBytes("GET",path,[["Host","localhost"],["Connection","close"]],Buffer.alloc(0)),false);
      const etag=first.toString("latin1").match(/\r\nETag: ([^\r]+)/i)[1];
      add(`${route}/fresh`,path,true,"GET",[["If-None-Match",etag]],"",304);
    }
    for(const c of cases) {
      const compressed=c.id==="iim/4linkmarkup/gzip";
      if(compressed) await pool.query("UPDATE conversations SET description=$1 WHERE zid=280003",["compressible text ".repeat(128)]);
      results.push(await compare(c));
      if(compressed) {
        const wire=Buffer.from(records[records.length-1].node,"base64").toString("latin1");
        if(!/\r\nContent-Encoding: gzip\r\n/i.test(wire))throw Error("compression case did not produce gzip");
        await pool.query("UPDATE conversations SET description=$1 WHERE zid=280003",["<em>raw markup</em>"]);
      }
    }
    let off=0;
    for(const c of cases) {
      const r=await exchange({host:"polis-api-off",port:5100},requestBytes(c.method,c.target,c.headers,c.body),c.method==="HEAD");
      if(!r.toString("latin1").startsWith("HTTP/1.1 502"))throw Error(`off switch served ${c.id}`);
      off++;
    }
    const failed=results.filter(r=>r.unexpectedFallback||r.unexpectedServe||(!r.fallback&&!r.equal));
    fs.writeFileSync("/artifacts/link-pages-recordings.json",JSON.stringify({records},null,2)+"\n");
    console.log(JSON.stringify({cases:cases.length,exact:results.filter(r=>r.equal).length,handbacks:results.filter(r=>r.fallback).length,off,dateRetries,failed},null,2));
    if(failed.length)process.exitCode=1;
  } finally { await pool.end(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
