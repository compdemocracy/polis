"use strict";
// Fresh generated conversations, using the two requests made by the participant
// page. Compare the projected Node JSON bytes without sorting response rows.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { fixtures } = require("/app/characterization/comments-cases.cjs");
const output = "/artifacts/participant-comments";
fs.mkdirSync(output, { recursive: true });
const project = rows => JSON.stringify(rows.map(({ txt, tid }) => ({ txt, tid })));
async function get(base, path, token, extra = {}, method = "GET") {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { headers, method, signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: await r.text() };
}
async function main() {
  const tokens = await fetch("http://server:5001/tokens").then(r => r.json());
  const recordings = [], deltas = [], failures = [];
  let comparisons = 0, headChecks = 0;
  for (const f of fixtures) {
    const cid = f.capability;
    const plain = `/api/v3/comments?conversation_id=${cid}`;
    const typed = `/api/v3/comments/participant?conversation_id=${cid}`;
    const topic = plain + "&moderation=true&include_voting_patterns=true";
    for (const actor of ["anonymous", `comments-participant-${f.zid}`, `comments-owner-${f.replicate}`, "comments-moderator", "comments-foreign", "admin"]) {
      const token = actor === "anonymous" ? null : tokens[actor];
      if (actor !== "anonymous") assert(token, `missing generated actor ${actor}`);
      const node = await get("http://server:5000", plain, token);
      const rust = await get("http://polis-api:5100", typed, token);
      const topicNode = await get("http://server:5000", topic, token);
      const id = `${f.key}/${actor}`;
      assert.equal(node.status, 200, id);
      assert.equal(topicNode.status, 200, id);
      const projected = project(JSON.parse(node.body));
      comparisons++;
      if (rust.status !== 200 || rust.body !== projected) failures.push({ id, node, rust, projected });
      const topicProjection = project(JSON.parse(topicNode.body));
      if (topicProjection !== rust.body) {
        const isModerator = actor.startsWith("comments-owner-") || ["comments-moderator", "admin"].includes(actor);
        const visible = JSON.parse(projected), topicRows = JSON.parse(topicProjection);
        const byTid = new Map(topicRows.map(r => [r.tid, r]));
        // Differences must never hide changed text or a missing visible comment.
        assert(visible.every(r => JSON.stringify(byTid.get(r.tid)) === JSON.stringify(r)), id);
        if (!isModerator) assert(topicRows.length >= visible.length, id);
        const visibleTids = new Set(visible.map(r => r.tid));
        const additionalTids = topicRows.filter(r => !visibleTids.has(r.tid)).map(r => r.tid);
        const reasons = [];
        if (additionalTids.length) {
          if (isModerator) reasons.push("The legacy topic call can include moderator-only rows; the typed route always applies participant visibility.");
          if (visible.length === 999) reasons.push("The legacy topic call is uncapped; the typed route retains the plain list's 999-row default limit.");
          assert(reasons.length, id + ": unexplained additional rows");
        }
        const sharedOrder = topicRows.filter(r => visibleTids.has(r.tid)).map(r => r.tid);
        const orderDiffers = JSON.stringify(sharedOrder) !== JSON.stringify(visible.map(r => r.tid));
        if (orderDiffers) reasons.push("The legacy topic vote-count join has no ORDER BY; the typed route retains the plain list's created order.");
        assert(reasons.length, id + ": unexplained projected-byte difference");
        deltas.push({
          id, source: topic, reasons, additionalTids, orderDiffers,
          nodeProjected: topicProjection, rustProjected: rust.body,
        });
      }
      recordings.push({ id, nodePath: plain, topicPath: topic, typedPath: typed, node, nodeProjected: projected, topicNode, rust });
      const head = await get("http://polis-api:5100", typed, token, {}, "HEAD");
      assert.equal(head.status, 200, id);
      assert.equal(head.body, "");
      headChecks++;
    }
  }
  const f = fixtures[0], path = `/api/v3/comments/participant?conversation_id=${f.capability}`;
  const firstParticipant = tokens[`comments-participant-${fixtures[1].zid}`];
  const cases = [
    [path, "broken", {}, "GET"],
    [path, firstParticipant, {}, "GET"],
    [path, null, { cookie: "session=unsupported" }, "GET"],
    [path + "&moderation=true", null, {}, "GET"],
    [path + "&pid=0", null, {}, "GET"],
    [path + "&report_id=fixture", null, {}, "GET"],
    [path + "&conversation_id=other", null, {}, "GET"],
    [path, null, {}, "POST"],
  ];
  for (const [target, token, headers, method] of cases) {
    const r = await get("http://polis-api:5100", target, token, headers, method);
    assert.equal(r.status, 502, target);
  }
  fs.writeFileSync(output + "/recordings.json", JSON.stringify(recordings, null, 2));
  fs.writeFileSync(output + "/deltas.json", JSON.stringify(deltas, null, 2));
  fs.writeFileSync(output + "/failures.json", JSON.stringify(failures, null, 2));
  const counters = await fetch("http://polis-api:5100/health").then(r => r.json());
  assert.equal(counters.participantCommentsServed, comparisons + headChecks);
  assert.equal(counters.participantCommentsFallback, cases.length);
  console.log(JSON.stringify({ conversations: fixtures.length, comparisons, headChecks, refusals: cases.length, deltas: deltas.length, failures: failures.length }, null, 2));
  assert.equal(failures.length, 0, "projected Node/Rust bytes differ");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
