"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  zlib = require("node:zlib");
const { readRecording, validate } = require("./recording.cjs");
const { hash } = require("./core.cjs");
const { plan, commentsCases, fixtureKey } = require("./comments-cases.cjs");
const keys = [
  "txt",
  "tid",
  "created",
  "quote_src_url",
  "is_seed",
  "is_meta",
  "lang",
  "pid",
  "original_id",
];
function audit(root) {
  const recording = readRecording(root),
    by = new Map(recording.cases.map((c) => [c.caseId, c]));
  const seed = JSON.parse(
      fs.readFileSync(path.join(root, "comments-seed.json"))
    ),
    auth = JSON.parse(fs.readFileSync(path.join(root, "comments-auth.json")));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "comments-plan.json"))),
    plan
  );
  assert.equal(auth.adminUid, 2);
  assert.equal(auth.moderatorUid, 200004);
  assert.equal(auth.distinct, true);
  assert.equal(
    seed.actors.find((a) => a.uid === 200004).site,
    seed.actors.find((a) => a.uid === 200001).site
  );
  assert.notEqual(
    seed.actors.find((a) => a.uid === 4).site,
    seed.actors.find((a) => a.uid === 200001).site
  );
  assert.equal(seed.fixtures.length, 71);
  assert.equal(new Set(seed.fixtures.map((f) => f.inputSha256)).size, 71);
  assert.equal(auth.participantBindings.length, 71);
  let records = 0;
  for (const e of recording.index.cases) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, e.manifest.path))
    );
    validate(manifest);
    records++;
    for (const n of [
      "request.json",
      "response.json",
      "effects.jsonl",
      "external.jsonl",
      "process.jsonl",
    ]) {
      const t = fs.readFileSync(path.join(root, e.path, n), "utf8");
      for (const r of n.endsWith("jsonl")
        ? t.trim().split("\n").filter(Boolean).map(JSON.parse)
        : [JSON.parse(t)]) {
        validate(r);
        records++;
      }
    }
  }
  const rows = [],
    cells = new Map();
  let populated = 0,
    empty = 0;
  const generated = commentsCases();
  assert.equal(generated.length, 396);
  assert.equal(new Set(generated.map((c) => c.caseId)).size, 396);
  for (let i = 0; i < plan.cases.length; i++) {
    const p = plan.cases[i],
      c = by.get(p.id),
      f = seed.fixtures.find((f) => f.key === fixtureKey(p));
    assert.ok(c, p.id);
    assert.deepEqual(c.request, generated[i].request);
    assert.equal(c.oracle.pass, true, p.id);
    assert.equal(Object.keys(c.effects.db).length, 0, p.id);
    assert.equal(Object.keys(c.effects.files).length, 0, p.id);
    assert.equal(c.effects.outbound.length, 0, p.id);
    assert.equal(c.effects.jwtMinted, 0, p.id);
    const e = recording.index.cases.find((e) => e.case_id === p.id),
      response = JSON.parse(
        fs.readFileSync(path.join(root, e.path, "response.json"))
      );
    const header = (n) =>
      response.headers.find((h) => h.name.toLowerCase() === n)?.value;
    const wire = Buffer.concat(
      response.body.map((b) => {
        const bytes = Buffer.from(b.bytes.base64, "base64");
        assert.equal(bytes.length, b.bytes.byte_length);
        assert.equal(hash(bytes), b.bytes.sha256);
        return bytes;
      })
    );
    const coding = header("content-encoding") || "identity",
      decoded = coding === "gzip" ? zlib.gunzipSync(wire) : wire;
    const body = header("content-type")?.includes("application/json")
      ? JSON.parse(decoded)
      : null;
    if (p.family === "dispatch") {
      assert.equal(
        response.status,
        p.mode === "repeated-param" ? 400 : 200,
        p.id
      );
      if (
        [
          "limit-zero",
          "limit-negative",
          "limit-positive",
          "query-body-precedence",
        ].includes(p.mode)
      ) {
        assert.ok(Array.isArray(body.comments), p.id);
        for (const item of body.comments)
          assert.deepEqual(Object.keys(item), keys, p.id);
      }

      if (p.mode === "tids-empty") {
        assert.equal(response.status, 200, p.id);
        assert.deepEqual(c.commentsContext.tids, []);
        assert.deepEqual(body, []);
      }
      if (p.mode === "tids-list") {
        assert.equal(response.status, 200, p.id);
        assert.deepEqual(c.commentsContext.tids, [0, 2]);
        assert.deepEqual(
          body.map((x) => x.tid),
          [2]
        );
      }
      if (p.mode === "query-body-precedence") {
        assert.equal(response.status, 200, p.id);
        assert.equal(c.commentsContext.limit, 1);
        assert.equal(body.pagination.limit, 1);
      }
      if (p.mode === "repeated-param") assert.equal(response.status, 400, p.id);
      if (p.mode === "moderation-false")
        assert.equal(c.commentsContext.moderation, false);
    }
    if (p.mode === "moderation-true") {
      assert.equal(c.commentsContext.moderation, true, p.id);
      assert.ok(body.length > 0, p.id);
      for (const item of body) {
        assert.equal(item.conversation_id, f.capability, p.id);
        assert.equal(Object.hasOwn(item, "zid"), false, p.id);
        assert.equal(Object.hasOwn(item, "uid"), false, p.id);
      }
    }
    if (p.family === "identity") {
      const status = {
        "missing-capability": 400,
        "malformed-capability": 400,
        "nonexistent-capability": 400,
        "valid-foreign-capability": 200,
        "expired-participant-jwt": 401,
        "cross-conversation-jwt": 200,
      }[p.mode];
      assert.equal(response.status, status, p.id);
      if (p.mode === "cross-conversation-jwt") {
        assert.equal(c.commentsContext.uid, 3);
        assert.equal(c.commentsContext.pid, 0);
        assert.equal(c.commentsContext.zid, f.zid);
        assert.equal(f.participantPid, 1);
      }
    }
    const derived = ["shape", "coding"].includes(p.family);
    let cell = null;
    if (derived) {
      assert.equal(response.status, 200, p.id);
      assert.ok(Array.isArray(body), p.id);
      assert.equal(body.length, f.expectedCount, p.id);
      assert.equal(decoded.toString(), JSON.stringify(body), p.id);
      const tids = body.map((c) => c.tid);
      if (f.shape === "tied-created")
        assert.deepEqual(
          [...tids].sort((a, b) => a - b),
          [...f.expectedTids].sort((a, b) => a - b)
        );
      else assert.deepEqual(tids, f.expectedTids, p.id);
      if (body.length) populated++;
      else empty++;
      for (const item of body) {
        assert.deepEqual(Object.keys(item), keys, p.id);
        assert.equal(typeof item.created, "string");
        assert.match(item.created, /^\d+$/);
        assert.equal(typeof item.txt, "string");
        assert.equal(typeof item.is_seed, "boolean");
        assert.equal(typeof item.is_meta, "boolean");
        for (const k of ["tid", "pid"]) assert.ok(Number.isInteger(item[k]));
        for (const k of ["lang", "quote_src_url", "original_id"])
          assert.ok(item[k] === null || typeof item[k] === "string");
      }
      const gzip = p.codingProfile === "large-accept-gzip";
      assert.equal(coding, gzip ? "gzip" : "identity", p.id);
      if (p.family === "coding")
        assert.equal(
          decoded.length >= 1024,
          p.codingProfile.startsWith("large-"),
          p.id
        );
      assert.match(header("vary"), /Accept-Encoding/i);
      assert.equal(header("access-control-allow-origin"), "https://localhost");
      const context = c.commentsContext;
      assert.equal(context.zid, f.zid);
      const expectedUid = {
        "bound-participant": 3,
        owner: f.owner,
        "site-sharing-moderator": 200004,
        "foreign-owner": 4,
        admin: 2,
      }[p.actor];
      if (expectedUid === undefined) assert.ok(context.uid === undefined);
      else assert.equal(context.uid, expectedUid, p.id);
      const pidOutcome =
        p.actor === "bound-participant"
          ? `bound-${f.participantPid === 0 ? "zero" : "nonzero"}`
          : "unresolved";
      if (p.actor === "bound-participant")
        assert.equal(context.pid, f.participantPid, p.id);
      cell = {
        registration: 42,
        actor: p.actor,
        family: p.family,
        shape: p.shape || p.codingProfile,
        requestMode: "ordinary-list",
        strict_moderation: f.strict,
        listShape: body.length ? "populated" : "empty",
        pidOutcome,
        status: response.status,
        mediaType: header("content-type"),
        contentCoding: coding,
        profile: hash(recording.manifest.serialization),
        cacheReplicaProfile: "single-primary-no-configured-replica",
        ordering: f.shape === "tied-created" ? "ties" : "distinct",
      };
      const key = JSON.stringify(cell);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({
        caseId: p.id,
        zid: f.zid,
        owner: f.owner,
        inputSha256: f.inputSha256,
        usage: p.usage,
      });
    }
    rows.push({
      caseId: p.id,
      family: p.family,
      actor: p.actor || generated[i].auth,
      mode: p.mode || "ordinary-list",
      fixture: f.zid,
      status: response.status,
      mediaType: header("content-type"),
      contentCoding: coding,
      vary: header("vary") || null,
      accessControlAllowOrigin: header("access-control-allow-origin") || null,
      negotiation: c.request.headers["accept-encoding"] || null,
      wireBytes: wire.length,
      wireSha256: hash(wire),
      decodedBytes: decoded.length,
      decodedSha256: hash(decoded),
      count: Array.isArray(body) ? body.length : body?.comments?.length ?? null,
      itemKeyOrder:
        Array.isArray(body) && body.length ? Object.keys(body[0]) : null,
      commentsContext: c.commentsContext,
      cell,
    });
  }
  assert.equal(cells.size, 96);
  for (const [key, group] of cells) {
    assert.equal(group.length, 3, key);
    for (const field of ["zid", "owner", "inputSha256"])
      assert.equal(new Set(group.map((g) => g[field])).size, 3, key);
    assert.deepEqual(
      group.map((g) => g.usage),
      ["derivation", "derivation", "held-out"]
    );
  }
  return {
    cases: recording.cases.length,
    records,
    newCases: 396,
    independentFixtures: 71,
    populated,
    empty,
    cells: [...cells].map(([key, fixtures]) => ({
      key: JSON.parse(key),
      fixtures,
    })),
    rows,
  };
}
module.exports = { audit, keys };
if (require.main === module) {
  const a = audit(process.argv[2]);
  console.log(
    JSON.stringify({ ...a, cells: a.cells.length, rows: a.rows.length })
  );
}
