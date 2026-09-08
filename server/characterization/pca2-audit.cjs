"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  zlib = require("node:zlib");
const { hash } = require("./core.cjs");
const { readRecording, validate } = require("./recording.cjs");
const { pca2Cases } = require("./pca2-cases.cjs");
function orders(value, at = "$", out = {}) {
  if (Array.isArray(value))
    value.forEach((v, i) => orders(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") {
    out[at] = Object.keys(value);
    for (const [k, v] of Object.entries(value)) orders(v, `${at}.${k}`, out);
  }
  return out;
}
function audit(root) {
  const recording = readRecording(root),
    by = new Map(recording.cases.map((c) => [c.caseId, c]));
  const evidence = JSON.parse(
    fs.readFileSync(path.join(root, "pca2-seed.json"))
  );
  const authEvidence = JSON.parse(
    fs.readFileSync(path.join(root, "pca2-auth.json"))
  );
  const fixtures = evidence.fixtures;
  assert.equal(recording.manifest.stack.mathEnv, "p027");
  assert.equal(fixtures.length, 60);
  assert.equal(new Set(fixtures.map((f) => f.zid)).size, 60);
  assert.equal(new Set(fixtures.map((f) => f.inputSha256)).size, 60);
  assert.equal(authEvidence.participantBindings.length, 15);
  assert.equal(authEvidence.moderator.uid, 2);
  for (const f of fixtures) {
    assert.ok(f.voteCount > 0);
    assert.equal(f.rows.length, f.rowMathEnv ? 1 : 0);
    if (f.rows.length) {
      assert.equal(f.rows[0].mathEnv, f.rowMathEnv);
      assert.equal(f.rows[0].mathTick, 1);
      assert.ok(f.rows[0].n > 0);
    }
    assert.equal(
      f.approvedCommentCount,
      f.shape === "zero-approved" ? 0 : f.comments
    );
    if (f.shape === "foreign") assert.equal(f.owner, 4);
    if (f.auth === "participant")
      assert.ok(
        authEvidence.participantBindings.some(
          (b) =>
            b.verified && b.zid === f.zid && b.conversation_id === f.capability
        )
      );
  }
  const rows = [],
    floors = new Map();
  let records = 0;
  for (const entry of recording.index.cases) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, entry.manifest.path))
    );
    validate(manifest);
    records++;
    for (const name of [
      "request.json",
      "response.json",
      "effects.jsonl",
      "external.jsonl",
      "process.jsonl",
    ]) {
      const text = fs.readFileSync(path.join(root, entry.path, name), "utf8");
      for (const record of name.endsWith("jsonl")
        ? text.trim().split("\n").filter(Boolean).map(JSON.parse)
        : [JSON.parse(text)]) {
        validate(record);
        records++;
      }
    }
  }
  for (const planned of pca2Cases()) {
    const c = by.get(planned.caseId);
    assert.ok(c, planned.caseId);
    assert.deepEqual(c.request, planned.request);
    const f = fixtures.find((f) => c.caseId.includes(`/f${f.zid}/`));
    assert.ok(f);
    assert.equal(c.oracle.pass, true, c.caseId);
    assert.equal(Object.keys(c.effects.db).length, 0, c.caseId);
    assert.equal(c.effects.outbound.length, 0, c.caseId);
    const response = c.wire.response;
    const wire = Buffer.concat(
      response.body.map((chunk) => Buffer.from(chunk.bytes.base64, "base64"))
    );
    const coding =
      response.headers.find((h) => h.name.toLowerCase() === "content-encoding")
        ?.value || "identity";
    const decoded =
      coding === "gzip" && wire.length ? zlib.gunzipSync(wire) : wire;
    const body = response.status === 200 ? JSON.parse(decoded) : null;
    const keys = c.request.body?.keys ?? c.request.query.keys;
    const parsed =
      typeof keys === "string" ? keys.split(",").map((s) => s.trim()) : keys;
    const mode = parsed?.length ? "keys" : "full";
    const name = planned.case;
    const status =
      name === "conditional-conflict"
        ? 400
        : ["malformed-capability", "missing-capability"].includes(name)
        ? 400
        : [
            "not-ready-cold",
            "not-ready-warm",
            "conditional-equal",
            "conditional-newer",
            "conditional-weak",
            "conditional-weak-lower",
            "conditional-star",
          ].includes(name)
        ? 304
        : 200;
    assert.equal(response.status, status, c.caseId);
    if (status === 304) assert.equal(wire.length, 0, c.caseId);
    if (body) {
      if (mode === "full")
        assert.equal(
          response.headers.find((h) => h.name.toLowerCase() === "etag")?.value,
          `"${body.math_tick}"`,
          c.caseId
        );
      if (mode === "full") assert.equal(coding, "gzip", c.caseId);
      assert.equal(decoded.toString(), JSON.stringify(body), c.caseId);
      if (
        ["zero-approved", "env-mismatch", "not-ready-latest"].includes(name)
      ) {
        assert.equal(body.n, 0);
        assert.equal(body.math_tick, 0);
        assert.equal(body["n-cmts"], name === "zero-approved" ? 0 : f.comments);
        assert.equal(body.tids.length, body["n-cmts"]);
      }
      if (name === "populated" || name === "cross-capability") {
        assert.ok(body.n > 0);
        assert.equal(body.math_tick, 1);
        assert.ok(body["group-clusters"].length > 0);
        assert.ok(body["base-clusters"].id.length > 0);
        assert.ok(body.pca.comps[0].length > 0);
      }
      if (mode === "keys") {
        const original = by.get(c.caseId.replace(/[^/]+$/, "populated"))
          .response.body;
        // JSON serialization omits picked prototype functions; __proto__ is not an own output property.
        const expected = Object.fromEntries(
          [...new Set(parsed)]
            .filter((k) => Object.hasOwn(original, k))
            .map((k) => [k, original[k]])
        );
        assert.deepEqual(body, expected, c.caseId);
        assert.deepEqual(Object.keys(body), Object.keys(expected), c.caseId);
      }
      if (name === "keys-empty") assert.deepEqual(body, {});
      if (name === "keys-gzip") assert.equal(coding, "gzip", c.caseId);
      if (name === "keys-small-gzip")
        assert.equal(coding, "identity", c.caseId);
    }
    const cell = {
      auth: f.auth,
      scenario: name,
      mathEnv: f.mathEnv,
      rowMathEnv: f.rowMathEnv,
      mathTick: f.mathTick,
      status,
      mediaType:
        response.headers.find((h) => h.name.toLowerCase() === "content-type")
          ?.value || null,
      contentCoding: coding,
      requestMode: mode,
    };
    const key = JSON.stringify(cell);
    if (!floors.has(key)) floors.set(key, []);
    floors.get(key).push({
      zid: f.zid,
      inputSha256: f.inputSha256,
      split: f.split,
      caseId: c.caseId,
    });
    rows.push({
      caseId: c.caseId,
      fixture: f.zid,
      split: f.split,
      cell,
      etag:
        response.headers.find((h) => h.name.toLowerCase() === "etag")?.value ||
        null,
      wireBytes: wire.length,
      wireSha256: hash(wire),
      decodedBytes: decoded.length,
      decodedSha256: hash(decoded),
      orders: body ? orders(body) : null,
    });
  }
  for (const [key, values] of floors) {
    assert.equal(values.length, 3, key);
    assert.equal(new Set(values.map((v) => v.zid)).size, 3, key);
    assert.equal(new Set(values.map((v) => v.inputSha256)).size, 3, key);
    assert.deepEqual(
      values.map((v) => v.split),
      ["derivation", "derivation", "held-out"],
      key
    );
  }
  return {
    records,
    cases: recording.cases.length,
    newCases: rows.length,
    independentFixtures: fixtures.length,
    cells: [...floors].map(([key, fixtures]) => ({
      key: JSON.parse(key),
      fixtures,
    })),
    rows,
  };
}
module.exports = { audit, orders };
if (require.main === module) {
  const result = audit(process.argv[2]);
  console.log(
    JSON.stringify({
      cases: result.cases,
      p025Records: result.records,
      newCases: result.newCases,
      independentFixtures: result.independentFixtures,
      cells: result.cells.length,
    })
  );
}
