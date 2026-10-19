"use strict";
// Direct typed-contract proof: generated local fixture only. The run script
// saves each job's raw SQL record and immutable assignment family; this file
// independently constructs the expected envelope and checks the wire bytes.
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ISSUER = "https://oidc.invalid/";
const AUDIENCE = "users";
const KID = "replay";
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function keys(dir) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  fs.writeFileSync(path.join(dir, "read-jwks.json"), JSON.stringify({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: KID }] }));
  fs.writeFileSync(path.join(dir, "oidc-private.pem"), privateKey.export({ format: "pem", type: "pkcs8" }));
}

function token(dir, claims) {
  const key = fs.readFileSync(path.join(dir, "oidc-private.pem"));
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 300, ...claims };
  const signing = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }))}.${b64url(JSON.stringify(body))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signing), key).toString("base64url");
  return `Bearer ${signing}.${signature}`;
}

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
  const length = /\r\ncontent-length: *(\d+)/i.exec(head);
  const at = headEnd + 4;
  if (headOnly || status === 204 || status === 304) return at;
  if (/\r\ntransfer-encoding: *chunked/i.test(head)) {
    let i = at;
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", i);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.subarray(i, lineEnd).toString("latin1"), 16);
      i = lineEnd + 2 + size + 2;
      if (i > buf.length) return null;
      if (size === 0) return i;
    }
  }
  if (length) return at + Number(length[1]) <= buf.length ? at + Number(length[1]) : null;
  return null;
}

function split(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, headEnd).toString("latin1").split("\r\n");
  return { status: Number(head[0].split(" ")[1]), head, body: buf.subarray(headEnd + 4) };
}

function header(head, name) {
  const line = head.find((l) => l.toLowerCase().startsWith(name + ":"));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
}

