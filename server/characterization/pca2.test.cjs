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

test("Comments: exact 396-request inventory has 96 three-replica cells and 108 witnesses", () => {
  const { plan, commentsCases, fixtures } = require("./comments-cases.cjs");
  const cases = commentsCases();
  assert.deepEqual(
    cases.map((c) => c.caseId),
    plan.cases.map((c) => c.id)
  );
  assert.equal(new Set(cases.map((c) => c.caseId)).size, 396);
  assert.equal(
    plan.cases.filter((c) => c.usage !== "witness-only").length,
    288
  );
  assert.equal(plan.cases.filter((c) => c.family === "dispatch").length, 102);
  assert.equal(plan.cases.filter((c) => c.family === "identity").length, 6);
  assert.equal(fixtures.length, 71);
  const empty = cases.find(
    (c) => c.caseId === "comments-read/dispatch/anonymous/tids-empty"
  );
  assert.deepEqual(empty.request.body, { tids: [] });
  assert.equal(empty.request.query.tids, undefined);
  const list = cases.find(
    (c) => c.caseId === "comments-read/dispatch/anonymous/tids-list"
  );
  assert.equal(list.request.query.tids, "0,2");
});

test("Comments: wire-derived projection, coding, six actors and independent floors", () => {
  const result = require("./comments-audit.cjs").audit(root);
  assert.equal(result.newCases, 396);
  assert.equal(result.cells.length, 96);
});
