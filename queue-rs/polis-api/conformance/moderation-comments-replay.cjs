"use strict";
// Compare complete projected envelopes, retaining Node's property and row order.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { fixtures } = require("/app/characterization/comments-cases.cjs");
const output = "/artifacts/moderation-comments";
fs.mkdirSync(output, { recursive: true });
const fields = ["txt", "tid", "is_meta", "velocity", "mod", "active", "conversation_id"];
function project(body) {
  const value = JSON.parse(body);
  if (Array.isArray(value)) return JSON.stringify(value.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => fields.includes(k)))));
  assert.deepEqual(Object.keys(value), ["comments", "pagination"]);
  value.comments = value.comments.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => fields.includes(k))));
  return JSON.stringify(value);
}
let served = 0, fallback = 0;
async function get(base, path, token, extra = {}, method = "GET") {
  const headers = { "accept-encoding": "identity", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { headers, method, signal: AbortSignal.timeout(10000) });
  if (base === "http://polis-api:5100") { if (r.status === 502) fallback++; else served++; }
  return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
}
async function main() {
  const tokens = await fetch("http://server:5001/tokens").then(r => r.json());
  const recordings = [], deltas = [], failures = [];
  let comparisons = 0, denied = 0, headChecks = 0;
  for (const f of fixtures) {
    const actors = ["anonymous", `comments-participant-${f.zid}`, `comments-owner-${f.replicate}`, "comments-moderator", "comments-foreign", "admin"];
    for (const actor of actors) for (const mod of [0, 1, -1]) {
      const allowed = actor.startsWith("comments-owner-") || ["comments-moderator", "admin"].includes(actor);
      const pages = actor.startsWith("comments-owner-") ? [[50,0],[2,1],[500,0]] : [[50,0]];
      for (const [limit, offset] of pages) {
        const token = actor === "anonymous" ? null : tokens[actor];
        if (actor !== "anonymous") assert(token, actor);
        const query = `conversation_id=${f.capability}&mod=${mod}&limit=${limit}&offset=${offset}`;
        const nodePath = `/api/v3/comments?${query}&moderation=true&include_voting_patterns=false`;
        const typedPath = `/api/v3/comments/moderation?${query}`;
        const id = `${f.key}/${actor}/${mod}/${limit}/${offset}`;
        const node = await get("http://server:5000", nodePath, token);
        const rust = await get("http://polis-api:5100", typedPath, token);
        assert.equal(node.status, 200, id);
        const projected = project(node.body);
        if (allowed) {
          comparisons++;
          if (rust.status !== 200 || rust.body !== projected) failures.push({id,node,rust,projected});
        } else {
          denied++;
          assert.equal(rust.status, 403, id);
          assert.deepEqual(JSON.parse(rust.body), {error:"polis_err_comments_moderation_forbidden",message:"polis_err_comments_moderation_forbidden",status:403}, id);
          deltas.push({id, nodePath, typedPath, nodeStatus:node.status, nodeProjected:projected, rustStatus:rust.status, rustBody:rust.body, nodeEquivalent:false,
            reason:"The overloaded Node route silently narrows non-moderators to participant-visible rows for its report and topic callers. The typed moderation-only route refuses them before statement or count queries; this 403 has no Node equivalent."});
        }
        recordings.push({id,nodePath,typedPath,node,nodeProjected:projected,rust});
        const head = await get("http://polis-api:5100", typedPath, token, {}, "HEAD");
        assert.equal(head.status, allowed ? 200 : 403,id);
        assert.equal(head.body, "",id);
        headChecks++;
      }
    }
  }
  const f = fixtures.find(f => f.shape === "content-edges") || fixtures[3];
  const baseQuery = `conversation_id=${f.capability}&mod=0&limit=50&offset=0`;
  const owner = tokens[`comments-owner-${f.replicate}`];
  const refusals = [];
  const boundary = "Outside the selected moderation-page request shape; the existing method, cookie and other-key boundary hands back to Node during the dual-writer window, without writes.";
  const modDomain = "The parsed mod is outside 0, 1 and -1, so this request stays outside the typed route. The 502 hands back to Node during the dual-writer window, without writes.";
  const omittedLimit = "Node answers with an unbounded array; the typed route never reads unbounded";
  const omittedMod = "Node answers every moderation state; the typed route serves one state per request";
  const authority = "The typed moderation-only route refuses unverifiable or foreign-scoped identities before statement/count reads; the overloaded Node route has a different identity response.";
  // Request identity encoding so compression thresholds cannot change framing.
  // Date is generated per response. Keep it in the recording but compare all
  // other headers. Successful projections change Content-Length and ETag;
  // compare those against the projected bytes instead of the full Node row.
  function headersForComparison(response, projected) {
    const headers = { ...response.headers };
    delete headers.date;
    if (response.status === 200 && projected !== response.body) {
      headers["content-length"] = String(Buffer.byteLength(projected));
      if (headers.etag) headers.etag = `W/"${Buffer.byteLength(projected).toString(16)}-${require("node:crypto").createHash("md5").update(projected).digest("base64").replace(/=+$/, "")}"`;
    }
    return headers;
  }
  async function probe(id, query, token = owner, headers = {}, method = "GET", expectedDelta = null, expectedStatus = null) {
    const nodePath = `/api/v3/comments?${query}&moderation=true&include_voting_patterns=false`;
    const typedPath = `/api/v3/comments/moderation?${query}`;
    const node = await get("http://server:5000", nodePath, token, headers, method);
    const rust = await get("http://polis-api:5100", typedPath, token, headers, method);
    const projected = node.status === 200 && node.body ? project(node.body) : node.body;
    const comparison = {
      status: node.status === rust.status,
      headers: require("node:util").isDeepStrictEqual(headersForComparison(node, projected), headersForComparison(rust, rust.body)),
      body: Buffer.from(projected).equals(Buffer.from(rust.body)),
    };
    const equal = Object.values(comparison).every(Boolean);
    const listed = !equal && expectedDelta && rust.status === expectedStatus &&
      (expectedStatus !== 502 || rust.body === "Bad Gateway\n") &&
      (expectedStatus !== 403 || rust.body === '{"error":"polis_err_comments_moderation_forbidden","message":"polis_err_comments_moderation_forbidden","status":403}');
    const outcome = equal ? "equal" : listed ? "listed delta" : "unexplained";
    const record = { id, nodePath, typedPath, method, node, rust, nodeProjected: projected, comparison, outcome };
    refusals.push(record);
    if (listed) deltas.push({ ...record, reason: expectedDelta });
    if (outcome === "unexplained") failures.push(record);
  }
  // Every former refusal now calls Node and compares status, headers and bytes.
  await probe("broken token", baseQuery, "broken", {}, "GET", authority, 403);
  await probe("foreign participant token", baseQuery, tokens[`comments-participant-${fixtures.find(x => x.zid !== f.zid).zid}`], {}, "GET", authority, 403);
  await probe("cookie", baseQuery, owner, {cookie:"session=unsupported"}, "GET", boundary, 502);
  for (const tail of ["moderation=true","include_voting_patterns=false","pid=0","report_id=fixture","modIn=true","mod_gt=0","tids=1","random=true","conversation_id=other","mod=1","unknown=1"]) {
    await probe(`extra ${tail}`, baseQuery + "&" + tail, owner, {}, "GET", ["conversation_id=other", "mod=1"].includes(tail) ? null : boundary, 502);
  }
  await probe("POST", baseQuery, owner, {}, "POST", boundary, 502);
  // The complete paired query matrix, including its out-of-domain controls.
  await probe("control", baseQuery);
  for (const key of ["mod", "limit", "offset"]) for (const value of ["-1","-2","0","2","1.5","abc","2147483648","-2147483649","01","%2B1","1abc","","9007199254740992"]) {
    const outside = key === "mod" && ["-2", "2", "2147483648", "-2147483649", "9007199254740992"].includes(value);
    await probe(`${key}=${value}`, baseQuery.replace(new RegExp(`${key}=[^&]*`), `${key}=${value}`), owner, {}, "GET", outside ? modDomain : null, outside ? 502 : null);
  }
  for (const key of ["mod","limit","offset","conversation_id"]) {
    await probe(`duplicate ${key}`, baseQuery + `&${key}=${key === "conversation_id" ? f.capability : "1"}`);
    const omission = key === "limit" ? omittedLimit : key === "mod" ? omittedMod : null;
    await probe(`missing ${key}`, baseQuery.split("&").filter(s => !s.startsWith(key + "=")).join("&"), owner, {}, "GET", omission, omission ? 502 : null);
  }
  // Repeat pagination edge cases with populated rows, so truncation and row
  // skipping are checked as well as the envelope. Include HEAD refusal bytes.
  for (const [key, value] of [["limit","1.5"],["limit","-1"],["limit","2147483648"],["offset","1.5"],["offset","-1"],["offset","2147483648"],["offset","9007199254740993"],["offset","9223372036854775808"]]) {
    await probe(`populated ${key}=${value}`, baseQuery.replace("mod=0", "mod=1").replace(new RegExp(`${key}=[^&]*`), `${key}=${value}`));
  }
  for (const key of ["mod", "limit", "offset"]) {
    await probe(`HEAD invalid ${key}`, baseQuery.replace(new RegExp(`${key}=[^&]*`), `${key}=abc`), owner, {}, "HEAD");
    await probe(`array ${key}`, baseQuery + `&${key}[]=1`);
  }
  fs.writeFileSync(output+"/recordings.json",JSON.stringify(recordings,null,2));
  fs.writeFileSync(output+"/deltas.json",JSON.stringify(deltas,null,2));
  fs.writeFileSync(output+"/failures.json",JSON.stringify(failures,null,2));
  fs.writeFileSync(output+"/refusals.json",JSON.stringify(refusals,null,2));
  const counters = await fetch("http://polis-api:5100/health").then(r=>r.json());
  assert.equal(counters.moderationCommentsServed,served);
  assert.equal(counters.moderationCommentsFallback,fallback);
  console.log(JSON.stringify({conversations:fixtures.length,comparisons,denied,headChecks,refusals:refusals.length,deltas:deltas.length,probeEqual:refusals.filter(x=>x.outcome === "equal").length,probeListed:refusals.filter(x=>x.outcome === "listed delta").length,unexplained:failures.length,failures:failures.length},null,2));
  assert.equal(failures.length,0,"projected Node/Rust bodies differ");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