const assert = require("node:assert/strict");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../..");
const FAMILIES = ["topics_by_layer","assignments","keywords","umap","visualizations","narratives","collective_statements","topic_stats","consensus_inputs"];
function validators() {
  const code = fs.readFileSync(path.join(root,"client-report/src/contract/validate.js"),"utf8")
    .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  return ["client-report/src/contract", "client-participation-alpha/src/api/contract"].map(dir => {
    // Only module bindings are adapted. Report's generated validator body is
    // unchanged; the alpha leg validates its actual schema with that engine.
    const context = {delphiJobResultSchema:JSON.parse(fs.readFileSync(path.join(root,dir,"delphiJobResult.schema.json"))),
      pca2Schema:JSON.parse(fs.readFileSync(path.join(root,dir,"pca2.schema.json")))};
    vm.createContext(context);vm.runInContext(code,context);return context.validateDelphiJobResult;
  });
}
function expected(raw, rows) {
  const f = raw.families.find(x => x.family === "Delphi_CommentHierarchicalClusterAssignments");
  assert.equal(rows.length, f.row_count);
  const assignments = {};
  for (const row of [...rows].sort((a,b)=>Number(a.comment_id.N)-Number(b.comment_id.N))) {
    assert.equal(row.conversation_id.S,String(raw.zid));
    const layers={};
    for(const key of Object.keys(row).filter(k=>/^layer\d+_cluster_id$/.test(k)).sort((a,b)=>Number(a.slice(5,-11))-Number(b.slice(5,-11))))
      if(row[key].NULL !== true) layers[String(Number(key.slice(5,-11)))]=Number(row[key].N);
    assignments[row.comment_id.N]=layers;
  }
  return {contract_version:"delphi-job-result/1",job_id:raw.job_id,run_id:raw.run_id,
    conversation_id:"local-dynamo-1424",report_id:raw.report_id,status:"ready",as_of:raw.completed_at,
    inputs:{math_tick:raw.manifest.inputs.math_tick,math_env:raw.manifest.inputs.math_env,vote_count:null,comment_count:null,
      model:{topic_names:raw.manifest.models.topic,narrative:raw.manifest.models.narrative,statement:null,embedding:raw.manifest.models.embed},
      prompt_version:{topic_names:null,narrative:null,statement:null}},attempt:null,failure:null,pinned:raw.pinned,label:null,
    outputs:{assignments},omitted:FAMILIES.filter(f=>f!=="assignments")};
}
const route = job => `/api/v3/delphi/runs/${job}?families=assignments`;
async function request(dir, c) {
  const [host,port]=process.env.DELPHI_RUN_API.split(":");
  let headers=`Host: localhost\r\n`;
  if(c.auth) headers+=`Authorization: ${c.auth}\r\n`;
  const wire=Buffer.from(`${c.method||"GET"} ${c.target} HTTP/1.1\r\n${headers}${c.extra||""}\r\n${c.payload||""}`);
  return exchange({host,port:Number(port)},wire,c.method==="HEAD");
}
function owner(dir) {return token(dir,{sub:"replay-owner",email:"owner@example.invalid"});}
async function snapshot(dir, job) {
  const out=split(await request(dir,{target:route(job),auth:owner(dir)}));
  assert.equal(out.status,200,out.body.toString());
  for(const validate of validators()) assert.equal(validate(JSON.parse(out.body)).valid,true);
  fs.writeFileSync(path.join(dir,"before-supersede.json"),out.body);
}
async function replay(dir) {
  const jobs=JSON.parse(fs.readFileSync(path.join(dir,"jobs.json")));
  const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name)));
  const before=await (await fetch(`http://${process.env.DELPHI_RUN_API}/health`)).json();
  const cases=[];
  const admin=token(dir,{sub:"replay-administrator",email:"administrator@example.invalid"});
  const other=token(dir,{sub:"replay-participant",email:"participant@example.invalid"});
  for(const name of ["first","second"]) {
    const job=jobs[name];const expect=JSON.stringify(expected(read(`record-${job}.json`),read(`assignments-${job}.json`)));
    for(const [who,auth] of [["owner",owner(dir)],["admin",admin]]) {
      cases.push({id:`${name}-${who}`,target:route(job),auth,status:200,body:expect,validate:true});
      cases.push({id:`${name}-${who}-repeat`,target:route(job),auth,status:200,body:expect,validate:true});
      cases.push({id:`${name}-${who}-head`,target:route(job),auth,method:"HEAD",status:200,length:Buffer.byteLength(expect)});
    }
    cases.push({id:`${name}-other`,target:route(job),auth:other,status:403,body:'{"status":"error","message":"polis_err_delphi_result_auth"}'});
    cases.push({id:`${name}-anonymous`,target:route(job),status:401,body:'{"error":"No authentication token found"}'});
  }
  const t=route(jobs.first);
  cases.push(
    {id:"unknown",target:route("00000000-0000-4000-8000-000000000000"),auth:owner(dir),status:404,body:'{"status":"error","message":"Job not found"}'},
    {id:"invalid-id",target:route("not-a-job"),auth:owner(dir),status:404},
    {id:"uppercase-id",target:route(jobs.first.toUpperCase()),auth:owner(dir),status:404},
    {id:"unsigned",target:t,auth:"Bearer e30.e30.",status:502},
    {id:"expired",target:t,auth:token(dir,{sub:"replay-owner",exp:Math.floor(Date.now()/1000)-60}),status:502},
    {id:"unmapped",target:t,auth:token(dir,{sub:"unmapped"}),status:502},
    {id:"no-model-recorded",target:route(jobs.statement),auth:owner(dir),status:502},
    {id:"missing-selector",target:t.split("?")[0],auth:owner(dir),status:502},
    {id:"unknown-family",target:t.replace("assignments","narratives"),auth:owner(dir),status:502},
    {id:"multiple-family",target:t+",narratives",auth:owner(dir),status:502},
    {id:"repeated-selector",target:t+"&families=assignments",auth:owner(dir),status:502},
    {id:"structured-selector",target:t.replace("families=","families[]="),auth:owner(dir),status:502},
    {id:"extra-param",target:t+"&job_id=x",auth:owner(dir),status:502},
    {id:"nested-path",target:t.replace("?","/extra?"),auth:owner(dir),status:502},
    {id:"post",target:t,method:"POST",auth:owner(dir),status:502},
    {id:"body",target:t,extra:"Content-Length: 2\r\n",payload:"{}",auth:owner(dir),status:502}
  );
  const checks=validators(),results=[];let validated=0,failed=0;
  for(const c of cases) {
    const bytes=await request(dir,c);const {status,head,body}=split(bytes);const errors=[];
    if(status!==c.status) errors.push(`status ${status}, expected ${c.status}`);
    if(c.body!==undefined && body.toString()!==c.body) errors.push("typed body differs");
    if(c.length!==undefined && Number(header(head,"content-length"))!==c.length) errors.push("HEAD length differs");
    if(c.method==="HEAD" && body.length) errors.push("HEAD body");
    if(c.validate && status===200) {
      for(const validate of checks){const v=validate(JSON.parse(body));if(!v.valid)errors.push(...v.errors);else validated++;}
      if(c.id.startsWith("first-") && !body.equals(fs.readFileSync(path.join(dir,"before-supersede.json"))))errors.push("superseding publication changed old job");
      fs.writeFileSync(path.join(dir,`${c.id}.json`),body);
    }
    if(errors.length)failed++;
    results.push({id:c.id,status,ok:errors.length===0,errors,wire:bytes.toString("base64")});
  }
  const after=await (await fetch(`http://${process.env.DELPHI_RUN_API}/health`)).json();
  const served=cases.filter(c=>c.status!==502).length, fallback=cases.length-served;
  const counters={served:after.delphiResultServed-before.delphiResultServed,fallback:after.delphiResultFallback-before.delphiResultFallback};
  if(counters.served!==served || counters.fallback!==fallback)failed++;
  // The inherited family is explicitly attributed to the original producer
  // by the companion even though the synchronous save has no model manifest.
  const statement=read(`record-${jobs.statement}.json`), first=read(`record-${jobs.first}.json`);
  const inherited=statement.families.find(f=>f.family==="Delphi_CommentHierarchicalClusterAssignments");
  assert.equal(inherited.job_id,jobs.first);assert.equal(inherited.run_id,first.run_id);
  assert.equal(first.families.find(f=>f.family===inherited.family).artifact_id,inherited.artifact_id);
  console.log(JSON.stringify({cases:cases.length,failed,validatedClientSchemaChecks:validated,served,fallback,counters,
    historicalStable:results.filter(r=>r.id.startsWith("first-")).every(r=>r.ok),inheritedProducerVerified:true,results},null,2));
  if(failed)process.exitCode=1;
}
const [mode,dir,job]=process.argv.slice(2);
if(mode==="keys") keys(dir);
else if(mode==="snapshot") snapshot(dir,job).catch(e=>{console.error(e);process.exitCode=1;});
else if(mode==="replay") replay(dir).catch(e=>{console.error(e);process.exitCode=1;});
else throw new Error("usage: delphi-result-replay.cjs keys|snapshot|replay artifacts [job]");
