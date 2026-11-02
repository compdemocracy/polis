"use strict";
// Preload the unchanged Treevite recordings driver. Each POST wave is sent to
// Rust from the same database state, then Node. Only generated codes and valid
// timestamps are normalized; every other response byte and durable row agrees.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {Pool} = require("/app/node_modules/pg");
const recorder = require("/app/characterization/cli.cjs");
const {bytes, strings} = require("/app/characterization/wire.cjs");
const send = recorder.send;
const pool = new Pool({connectionString:process.env.DATABASE_URL});
const tables=["treevite_waves","treevite_invites"];
const results=[];
let ownerRequest;
async function snapshot() {
  const out={};
  for(const table of tables) out[table]=(await pool.query(`select * from ${table} order by id`)).rows;
  return out;
}
function normalize(rows,before) {
  const existingCodes=new Set(before.treevite_invites.map(r=>r.invite_code));
  return JSON.parse(JSON.stringify(rows, (k,v)=> {
    if(v!==null && ["created_at","updated_at"].includes(k)) { assert.ok(Number.isFinite(Date.parse(v))); return "$timestamp"; }
    if(k==="invite_code" && !existingCodes.has(v)) { assert.match(v,/^[A-Za-z0-9]{10}$/); return "$invite"; }
    return v;
  }));
}
function wire(response) {
  const raw=bytes(response);
  const headers=response.wire.response.headers;
  const header=(n)=>headers.find(h=>h.name.toLowerCase()===n)?.value;
  assert.equal(header("content-length"),String(raw.length));
  if(header("etag")) assert.equal(header("etag"),require("/app/node_modules/express/lib/utils").wetag(raw));
  const body=header("content-type")?.includes("application/json") ? strings(raw.toString(),(v,p,k)=> {
    if(["created_at","updated_at"].includes(k) && v!==null) { assert.match(v,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);return "$timestamp"; }
    return v;
  }):raw.toString();
  const ignored=new Set(["date","connection","keep-alive","content-length","etag"]);
  return {status:response.status,body,headers:headers.filter(h=>!ignored.has(h.name.toLowerCase())).map(h=>[h.name.toLowerCase(),h.value]).sort()};
}
recorder.send=async function(request,tokens,deadline) {
  if(request.path!=="/api/v3/treevite/waves" || request.method!=="POST") return send(request,tokens,deadline);
  ownerRequest ||= {request,tokens,deadline};
  const before=await snapshot();
  const sequences={};
  for(const t of tables) sequences[t]=(await pool.query(`select last_value,is_called from ${t}_id_seq`)).rows[0];
  const rust=await send({...request,path:"http://polis-api:5100"+request.path,headers:{...request.headers,"content-length":String(Buffer.byteLength(JSON.stringify(request.body)))}},tokens,deadline);
  assert.notEqual(rust.status,502,"wave recording must execute in Rust, never hand back");
  const rustAfter=await snapshot();
  // Rust only adds waves and invites. Remove its additions and restore sequence
  // state so the immutable recording still observes exactly Node's IDs.
  for(const t of [...tables].reverse()) await pool.query(`delete from ${t} where not(id=any($1::bigint[]))`,[before[t].map(r=>r.id)]);
  for(const t of tables) await pool.query(`select setval('${t}_id_seq',$1,$2)`,[sequences[t].last_value,sequences[t].is_called]);
  assert.deepEqual(await snapshot(),before);
  const node=await send(request,tokens,deadline);
  assert.deepEqual(wire(rust),wire(node),JSON.stringify(request.body));
  assert.deepEqual(normalize(rustAfter,before),normalize(await snapshot(),before),"committed wave/invite rows");
  results.push({status:rust.status,body:wire(rust).body});
  fs.writeFileSync("/artifacts/treevite-wave-rust-replay.json",JSON.stringify({cases:results.length,results},null,2)+"\n");
  return node;
};
const close=recorder.close;
recorder.close=async()=>{
  try {
    assert.equal(results.length,13);
    // Run extra refusal comparisons after the immutable profile has captured
    // route hits, so the additional requests cannot alter its baseline.
    const {request,tokens,deadline}=ownerRequest;
    const evidence=[];
    for(const fields of [
      {owner_invites:-2147483649,invites_per_user:0,parent_wave:0},
      {owner_invites:"-2147483649",invites_per_user:0,parent_wave:0},
      {owner_invites:1,invites_per_user:0,parent_wave:2147483648},
    ]) {
      const body={...request.body,...fields};
      const before=await snapshot();
      const rust=await send({...request,body,path:"http://polis-api:5100"+request.path,headers:{...request.headers,"content-length":String(Buffer.byteLength(JSON.stringify(body)))}},tokens,deadline);
      const node=await send({...request,body},tokens,deadline);
      assert.deepEqual(await snapshot(),before,"integer refusals write nothing");
      assert.deepEqual(wire(rust),wire(node),JSON.stringify(fields));
      const expected=fields.parent_wave>0 ? 500 : 400;
      assert.equal(rust.status,expected);
      evidence.push({input:fields,rust:{status:rust.status,body:bytes(rust).toString()},node:{status:node.status,body:bytes(node).toString()},equal:true});
    }
    fs.writeFileSync("/artifacts/treevite-wave-integer-parity.json",JSON.stringify(evidence,null,2)+"\n");
    console.log("Integer refusal comparisons: "+JSON.stringify(evidence));
  } finally { await pool.end();await close(); }
};
