"use strict";
// Fresh Node responses projected in their original row/property order.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {fixtures} = require("/app/characterization/comments-cases.cjs");
const {Client} = require("/app/node_modules/pg");
const output = "/artifacts/report-comments";
fs.mkdirSync(output, {recursive: true});
const fields = ["txt", "tid", "is_meta", "pid", "agree_count", "disagree_count", "pass_count", "count"];
const recordings = [], differences = [], boundaries = [];
function project(body) {
  return JSON.stringify(JSON.parse(body).map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key)))));
}
async function request(base, path, token, method="GET", extra={}) {
  const headers = {"accept-encoding":"identity", ...extra};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, {headers, method, signal: AbortSignal.timeout(10000)});
  return {status:r.status, headers:Object.fromEntries(r.headers), body:await r.text()};
}
function comparableHeaders(response, projected) {
  const headers = {...response.headers};
  delete headers.date; // Wall-clock response metadata, retained in recordings.
  if (projected !== response.body && response.status === 200) {
    headers["content-length"] = String(Buffer.byteLength(projected));
    if (headers.etag) headers.etag = `W/"${Buffer.byteLength(projected).toString(16)}-${crypto.createHash("md5").update(projected).digest("base64").replace(/=+$/, "")}"`;
  }
  return headers;
}
async function pair(id, query, token, expectedStatus=200) {
  const nodePath = `/api/v3/comments?${query}&moderation=true&include_voting_patterns=true`;
  const typedPath = `/api/v3/comments/report?${query}`;
  const node = await request("http://server:5000", nodePath, token);
  const rust = await request("http://polis-api:5100", typedPath, token);
  const projected = node.status === 200 ? project(node.body) : node.body;
  const comparison = {status:node.status===rust.status, expectedStatus:node.status===expectedStatus && rust.status===expectedStatus, body:Buffer.from(projected).equals(Buffer.from(rust.body)),
    headers:isDeepStrictEqual(comparableHeaders(node,projected),comparableHeaders(rust,rust.body))};
  const head = await request("http://polis-api:5100",typedPath,token,"HEAD");
  const headHeaders = {...head.headers}, getHeaders = {...rust.headers};
  delete headHeaders.date; delete getHeaders.date;
  const headEqual = head.status===rust.status && head.body==="" && isDeepStrictEqual(headHeaders,getHeaders);
  const record = {id,nodePath,typedPath,node,nodeProjected:projected,rust,comparison,head,headEqual};
  recordings.push(record);
  if (!Object.values(comparison).every(Boolean) || !headEqual) differences.push(record);
}
async function main() {
  const tokens = await fetch("http://server:5001/tokens").then(r=>r.json());
  const c = new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  const math = await c.query("SELECT count(*)::integer AS n FROM math_main WHERE zid = ANY($1::integer[])",[fixtures.map(f=>f.zid)]);
  assert.equal(math.rows[0].n,0,"report fixtures must have no math");
  await c.end();
  for (const f of fixtures) {
    for (const actor of ["anonymous",`comments-participant-${f.zid}`,`comments-owner-${f.replicate}`,"comments-moderator","comments-foreign","admin"]) {
      const token = actor==="anonymous" ? null : tokens[actor];
      if (actor!=="anonymous") assert(token, actor);
      for (const level of [-2,-1,0]) {
        await pair(`${f.key}/${actor}/${level}`,`conversation_id=${f.capability}&report_id=${f.report}&mod_gt=${level}`,token);
      }
    }
  }
  const f=fixtures.find(f=>f.shape==="content-edges")||fixtures[0];
  const q=`conversation_id=${f.capability}&report_id=${f.report}&mod_gt=-2`;
  for (const [id,query] of [
    ["unknown report",q.replace(f.report,"rGeneratedMissingReport")],
    ["empty report",q.replace(f.report,"")],
    ["report array",q.replace("report_id=","report_id[]=")],
    ["duplicate report",q+`&report_id=${f.report}`],
    ["malformed level",q.replace("mod_gt=-2","mod_gt=bad")],
    ["duplicate level",q+"&mod_gt=-2"],
    ["default level",q.replace("&mod_gt=-2","")],
    ["integer prefix",q.replace("mod_gt=-2","mod_gt=0suffix")],
  ]) await pair(id,query,null,["default level","integer prefix"].includes(id)?200:400);
  for (const [id,query,method,headers] of [
    ["language",q+"&lang=fr","GET",{}], ["translation",q+"&translate=true","GET",{}],
    ["limit",q+"&limit=1","GET",{}], ["level outside report",q.replace("mod_gt=-2","mod_gt=1"),"GET",{}],
    ["cookie",q,"GET",{cookie:"generated=1"}], ["write method",q,"POST",{}],
    ["wrong report conversation",q.replace(f.report,fixtures.find(x=>x.zid!==f.zid).report),"GET",{}],
    ["broken identity",q,"GET",{authorization:"Bearer broken"}],
  ]) {
    const response=await request("http://polis-api:5100",`/api/v3/comments/report?${query}`,null,method,headers);
    boundaries.push({id,query,method,response});
    assert.equal(response.status,502,id);
    assert.equal(response.body,"Bad Gateway\n",id);
  }
  const result={conversations:fixtures.length, noMathConversations:fixtures.length, pairs:recordings.length,
    headChecks:recordings.length, differences:differences.length, boundaries:boundaries.length};
  for (const [name,value] of Object.entries({recordings,differences,boundaries,result})) fs.writeFileSync(`${output}/${name}.json`,JSON.stringify(value,null,2)+"\n");
  console.log(JSON.stringify(result));
  assert.equal(differences.length,0,"Node projection differences; see recording");
}
main().catch(e=>{ console.error(e); process.exitCode=1; });
