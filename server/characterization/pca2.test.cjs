"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { testBaseline } = require("./baseline.cjs");
const { pca2Cases } = require("./pca2-cases.cjs");
const { audit } = require("./pca2-audit.cjs");
const root = testBaseline();
test("PCA2: every auth/scenario/env/tick cell has independent derivation and held-out recordings", () => {
  const result = audit(root);
  assert.equal(result.newCases, 336);
  assert.equal(result.cells.length, 112);
  assert.equal(result.independentFixtures, 60);
});
test("PCA2: actor relabelling cannot satisfy fixture independence", () => {
  const fixtures = require("./pca2-fixtures.json");
  assert.equal(new Set(fixtures.map((f) => f.seed)).size, 60);
  for (const auth of ["unauthenticated", "participant", "owner", "moderator"])
    for (const shape of [
      "zero-approved",
      "populated",
      "env-mismatch",
      "not-ready",
      "foreign",
    ]) {
      const group = fixtures.filter(
        (f) => f.auth === auth && f.shape === shape
      );
      assert.equal(group.length, 3);
      assert.equal(
        new Set(group.map((f) => `${f.participants}/${f.comments}/${f.seed}`))
          .size,
        3
      );
    }
});
test("PCA2: participant credentials are conversation-bound; cross-capability intentionally uses a different binding", () => {
  const bindings = JSON.parse(
    fs.readFileSync(path.join(root, "pca2-auth.json"))
  ).participantBindings;
  for (const c of pca2Cases().filter((c) => c.auth === "participant")) {
    const binding = bindings.find(
      (b) => b.credentialRef === c.request.headers.authorization
    );
    assert.ok(binding?.verified, c.caseId);
    if (c.case === "cross-capability")
      assert.notEqual(binding.conversation_id, c.request.query.conversation_id);
    else if (!c.case.includes("capability"))
      assert.equal(binding.conversation_id, c.request.query.conversation_id);
  }
});
test("PCA2: empty string and empty array are distinct request modes, GET body is sent with its actual byte length", () => {
  const cases = pca2Cases();
  assert.equal(
    cases.filter((c) => c.case === "keys-empty" && c.request.query.keys === "")
      .length,
    12
  );
  assert.equal(
    cases.filter(
      (c) => c.case === "keys-empty-array" && c.request.body.keys.length === 0
    ).length,
    12
  );
  const { readRecording } = require("./recording.cjs");
  for (const c of readRecording(root).cases.filter(
    (c) => c.case === "keys-array" || c.case === "keys-empty-array"
  )) {
    const bytes = Buffer.concat(
      c.wire.request.body.map((b) => Buffer.from(b.bytes.base64, "base64"))
    );
    assert.equal(
      c.wire.request.headers.find(
        (h) => h.name.toLowerCase() === "content-length"
      ).value,
      String(bytes.length)
    );
  }
});
